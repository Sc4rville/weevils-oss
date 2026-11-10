// The curator of the « for you » stream: its budget (only while the app looks, Claude logged in, no usage window nearly
// full, one call per pass, a daily cap, a back-off kept across restarts), what it accepts from the model (parse, caps,
// nothing said twice), the pace of each producer, the milestones and the day's bars counted without a model. No claude
// CLI: fast.ts is simulated; the store is the real one on a temporary file.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message, Optimizer, Session, Snapshot } from '../shared/api.ts'
import type { UsageInfo } from '../shared/infra.ts'
import { haiku, smart } from './fast.ts'
import {
  BACKOFF_MAX_MS, BACKOFF_MS, Curator, DAILY_CAP, DIGEST_EVERY_MS, IMPROVE_EVERY_MS, INSIGHT_EVERY_MS, INSIGHT_MAX, MAIL_BATCH, MAIL_EVERY_MS, STAT_EVERY_MS,
  dayKey, fit, isoWeek, manifestDeps, parseDigest, parseImprove, parseInsight, parseLines, repoFacts, usagePatterns, type CuratorDeps, type RepoFacts,
} from './foryou-curator.ts'
import { ForYou, WANTED_MS } from './foryou.ts'
import P from './i18n/foryou-curator.ts'

vi.mock('./fast.ts', async (orig) => ({ ...(await orig<typeof import('./fast.ts')>()), smart: vi.fn(), haiku: vi.fn() }))
vi.mock('./setup.ts', () => ({ claudeLogged: vi.fn(() => true) }))
vi.mock('./i18n.ts', async (orig) => {
  const real = await orig<typeof import('./i18n.ts')>()
  return { ...real, lang: () => 'en', tr: (m: Record<string, unknown>) => m.en, user: () => 'Sam' }
})

const model = vi.mocked(smart)
const cheap = vi.mocked(haiku)
const T0 = new Date(2026, 10, 10, 9, 0, 0).getTime()
const MIN = 60_000
const HOUR = 3600_000

const session = (over: Partial<Session> = {}): Session =>
  ({ id: 's1', projectId: 'mygame', repo: 'mygame', machineId: 'test', tool: 'claude', title: 'Jump physics', status: 'idle', cwd: '/home/u/projects/mygame', openedAt: T0 - HOUR, lastActivityAt: T0, origin: 'weevils', controllable: true, live: true, hasScreen: true, messageCount: 4, lastMessage: 'tail', ...over }) as Session
const says = (text: string): Message => ({ id: `m${Math.random()}`, role: 'assistant', text, at: T0 })
const usage = (percent: number, ok = true): UsageInfo => ({ claude: { ok, windows: [{ kind: 'session', percent: 12, resetsAt: null }, { kind: 'week', percent, resetsAt: null }], source: 't', at: T0 }, codex: { ok: false, windows: [], source: 't', at: T0 } })
const DIGEST = JSON.stringify({ text: 'Ok, Jump physics on mygame is back: the double jump is in. Nothing is waiting on you.', thought: 'Actually, when you think about it, the jump is the whole game.', actions: [{ label: 'Show me the jump', brief: 'ask the mygame session for a clip of the double jump and show it' }] })
const IMPROVE = JSON.stringify({ title: 'A morning recap', text: 'Most of your turns end in the morning. I can post the recap at noon.', action: { label: 'Set it up', brief: 'post a recap in the stream every day at noon, then confirm' } })
const INSIGHT = JSON.stringify({ about: 'vitest', text: 'Vitest runs only the tests touched by a change in watch mode. Ask your agents to keep it running while they work.' })

let dir: string
let now: number
let snap: Snapshot
let threads: Record<string, Message[]>
let known: UsageInfo | null
let logged: boolean
let facts: RepoFacts | null
let host: { snapshot: () => Snapshot; bump: () => void; detailAny: (id: string) => Promise<any>; send: any; sendMain: any; resume: any; close: any; orchestratorId: string | null }
let fy: ForYou
const flush = () => new Promise((r) => setTimeout(r, 0))

const makeStore = () => new ForYou(host, { file: path.join(dir, 'foryou.json'), now: () => now, dataDir: '/home/u/.local/share/weevils', machineId: 'test', later: () => undefined })
const makeCurator = (deps: CuratorDeps = {}) =>
  new Curator(fy, {
    file: path.join(dir, 'curator.json'),
    now: () => now,
    logged: () => logged,
    usage: () => known,
    memory: () => ({ digest: () => '- wants to ship mygame this year' }),
    repoDir: (repo) => path.join(dir, 'p', repo),
    facts: async () => facts ?? { deps: [], files: [], commits: [] },
    ...deps,
  })
/** A turn that ends: recorded by the store as core would tell it. */
const deliver = async (id: string, text: string, over: Partial<Session> = {}) => {
  const s = session({ id, lastActivityAt: now, ...over })
  snap.sessions = [...snap.sessions.filter((x) => x.id !== id), s]
  threads[id] = [says(text)]
  fy.sessionTurn(s, 'result')
  await flush()
}
const looked = () => void (fy.lastWanted = now)
const stored = () => (fs.existsSync(fy.file) ? JSON.parse(fs.readFileSync(fy.file, 'utf8')).items : []) as { id: string; kind: string; text: string; lang?: string; title?: string; gauges?: unknown[]; actions?: { brief: string }[]; sum?: { text?: string } }[]
const kinds = (kind: string) => stored().filter((i) => i.kind === kind)
const state = () => JSON.parse(fs.readFileSync(path.join(dir, 'curator.json'), 'utf8'))

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-'))
  now = T0
  threads = {}
  known = usage(40)
  logged = true
  facts = null
  snap = { machines: [{ id: 'test', name: 'vps', online: true }], projects: [{ id: 'mygame', name: 'mygame' }, { id: 'site', name: 'the site' }, { id: 'notes', name: 'notes' }], sessions: [], optimizers: [], config: { authors: [{ id: 'weevboss', name: 'weevboss', color: '' }, { id: 'gepetto', name: 'Gepetto', color: '#3fc1f0' }] } } as unknown as Snapshot
  host = {
    snapshot: () => snap,
    bump: vi.fn(() => {}),
    detailAny: async (id: string) => (threads[id] ? { session: session({ id }), messages: threads[id] } : undefined),
    send: vi.fn(async (id: string) => ({ id })),
    sendMain: vi.fn(async () => ({ id: 'boss' })),
    resume: vi.fn(async (id: string) => ({ id })),
    close: vi.fn(async () => ({ ok: true })),
    orchestratorId: 'boss',
  }
  fy = makeStore()
  model.mockReset()
  cheap.mockReset()
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------- what the model may say

describe('what the curator accepts from the model', () => {
  it('a digest: real words, a thought only when it adds something, two actions with a brief at most', () => {
    const d = parseDigest(JSON.parse(DIGEST))!
    expect(d.text).toMatch(/^Ok, Jump physics/)
    expect(d.thought).toMatch(/^Actually/)
    expect(d.actions).toEqual([{ label: 'Show me the jump', brief: expect.stringContaining('double jump') }])
    expect(parseDigest({ text: ' "All good 🎉  on   mygame, the menu is in and waits for you." ', actions: [{ label: 'A', brief: 'short' }, { label: 'Go on', brief: 'continue the menu on mygame' }, { label: 'Two', brief: 'a second real brief' }, { label: 'Three', brief: 'a third real brief' }] })).toEqual({
      text: 'All good on mygame, the menu is in and waits for you.',
      actions: [{ label: 'Go on', brief: 'continue the menu on mygame' }, { label: 'Two', brief: 'a second real brief' }],
    })
    // The thought that only says the recap again is dropped; the recap stays.
    expect(parseDigest({ text: 'The menu of mygame is in and waits for your look.', thought: 'The menu of mygame is in, waits for your look.' })).toEqual({ text: 'The menu of mygame is in and waits for your look.' })
    for (const bad of [null, 'text', [], {}, { text: '' }, { text: 'ok' }, { text: 42 }]) expect(parseDigest(bad)).toBeNull()
    expect(parseDigest({ text: 'Ok, jump physics on mygame is back, the double jump is in; nothing is waiting on you.' }, [d.text])).toBeNull()
    expect(parseDigest({ text: `${'A long sentence about the day. '.repeat(40)}` })!.text.length).toBeLessThanOrEqual(600)
  })

  it('an improvement needs words and one button with its brief; an idea already given is refused', () => {
    expect(parseImprove(JSON.parse(IMPROVE))).toEqual({ title: 'A morning recap', text: expect.stringContaining('morning'), action: { label: 'Set it up', brief: expect.stringContaining('noon') } })
    expect(parseImprove({ text: 'Most of your turns end in the morning, a recap at noon would help.' })).toBeNull()
    expect(parseImprove({})).toBeNull()
    expect(parseImprove(JSON.parse(IMPROVE), ['a morning recap'])).toBeNull()
    expect(parseImprove(JSON.parse(IMPROVE), ['Most of your turns end in the morning; I can post the recap at noon'])).toBeNull()
  })

  it('an insight holds in 220 characters of full sentences, or is refused', () => {
    expect(parseInsight(JSON.parse(INSIGHT))).toEqual({ about: 'vitest', text: expect.stringMatching(/^Vitest runs/) })
    const long = `${'Vitest shares its config with Vite. '.repeat(4)}${'x'.repeat(200)}`
    const cut = parseInsight({ text: long })!
    expect(cut.text.length).toBeLessThanOrEqual(INSIGHT_MAX)
    expect(cut.text.endsWith('.')).toBe(true)
    expect(parseInsight({ text: 'y'.repeat(400) })).toBeNull()
    expect(parseInsight({})).toBeNull()
    expect(parseInsight(JSON.parse(INSIGHT), ['Vitest runs only the tests touched by a change in watch mode, ask your agents to keep it running'])).toBeNull()
  })

  it('mail lines come back by number, one short line each', () => {
    const got = parseLines([{ n: 1, line: 'I finished the menu, the tests are left' }, { n: 2, line: 'ok' }, { n: 9, line: 'out of range, never kept' }, { n: 1, line: 'a second line for the same mail' }, 'junk'], 3)
    expect([...got]).toEqual([[1, 'I finished the menu, the tests are left']])
    expect(parseLines({ lines: [{ id: 2, line: 'the build is green again' }] }, 2).get(2)).toBe('the build is green again')
    expect(parseLines('nope', 2).size).toBe(0)
  })

  it('fit keeps whole sentences', () => {
    expect(fit('Short.', 20)).toBe('Short.')
    expect(fit('One sentence here. And a second one that is too long.', 30)).toBe('One sentence here.')
    expect(fit('abcdefghijklmnopqrstuvwxyz', 10)).toBe('abcdefghi…')
    expect(fit('abcdefghijklmnopqrstuvwxyz', 10, true)).toBe('')
  })

  it('every prompt exists in both languages with the same arguments', () => {
    expect(Object.keys(P.fr).sort()).toEqual(Object.keys(P.en).sort())
    for (const k of Object.keys(P.en) as (keyof typeof P.en)[]) {
      expect(typeof P.fr[k]).toBe(typeof P.en[k])
      if (typeof P.en[k] === 'function') expect((P.fr[k] as (...a: never[]) => string).length).toBe((P.en[k] as (...a: never[]) => string).length)
    }
    expect(P.fr.digest({ user: 'Sam', memory: '', done: '', waiting: '', counts: '', earlier: '' })).toContain('en français')
    expect(P.en.digest({ user: 'Sam', memory: '', done: '', waiting: '', counts: '', earlier: '' })).toContain('in English')
  })
})

// ---------------------------------------------------------------- what is read in a repo

describe('what is really in a repo', () => {
  it('reads names from the manifests, never versions or values', () => {
    expect(manifestDeps('package.json', JSON.stringify({ name: 'x', dependencies: { react: '^19', vite: '7' }, devDependencies: { vitest: '3' }, scripts: { build: 'secret --token abc' } }))).toEqual(['react', 'vite', 'vitest'])
    expect(manifestDeps('package.json', '{ broken')).toEqual([])
    expect(manifestDeps('pyproject.toml', '[project]\nname = "x"\ndependencies = [\n  "fastapi>=0.110",\n  \'httpx\',\n]\n[tool.poetry.dependencies]\npython = "^3.12"\npydantic = "^2"\n')).toEqual(['fastapi', 'httpx', 'pydantic'])
    expect(manifestDeps('requirements.txt', '# pinned\nrequests==2.32\nnumpy>=2\n-r other.txt\nuvicorn[standard]\n')).toEqual(['requests', 'numpy', 'uvicorn'])
    expect(manifestDeps('go.mod', 'module example.com/x\n\ngo 1.23\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.10.0\n\tgolang.org/x/sync v0.8.0 // indirect\n)\n')).toEqual(['github.com/gin-gonic/gin', 'golang.org/x/sync'])
    expect(manifestDeps('Cargo.toml', '[package]\nname = "x"\n\n[dependencies]\nserde = { version = "1", features = ["derive"] }\ntokio = "1"\n\n[dev-dependencies]\ninsta = "1"\n')).toEqual(['serde', 'tokio', 'insta'])
    expect(manifestDeps('README.md', 'react')).toEqual([])
  })

  it('a folder: manifest names, the root listing without dot files, the last commit subjects', async () => {
    const repo = path.join(dir, 'repo')
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true })
    fs.mkdirSync(path.join(repo, 'node_modules'))
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ dependencies: { react: '19' } }))
    fs.writeFileSync(path.join(repo, '.env'), 'TOKEN=never-read')
    fs.writeFileSync(path.join(repo, 'src', 'main.ts'), 'const secret = "never read"')
    const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { stdio: 'ignore' })
    git('init', '-q')
    git('add', 'package.json')
    git('commit', '-q', '-m', 'Add the jump physics')
    const f = await repoFacts(repo)
    expect(f).toEqual({ deps: ['react'], files: ['package.json', 'src/'], commits: ['Add the jump physics'] })
    expect(JSON.stringify(f)).not.toContain('never')
    expect(await repoFacts(path.join(dir, 'missing'))).toEqual({ deps: [], files: [], commits: [] })
  })

  it('weeks and days are the local ones', () => {
    expect(dayKey(new Date(2026, 10, 10, 23, 59).getTime())).toBe('2026-11-10')
    expect(isoWeek(new Date(2026, 10, 10, 9).getTime())).toBe('2026-W46')
    expect(isoWeek(new Date(2027, 0, 1, 9).getTime())).toBe('2026-W53')
    expect(isoWeek(new Date(2024, 11, 30, 9).getTime())).toBe('2025-W01')
  })
})

// ---------------------------------------------------------------- the budget

describe('the budget', () => {
  it('nothing is asked while the app is not looking at the stream, or half an hour after its last look', async () => {
    const c = makeCurator()
    await deliver('s1', 'The double jump is in.')
    await c.tick(now)
    expect(model).not.toHaveBeenCalled()
    looked()
    now += WANTED_MS + MIN
    await c.tick(now)
    expect(model).not.toHaveBeenCalled()
    looked()
    model.mockResolvedValue(DIGEST)
    await c.tick(now)
    expect(model).toHaveBeenCalledTimes(1)
  })

  it('nothing without Claude logged in, nor while a usage window of Claude is at 85 % or more, nor before the figures are known', async () => {
    const c = makeCurator()
    await deliver('s1', 'The double jump is in.')
    looked()
    model.mockResolvedValue(DIGEST)
    logged = false
    await c.tick(now)
    logged = true
    known = usage(85)
    // Past 85 %: no sonnet call, only haiku (lean) until LINES_CEIL.
    expect(c.can(now)).toBe(false)
    expect(c.mode(now)).toBe('lean')
    known = usage(98)
    expect(c.mode(now)).toBe(null)
    await c.tick(now)
    expect(model).not.toHaveBeenCalled()
    // Not known yet (a start) or a read that failed: no call made blind.
    known = usage(99, false)
    expect(c.can(now)).toBe(false)
    known = null
    await c.tick(now)
    expect(model).not.toHaveBeenCalled()
    known = usage(40)
    await c.tick(now)
    expect(model).toHaveBeenCalledTimes(1)
  })

  it('one model call per pass, the most useful first: the digest, the mail lines, an improvement, an insight', async () => {
    const c = makeCurator()
    facts = { deps: ['vitest'], files: ['package.json'], commits: ['Add the jump physics'] }
    for (const id of ['s1', 's2', 's3']) await deliver(id, `Turn of ${id} is done.`)
    fy.mail({ author: 'gepetto', subject: 'menu', text: 'Hello,\n\nThe menu is in.\nThe tests are left, I will do them tomorrow.', target: 'weevboss', mid: '<m1@x>', address: 'g@example.com' })
    looked()
    model.mockResolvedValueOnce(DIGEST).mockResolvedValueOnce(IMPROVE).mockResolvedValueOnce(INSIGHT)
    cheap.mockResolvedValue('[{"n": 1, "line": "the menu is in, the tests are for tomorrow"}]')
    const calls = () => model.mock.calls.length + cheap.mock.calls.length
    await c.tick(now)
    expect(calls()).toBe(1)
    expect(kinds('boss')).toHaveLength(1)
    await c.tick(now)
    expect(calls()).toBe(2)
    expect(cheap).toHaveBeenCalledTimes(1)
    await c.tick(now)
    expect(calls()).toBe(3)
    expect(kinds('improve')).toHaveLength(1)
    expect(model.mock.calls[1][0]).toContain('wants to ship mygame this year')
    await c.tick(now)
    expect(calls()).toBe(4)
    expect(kinds('insight')).toHaveLength(1)
    await c.tick(now)
    expect(calls()).toBe(4)
    expect(c.calls(now) + c.lineCalls(now)).toBe(4)
    // Every generated item says which language it was written in.
    for (const i of stored().filter((x) => ['boss', 'improve', 'insight', 'milestone', 'stat'].includes(x.kind))) expect(i.lang).toBe('en')
  })

  it('two passes at once share the one call that runs', async () => {
    const c = makeCurator()
    await deliver('s1', 'The double jump is in.')
    looked()
    let done!: (v: string) => void
    model.mockReturnValue(new Promise<string>((r) => (done = r)))
    const a = c.tick(now)
    const b = c.tick(now)
    done(DIGEST)
    await Promise.all([a, b])
    expect(model).toHaveBeenCalledTimes(1)
  })

  it('never more than 12 calls a day, counted across restarts; the next day starts again', async () => {
    fs.writeFileSync(path.join(dir, 'curator.json'), JSON.stringify({ calls: { day: dayKey(now), n: DAILY_CAP - 1 } }))
    let c = makeCurator()
    await deliver('s1', 'The double jump is in.')
    looked()
    model.mockResolvedValue(DIGEST)
    await c.tick(now)
    expect(model).toHaveBeenCalledTimes(1)
    expect(state().calls).toEqual({ day: dayKey(now), n: DAILY_CAP })
    c = makeCurator()
    now += DIGEST_EVERY_MS
    await deliver('s2', 'The menu is in.')
    looked()
    await c.tick(now)
    expect(model).toHaveBeenCalledTimes(1)
    expect(c.can(now)).toBe(false)
    now += 24 * HOUR
    await deliver('s3', 'The trailer is cut.')
    looked()
    await c.tick(now)
    expect(model).toHaveBeenCalledTimes(2)
    expect(c.calls(now)).toBe(1)
  })

  it('a failed call backs everything off an hour, doubling to twelve, kept across a restart; a success clears it', async () => {
    let c = makeCurator()
    await deliver('s1', 'The double jump is in.')
    looked()
    model.mockRejectedValue(new Error('usage limit'))
    await c.tick(now)
    expect(model).toHaveBeenCalledTimes(1)
    expect(state()).toMatchObject({ fails: 1, failUntil: T0 + BACKOFF_MS })
    c = makeCurator()
    now = T0 + BACKOFF_MS - MIN
    looked()
    await c.tick(now)
    expect(model).toHaveBeenCalledTimes(1)
    // An answer that is not JSON is a failure too.
    now = T0 + BACKOFF_MS
    looked()
    model.mockResolvedValue('I cannot do that.')
    await c.tick(now)
    expect(model).toHaveBeenCalledTimes(2)
    expect(state()).toMatchObject({ fails: 2, failUntil: now + 2 * BACKOFF_MS })
    fs.writeFileSync(path.join(dir, 'curator.json'), JSON.stringify({ ...state(), fails: 9, failUntil: now }))
    c = makeCurator()
    model.mockRejectedValue(new Error('down'))
    looked()
    await c.tick(now)
    expect(state().failUntil).toBe(now + BACKOFF_MAX_MS)
    now += BACKOFF_MAX_MS
    await deliver('s2', 'The menu is in.', { repo: undefined })
    looked()
    model.mockResolvedValue(DIGEST)
    await c.tick(now)
    expect(state()).toMatchObject({ fails: 0, failUntil: 0 })
    expect(kinds('boss')).toHaveLength(1)
  })

  it('writes its state for the user only, through a temporary file; a broken file starts blank', async () => {
    fs.writeFileSync(path.join(dir, 'curator.json'), '{ nope')
    const c = makeCurator()
    await deliver('s1', 'The double jump is in.')
    looked()
    model.mockResolvedValue(DIGEST)
    await c.tick(now)
    expect(fs.statSync(path.join(dir, 'curator.json')).mode & 0o777).toBe(0o600)
    expect(fs.existsSync(path.join(dir, 'curator.json.tmp'))).toBe(false)
    expect(state().digestAt).toBe(now)
  })
})

// ---------------------------------------------------------------- the digest

describe('the digest', () => {
  it('weevboss speaks: the recap then the thought as its own paragraph, buttons whose briefs stay on the server', async () => {
    const c = makeCurator({ advice: async () => [] })
    await deliver('s1', 'The double jump is in, with its tests.', { title: '[from:weevboss] Jump physics' })
    snap.sessions.push(session({ id: 'q1', title: 'Menu', status: 'needs_user', attention: 'Which font for the menu?', lastActivityAt: now }))
    looked()
    model.mockResolvedValue(DIGEST)
    await c.tick(now)
    const prompt = model.mock.calls[0][0]
    expect(prompt).toContain('The double jump is in, with its tests.')
    expect(prompt).not.toContain('Which font for the menu?')
    expect(prompt).toContain('1 turn delivered')
    expect(prompt).toContain('wants to ship mygame this year')
    expect(prompt).toContain('Sam')
    expect(prompt).not.toContain('[from:')
    const item = fy.feed(now).items.find((i) => i.kind === 'boss')!
    expect(item).toMatchObject({ who: 'weevboss', tone: 'neutral', reply: 'boss', open: { page: 'boss' }, actions: [{ id: 'a1', label: 'Show me the jump' }] })
    expect(item.text).toBe('Ok, Jump physics on mygame is back: the double jump is in. Nothing is waiting on you.\n\nActually, when you think about it, the jump is the whole game.')
    expect(JSON.stringify(item)).not.toContain('ask the mygame session')
    expect(kinds('boss')[0].actions?.[0].brief).toContain('ask the mygame session')
    // The button goes to weevboss with its brief, like one of its own posts.
    await fy.act(item.id, 'a1')
    expect(host.sendMain).toHaveBeenCalledWith(expect.stringContaining('Show me the jump'), expect.stringContaining('ask the mygame session'))
  })

  it('only includes an exact unanswered question from the current conversation', async () => {
    const c = makeCurator()
    await deliver('s1', 'The menu is ready.')
    snap.sessions.push(session({ id: 'q1', status: 'needs_user', attention: 'stale choice' }))
    threads.q1 = [says('Which colour do you prefer?')]
    looked()
    model.mockResolvedValue(DIGEST)
    await c.tick(now)
    expect(model.mock.calls[0][0]).toContain('Which colour do you prefer?')
    expect(model.mock.calls[0][0]).not.toContain('stale choice')
  })

  it('does not repeat a question already answered despite a stale waiting status', async () => {
    const c = makeCurator()
    await deliver('s1', 'The capture layout is already live.')
    snap.sessions.push(session({ id: 'q1', status: 'needs_user', attention: 'Which rendering should I start?' }))
    threads.q1 = [says('Which rendering should I start?'), { ...says('Start the approved production.'), role: 'user' }]
    looked()
    model.mockResolvedValue(DIGEST)
    await c.tick(now)
    expect(model.mock.calls[0][0]).not.toContain('Which rendering should I start?')
    expect(model.mock.calls[0][0]).toContain('The capture layout is already live.')
  })

  it('drops a recap when the source changes while it is being written', async () => {
    const c = makeCurator()
    await deliver('s1', 'The menu is ready.')
    looked()
    model.mockImplementation(async () => {
      snap.sessions = snap.sessions.map((s) => ({ ...s, status: 'working', lastActivityAt: now + 1000 }))
      return DIGEST
    })
    await c.tick(now)
    expect(kinds('boss')).toHaveLength(0)
  })

  it('at most one every three hours, and only when something happened since the last one', async () => {
    const c = makeCurator()
    looked()
    model.mockResolvedValue(DIGEST)
    // Nothing happened yet: nothing to say, no call.
    await c.tick(now)
    expect(model).not.toHaveBeenCalled()
    await deliver('s1', 'The double jump is in.')
    await c.tick(now)
    expect(model).toHaveBeenCalledTimes(1)
    now += DIGEST_EVERY_MS - MIN
    await deliver('s2', 'The menu is in.', { repo: undefined })
    looked()
    await c.tick(now)
    expect(model).toHaveBeenCalledTimes(1)
    now += 2 * MIN
    looked()
    model.mockResolvedValue(JSON.stringify({ text: 'The menu came back on mygame, with its three screens; the font is yours to pick.' }))
    await c.tick(now)
    expect(model).toHaveBeenCalledTimes(2)
    expect(model.mock.calls[1][0]).toContain('The menu is in.')
    // Only what is new since the last word, and that word is given so it is not said again.
    expect(model.mock.calls[1][0]).not.toContain('The double jump is in.')
    expect(model.mock.calls[1][0]).toContain('Ok, Jump physics on mygame is back')
    now += DIGEST_EVERY_MS
    looked()
    await c.tick(now)
    expect(model).toHaveBeenCalledTimes(2)
    expect(kinds('boss')).toHaveLength(2)
  })

  it('a recap that says the last one again is dropped, and the next waits its three hours', async () => {
    const c = makeCurator()
    await deliver('s1', 'The double jump is in.', { repo: undefined })
    looked()
    model.mockResolvedValue(DIGEST)
    await c.tick(now)
    now += DIGEST_EVERY_MS
    await deliver('s1', 'The double jump is in, again.', { repo: undefined })
    looked()
    await c.tick(now)
    expect(model).toHaveBeenCalledTimes(2)
    expect(kinds('boss')).toHaveLength(1)
    expect(state()).toMatchObject({ digestAt: now, fails: 0 })
    now += HOUR
    looked()
    await c.tick(now)
    expect(model).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------- mail lines

describe('mail lines', () => {
  it.each([0, 1])('rewrites session results in a batch with %i mails', async (count) => {
    fs.writeFileSync(path.join(dir, 'curator.json'), JSON.stringify({ digestAt: now, improveAt: now, insightAt: now }))
    await deliver('s1', 'I finished the double jump.\n\n' + 'I checked the landing behaviour in the game. '.repeat(8))
    if (count) fy.mail({ author: 'gepetto', subject: 'menu', text: 'Hello,\n\nThe menu is finished and ready for review.', target: 'weevboss', mid: '<mixed@x>', address: 'g@example.com' })
    cheap.mockResolvedValue(JSON.stringify(Array.from({ length: count + 1 }, (_, i) => ({ n: i + 1, line: i === count ? 'I tuned the double jump; try landing twice.' : 'The menu is ready for your look.' }))))
    looked()
    await makeCurator().tick(now)
    expect(fy.feed(now).items.find((i) => i.id === 's:s1')?.text).toBe('I tuned the double jump; try landing twice.')
    expect(cheap).toHaveBeenCalledTimes(1)
  })

  const mail = (n: number, text = `Hello,\n\nMail ${n} says the menu is in.\nAnd much more below, with details.`) => fy.mail({ author: 'gepetto', subject: `subject ${n}`, text, target: 'weevboss', mid: `<m${n}@x>`, address: 'g@example.com' })

  it('one haiku call for up to six mails still raw and unseen; the whole mail stays, the first line is the fallback', async () => {
    const c = makeCurator()
    for (let n = 1; n <= 8; n++) {
      now += 1000
      mail(n)
    }
    fy.mail({ author: 'gepetto', subject: 'short', text: 'Just one line here.', target: 'weevboss', mid: '<short@x>', address: 'g@example.com' })
    const seen = stored().find((i) => i.title === 'subject 8')!
    fy.seen([seen.id])
    model.mockResolvedValue(DIGEST)
    now += DIGEST_EVERY_MS
    looked()
    await c.tick(now) // the digest first (mails came in)
    cheap.mockResolvedValue(JSON.stringify([{ n: 1, line: 'the menu is in, details below' }, { n: 2, line: 'x' }]))
    await c.tick(now)
    expect(cheap).toHaveBeenCalledTimes(1)
    const prompt = cheap.mock.calls[0][0]
    expect((prompt.match(/^### \d/gm) ?? []).length).toBe(MAIL_BATCH)
    expect(prompt).toContain('From: Gepetto')
    expect(prompt).not.toContain('subject 8')
    expect(prompt).not.toContain('Just one line here.')
    expect(prompt).not.toContain('g@example.com')
    const items = fy.feed(now).items.filter((i) => i.kind === 'mail')
    const first = items.find((i) => i.title === 'subject 7')!
    expect(first).toMatchObject({ text: 'the menu is in, details below', body: expect.stringContaining('And much more below') })
    // A line refused (too short) or missing: the first line of the mail stays.
    expect(items.find((i) => i.title === 'subject 6')!.text).toBe('Mail 6 says the menu is in.')
    // The batch is never sent twice; the mail left out waits for the next batch, ten minutes later.
    await c.tick(now)
    expect(cheap).toHaveBeenCalledTimes(1)
    now += MAIL_EVERY_MS
    looked()
    cheap.mockResolvedValue('[{"n": 1, "line": "mail one says the menu is in"}]')
    await c.tick(now)
    expect(cheap).toHaveBeenCalledTimes(2)
    expect((cheap.mock.calls[1][0].match(/^### \d/gm) ?? []).length).toBe(1)
    expect(c.calls(now) + c.lineCalls(now)).toBe(3)
  })

  it('an answer that cannot be read: the mails keep their first line and are not sent again', async () => {
    const c = makeCurator()
    mail(1)
    now += DIGEST_EVERY_MS
    looked()
    model.mockResolvedValue(DIGEST)
    await c.tick(now)
    cheap.mockResolvedValue('sorry')
    await c.tick(now)
    expect(state().fails).toBe(1)
    expect(fy.rawMails()).toEqual([])
    expect(fy.feed(now).items.find((i) => i.kind === 'mail')!.text).toBe('Mail 1 says the menu is in.')
  })
})

// ---------------------------------------------------------------- improve

describe('improve', () => {
  it('counts the patterns first: sessions per project and time of day, cuts and why, long waits, auto tasks, unused bricks', async () => {
    for (const [id, project] of [['a', 'mygame'], ['b', 'mygame'], ['c', 'site']]) await deliver(id, `Turn ${id} done.`, { projectId: project })
    snap.sessions.push(session({ id: 'cut1', status: 'interrupted', interrupted: { reason: 'died', at: now } }), session({ id: 'w1', status: 'needs_user', attention: 'Which font?', lastActivityAt: now - 45 * MIN }), session({ id: 'w2', status: 'needs_user', lastActivityAt: now - 5 * MIN }))
    snap.optimizers = [{ id: 'o1', state: 'done' }, { id: 'o2', state: 'failed' }, { id: 'o3', state: 'proposed' }, { id: 'o4', state: 'proposed' }] as Optimizer[]
    snap.setup = { claude: true, voice: false, dictation: true, github: false, welcomed: true }
    const p = usagePatterns(fy.recent(['session'], 200), snap, now)
    expect(p).toMatchObject({ projects: [['mygame', 2], ['the site', 1]], cuts: 1, waited: 1, auto: { done: 1, failed: 1, unanswered: 2 }, unused: ['voice', 'github'], sessions: 3 })
    expect(p.hours.morning + p.hours.afternoon + p.hours.evening + p.hours.night).toBe(3)
    expect(p.cutWhy).toHaveLength(1)
  })

  it('one idea at most every twelve hours, in gradient, with its button; never the same idea twice; nothing to count, no call', async () => {
    fs.writeFileSync(path.join(dir, 'curator.json'), JSON.stringify({ digestAt: now }))
    const fresh = makeCurator({ advice: async () => ['No swap: add 4 GB.'] })
    looked()
    await fresh.tick(now)
    expect(model).not.toHaveBeenCalled()
    for (const id of ['a', 'b', 'c']) await deliver(id, `Turn ${id} done.`, { repo: undefined })
    snap.setup = { claude: true, voice: false, dictation: true, github: true, welcomed: true }
    model.mockResolvedValue(IMPROVE)
    await fresh.tick(now)
    expect(model).toHaveBeenCalledTimes(1)
    const prompt = model.mock.calls[0][0]
    expect(prompt).toContain('Sessions per project (last 14 days): mygame 3')
    expect(prompt).toContain('not set up yet: voice')
    expect(prompt).toContain('No swap: add 4 GB.')
    const item = fy.feed(now).items.find((i) => i.kind === 'improve')!
    expect(item).toMatchObject({ tone: 'magic', who: 'weevils', title: 'A morning recap', reply: 'boss', actions: [{ id: 'a1', label: 'Set it up' }] })
    now += IMPROVE_EVERY_MS - MIN
    looked()
    await fresh.tick(now)
    expect(model.mock.calls.filter(([p]) => p.includes('ONE concrete way'))).toHaveLength(1)
    now += 2 * MIN
    looked()
    await fresh.tick(now)
    await fresh.tick(now)
    const asks = model.mock.calls.filter(([p]) => p.includes('ONE concrete way'))
    expect(asks).toHaveLength(2)
    expect(asks[1][0]).toContain('- A morning recap')
    expect(kinds('improve')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------- insight

describe('insight', () => {
  const quiet = () => fs.writeFileSync(path.join(dir, 'curator.json'), JSON.stringify({ digestAt: now, improveAt: now }))

  it('one repo active today, read cheaply, once per repo and week; « more » asks a longer answer once', async () => {
    quiet()
    const c = makeCurator()
    fy.curator = c
    facts = { deps: ['vitest', 'react'], files: ['package.json', 'src/'], commits: ['Add the jump physics'] }
    await deliver('s1', 'The double jump is in.')
    looked()
    model.mockResolvedValue(INSIGHT)
    await c.tick(now)
    expect(model).toHaveBeenCalledTimes(1)
    const prompt = model.mock.calls[0][0]
    expect(prompt).toContain('"mygame"')
    expect(prompt).toContain('Declared dependencies: vitest, react')
    expect(prompt).toContain('- Add the jump physics')
    expect(prompt).toContain('What an agent just did there: Jump physics: The double jump is in.')
    const item = fy.feed(now).items.find((i) => i.kind === 'insight')!
    expect(item).toMatchObject({ id: `i:mygame:${dayKey(now)}`, projectId: 'mygame', more: true, who: 'weevils' })
    // Same repo, same day: never again, even two hours later.
    now += INSIGHT_EVERY_MS
    await deliver('s1', 'The double jump is tuned.')
    looked()
    fs.writeFileSync(path.join(dir, 'curator.json'), JSON.stringify({ ...state(), digestAt: now, improveAt: now }))
    const again = makeCurator()
    await again.tick(now)
    expect(model).toHaveBeenCalledTimes(1)
    // « More »: one call, kept by the store.
    model.mockResolvedValue('Vitest is the test runner of this repo. ' + 'It shares its config with Vite. '.repeat(40))
    const [a, b] = await Promise.all([c.more(item), c.more(item)])
    expect(a).toBe(b)
    expect(a.length).toBeLessThanOrEqual(900)
    expect(model).toHaveBeenCalledTimes(2)
    expect(model.mock.calls[1][0]).toContain(item.text)
    expect(await fy.more(item.id)).toBe(await fy.more(item.id))
    expect(model).toHaveBeenCalledTimes(3)
    expect(c.calls(now) + c.lineCalls(now)).toBe(3)
  })

  it('at most one every two hours; a repo with nothing to read costs no call; nothing sure to say is not an item', async () => {
    quiet()
    const c = makeCurator()
    await deliver('s1', 'The double jump is in.')
    looked()
    await c.tick(now)
    expect(model).not.toHaveBeenCalled()
    expect(c.calls(now)).toBe(0)
    facts = { deps: ['astro'], files: [], commits: [] }
    await deliver('s2', 'The page is up.', { projectId: 'site', repo: 'the-site' })
    model.mockResolvedValue('{}')
    await c.tick(now)
    expect(model).toHaveBeenCalledTimes(1)
    expect(kinds('insight')).toHaveLength(0)
    await deliver('s3', 'Notes sorted.', { projectId: 'notes', repo: 'notes' })
    now += INSIGHT_EVERY_MS - MIN
    snap.sessions.forEach((s) => (s.lastActivityAt = now))
    looked()
    fs.writeFileSync(path.join(dir, 'curator.json'), JSON.stringify({ ...state(), digestAt: now, improveAt: now }))
    const next = makeCurator()
    await next.tick(now)
    expect(model).toHaveBeenCalledTimes(1)
    now += 2 * MIN
    looked()
    model.mockResolvedValue(INSIGHT)
    await next.tick(now)
    expect(model).toHaveBeenCalledTimes(2)
    expect(kinds('insight')).toMatchObject([{ id: `i:notes:${dayKey(now)}` }])
  })

  it('« more » answers nothing when the day is spent, a window is nearly full or Claude is logged out', async () => {
    const c = makeCurator()
    const item = fy.add({ id: 'i:mygame:w', kind: 'insight', projectId: 'mygame', text: 'Vitest runs only the tests touched by a change.', more: true, lang: 'en' })!
    model.mockResolvedValue('A longer answer about Vitest.')
    known = usage(90)
    expect(await c.more(item)).toBe('')
    known = usage(10)
    logged = false
    expect(await c.more(item)).toBe('')
    logged = true
    fs.writeFileSync(path.join(dir, 'curator.json'), JSON.stringify({ calls: { day: dayKey(now), n: DAILY_CAP } }))
    expect(await makeCurator().more(item)).toBe('')
    expect(model).not.toHaveBeenCalled()
    model.mockRejectedValue(new Error('down'))
    expect(await c.more(item)).toBe('')
    expect(model).toHaveBeenCalledTimes(1)
    // A tap that fails does not hold the loop back.
    expect(state().failUntil ?? 0).toBe(0)
    expect(await c.more(fy.add({ kind: 'boss', text: 'not an insight' })!)).toBe('')
  })
})

// ---------------------------------------------------------------- milestones and the day's bars (no model)

describe('milestones', () => {
  it('turns crossing 10 and 25, three projects moving, the first auto task: each said once, app looking or not', async () => {
    const c = makeCurator()
    for (let n = 1; n <= 9; n++) await deliver(`s${n}`, `Turn ${n} done.`)
    await c.tick(now)
    expect(kinds('milestone')).toHaveLength(0)
    await deliver('s10', 'Turn 10 done.', { projectId: 'site' })
    await c.tick(now)
    await c.tick(now)
    expect(kinds('milestone').map((i) => i.text)).toEqual(["10 turns delivered today, we're on a roll!"])
    await deliver('s11', 'Turn 11 done.', { projectId: 'notes' })
    snap.optimizers = [{ id: 'o1', state: 'done', title: 't', endedAt: now }] as Optimizer[]
    await c.tick(now)
    expect(kinds('milestone').map((i) => i.text).sort()).toEqual(["10 turns delivered today, we're on a roll!", '3 projects moved today, good day.', 'First auto task wrapped up on its own while you were doing something else.'])
    for (let n = 12; n <= 26; n++) await deliver(`s${n}`, `Turn ${n} done.`)
    const again = makeCurator()
    await again.tick(now)
    await again.tick(now)
    expect(kinds('milestone')).toHaveLength(4)
    expect(fy.feed(now).items.find((i) => i.id === `ms:turns:${dayKey(now)}:25`)).toMatchObject({ kind: 'milestone', tone: 'magic', text: "25 turns delivered today, we're on a roll!" })
    expect(model).not.toHaveBeenCalled()
    expect(cheap).not.toHaveBeenCalled()
  })

  it('a first pass on a busy day says the highest step only; dismissed, a milestone never comes back', async () => {
    const c = makeCurator()
    for (let n = 1; n <= 26; n++) await deliver(`s${n}`, `Turn ${n} done.`)
    await c.tick(now)
    expect(kinds('milestone').map((i) => i.text)).toEqual(["25 turns delivered today, we're on a roll!"])
    fy.dismiss(`ms:turns:${dayKey(now)}:25`)
    await makeCurator().tick(now)
    expect(fy.feed(now).items.filter((i) => i.kind === 'milestone')).toEqual([])
  })

  it('a streak of days with delivered turns is said at 3, then 7, once each', async () => {
    const c = makeCurator()
    for (let d = 0; d < 7; d++) {
      await deliver(`d${d}`, `Day ${d} done.`)
      await c.tick(now)
      now += 24 * HOUR
    }
    expect(kinds('milestone').map((i) => i.text)).toEqual(['3 days in a row of shipping, keep it going.', '7 days in a row of shipping, keep it going.'])
    // A day without anything breaks it.
    now += 24 * HOUR
    for (let d = 0; d < 2; d++) {
      await deliver(`e${d}`, `Day ${d} done.`)
      await c.tick(now)
      now += 24 * HOUR
    }
    expect(kinds('milestone')).toHaveLength(2)
  })
})

describe('where the day stands', () => {
  it('one item a day while the app looks, replaced in place every four hours: usage windows, turns per project, the auto queue', async () => {
    const c = makeCurator()
    model.mockResolvedValue(DIGEST)
    for (const [id, project] of [['a', 'mygame'], ['b', 'mygame'], ['c', 'site']]) await deliver(id, `Turn ${id} done.`, { projectId: project, repo: undefined })
    snap.optimizers = [{ id: 'o1', state: 'running' }, { id: 'o2', state: 'queued' }, { id: 'o3', state: 'queued' }] as Optimizer[]
    known = usage(71)
    // Not looking: no bars.
    await c.tick(now)
    expect(kinds('stat')).toHaveLength(0)
    looked()
    await c.tick(now)
    const id = `stat:${dayKey(now)}`
    const item = fy.feed(now).items.find((i) => i.id === id)!
    expect(item).toMatchObject({ kind: 'stat', who: 'weevils', text: 'Your day so far: 3 turns delivered', open: { page: 'usage' } })
    expect(item.gauges).toEqual([
      { label: 'Claude · 5 h window', value: 12, max: 100, shown: '12%' },
      { label: 'Claude · week', value: 71, max: 100, shown: '71%' },
      { label: 'mygame', value: 2, max: 3, shown: '2 of 3', projectId: 'mygame' },
      { label: 'the site', value: 1, max: 3, shown: '1 of 3', projectId: 'site' },
      { label: 'Auto queue', value: 1, max: 3, shown: '1 running, 2 waiting' },
    ])
    fy.seen([id])
    known = usage(88)
    now += STAT_EVERY_MS - MIN
    looked()
    await c.tick(now)
    expect(fy.feed(now).items.find((i) => i.id === id)).toMatchObject({ seen: true, gauges: expect.arrayContaining([expect.objectContaining({ shown: '71%' })]) })
    now += 2 * MIN
    looked()
    await c.tick(now)
    expect(kinds('stat')).toHaveLength(1)
    const fresh = fy.feed(now).items.find((i) => i.id === id)!
    expect(fresh.seen).toBeUndefined()
    expect(fresh.at).toBe(now)
    expect(fresh.gauges?.[1]).toEqual({ label: 'Claude · week', value: 88, max: 100, shown: '88%', hot: true })
    // A window nearly full: the bars still come, the model is not asked.
    expect(model).toHaveBeenCalledTimes(1)
  })

  it('nothing to show, no item', async () => {
    const c = makeCurator()
    known = null
    looked()
    await c.tick(now)
    expect(kinds('stat')).toHaveLength(0)
  })
})


describe('relay and concurrent more requests', () => {
  it('uses Codex when Claude is full and persists the relay budget', async () => {
    known = usage(99)
    known.codex = { ok: true, windows: [{ kind: 'week', percent: 9, resetsAt: null }], source: 'test', at: now }
    const relay = vi.fn(async () => 'Here is a longer explanation about this repo and its tests.')
    const c = makeCurator({ relay })
    const item = fy.add({ kind: 'insight', projectId: 'mygame', text: 'Vitest checks the landing behaviour.', more: true })!
    expect(c.mode()).toBe('relay')
    await c.more(item)
    expect(relay).toHaveBeenCalledTimes(1)
    expect(model).not.toHaveBeenCalled()
    expect(state().relay.n).toBe(1)
    expect(makeCurator({ relay }).mode()).toBe('relay')
    expect(c.calls()).toBe(0)
  })

  it('rechecks the route after repo facts arrive, without spending an exhausted Claude budget', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const relay = vi.fn(async () => 'The answer uses the available Codex subscription instead.')
    const c = makeCurator({ relay, facts: async () => { await gate; return { deps: ['vitest'], files: [], commits: [] } } })
    const item = fy.add({ kind: 'insight', projectId: 'mygame', text: 'Vitest checks the landing behaviour.', more: true })!
    const pending = c.more(item)
    known = usage(99)
    known.codex = { ok: true, windows: [{ kind: 'week', percent: 9, resetsAt: null }], source: 'test', at: now }
    release()
    await pending
    expect(relay).toHaveBeenCalledTimes(1)
    expect(c.calls()).toBe(0)
    expect(state().relay.n).toBe(1)
  })

  it('never turns builds or Git history into feed cards, including after restart', async () => {
    const deployment = () => ({ commit: 'a'.repeat(40), at: now - MIN })
    await makeCurator({ deployment }).tick(now)
    await makeCurator({ deployment }).tick(now)
    const events = fy.feed().items.filter((i) => i.id.startsWith('deploy:'))
    expect(events).toHaveLength(0)
  })
})


describe('last available budget slot', () => {
  it('reserves only one slot when two different insights finish reading facts together', async () => {
    fs.writeFileSync(path.join(dir, 'curator.json'), JSON.stringify({ calls: { day: dayKey(now), n: DAILY_CAP - 1 }, lines: { day: dayKey(now), n: 16 } }))
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const c = makeCurator({ facts: async () => { await gate; return { deps: ['vitest'], files: [], commits: [] } } })
    const a = fy.add({ id: 'i:a', kind: 'insight', projectId: 'mygame', text: 'Vitest checks the game.', more: true })!
    const b = fy.add({ id: 'i:b', kind: 'insight', projectId: 'mygame', text: 'React renders the game.', more: true })!
    model.mockResolvedValue('Here is a longer answer about the tests and the game.')
    const first = c.more(a), second = c.more(b)
    release()
    const answers = await Promise.all([first, second])
    expect(answers.filter(Boolean)).toHaveLength(1)
    expect(model).toHaveBeenCalledTimes(1)
    expect(c.calls()).toBe(DAILY_CAP)
  })
})
