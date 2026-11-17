import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pageLink, slugOf } from '../shared/pages.ts'
import { ARCH_AROUND, ARCH_FILES, ARCH_ROWS, changedPieces, listItems, MACHINE_SLUG, PageRefused, Pages, scanLibrary } from './pages.ts'
import A from './i18n/architecture.ts'

let tmp: string
let pages: Pages
const write = (rel: string, data: string | Buffer = 'x') => {
  const f = path.join(tmp, rel)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, data)
  return f
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-pages-'))
  pages = new Pages({ dataDir: path.join(tmp, 'data'), secret: 'secret', roots: [path.join(tmp, 'projects')] })
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

/** Serves one request through Pages.serve and returns status, headers and body. */
async function get(url: string, headers: Record<string, string> = {}) {
  const m = /^\/api\/page\/([\w-]{22})\/([a-z0-9-]+)(\/.*)?$/.exec(url)!
  const server = http.createServer((req, res) => pages.serve(req, res, m[1], m[2], m[3]))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as any).port
  try {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, { headers, redirect: 'manual' })
    return { status: res.status, headers: res.headers, body: await res.text() }
  } finally {
    server.close()
  }
}

describe('page addresses', () => {
  it('turns a title into a stable slug', () => {
    expect(slugOf('Deals this week — Été 2026!')).toBe('deals-this-week-ete-2026')
    expect(slugOf('***')).toBe('page')
  })
  it('recognises only this weevils’ page links', () => {
    expect(pageLink('https://w.example.com/p/library/content', ['w.example.com'])).toEqual({ kind: 'library', slug: 'content', path: '/p/library/content' })
    expect(pageLink('http://127.0.0.1:4179/p/report/x')?.kind).toBe('report')
    expect(pageLink('https://evil.example.com/p/library/content', ['w.example.com'])).toBeUndefined()
    expect(pageLink('https://w.example.com/p/unknown/content', ['w.example.com'])).toBeUndefined()
  })
})

describe('Pages', () => {
  it('publishes a folder, keeps its address on republish, and serves it with a per-page key only', async () => {
    write('projects/app/report/index.html', '<h1>hi</h1>')
    const a = pages.publish({ path: path.join(tmp, 'projects/app/report'), title: 'Weekly report', kind: 'report' })
    const b = pages.publish({ path: path.join(tmp, 'projects/app/report'), title: 'Weekly report', kind: 'report' })
    expect(a.path).toBe('/p/report/weekly-report')
    expect(b.slug).toBe(a.slug)
    expect(pages.list()).toHaveLength(1)
    const ok = await get(`/api/page/${pages.key(a.slug)}/${a.slug}/`)
    expect(ok.status).toBe(200)
    expect(ok.body).toContain('hi')
    expect(ok.headers.get('content-security-policy')).toMatch(/^sandbox /)
    expect(ok.headers.get('content-security-policy')).not.toContain('allow-same-origin')
    expect((await get(`/api/page/${'x'.repeat(22)}/${a.slug}/`)).status).toBe(404)
    write('projects/app/report/.env', 'SECRET')
    expect((await get(`/api/page/${pages.key(a.slug)}/${a.slug}/.env`)).status).toBe(404)
  })

  it('refuses a folder outside the projects, and an unknown kind', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-out-'))
    try {
      fs.writeFileSync(path.join(outside, 'index.html'), 'x')
      expect(() => pages.publish({ path: outside, title: 'x', kind: 'report' })).toThrow(PageRefused)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
    write('projects/a/index.html')
    expect(() => pages.publish({ path: path.join(tmp, 'projects/a'), title: 'x', kind: 'nope' })).toThrow(PageRefused)
  })

  it('answers a byte range (a phone plays a video only that way)', async () => {
    write('projects/v/index.html', 'x')
    write('projects/v/clip.mp4', Buffer.alloc(1000, 7))
    const p = pages.publish({ path: path.join(tmp, 'projects/v'), title: 'Clip', kind: 'render' })
    const r = await get(`/api/page/${pages.key(p.slug)}/${p.slug}/clip.mp4`, { range: 'bytes=0-99' })
    expect(r.status).toBe(206)
    expect(r.headers.get('content-range')).toBe('bytes 0-99/1000')
    expect(r.headers.get('content-type')).toBe('video/mp4')
  })

  it('builds an actionable list from hunter leads, dropping skipped ones, rebuilt when the leads change', async () => {
    const src = write('projects/.auto/x/leads.json', JSON.stringify({ leads: [
      { id: 'a', platform: 'reddit', author: 'u1', url: 'https://reddit.com/a', title: 'Claude Code from my phone?', summary: 'Wants to approve prompts away from desk', fit: 5, reply: 'Try weevils', status: 'open', postedAt: '2026-11-16' },
      { id: 'b', platform: 'hn', url: 'https://news.ycombinator.com/b', title: 'Old', fit: 2, status: 'skip' },
    ] }))
    const items = listItems(src)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ title: 'Claude Code from my phone?', source: 'reddit · u1', url: 'https://reddit.com/a', copy: 'Try weevils' })
    const p = pages.publishList({ source: src, title: 'Opportunities', kind: 'opportunities' })
    const html = (await get(`/api/page/${pages.key(p.slug)}/${p.slug}/`)).body
    expect(html).toContain('Claude Code from my phone?')
    expect(html).not.toContain('<script>alert')
    fs.writeFileSync(src, JSON.stringify([{ title: 'New </script><script>alert(1)</script>', url: 'https://x.example.com' }]))
    fs.utimesSync(src, new Date(), new Date(Date.now() + 5000))
    const again = (await get(`/api/page/${pages.key(p.slug)}/${p.slug}/`)).body
    expect(again).toContain('New \\u003c/script>')
    expect(again).not.toContain('</script><script>alert')
  })

  it('organises a media library by project and series, finished work only, and serves listed files only', async () => {
    write('projects/content/productions/recursivite/out/recursivite.mp4', Buffer.alloc(3_000_000))
    write('projects/content/productions/recursivite/out/recursivite.poster.jpg')
    write('projects/content/productions/recursivite/captures/raw.png')
    write('projects/content/productions/ads/out/hero/cover-og.png')
    write('projects/content/.work/frame.png')
    const groups = scanLibrary([path.join(tmp, 'projects/content')])
    const names = Object.fromEntries(groups.map((g) => [g.group, g.items.map((i) => `${i.type}:${i.name}${i.series ? `@${i.series}` : ''}`)]))
    expect(names).toEqual({ recursivite: ['video:recursivite'], ads: ['card:cover og@hero'] })
    expect(groups.find((g) => g.group === 'recursivite')!.items[0].poster).toBe('m/0/productions/recursivite/out/recursivite.poster.jpg')
    const p = pages.publishLibrary({ roots: [path.join(tmp, 'projects/content')], title: 'Content' })
    expect(p.path).toBe('/p/library/content')
    const key = pages.key(p.slug)
    expect((await get(`/api/page/${key}/${p.slug}/m/0/productions/recursivite/out/recursivite.mp4`, { range: 'bytes=0-9' })).status).toBe(206)
    expect((await get(`/api/page/${key}/${p.slug}/m/0/productions/recursivite/captures/raw.png`)).status).toBe(404)
    expect(pages.remove(p.slug)).toBe(true)
    expect(fs.existsSync(path.join(tmp, 'projects/content/productions'))).toBe(true)
    expect(pages.list()).toHaveLength(0)
  })
})

describe('how weevils works', () => {
  it('names every piece of its diagram in both languages, with its files', () => {
    const ids = [...ARCH_ROWS.flat(), ...ARCH_AROUND]
    expect(new Set(ids).size).toBe(ids.length)
    for (const l of ['fr', 'en'] as const) for (const id of ids) expect(typeof (A[l] as Record<string, unknown>)[`${id}Body`], id).toBe('string')
    expect(Object.keys(ARCH_FILES).sort()).toEqual([...ids].sort())
    for (const files of Object.values(ARCH_FILES)) for (const f of files) expect(fs.existsSync(path.resolve(import.meta.dirname, '..', f)), f).toBe(true)
  })

  it('marks a piece changed by the newest commit that touched one of its files', () => {
    const c = changedPieces([
      { at: 2000, files: ['server/relay.ts'] },
      { at: 1000, files: ['server/relay.ts', 'src/ui/feed.tsx', 'README.md'] },
    ])
    expect(c).toEqual({ relay: 2000, phone: 1000 })
  })

  it('is one page per install, replaces the old live dashboard, and says only what changed', async () => {
    fs.mkdirSync(path.join(pages.dir, 'weevils-machine'), { recursive: true })
    fs.writeFileSync(path.join(pages.dir, 'weevils-machine', 'index.html'), 'old')
    fs.writeFileSync(path.join(pages.dir, 'index.json'), JSON.stringify([{ slug: 'weevils-machine', kind: 'report', title: 'The weevils machine', path: '/p/report/weevils-machine', root: path.join(pages.dir, 'weevils-machine'), entry: 'index.html', build: { type: 'machine' }, createdAt: 1, updatedAt: 1 }]))
    const a = pages.publishMachine()
    expect(pages.publishMachine().slug).toBe(a.slug)
    expect(a.slug).toBe(MACHINE_SLUG)
    expect(pages.list().map((p) => p.slug)).toEqual([MACHINE_SLUG])
    expect(fs.existsSync(path.join(pages.dir, 'weevils-machine'))).toBe(false)
    const k = pages.key(a.slug)
    expect(JSON.parse((await get(`/api/page/${k}/${a.slug}/state.json`)).body)).toEqual({ changed: {} })
    pages.live = { state: async () => ({ changed: { relay: 5 } }) }
    const s = await get(`/api/page/${k}/${a.slug}/state.json`)
    expect(s.headers.get('access-control-allow-origin')).toBe('*')
    expect(JSON.parse(s.body)).toEqual({ changed: { relay: 5 } })
    expect((await get(`/api/page/${'x'.repeat(22)}/${a.slug}/state.json`)).status).toBe(404)
    const html = (await get(`/api/page/${k}/${a.slug}/`)).body
    expect(html).toContain('server/boss-turns.ts')
    expect(html).not.toMatch(/loadavg|Claude week/)
  })
})
