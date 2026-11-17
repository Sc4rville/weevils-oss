import { execFile } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { tr } from './i18n.ts'
import M from './i18n/memory.ts'
import { Memory, looksSecret, memoryRoutes, redact } from './memory.ts'

// What weevils remembers about the user (server/memory.ts): a temp file, never the real ~/.config/weevils/memory.json.
const fresh = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mem-')), 'sub', 'memory.json')

describe('Memory store', () => {
  it('adds, lists newest first, updates, removes, and persists in a 600 file', () => {
    const file = fresh()
    const m = new Memory(file)
    expect(m.count).toBe(0)
    const a = m.add('  wants   to ship a mobile game\nthis year ')
    expect(a.text).toBe('wants to ship a mobile game this year')
    expect(a.source).toBe('manual')
    const b = m.add('runs on coffee', { source: 'answer', q: 'what keeps you going?', a: 'coffee, mostly' })
    expect(b).toMatchObject({ source: 'answer', q: 'what keeps you going?', a: 'coffee, mostly' })
    b.updatedAt = a.updatedAt + 1
    expect(m.list().map((x) => x.id)).toEqual([b.id, a.id])
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)

    // A hand edit changes the words only: the item keeps where it came from (its weevil question and answer).
    const edited = m.update(b.id, 'runs on tea now')
    expect(edited).toMatchObject({ text: 'runs on tea now', source: 'answer', q: 'what keeps you going?', a: 'coffee, mostly' })
    const again = m.update(a.id, 'ships the game in June', { q: 'and the game?', a: 'June' })
    expect(again).toMatchObject({ source: 'manual', q: 'and the game?', a: 'June' })

    m.remove(a.id)
    m.remove('nope')
    const back = new Memory(file)
    expect(back.list().map((x) => x.text)).toEqual(['runs on tea now'])
  })

  it('refuses an empty text and an unknown id', () => {
    const m = new Memory(fresh())
    expect(() => m.add('   ')).toThrow()
    expect(() => m.update('nope', 'x')).toThrow()
    const a = m.add('x')
    expect(() => m.update(a.id, ' ')).toThrow()
  })

  it('never keeps a secret, whoever writes: refused with a short reason, masked in the kept question and answer', () => {
    const file = fresh()
    const m = new Memory(file)
    for (const s of ['my api key is sk-abcdefghijklmnop1234', 'password: hunter2', 'mail me at sam@example.com', 'call 06 12 34 56 78', 'token ghp_abcdefghijklmnopqrstuvwxyz']) {
      expect(() => m.add(s), s).toThrow(tr(M).secret)
    }
    const a = m.add('plays the piano')
    expect(() => m.update(a.id, 'plays the piano, code pin 1234')).toThrow(tr(M).secret)
    expect(m.get(a.id)?.text).toBe('plays the piano')
    const b = m.add('building a recipe app', { source: 'answer', q: 'what are you building?', a: 'a recipe app · my key is sk-abcdefghijklmnop1234' })
    expect(b.a).toBe('a recipe app · my key is •••')
    m.update(b.id, 'building a recipe app for friends', { q: 'and who for?', a: 'friends, write to sam@example.com' })
    expect(m.get(b.id)?.a).toBe('friends, write to •••')
    expect(m.count).toBe(2)
    expect(fs.readFileSync(file, 'utf8')).not.toMatch(/sk-abc|sam@example|hunter2/)
  })

  it('caps the text length and the number of items (the oldest go), in memory and on disk', () => {
    const file = fresh()
    const m = new Memory(file)
    expect(m.add('y'.repeat(2000)).text).toHaveLength(400)
    for (let i = 0; i < 305; i++) m.add(`item ${i}`)
    expect(m.count).toBe(300)
    expect(new Memory(file).count).toBe(300)
    expect(m.list().some((x) => x.text === 'item 0')).toBe(false)
    expect(m.list().some((x) => x.text === 'item 304')).toBe(true)
  })

  it('reads a broken or partial file as empty, skipping malformed items', () => {
    const file = fresh()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{not json')
    expect(new Memory(file).count).toBe(0)
    fs.writeFileSync(file, JSON.stringify({ items: [{ id: 'a', text: 'ok', source: 'manual', at: 1, updatedAt: 1 }, { nope: 1 }, null] }))
    const m = new Memory(file)
    expect(m.count).toBe(1)
    expect(m.asked()).toEqual([])
  })

  it('tells its listeners after every change', () => {
    const m = new Memory(fresh())
    const fn = vi.fn()
    const off = m.onChange(fn)
    const a = m.add('x')
    m.update(a.id, 'y')
    m.remove(a.id)
    expect(fn).toHaveBeenCalledTimes(3)
    off()
    m.add('z')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('asText, digest and signature for the prompts', () => {
    const m = new Memory(fresh())
    expect(m.asText()).toBe('')
    expect(m.digest()).toBe('')
    expect(m.signature()).toBe('')
    const a = m.add('likes climbing')
    const b = m.add('wants a quiet week')
    b.updatedAt = a.updatedAt + 1
    expect(m.asText()).toBe(`- [${b.id}] wants a quiet week\n- [${a.id}] likes climbing`)
    expect(m.asText(1)).toBe(`- [${b.id}] wants a quiet week`)
    expect(m.digest()).toBe('- wants a quiet week\n- likes climbing')
    expect(m.digest(12, 25)).toBe('- wants a quiet week')
    const sig = m.signature()
    expect(sig).toMatch(/^[0-9a-f]{16}$/)
    expect(m.signature()).toBe(sig)
    m.update(a.id, 'loves climbing')
    expect(m.signature()).not.toBe(sig)
  })
})

describe('weevils questions', () => {
  it('ask, markAsked (misses counted, answered sticks), askedText newest first', () => {
    const file = fresh()
    const m = new Memory(file)
    const q1 = m.ask('what would you like right now?')
    const q2 = m.ask('and in ten years?')
    expect(q1.state).toBe('pending')
    m.markAsked(q1.id, 'shown')
    m.markAsked(q1.id, 'shown')
    expect(m.question(q1.id)).toMatchObject({ state: 'shown', misses: 2 })
    m.markAsked(q2.id, 'answered')
    m.markAsked(q2.id, 'shown')
    expect(m.question(q2.id)?.state).toBe('answered')
    m.markAsked('nope', 'answered')
    expect(m.askedText()).toBe('- and in ten years?\n- what would you like right now? (no answer)')
    expect(new Memory(file).asked()).toHaveLength(2)
  })

  it('keeps at most 400 questions', () => {
    const m = new Memory(fresh())
    for (let i = 0; i < 405; i++) m.ask(`q${i}`)
    expect(m.asked()).toHaveLength(400)
    expect(m.asked()[0].text).toBe('q5')
  })
})

describe('memory routes', () => {
  const call = async (m: Memory, method: string, url: string, body: unknown = {}) => {
    const routes = memoryRoutes(m, (_res, status, out) => void (res = { status, out }), async () => body)
    let res: { status: number; out: any } = { status: 0, out: null }
    for (const [verb, re, h] of routes) {
      const hit = verb === method && re.exec(url)
      if (hit) {
        await h({} as never, {} as never, new URL(`http://x${url}`), hit.slice(1))
        return res
      }
    }
    throw new Error(`no route ${method} ${url}`)
  }
  it('a secret is refused with 400 and its reason, on add and on edit', async () => {
    const m = new Memory(fresh())
    expect(await call(m, 'POST', '/api/memory', { text: 'my api key is sk-abcdefghijklmnop1234' })).toEqual({ status: 400, out: { error: tr(M).secret } })
    const id = (await call(m, 'POST', '/api/memory', { text: 'plays the piano' })).out.item.id
    expect(await call(m, 'PUT', `/api/memory/${id}`, { text: 'mdp: azerty' })).toEqual({ status: 400, out: { error: tr(M).secret } })
    expect(await call(m, 'POST', '/api/memory', {})).toEqual({ status: 400, out: { error: tr(M).empty } })
    expect(m.list().map((x) => x.text)).toEqual(['plays the piano'])
  })

  it('list, add, edit, delete, with 400 on empty and 404 on unknown', async () => {
    const m = new Memory(fresh())
    expect((await call(m, 'POST', '/api/memory', { text: '  ' })).status).toBe(400)
    const added = await call(m, 'POST', '/api/memory', { text: 'plays the piano' })
    expect(added.status).toBe(200)
    const id = added.out.item.id
    expect((await call(m, 'GET', '/api/memory')).out.items).toHaveLength(1)
    expect((await call(m, 'PUT', `/api/memory/${id}`, { text: 'plays the cello' })).out.item.text).toBe('plays the cello')
    expect((await call(m, 'PUT', '/api/memory/nope', { text: 'x' })).status).toBe(404)
    expect((await call(m, 'PUT', `/api/memory/${id}`, { text: '' })).status).toBe(400)
    expect((await call(m, 'DELETE', `/api/memory/${id}`)).out).toEqual({ ok: true })
    expect(m.count).toBe(0)
  })
})

describe('secret filter', () => {
  it('spots keys, tokens, passwords, e-mails and phone numbers, and masks them', () => {
    for (const s of ['reach me at a.b@c.io', '+33 6 12 34 56 78', 'ghp_abcdefghijklmnopqrstuvwxyz', 'mot de passe : azerty', 'token 1234', 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4']) expect(looksSecret(s), s).toBe(true)
    for (const s of ['wants to launch a game in 2027', 'aime le jeu de go', 'runs a 10k every Sunday']) expect(looksSecret(s), s).toBe(false)
    expect(redact('my password is hunter2, mail a@b.co')).toBe('my password is •••, mail •••')
  })
})

describe('weevils memory (the CLI)', () => {
  // The real script against a throwaway server on a free port: a temp HOME, English, nothing else from this shell.
  const cli = (port: number, ...args: string[]) =>
    new Promise<{ rc: number; out: string; err: string }>((done) => {
      const env = { HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'cli-')), PATH: process.env.PATH ?? '', WEEVILS_LANG: 'en', WEEVILS_PORT: String(port) }
      execFile('bash', [path.join(import.meta.dirname, 'weevils-cli'), 'memory', ...args], { env }, (e, out, err) =>
        done({ rc: e ? Number((e as { code?: number }).code ?? 1) : 0, out: String(out), err: String(err) }),
      )
    })

  it('nothing to add or remove: one clean line, rc 1; a secret: the server reason, rc 1', async () => {
    const m = new Memory(fresh())
    const routes = memoryRoutes(
      m,
      (res, status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body)),
      (req) => new Promise((ok) => {
        let b = ''
        req.on('data', (c) => (b += c)).on('end', () => ok(JSON.parse(b || '{}')))
      }),
    )
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      for (const [verb, re, h] of routes) {
        const hit = verb === req.method && re.exec(url.pathname)
        if (hit) return void h(req, res, url, hit.slice(1))
      }
      res.writeHead(404).end('{}')
    })
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
    const port = (server.address() as { port: number }).port
    try {
      for (const args of [['add', ''], ['add'], ['add', '   ']]) {
        expect(await cli(port, ...args), args.join(' ')).toEqual({ rc: 1, out: '', err: 'empty memory: weevils memory add "memory"\n' })
      }
      expect(await cli(port, 'rm')).toEqual({ rc: 1, out: '', err: 'which memory? weevils memory rm <id>\n' })
      const secret = await cli(port, 'add', 'my api key is sk-abcdefghijklmnop1234')
      expect(secret).toMatchObject({ rc: 1, out: '' })
      expect(secret.err.trim()).toBe(tr(M).secret)
      const ok = await cli(port, 'add', 'plays the piano')
      expect(ok.rc).toBe(0)
      expect(m.list().map((x) => x.text)).toEqual(['plays the piano'])
    } finally {
      server.close()
    }
  })
})
