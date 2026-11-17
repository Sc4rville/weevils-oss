import { execFile } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { tr } from './i18n.ts'
import M from './i18n/foryou-media.ts'
import { MAX_ENTRIES, MediaRefused, MediaShelf, citedPaths, disposition, mimeOf, parseRange, sniff } from './foryou-media.ts'

// The media shelf of « for you » (server/foryou-media.ts): temp folders only, never the real projects or data.
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(40, 1)])
const JPG = Buffer.concat([Buffer.from('ffd8ffe000104a464946', 'hex'), Buffer.alloc(40, 2)])
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(20, 3)])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([40, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(20, 4)])
const ftyp = (major: string, ...compat: string[]) => {
  const body = Buffer.from(major + '\0\0\0\0' + compat.join(''), 'latin1')
  const size = Buffer.alloc(4)
  size.writeUInt32BE(body.length + 8)
  return Buffer.concat([size, Buffer.from('ftyp'), body, Buffer.alloc(24, 5)])
}
const MP4 = ftyp('isom', 'isom', 'iso2', 'avc1', 'mp41')
const MOV = ftyp('qt  ', 'qt  ')
const AVIF = ftyp('avif', 'mif1', 'miaf')
const WEBM = Buffer.concat([Buffer.from('1a45dfa3', 'hex'), Buffer.alloc(30, 6)])

/** A world: two roots (projects, data with an inbox below a dot folder) and an « elsewhere » outside both. */
function world(caps?: { image?: number; video?: number }) {
  const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fym-')))
  const projects = path.join(top, 'projects')
  const data = path.join(top, '.local', 'share', 'weevils')
  const elsewhere = path.join(top, 'elsewhere')
  for (const d of [path.join(projects, 'game', 'out'), path.join(data, 'inbox'), elsewhere]) fs.mkdirSync(d, { recursive: true })
  const put = (file: string, bytes: Buffer | string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, bytes)
    return file
  }
  const file = path.join(data, 'foryou-media.json')
  const shelf = () => new MediaShelf({ file, roots: [projects, data], caps })
  return { top, projects, data, elsewhere, put, file, shelf, game: path.join(projects, 'game') }
}

const reason = (f: () => unknown): string => {
  try {
    f()
  } catch (e) {
    expect(e).toBeInstanceOf(MediaRefused)
    return (e as MediaRefused).reason + ' | ' + (e as Error).message
  }
  return 'accepted'
}

describe('sniff', () => {
  it('tells images from videos by their first bytes, whatever the name', () => {
    for (const b of [PNG, JPG, GIF, WEBP, AVIF]) expect(sniff(b)).toBe('image')
    for (const b of [MP4, MOV, WEBM, ftyp('mp42', 'mp42', 'isom'), Buffer.concat([Buffer.from([0, 0, 0, 8]), Buffer.from('wide'), Buffer.alloc(8)])]) expect(sniff(b)).toBe('video')
    // avif declared only among the compatible brands
    expect(sniff(ftyp('mif1', 'mif1', 'avif'))).toBe('image')
  })

  it('refuses text, html, svg, pdf, truncated and empty content', () => {
    for (const s of ['just some text\n', '<!doctype html><script>alert(1)</script>', '<svg xmlns="http://www.w3.org/2000/svg"/>', '%PDF-1.7', 'GIF', 'RIFF1234WAVE', '']) {
      expect(sniff(Buffer.from(s)), s).toBeNull()
    }
    expect(sniff(Buffer.from([0x89, 0x50]))).toBeNull()
  })

  it('knows the content type of every extension it takes, video included', () => {
    expect(mimeOf('/a/b.PNG')).toBe('image/png')
    expect(mimeOf('a.jpeg')).toBe('image/jpeg')
    expect(mimeOf('a.mp4')).toBe('video/mp4')
    expect(mimeOf('a.m4v')).toBe('video/mp4')
    expect(mimeOf('a.webm')).toBe('video/webm')
    expect(mimeOf('a.mov')).toBe('video/quicktime')
    expect(mimeOf('a.svg')).toBeUndefined()
  })
})

describe('parseRange', () => {
  it('reads a-b, a- and the suffix -n, clamped to the file', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=0-0', 1000)).toEqual({ start: 0, end: 0 })
    expect(parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 })
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=999-999', 1000)).toEqual({ start: 999, end: 999 })
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 })
    expect(parseRange(' Bytes = 2 - 3 ', 10)).toEqual({ start: 2, end: 3 })
  })

  it('says unsatisfiable past the end, for an empty suffix and for an empty file', () => {
    expect(parseRange('bytes=1000-', 1000)).toBe('unsatisfiable')
    expect(parseRange('bytes=1000-1200', 1000)).toBe('unsatisfiable')
    expect(parseRange('bytes=-0', 1000)).toBe('unsatisfiable')
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable')
    expect(parseRange('bytes=-5', 0)).toBe('unsatisfiable')
  })

  it('ignores what it does not serve (the whole file is sent): no header, another unit, several ranges, nonsense', () => {
    for (const h of [undefined, '', 'items=0-5', 'bytes=0-5,10-15', 'bytes=-', 'bytes=5-2', 'bytes=a-b', 'bytes=1.5-3', 'bytes 0-5', 'bytes=99999999999999999999-']) {
      expect(parseRange(h, 1000), String(h)).toBeNull()
    }
  })
})

describe('MediaShelf.add', () => {
  it('takes an image or a video under a root: absolute, ~/ and relative to the cwd', () => {
    const w = world()
    const s = w.shelf()
    const png = w.put(path.join(w.game, 'out', 'render.png'), PNG)
    const e = s.add(png)
    expect(e).toMatchObject({ path: png, type: 'image', bytes: PNG.length, name: 'render.png' })
    expect(e.id).toMatch(/^[a-f0-9]{16}$/)
    expect(e.mtime).toBe(Math.round(fs.statSync(png).mtimeMs))
    expect(s.add('out/render.png', w.game).id).toBe(e.id)
    expect(s.add('./out/../out/render.png', w.game).id).toBe(e.id)
    expect(s.add(w.put(path.join(w.game, 'clip.MP4'), MP4))).toMatchObject({ type: 'video', name: 'clip.MP4' })
    for (const [name, bytes, type] of [['a.jpg', JPG, 'image'], ['a.jpeg', JPG, 'image'], ['a.gif', GIF, 'image'], ['a.webp', WEBP, 'image'], ['a.avif', AVIF, 'image'], ['a.webm', WEBM, 'video'], ['a.mov', MOV, 'video'], ['a.m4v', MP4, 'video']] as const) {
      expect(s.add(w.put(path.join(w.game, name), bytes)).type, name).toBe(type)
    }
    // The inbox lives under a dot folder (~/.local/share/weevils): still a root.
    expect(s.add(w.put(path.join(w.data, 'inbox', '2026-11-10-photo.jpg'), JPG)).type).toBe('image')

    const home = process.env.HOME
    process.env.HOME = w.top
    try {
      expect(s.add('~/projects/game/out/render.png').id).toBe(e.id)
    } finally {
      process.env.HOME = home
    }
  })

  it('same file again: same id, refreshed size and date; another file: another id', () => {
    const w = world()
    const s = w.shelf()
    const png = w.put(path.join(w.game, 'shot.png'), PNG)
    const a = s.add(png)
    fs.writeFileSync(png, Buffer.concat([PNG, Buffer.alloc(100)]))
    fs.utimesSync(png, new Date(), new Date(Date.now() + 5000))
    const b = s.add(png)
    expect(b.id).toBe(a.id)
    expect(b.bytes).toBe(PNG.length + 100)
    expect(b.mtime).not.toBe(a.mtime)
    expect(s.list()).toHaveLength(1)
    // Through a link inside the project: the same real file, the same entry.
    fs.symlinkSync(png, path.join(w.game, 'latest.png'))
    expect(s.add(path.join(w.game, 'latest.png')).id).toBe(a.id)
    expect(s.add(w.put(path.join(w.game, 'other.png'), PNG)).id).not.toBe(a.id)
  })

  it('refuses with a reason: missing, a folder, outside the roots, a link that escapes', () => {
    const w = world()
    const s = w.shelf()
    const t = tr(M)
    expect(reason(() => s.add(path.join(w.game, 'nope.png')))).toBe('missing | ' + t.missing)
    expect(reason(() => s.add('nope.png'))).toBe('missing | ' + t.missing)
    expect(reason(() => s.add(''))).toBe('missing | ' + t.missing)
    fs.mkdirSync(path.join(w.game, 'folder.png'))
    expect(reason(() => s.add(path.join(w.game, 'folder.png')))).toBe('notFile | ' + t.notFile)

    const out = w.put(path.join(w.elsewhere, 'secret.png'), PNG)
    expect(reason(() => s.add(out))).toBe('outside | ' + t.outside)
    expect(reason(() => s.add('../../elsewhere/secret.png', w.game))).toBe('outside | ' + t.outside)
    // A neighbour whose name merely starts like a root is not inside it.
    expect(reason(() => s.add(w.put(path.join(w.top, 'projects-old', 'a.png'), PNG)))).toBe('outside | ' + t.outside)

    // Symlink escapes: a file link, and a folder link, both inside a project and pointing out.
    fs.symlinkSync(out, path.join(w.game, 'innocent.png'))
    fs.symlinkSync(w.elsewhere, path.join(w.game, 'assets'))
    expect(reason(() => s.add(path.join(w.game, 'innocent.png')))).toBe('outside | ' + t.outside)
    expect(reason(() => s.add(path.join(w.game, 'assets', 'secret.png')))).toBe('outside | ' + t.outside)
    expect(s.list()).toEqual([])
  })

  it('refuses what is not an image or a video: by extension, then by content', () => {
    const w = world()
    const s = w.shelf()
    const t = tr(M)
    for (const name of ['notes.txt', 'page.html', 'logo.svg', 'doc.pdf', 'noext', 'archive.png.zip']) {
      expect(reason(() => s.add(w.put(path.join(w.game, name), PNG))), name).toBe('badType | ' + t.badType)
    }
    // A .png that is text, an .mp4 that is a picture, a .jpg that is a film, an empty .gif
    expect(reason(() => s.add(w.put(path.join(w.game, 'fake.png'), 'ceci est du texte, pas une image\n')))).toBe('badHeader | ' + t.badHeader('png'))
    expect(reason(() => s.add(w.put(path.join(w.game, 'fake.mp4'), PNG)))).toBe('badHeader | ' + t.badHeader('mp4'))
    expect(reason(() => s.add(w.put(path.join(w.game, 'fake.jpg'), MP4)))).toBe('badHeader | ' + t.badHeader('jpg'))
    expect(reason(() => s.add(w.put(path.join(w.game, 'empty.gif'), '')))).toBe('badHeader | ' + t.badHeader('gif'))
    expect(s.list()).toEqual([])
  })

  it('refuses a file over the cap of its type', () => {
    const w = world({ image: 100, video: 3 * 1024 * 1024 })
    const s = w.shelf()
    const t = tr(M)
    expect(s.add(w.put(path.join(w.game, 'ok.png'), Buffer.concat([PNG, Buffer.alloc(100 - PNG.length)]))).bytes).toBe(100)
    expect(reason(() => s.add(w.put(path.join(w.game, 'big.png'), Buffer.concat([PNG, Buffer.alloc(101 - PNG.length)]))))).toBe('tooBig | ' + t.tooBig(1))
    // Each type has its own cap: the same weight passes as a video.
    expect(s.add(w.put(path.join(w.game, 'ok.mp4'), Buffer.concat([MP4, Buffer.alloc(5000)]))).type).toBe('video')
    expect(reason(() => s.add(w.put(path.join(w.game, 'big.mp4'), Buffer.concat([MP4, Buffer.alloc(3 * 1024 * 1024)]))))).toBe('tooBig | ' + t.tooBig(3))
    // The real caps
    expect(tr(M).tooBig(25)).toContain('25')
  })
})

describe('MediaShelf store', () => {
  it('persists in a 600 file written whole, and a new shelf finds the entries again', () => {
    const w = world()
    const a = w.shelf().add(w.put(path.join(w.game, 'a.png'), PNG))
    expect(fs.statSync(w.file).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(path.dirname(w.file)).filter((f) => f.includes('.tmp'))).toEqual([])
    const again = w.shelf()
    expect(again.get(a.id)).toEqual(a)
    expect(again.view(a)).toEqual({ id: a.id, type: 'image', url: '/api/foryou/media/' + a.id, name: 'a.png', bytes: PNG.length })
  })

  it('starts empty on a missing or broken file', () => {
    const w = world()
    expect(w.shelf().list()).toEqual([])
    fs.writeFileSync(w.file, '{ not json')
    expect(w.shelf().list()).toEqual([])
    fs.writeFileSync(w.file, JSON.stringify({ entries: [null, { id: 3 }, { id: 'x', path: '/etc/passwd', type: 'text' }] }))
    expect(w.shelf().list()).toEqual([])
  })

  it('get: null when unknown, when the file is gone, when it is no longer that kind of media, when a link took its place', () => {
    const w = world()
    const s = w.shelf()
    expect(s.get('nope')).toBeNull()
    const gone = s.add(w.put(path.join(w.game, 'gone.png'), PNG))
    const turned = s.add(w.put(path.join(w.game, 'turned.png'), PNG))
    const swapped = s.add(w.put(path.join(w.game, 'swapped.png'), PNG))
    const kept = s.add(w.put(path.join(w.game, 'kept.png'), PNG))
    fs.rmSync(gone.path)
    fs.writeFileSync(turned.path, 'now a text file, longer than before, nothing to show here\n')
    fs.rmSync(swapped.path)
    fs.symlinkSync(w.put(path.join(w.elsewhere, 'secret.png'), PNG), swapped.path)
    expect(s.get(gone.id)).toBeNull()
    expect(s.get(turned.id)).toBeNull()
    expect(s.get(swapped.id)).toBeNull()
    expect(s.list().map((e) => e.id)).toEqual([kept.id])
    // Dropped for good, on disk too.
    expect(w.shelf().list().map((e) => e.id)).toEqual([kept.id])
  })

  it('get: a file rewritten with the same kind of content keeps its id and gets its new size', () => {
    const w = world()
    const s = w.shelf()
    const e = s.add(w.put(path.join(w.game, 'live.png'), PNG))
    fs.writeFileSync(e.path, Buffer.concat([PNG, Buffer.alloc(7)]))
    expect(s.get(e.id)).toMatchObject({ id: e.id, bytes: PNG.length + 7 })
  })

  it('keeps the newest entries under the cap', () => {
    const w = world()
    const entries = Array.from({ length: MAX_ENTRIES }, (_, i) => ({ id: 'old' + i, path: path.join(w.game, `old${i}.png`), type: 'image', bytes: 1, mtime: 1, name: `old${i}.png`, at: i + 1 }))
    fs.writeFileSync(w.file, JSON.stringify({ entries }))
    const s = w.shelf()
    const e = s.add(w.put(path.join(w.game, 'new.png'), PNG))
    const kept = (JSON.parse(fs.readFileSync(w.file, 'utf8')) as { entries: { id: string }[] }).entries.map((x) => x.id)
    expect(kept).toHaveLength(MAX_ENTRIES)
    expect(kept).toContain(e.id)
    expect(kept).not.toContain('old0')
    expect(kept).toContain('old1')
  })
})

describe('fromText', () => {
  it('finds the paths an agent cites, in French and in English prose', () => {
    expect(
      citedPaths(
        'C’est fait : le rendu est dans `/home/u/projects/game/out/render final.png`, et la capture ici : /home/u/projects/game/shots/menu.png. ' +
          'J’ai aussi mis le clip (out/trailer.mp4) et « ~/projects/game/b.webp ». Voir https://game.example.tech/img/hero.png pour la version en ligne.',
      ),
    ).toEqual(['/home/u/projects/game/out/render final.png', '/home/u/projects/game/shots/menu.png', 'out/trailer.mp4', '~/projects/game/b.webp'])
    expect(
      citedPaths(
        'Done. Screenshot saved to ./shots/home.PNG; the recording is "captures/run 2.webm" (12 s).\n' +
          '- ![before](docs/before.jpg "the old one")\n- [after](<docs/after shot.jpeg>)\n- **out/final.mov**\n' +
          'He said "ok" and the file is /tmp/a.gif "great". Not media: notes.md, build.png.zip, v1.2.mp4-draft, file=/x/y.avif',
      ),
    ).toEqual(['./shots/home.PNG', 'captures/run 2.webm', 'docs/before.jpg', 'docs/after shot.jpeg', 'out/final.mov', '/tmp/a.gif', '/x/y.avif'])
    expect(citedPaths('')).toEqual([])
    expect(citedPaths('nothing to see, tests pass')).toEqual([])
  })

  it('registers the valid ones: absolute, ~/ and relative to the cwd, de-duplicated, at most max', () => {
    const w = world()
    const s = w.shelf()
    const render = w.put(path.join(w.game, 'out', 'render final.png'), PNG)
    const menu = w.put(path.join(w.game, 'shots', 'menu.png'), PNG)
    const clip = w.put(path.join(w.game, 'out', 'trailer.mp4'), MP4)
    w.put(path.join(w.game, 'out', 'fake.png'), 'not an image')
    w.put(path.join(w.elsewhere, 'secret.png'), PNG)
    const text =
      `C’est fait : le rendu est dans \`${render}\`, et la capture ici : ${menu}. Le clip : out/trailer.mp4 (12 s). ` +
      `Encore la capture : shots/menu.png. Pas bon : out/fake.png, ${path.join(w.elsewhere, 'secret.png')}, out/absent.png, https://x.example.tech/a.png.`
    const got = s.fromText(text, w.game)
    expect(got.map((e) => e.path)).toEqual([render, menu, clip])
    expect(got.map((e) => e.type)).toEqual(['image', 'image', 'video'])
    expect(s.list()).toHaveLength(3)
    // Relative paths need a cwd; max cuts.
    expect(s.fromText('Le clip : out/trailer.mp4', undefined)).toEqual([])
    expect(s.fromText(text, w.game, 2).map((e) => e.path)).toEqual([render, menu])
    expect(s.fromText(text, w.game, 0)).toEqual([])
    // A link target written url-encoded
    expect(s.fromText('![rendu](out/render%20final.png)', w.game).map((e) => e.path)).toEqual([render])
  })

  it('caps at 4 by default', () => {
    const w = world()
    const names = Array.from({ length: 7 }, (_, i) => w.put(path.join(w.game, `frame${i}.png`), PNG))
    expect(w.shelf().fromText(names.join('\n'), w.game).map((e) => e.name)).toEqual(['frame0.png', 'frame1.png', 'frame2.png', 'frame3.png'])
  })

  it('refuses dot-folders and node_modules below a root, cited any way, even through a link', () => {
    const w = world()
    const s = w.shelf()
    for (const dir of ['.run', '.work/frames', '.git', 'node_modules/pkg', 'out/.cache']) w.put(path.join(w.game, dir, 'a.png'), PNG)
    fs.symlinkSync(path.join(w.game, '.work'), path.join(w.game, 'work'))
    const text = [
      path.join(w.game, '.run', 'a.png'),
      '.work/frames/a.png',
      './.git/a.png',
      'node_modules/pkg/a.png',
      '`out/.cache/a.png`',
      'work/frames/a.png',
      'out/../.run/a.png',
    ].join(' puis ')
    expect(s.fromText(text, w.game)).toEqual([])
    // A session whose cwd is itself hidden (a worktree under .claude) cites nothing either.
    w.put(path.join(w.game, '.claude', 'worktrees', 'x', 'shot.png'), PNG)
    expect(s.fromText('shot.png', path.join(w.game, '.claude', 'worktrees', 'x'))).toEqual([])
    expect(s.list()).toEqual([])
    // The same files published on purpose are accepted: the refusal is for what is merely cited.
    expect(s.add(path.join(w.game, '.run', 'a.png')).type).toBe('image')
    // The inbox, under ~/.local/share/weevils, is not « hidden »: the dot folders are above the root.
    const photo = w.put(path.join(w.data, 'inbox', 'photo.jpg'), JPG)
    expect(s.fromText(`(photo : ${photo})`, undefined).map((e) => e.path)).toEqual([photo])
  })

  it('never throws', () => {
    const w = world()
    const s = w.shelf()
    expect(s.fromText(undefined as unknown as string, undefined)).toEqual([])
    expect(s.fromText('\0/a.png %E0%A4%A.png `' + 'x'.repeat(5000) + '.png`', '/nonexistent')).toEqual([])
    expect(new MediaShelf({ file: path.join(w.top, 'nodir', 'x.json'), roots: ['/nonexistent-root'] }).fromText('/etc/hosts.png', '/')).toEqual([])
  })
})

describe('serve', () => {
  const w = world()
  const shelf = w.shelf()
  const body = Buffer.concat([MP4, Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251))])
  const clip = shelf.add(w.put(path.join(w.game, 'clip.mp4'), body))
  const shot = shelf.add(w.put(path.join(w.game, 'shot.png'), PNG))
  let port = 0
  // The route as index.ts mounts it: only the id reaches the shelf.
  const server = http.createServer((req, res) => {
    const m = /^\/api\/foryou\/media\/([^/?]+)/.exec(req.url ?? '')
    shelf.serve(req, res, m ? decodeURIComponent(m[1]) : '', new URL(req.url ?? '', 'http://x').searchParams.get('download') === '1')
  })
  beforeAll(async () => {
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
    port = (server.address() as { port: number }).port
  })
  afterAll(() => void server.close())

  const get = (id: string, headers: Record<string, string> = {}, method = 'GET') =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((ok, ko) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/foryou/media/' + id, method, headers }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c)).on('end', () => ok({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
      })
      req.on('error', ko).end()
    })

  it('sends the whole file with its type, its length and accept-ranges', async () => {
    const r = await get(clip.id)
    expect(r.status).toBe(200)
    expect(r.headers).toMatchObject({
      'content-type': 'video/mp4',
      'content-length': String(body.length),
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=3600',
      'x-content-type-options': 'nosniff',
    })
    expect(r.headers['content-range']).toBeUndefined()
    expect(r.body.equals(body)).toBe(true)
    const img = await get(shot.id)
    expect(img.headers['content-type']).toBe('image/png')
    expect(img.body.equals(PNG)).toBe(true)
  })

  it('names the file: inline by default, attachment with ?download=1, ranges still answered (a save to the camera roll)', async () => {
    const r = await get(clip.id)
    expect(r.headers['content-disposition']).toBe(`inline; filename="clip.mp4"; filename*=UTF-8''clip.mp4`)
    const d = await get(`${clip.id}?download=1`, { range: 'bytes=0-9' })
    expect(d.status).toBe(206)
    expect(d.headers).toMatchObject({ 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-disposition': `attachment; filename="clip.mp4"; filename*=UTF-8''clip.mp4` })
    expect(d.body.equals(body.subarray(0, 10))).toBe(true)
    expect((await get(`${shot.id}?download=1`, {}, 'HEAD')).headers['content-disposition']).toMatch(/^attachment; filename="shot.png"/)
  })

  it('a file name in the header is clean: real extension, accents kept in filename*, nothing that breaks the header', () => {
    expect(disposition('Écran d’accueil.PNG', 'abc', true)).toBe(`attachment; filename="Ecran d_accueil.png"; filename*=UTF-8''%C3%89cran%20d%E2%80%99accueil.png`)
    expect(disposition('a"b\\c;.mp4', 'abc', false)).toBe(`inline; filename="a b c_.mp4"; filename*=UTF-8''a%20b%20c%3B.mp4`)
    expect(disposition('___.jpg', 'k9', true)).toBe(`attachment; filename="weevils-k9.jpg"; filename*=UTF-8''weevils-k9.jpg`)
  })

  it('answers a range with 206 and exactly those bytes (what iOS asks before playing)', async () => {
    const n = body.length
    for (const [header, start, end] of [['bytes=0-1', 0, 1], ['bytes=100-199', 100, 199], [`bytes=${n - 10}-`, n - 10, n - 1], ['bytes=-64', n - 64, n - 1], [`bytes=50-${n + 500}`, 50, n - 1], ['bytes=0-', 0, n - 1]] as const) {
      const r = await get(clip.id, { range: header })
      expect(r.status, header).toBe(206)
      expect(r.headers['content-range'], header).toBe(`bytes ${start}-${end}/${n}`)
      expect(r.headers['content-length'], header).toBe(String(end - start + 1))
      expect(r.headers['content-type']).toBe('video/mp4')
      expect(r.body.equals(body.subarray(start, end + 1)), header).toBe(true)
    }
  })

  it('answers 416 with the size when the range is past the end, and the whole file to a range it does not serve', async () => {
    const r = await get(clip.id, { range: `bytes=${body.length}-` })
    expect(r.status).toBe(416)
    expect(r.headers['content-range']).toBe(`bytes */${body.length}`)
    expect(r.body.length).toBe(0)
    const multi = await get(clip.id, { range: 'bytes=0-1,5-6' })
    expect(multi.status).toBe(200)
    expect(multi.body.length).toBe(body.length)
  })

  it('HEAD: the headers, no body', async () => {
    const r = await get(clip.id, {}, 'HEAD')
    expect(r.status).toBe(200)
    expect(r.headers['content-length']).toBe(String(body.length))
    expect(r.headers['accept-ranges']).toBe('bytes')
    expect(r.body.length).toBe(0)
    const part = await get(clip.id, { range: 'bytes=0-9' }, 'HEAD')
    expect(part.status).toBe(206)
    expect(part.headers['content-range']).toBe(`bytes 0-9/${body.length}`)
    expect(part.body.length).toBe(0)
  })

  it('404 in JSON for an unknown id, a path instead of an id, and a file that went away', async () => {
    for (const id of ['nope', encodeURIComponent(clip.path), encodeURIComponent('../../etc/passwd'), '']) {
      const r = await get(id)
      expect(r.status, id).toBe(404)
      expect(r.headers['content-type']).toBe('application/json')
      expect(JSON.parse(r.body.toString())).toEqual({ error: tr(M).gone })
    }
    const tmp = shelf.add(w.put(path.join(w.game, 'tmp.png'), PNG))
    fs.rmSync(tmp.path)
    expect((await get(tmp.id)).status).toBe(404)
  })

  it('a player that leaves mid-file does not leave the file open or the server stuck', async () => {
    const big = shelf.add(w.put(path.join(w.game, 'big.mp4'), Buffer.concat([MP4, Buffer.alloc(8 * 1024 * 1024, 7)])))
    await new Promise<void>((ok) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/foryou/media/' + big.id }, (res) => {
        res.once('data', () => {
          req.destroy()
          ok()
        })
      })
      req.on('error', () => ok())
    })
    expect((await get(clip.id, { range: 'bytes=0-3' })).status).toBe(206)
  })
})

describe('weevils post / show (the CLI)', () => {
  // The real script against a throwaway server on a free port that records what it receives.
  const seen: { url: string; body: Record<string, unknown> }[] = []
  let answer: { status: number; body: unknown } = { status: 200, body: { ok: true } }
  const server = http.createServer((req, res) => {
    let b = ''
    req.on('data', (c) => (b += c)).on('end', () => {
      seen.push({ url: `${req.method} ${req.url}`, body: JSON.parse(b || '{}') as Record<string, unknown> })
      res.writeHead(answer.status, { 'content-type': 'application/json' }).end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body))
    })
  })
  let port = 0
  beforeAll(async () => {
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
    port = (server.address() as { port: number }).port
  })
  afterAll(() => void server.close())
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-'))
  const cli = (args: string[], opts: { lang?: string; cwd?: string; port?: number; from?: string } = {}) =>
    new Promise<{ rc: number; out: string; err: string }>((done) => {
      const env: Record<string, string> = { HOME: home, PATH: process.env.PATH ?? '', WEEVILS_LANG: opts.lang ?? 'en', WEEVILS_PORT: String(opts.port ?? port) }
      if (opts.from) env.WEEVILS_FROM = opts.from
      execFile('bash', [path.join(import.meta.dirname, 'weevils-cli'), ...args], { env, cwd: opts.cwd ?? home }, (e, out, err) =>
        done({ rc: e ? Number((e as { code?: number }).code ?? 1) : 0, out: String(out), err: String(err) }),
      )
    })
  const last = () => seen[seen.length - 1]

  it('post: the text, the actions split on the first « :: », the author', async () => {
    answer = { status: 200, body: { ok: true } }
    const r = await cli(['post', 'Sent 3 things: tests on game, a "quoted" word\nand a second line', '--action', 'Ship it::merge the branch and deploy :: carefully', '--action', 'Plus tard::rappelle-moi demain'])
    expect(r).toEqual({ rc: 0, out: 'posted in "for you"\n', err: '' })
    expect(last()).toEqual({
      url: 'POST /api/foryou/post',
      body: {
        text: 'Sent 3 things: tests on game, a "quoted" word\nand a second line',
        actions: [
          { label: 'Ship it', brief: 'merge the branch and deploy :: carefully' },
          { label: 'Plus tard', brief: 'rappelle-moi demain' },
        ],
        from: 'weevils',
      },
    })
    // No action, another author, options before the text
    expect((await cli(['post', '--action', 'Go::do it', 'hello'], { from: 'ci-bot' })).rc).toBe(0)
    expect(last().body).toEqual({ text: 'hello', actions: [{ label: 'Go', brief: 'do it' }], from: 'ci-bot' })
    expect((await cli(['post', 'just words'])).rc).toBe(0)
    expect(last().body).toEqual({ text: 'just words', actions: [], from: 'weevils' })
  })

  it('post: one clean line when the text is missing or an action is malformed, nothing sent', async () => {
    const before = seen.length
    for (const args of [['post'], ['post', ''], ['post', '   '], ['post', '--action', 'Go::do it']]) {
      expect(await cli(args), args.join(' ')).toEqual({ rc: 1, out: '', err: 'nothing to post: weevils post "text" [--action "label::what to do"]\n' })
    }
    for (const args of [['post', 'hi', '--action', 'no separator'], ['post', 'hi', '--action', '::no label'], ['post', 'hi', '--action', 'no brief::'], ['post', 'hi', '--action']]) {
      expect(await cli(args), args.join(' ')).toEqual({ rc: 1, out: '', err: 'an action is written "label::what to do"\n' })
    }
    expect((await cli(['post'], { lang: 'fr' })).err).toBe('rien à poster : weevils post "texte" [--action "libellé::quoi faire"]\n')
    expect(seen.length).toBe(before)
  })

  it('show: the path made absolute from where the command runs, the caption, the cwd', async () => {
    answer = { status: 200, body: { ok: true } }
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-cwd-')))
    const r = await cli(['show', 'out/render final.png', 'Le menu, version "nuit"'], { cwd: dir })
    expect(r).toEqual({ rc: 0, out: 'shown in "for you"\n', err: '' })
    expect(last()).toEqual({ url: 'POST /api/foryou/media', body: { path: path.join(dir, 'out/render final.png'), caption: 'Le menu, version "nuit"', cwd: dir, from: 'weevils' } })
    expect((await cli(['show', '/abs/clip.mp4'], { cwd: dir })).rc).toBe(0)
    expect(last().body).toEqual({ path: '/abs/clip.mp4', caption: '', cwd: dir, from: 'weevils' })
    expect((await cli(['show', '~/pics/a.png'], { cwd: dir })).rc).toBe(0)
    expect(last().body.path).toBe(path.join(home, 'pics/a.png'))
    expect((await cli(['show', 'a.png'], { cwd: dir, lang: 'fr' })).out).toBe('affiché dans « pour toi »\n')
  })

  it('show / post: the evidence flags become a structured field, never guessed from the words', async () => {
    answer = { status: 200, body: { ok: true } }
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-cwd-')))
    const limit = 'Interruption not tested on a real iPhone'
    expect((await cli(['show', 'live.mp4', '--demonstrated', 'emulated iPhone, test server', 'Live voice mode: interrupt anytime', '--limit', limit, '--limit', 'No sound in the clip'], { cwd: dir })).rc).toBe(0)
    expect(last().body).toEqual({ path: path.join(dir, 'live.mp4'), caption: 'Live voice mode: interrupt anytime', cwd: dir, from: 'weevils', evidence: { demonstrated: 'emulated iPhone, test server', limits: [limit, 'No sound in the clip'] } })
    expect((await cli(['post', 'Voice mode checked', '--verified', 'real iPhone, Safari PWA', '--action', 'Try it::open live mode'])).rc).toBe(0)
    expect(last().body).toEqual({ text: 'Voice mode checked', actions: [{ label: 'Try it', brief: 'open live mode' }], from: 'weevils', evidence: { verified: 'real iPhone, Safari PWA' } })
    // The words alone (« verified », « works ») send no evidence at all.
    expect((await cli(['post', 'verified on iPhone, works'])).rc).toBe(0)
    expect(last().body.evidence).toBeUndefined()
    const before = seen.length
    for (const args of [['show', 'a.png', '--verified'], ['show', 'a.png', '--limit', '  '], ['post', 'hi', '--demonstrated', '']]) {
      expect(await cli(args, { cwd: dir }), args.join(' ')).toEqual({ rc: 1, out: '', err: '--demonstrated, --verified and --limit take a text: where, which environment, what is missing\n' })
    }
    expect(seen.length).toBe(before)
  })

  it('show: one clean line when the file is missing; the reason of the server when it refuses', async () => {
    const before = seen.length
    for (const args of [['show'], ['show', ''], ['show', '  ']]) {
      expect(await cli(args), args.join(' ')).toEqual({ rc: 1, out: '', err: 'which file? weevils show <file> ["caption"]\n' })
    }
    expect((await cli(['show'], { lang: 'fr' })).err).toBe('quel fichier ? weevils show <fichier> ["légende"]\n')
    expect(seen.length).toBe(before)

    answer = { status: 400, body: { error: tr(M).badHeader('png') } }
    expect(await cli(['show', 'fake.png'])).toEqual({ rc: 1, out: '', err: tr(M).badHeader('png') + '\n' })
    expect(await cli(['post', 'hello'])).toEqual({ rc: 1, out: '', err: tr(M).badHeader('png') + '\n' })
    // No reason given, a body that is not JSON, no server at all: the code, still one line.
    answer = { status: 404, body: {} }
    expect(await cli(['show', 'a.png'])).toEqual({ rc: 1, out: '', err: 'error 404\n' })
    answer = { status: 500, body: '<html>boom</html>' }
    expect(await cli(['post', 'hello'])).toEqual({ rc: 1, out: '', err: 'error 500\n' })
    expect(await cli(['show', 'a.png'], { port: 1 })).toEqual({ rc: 1, out: '', err: 'error 000\n' })
  })
})
