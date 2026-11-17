// Bring your conversations (server/bring.ts, server/bring.sh): the list a computer sends, where a conversation lands
// here, its folders rewritten, and the real script run against a real HTTP server, from a fake home to this one.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Bring, arrive, claudeSlug, cloneable, describe as describeItem, parseIndex, place, repoName, rewritePaths, safeUrl, sameRepo, type PlaceDeps } from './bring.ts'

const CID = '0b6c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d'
const XID = '01a1c600-1edd-76d2-84d5-e64b834a44c6'
const OLD = '/Users/bob/code/app'
const iso = (ms: number) => new Date(ms).toISOString()
const jsonl = (lines: unknown[]) => lines.map((l) => JSON.stringify(l) + '\n').join('')
const T0 = Date.parse('2026-09-01T10:00:00Z')

const claudeLines = (id = CID, cwd = OLD, extra: unknown[] = []) => [
  { type: 'user', uuid: 'u1', sessionId: id, timestamp: iso(T0), cwd, gitBranch: 'main', message: { role: 'user', content: 'refactor the billing module' } },
  { type: 'assistant', uuid: 'a1', sessionId: id, timestamp: iso(T0 + 1000), cwd, message: { role: 'assistant', model: 'x', content: [{ type: 'text', text: `I read ${cwd}/src/billing.ts` }] } },
  ...extra,
]
const codexLines = (id = XID, cwd = OLD) => [
  { type: 'session_meta', timestamp: iso(T0), payload: { id, cwd, originator: 'codex-tui', base_instructions: { text: 'x'.repeat(30_000) } } },
  { type: 'turn_context', timestamp: iso(T0 + 10), payload: { cwd, model: 'gpt' } },
  { type: 'response_item', timestamp: iso(T0 + 20), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ship the landing page' }] } },
]

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-bring-'))
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

function deps(over: Partial<PlaceDeps> = {}): PlaceDeps {
  const d = {
    home: path.join(root, 'here'),
    projectsDir: path.join(root, 'here', 'projects'),
    roots: [path.join(root, 'here', 'projects')],
    claudeDir: path.join(root, 'here', '.claude', 'projects'),
    codexDir: path.join(root, 'here', '.codex', 'sessions'),
    git: async () => ({ ok: false, out: '' }),
    now: () => new Date('2026-11-17T12:00:00'),
    ...over,
  }
  fs.mkdirSync(d.home, { recursive: true })
  return d
}

/** Build the list exactly as server/bring.sh does. */
function indexOf(entries: { n: number; tool: string; file: string; text: string; mtime?: number }[]): Buffer {
  const parts: Buffer[] = []
  for (const e of entries) {
    const b = Buffer.from(e.text)
    const head = b.subarray(0, 49152)
    const tail = b.length > 65536 ? b.subarray(b.length - 16384) : Buffer.alloc(0)
    parts.push(Buffer.from(`WVB1\t${e.n}\t${e.tool}\t${b.length}\t${e.mtime ?? 1_700_000_000}\t${head.length}\t${tail.length}\t${e.file}\n`), head, tail)
  }
  return Buffer.concat(parts)
}

describe('the list a computer sends', () => {
  it('titles, ids and folders from heads and tails; Codex names from its index; scripts and empty threads left out', () => {
    const big = jsonl(claudeLines(CID, OLD, [...Array.from({ length: 400 }, (_, i) => ({ type: 'assistant', uuid: `p${i}`, sessionId: CID, timestamp: iso(T0 + 5000 + i), message: { role: 'assistant', content: [{ type: 'text', text: 'y'.repeat(300) }] } })), { type: 'custom-title', customTitle: 'Billing refactor', sessionId: CID }]))
    const headless = jsonl([{ ...(claudeLines('22222222-2222-4222-8222-222222222222')[0] as object), entrypoint: 'sdk-cli', sessionId: '22222222-2222-4222-8222-222222222222' }])
    const empty = jsonl([{ type: 'summary', summary: 'x', leafUuid: 'l' }])
    const idx = jsonl([{ id: XID, thread_name: 'Landing page', updated_at: iso(T0) }])
    const items = parseIndex(indexOf([
      { n: 1, tool: 'claude', file: `/Users/bob/.claude/projects/-Users-bob-code-app/${CID}.jsonl`, text: big, mtime: 1_800_000_000 },
      { n: 2, tool: 'codex', file: `/Users/bob/.codex/sessions/2026/09/01/rollout-2026-09-01T10-00-00-${XID}.jsonl`, text: jsonl(codexLines()) },
      { n: 3, tool: 'claude', file: '/Users/bob/.claude/projects/x/22222222-2222-4222-8222-222222222222.jsonl', text: headless },
      { n: 4, tool: 'claude', file: '/Users/bob/.claude/projects/x/33333333-3333-4333-8333-333333333333.jsonl', text: empty },
      { n: 0, tool: 'codex-index', file: '/Users/bob/.codex/session_index.jsonl', text: idx },
    ]))
    expect(items.map((i) => [i.n, i.key, i.title, i.project])).toEqual([
      [1, `claude:${CID}`, 'Billing refactor', 'app'],
      [2, `codex:${XID}`, 'Landing page', 'app'],
    ])
    expect(items[0].at).toBe(1_800_000_000_000)
  })

  it('a Codex file whose name and content disagree is not offered', () => {
    expect(describeItem('codex', `/x/rollout-2026-09-01T10-00-00-${CID}.jsonl`, jsonl(codexLines()), '', 10, 1)).toBeNull()
  })

  it('stops at anything that is not a header line', () => {
    expect(parseIndex(Buffer.from('garbage\nWVB1\t1\tclaude\n'))).toEqual([])
  })
})

describe('folders', () => {
  it('rewrites the old project folder, never a longer name that starts the same', () => {
    const s = `{"cwd":"${OLD}","x":"${OLD}/src/a.ts","y":"${OLD}2/b","z":"${OLD}"}`
    expect(rewritePaths(s, OLD, '/home/me/projects/app')).toBe('{"cwd":"/home/me/projects/app","x":"/home/me/projects/app/src/a.ts","y":"/Users/bob/code/app2/b","z":"/home/me/projects/app"}')
    expect(rewritePaths(s, OLD, OLD)).toBe(s)
  })

  it('knows one repository under its addresses, clones only remote ones, keeps credentials out of logs', () => {
    expect(sameRepo('git@github.com:Me/App.git', 'https://tok@github.com/me/app')).toBe(true)
    expect(sameRepo('ssh://git@github.com:22/me/app.git', 'https://github.com/me/app/')).toBe(true)
    expect(sameRepo('https://github.com/me/app', 'https://github.com/me/app2')).toBe(false)
    expect(cloneable('https://github.com/me/app')).toBe(true)
    expect(cloneable('git@github.com:me/app.git')).toBe(true)
    for (const bad of ['/srv/repo', '--upload-pack=x', 'ext::sh -c x', 'file:///etc', '', 'git@-oProxyCommand=x:a', 'ssh://-oProxyCommand=x/a']) expect(cloneable(bad)).toBe(false)
    expect(repoName('..')).toBe('project')
    expect(repoName('git@github.com:me/my-app.git')).toBe('my-app')
    expect(safeUrl('https://user:tok@github.com/me/app')).toBe('https://github.com/me/app')
    expect(claudeSlug('/home/me/projects/my_app.v2')).toBe('-home-me-projects-my-app-v2')
  })

  it('places a project: an existing clone, a fresh clone on its branch, an empty folder when cloning fails, home for home', async () => {
    const calls: string[][] = []
    const existing = path.join(root, 'here', 'projects', 'billing')
    fs.mkdirSync(path.join(existing, '.git'), { recursive: true })
    const git: PlaceDeps['git'] = async (args) => {
      calls.push(args)
      if (args[2] === 'remote') return args[1] === existing ? { ok: true, out: 'git@github.com:me/app.git' } : { ok: false, out: '' }
      if (args[0] === 'clone') {
        fs.mkdirSync(args[4], { recursive: true })
        return { ok: true, out: '' }
      }
      return { ok: true, out: '' }
    }
    const d = deps({ git })
    expect(await place({ cwd: `${OLD}/web`, origin: 'https://github.com/me/app', root: OLD }, d)).toEqual({ from: OLD, to: existing, cwd: path.join(existing, 'web') })
    const fresh = await place({ cwd: '/Users/bob/code/site', origin: 'https://github.com/me/site.git', root: '/Users/bob/code/site', branch: 'dev' }, d)
    expect(fresh.to).toBe(path.join(d.projectsDir, 'site'))
    expect(calls).toContainEqual(['clone', '--quiet', '--', 'https://github.com/me/site.git', fresh.to])
    expect(calls).toContainEqual(['-C', fresh.to, 'checkout', '--quiet', 'dev'])
    const failed = await place({ cwd: '/Users/bob/code/secret', origin: 'https://github.com/me/secret' }, deps({ git: async () => ({ ok: false, out: 'denied' }) }))
    expect(failed.note).toBe('clone')
    expect(fs.statSync(failed.cwd).isDirectory()).toBe(true)
    expect(await place({ cwd: '/Users/bob' }, d)).toEqual({ from: '/Users/bob', to: d.home, cwd: d.home })
    const plain = await place({ cwd: '/Users/bob/notes' }, d)
    expect(plain.cwd).toBe(path.join(d.projectsDir, 'notes'))
    // A folder written with « .. » stays inside the projects folder.
    const sneaky = await place({ cwd: '/Users/bob/code/app/../../../..', root: '/Users/bob/code/app' }, d)
    expect(sneaky.cwd.startsWith(d.projectsDir + path.sep)).toBe(true)
    // The same folder exists here: nothing moves.
    expect(await place({ cwd: existing }, d)).toEqual({ from: existing, to: existing, cwd: existing })
  })
})

describe('arriving here', () => {
  it('a Claude Code conversation lands in the folder named after its new working directory, paths rewritten', async () => {
    const d = deps()
    const f = path.join(root, 'in.jsonl')
    fs.writeFileSync(f, jsonl(claudeLines()))
    const r = await arrive({ tool: 'claude', id: CID, file: f }, d)
    const cwd = path.join(d.projectsDir, 'app')
    expect(r).toEqual({ state: 'here', sessionId: CID, cwd })
    const dest = path.join(d.claudeDir, claudeSlug(cwd), `${CID}.jsonl`)
    const text = fs.readFileSync(dest, 'utf8')
    expect(text).not.toContain(OLD)
    expect(text).toContain(`"cwd":"${cwd}"`)
    expect(text).toContain(`I read ${cwd}/src/billing.ts`)
    // Twice: nothing overwritten.
    expect((await arrive({ tool: 'claude', id: CID, file: f }, d)).already).toBe(true)
  })

  it('a Codex conversation lands in today’s folder under its own name; one already here is left alone', async () => {
    const d = deps()
    const f = path.join(root, 'in.jsonl')
    fs.writeFileSync(f, jsonl(codexLines()))
    const name = `rollout-2026-09-01T10-00-00-${XID}.jsonl`
    const r = await arrive({ tool: 'codex', id: XID, file: f, name }, d)
    expect(r.state).toBe('here')
    const dest = path.join(d.codexDir, '2026', '11', '17', name)
    expect(JSON.parse(fs.readFileSync(dest, 'utf8').split('\n')[0]).payload.cwd).toBe(path.join(d.projectsDir, 'app'))
    expect((await arrive({ tool: 'codex', id: XID, file: f, name }, d)).already).toBe(true)
  })

  it('refuses a file that is not the conversation it claims to be', async () => {
    const f = path.join(root, 'in.jsonl')
    fs.writeFileSync(f, jsonl(claudeLines('44444444-4444-4444-8444-444444444444')))
    expect(await arrive({ tool: 'claude', id: CID, file: f }, deps())).toEqual({ state: 'failed', note: 'content' })
    expect(await arrive({ tool: 'claude', id: '../../x', file: f }, deps())).toEqual({ state: 'failed', note: 'id' })
  })

})

// ---------------------------------------------------------------- the real script, end to end

const run = (cmd: string, args: string[], env: NodeJS.ProcessEnv, input?: string) =>
  new Promise<{ code: number; out: string }>((resolve) => {
    const p = execFile(cmd, args, { env, timeout: 60_000 }, (e, out, err) => resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out: String(out) + String(err) }))
    if (input !== undefined) p.stdin?.end(input)
  })

describe('server/bring.sh against a real server', () => {
  it('lists a computer’s conversations, sends only the tapped one, with its git address; it lands here and resumes', async () => {
    // The computer: a home with one Claude Code and one Codex conversation, the Claude one in a git repository.
    const pc = path.join(root, 'pc')
    const repo = path.join(pc, 'code', 'app')
    fs.mkdirSync(repo, { recursive: true })
    await run('git', ['init', '-q', repo], process.env)
    await run('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/me/app.git'], process.env)
    const cf = path.join(pc, '.claude', 'projects', claudeSlug(repo), `${CID}.jsonl`)
    fs.mkdirSync(path.dirname(cf), { recursive: true })
    fs.writeFileSync(cf, jsonl(claudeLines(CID, repo)))
    fs.mkdirSync(path.join(pc, '.claude', 'projects', claudeSlug(repo), CID, 'subagents'), { recursive: true })
    fs.writeFileSync(path.join(pc, '.claude', 'projects', claudeSlug(repo), CID, 'subagents', 'agent-1.jsonl'), jsonl(claudeLines(CID, repo)))
    const xf = path.join(pc, '.codex', 'sessions', '2026', '09', '01', `rollout-2026-09-01T10-00-00-${XID}.jsonl`)
    fs.mkdirSync(path.dirname(xf), { recursive: true })
    fs.writeFileSync(xf, jsonl(codexLines(XID, '/Users/bob/elsewhere')))

    // Here: a weevilsd's bring routes, with a git that "clones" by making the folder.
    const cloned: string[] = []
    const d = deps({
      git: async (args) => {
        if (args[0] === 'clone') {
          cloned.push(args[3])
          fs.mkdirSync(path.join(args[4], '.git'), { recursive: true })
          return { ok: true, out: '' }
        }
        return { ok: false, out: '' }
      },
    })
    let bumps = 0
    const bring = new Bring({ ...d, dataDir: path.join(root, 'data'), codexHome: path.dirname(d.codexDir), remotes: () => [], bump: () => bumps++ })
    const server = http.createServer(async (req, res) => {
      if (!(await bring.pcRoute(req, res, new URL(req.url ?? '/', 'http://x').pathname))) res.writeHead(404).end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    try {
      const script = await (await fetch(`http://127.0.0.1:${port}/api/bring.sh`)).text()
      expect(script).toContain(`base="http://127.0.0.1:${port}"`)
      const code = bring.link()
      const env = { PATH: process.env.PATH, HOME: pc, LANG: 'C.UTF-8' }
      const child = run('bash', ['-s', code], env, script)

      // The list arrives: two conversations (the subagent file is not one), from this computer.
      let view = await bring.view()
      for (let i = 0; i < 100 && !view.sources.length; i++) {
        await new Promise((r) => setTimeout(r, 100))
        view = await bring.view()
      }
      expect(view.sources).toHaveLength(1)
      const src = view.sources[0]
      expect(src.live).toBe(true)
      expect(src.items.map((i) => i.key).sort()).toEqual([`claude:${CID}`, `codex:${XID}`].sort())
      expect(fs.existsSync(d.claudeDir)).toBe(false) // nothing moved yet

      // One tap: only that one comes over.
      expect(bring.request(src.id, `claude:${CID}`)).toEqual({ ok: true })
      for (let i = 0; i < 100; i++) {
        view = await bring.view()
        if (view.sources[0].items.find((x) => x.key === `claude:${CID}`)?.state === 'here') break
        await new Promise((r) => setTimeout(r, 100))
      }
      const item = view.sources[0].items.find((x) => x.key === `claude:${CID}`)!
      expect(item.state).toBe('here')
      expect(item.sessionId).toBe(CID)
      expect(cloned).toEqual(['https://github.com/me/app.git'])
      const here = path.join(d.projectsDir, 'app')
      const dest = path.join(d.claudeDir, claudeSlug(here), `${CID}.jsonl`)
      expect(fs.readFileSync(dest, 'utf8')).toContain(`"cwd":"${here}"`)
      expect(fs.existsSync(d.codexDir)).toBe(false) // the other one stayed on the computer
      expect(bring.broughtAt(CID)).toBeGreaterThan(0)
      expect(bumps).toBeGreaterThan(0)

      // The link closes: the script says so and stops.
      for (const l of (bring as unknown as { links: Map<string, { createdAt: number; seen: number }> }).links.values()) l.createdAt = l.seen = 1
      await bring.view()
      const done = await child
      expect(done.out).toContain('now shows 2 conversations')
      expect(done.out).toContain('across.')
      expect(done.code).toBe(0)
    } finally {
      server.close()
    }
  }, 60_000)

  it('a wrong code opens nothing', async () => {
    const d = deps()
    const bring = new Bring({ ...d, dataDir: path.join(root, 'data'), codexHome: path.dirname(d.codexDir), remotes: () => [], bump: () => {} })
    const res = { status: 0, body: '', writeHead(s: number) { this.status = s; return this }, end(b?: string) { this.body = b ?? '' } }
    const req = { method: 'GET', headers: {} } as http.IncomingMessage
    expect(await bring.pcRoute({ ...req, method: 'POST' } as http.IncomingMessage, res as unknown as http.ServerResponse, '/api/bring/pc/AAAAAAAAAAAAAAAAAAAAAAAA/file/1')).toBe(true)
    expect(res.status).toBe(404)
    expect(await bring.pcRoute(req, res as unknown as http.ServerResponse, '/api/bring/pc/AAAAAAAAAAAAAAAAAAAAAAAA/next')).toBe(true)
    expect(res.body).toBe('bye\n')
    expect(await bring.pcRoute(req, res as unknown as http.ServerResponse, '/api/bring/pc/short/next')).toBe(false)
  })
})

describe('a machine already connected to this weevils', () => {
  it('its conversations just appear, no line to paste; a tap brings one with its git facts', async () => {
    const other = path.join(root, 'other')
    const repo = path.join(other, 'work', 'shop')
    fs.mkdirSync(repo, { recursive: true })
    await run('git', ['init', '-q', repo], process.env)
    await run('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:me/shop.git'], process.env)
    const od = { home: other, projectsDir: path.join(other, 'work'), roots: [path.join(other, 'work')], claudeDir: path.join(other, '.claude', 'projects'), codexDir: path.join(other, '.codex', 'sessions'), git: async () => ({ ok: false, out: '' }) }
    const cf = path.join(od.claudeDir, claudeSlug(repo), `${CID}.jsonl`)
    fs.mkdirSync(path.dirname(cf), { recursive: true })
    fs.writeFileSync(cf, jsonl(claudeLines(CID, repo)))
    const theirs = new Bring({ ...od, dataDir: path.join(other, 'data'), codexHome: path.join(other, '.codex'), remotes: () => [], bump: () => {} })
    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url ?? '/', 'http://x')
      if (u.pathname === '/api/bring/local') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(theirs.local()))
      if (u.pathname === '/api/bring/local/file') return void (await theirs.sendLocal(u.searchParams.get('key') ?? '', res))
      res.writeHead(404).end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    try {
      expect(JSON.stringify(theirs.local())).not.toContain(other) // never a path of that machine in the list
      const remote = { id: 'laptop', url, online: true, snap: { machines: [{ name: 'Bob’s laptop' }] }, call: async <T,>(_m: string, p: string) => (await (await fetch(url + p)).json()) as T }
      const cloned: string[] = []
      const d = deps({ git: async (args) => (args[0] === 'clone' ? (cloned.push(args[3]), fs.mkdirSync(args[4], { recursive: true }), { ok: true, out: '' }) : { ok: false, out: '' }) })
      const ours = new Bring({ ...d, dataDir: path.join(root, 'data'), codexHome: path.dirname(d.codexDir), remotes: () => [remote], bump: () => {} })
      let view = await ours.view()
      expect(view.sources.map((s) => [s.id, s.name, s.items.map((i) => i.title)])).toEqual([['remote:laptop', 'Bob’s laptop', ['refactor the billing module']]])
      expect(ours.request('remote:laptop', `claude:${CID}`)).toEqual({ ok: true })
      for (let i = 0; i < 100 && view.sources[0].items[0].state !== 'here'; i++) {
        await new Promise((r) => setTimeout(r, 50))
        view = await ours.view()
      }
      expect(view.sources[0].items[0]).toMatchObject({ state: 'here', sessionId: CID })
      expect(cloned).toEqual(['git@github.com:me/shop.git'])
      const here = path.join(d.projectsDir, 'shop')
      expect(fs.readFileSync(path.join(d.claudeDir, claudeSlug(here), `${CID}.jsonl`), 'utf8')).toContain(`"cwd":"${here}"`)
      // Asking for anything not in its list gets nothing.
      expect((await fetch(`${url}/api/bring/local/file?key=${encodeURIComponent('claude:../../etc/passwd')}`)).status).toBe(404)
    } finally {
      server.close()
    }
  })
})
