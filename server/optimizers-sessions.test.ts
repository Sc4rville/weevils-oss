// The « auto » tasks against the real Weevils session list (the unit tests in optimizers.test.ts mock the snapshot):
// a task's session must show up in its project, never hidden like weevboss's (everything under DATA_DIR is), so that
// the runner follows it, holds the one-at-a-time slot with it, and the pane is reaped like any other. tmux is simulated;
// git is real (the worktree is made by weevils before the session starts).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mux = vi.hoisted(() => ({
  sendText: vi.fn(async (_name: string, _text: string) => {}),
  sendKey: vi.fn(async (_name: string, _key: string) => {}),
  capture: vi.fn(async (_name: string) => ''),
  spawnWv: vi.fn(async (..._args: unknown[]) => {}),
  killWv: vi.fn(async (_name: string) => {}),
  listWv: vi.fn(async () => [] as unknown[]),
  setOpt: vi.fn(async (..._args: unknown[]) => {}),
}))
vi.mock('./mux.ts', async (orig) => ({ ...(await orig<typeof import('./mux.ts')>()), ...mux }))
vi.mock('./voicepipe.ts', () => ({ keepWarm() {}, warmCues() {} }))
vi.mock('./fast.ts', async (orig) => { const smart = vi.fn(); return { ...(await orig<typeof import('./fast.ts')>()), smart, claudeHaiku: (...a: any[]) => smart(...a), claudeAvailable: () => true, setCartesiaVoice() {} } })
vi.mock('./titles.ts', async (orig) => ({ ...(await orig<typeof import('./titles.ts')>()), llmTitles: async () => [] }))

const { Weevils } = await import('./core.ts')
const { DATA_DIR, HOME } = await import('./config.ts')
const { Memory } = await import('./memory.ts')
const { Optimizers, IDLE_MS } = await import('./optimizers.ts')
const { smart } = await import('./fast.ts')
type Transcript = import('./transcripts.ts').Transcript

const MIN = 60_000
const T0 = Date.parse('2026-11-10T03:00:00Z')
const projects = path.join(HOME, 'projects')
const repo = path.join(projects, 'mygame')
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' })
fs.mkdirSync(repo, { recursive: true })
git('init', '-q', '-b', 'main')
git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'first')

let w: InstanceType<typeof Weevils>
let tmp: string
const flush = async () => {
  // git worktree add runs for real: wait for the session to be spawned (or the launch to fail).
  for (let i = 0; i < 200 && !mux.spawnWv.mock.calls.length; i++) await new Promise((r) => setTimeout(r, 10))
  await new Promise((r) => setTimeout(r, 0))
}
const make = () => new Optimizers(w, new Memory(path.join(tmp, 'memory.json')), { file: path.join(tmp, 'optimizers.json'), sys: { load: () => 0.1, cpus: () => 4, free: () => 8 * 1024 ** 3, logged: () => true } })
async function accepted(task: Record<string, unknown>) {
  const o = make()
  vi.mocked(smart).mockResolvedValueOnce(JSON.stringify([{ why: 'w', kind: 'tests', heavy: false, priority: 1, est: 30, prompt: 'Do the thing, then stop and summarise.', ...task }]))
  await o.round(T0)
  o.accept(o.list()[0].id)
  return o
}
const transcript = (id: string, cwd: string, over: Partial<Transcript> = {}): Transcript => ({
  id,
  tool: 'claude',
  file: `/nowhere/${id}.jsonl`,
  cwd,
  openedAt: T0,
  lastActivityAt: Date.now(),
  workStartedAt: null,
  phase: 'idle',
  firstPrompt: 'brief',
  messages: [
    { id: `${id}-0`, role: 'user', text: 'brief', at: Date.now() },
    { id: `${id}-1`, role: 'assistant', text: 'Done: a report awaits review.', at: Date.now() },
  ],
  subagents: [],
  offset: 0,
  partial: '',
  queued: [],
  ...over,
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  for (const f of Object.values(mux)) f.mockReset()
  mux.listWv.mockResolvedValue([])
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-sessions-'))
  w = new Weevils()
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('auto — the task sessions are real sessions of their project', () => {
  it('a repo task runs in its own worktree (fresh branch), shows in the repo project, then ends done', async () => {
    const o = await accepted({ title: 'Harden mygame tests', repo: 'mygame' })
    const id = o.list()[0].id
    o.tick(T0 + IDLE_MS)
    await flush()
    expect(mux.spawnWv).toHaveBeenCalledTimes(1)
    const [, cwd, , , command, sessionId] = mux.spawnWv.mock.calls[0] as [string, string, string, string, string[], string]
    expect(cwd).toBe(path.join(projects, '.auto', 'mygame', id))
    expect(cwd.startsWith(DATA_DIR)).toBe(false)
    expect(command).toContain('--settings')
    // The worktree is there, on its branch; the user's checkout stays on main.
    expect(execFileSync('git', ['-C', cwd, 'branch', '--show-current']).toString().trim()).toMatch(/^auto\/harden-mygame-tests-\w{4}$/)
    expect(git('branch', '--show-current').toString().trim()).toBe('main')

    // Starting: the placeholder is in the repo's project, and the runner sees it.
    const seen = w.sessions(Date.now()).find((s) => s.id === sessionId)
    expect(seen).toMatchObject({ projectId: 'mygame', repo: 'mygame', status: 'working' })
    o.tick(T0 + IDLE_MS + MIN)
    expect(o.list()[0]).toMatchObject({ state: 'running', sessionId })

    // The transcript appears (its cwd is the worktree) and the turn ends.
    vi.setSystemTime(T0 + IDLE_MS + 10 * MIN)
    w.store.byFile.set('/nowhere/x.jsonl', transcript(sessionId, cwd))
    w.bump()
    expect(w.sessions(Date.now()).find((s) => s.id === sessionId)).toMatchObject({ projectId: 'mygame', repo: 'mygame' })
    o.tick(Date.now())
    expect(o.list()[0]).toMatchObject({ state: 'done', lastEvent: 'Done: a report awaits review.' })
  })

  it('a task without a repo is visible too (never under DATA_DIR) and holds the slot: the next one waits', async () => {
    const o = await accepted({ title: 'Watch indie game fairs', repo: null, kind: 'watch' })
    vi.mocked(smart).mockResolvedValueOnce(JSON.stringify([{ title: 'Draft the press kit', why: 'w', repo: null, kind: 'content', prompt: 'Draft a press kit, then stop and summarise.' }]))
    await o.round(T0)
    o.accept(o.list().find((x) => x.state === 'proposed')!.id)
    o.tick(T0 + IDLE_MS)
    await flush()
    const [, cwd, , , , sessionId] = mux.spawnWv.mock.calls[0] as [string, string, string, string, string[], string]
    expect(cwd.startsWith(DATA_DIR)).toBe(false)
    expect(path.relative(projects, cwd).split(path.sep).every((seg) => seg.startsWith('.'))).toBe(true)
    // Past the vanish delay, still followed: the session is in the list.
    for (const at of [T0 + IDLE_MS + 4 * MIN, T0 + IDLE_MS + 9 * MIN]) {
      vi.setSystemTime(at)
      w.bump()
      expect(w.sessions(at).some((s) => s.id === sessionId)).toBe(true)
      o.tick(at)
      await new Promise((r) => setTimeout(r, 0))
    }
    expect(o.list().map((x) => [x.title, x.state])).toEqual([
      ['Watch indie game fairs', 'running'],
      ['Draft the press kit', 'queued'],
    ])
    expect(mux.spawnWv).toHaveBeenCalledTimes(1)
  })

  // Claude at its usage limit (server/relay.ts): the running task is handed over like any session — back in the queue,
  // its worktree kept, until its Codex plan is approved (then Codex carries on in the same worktree, inside the jail,
  // with its own login visible) or Claude is back.
  it('a task cut by the Claude limit waits for its plan; approved, Codex takes it over in the same worktree, jailed', async () => {
    const held = new Set<string>()
    let until = T0 + 3 * 60 * MIN
    let auto = false
    w.relay = { holdUntil: () => until, autoOnCodex: () => auto, holds: (id: string) => held.has(id), relayOf: () => undefined, relayedBy: () => undefined, covers: () => false, view: () => undefined, bossOn: () => false, boss: undefined } as never
    until = 0
    const o = new Optimizers(w, new Memory(path.join(tmp, 'memory.json')), { file: path.join(tmp, 'optimizers.json'), sys: { load: () => 0.1, cpus: () => 4, free: () => 8 * 1024 ** 3, logged: () => true, jail: async () => true } })
    vi.mocked(smart).mockResolvedValueOnce(JSON.stringify([{ title: 'Harden cart tests', repo: 'mygame', why: 'w', kind: 'tests', heavy: false, priority: 1, est: 30, prompt: 'Do the thing, then stop and summarise.' }]))
    await o.round(T0)
    const first = o.list()[0]
    vi.mocked(smart).mockResolvedValueOnce(JSON.stringify([{ title: 'Draft the press kit', why: 'w', repo: null, kind: 'content', prompt: 'Draft a press kit, then stop and summarise.' }]))
    await o.round(T0)
    const second = o.list().find((x) => x.id !== first.id)!
    o.accept(first.id)
    o.tick(T0 + IDLE_MS)
    await flush()
    const [, cwd, , , , sessionId] = mux.spawnWv.mock.calls[0] as [string, string, string, string, string[], string]
    w.store.byFile.set('/nowhere/x.jsonl', transcript(sessionId, cwd, { phase: 'working', messages: [{ id: 'm', role: 'user', text: 'brief', at: Date.now() }] }))
    w.panes = [{ name: mux.spawnWv.mock.calls[0][0] as string, tool: 'claude', sessionId, title: 't', cwd, createdAt: T0 }]
    o.tick(T0 + IDLE_MS + MIN)
    expect(o.list()[0]).toMatchObject({ state: 'running' })
    expect(o.owns(sessionId)).toBe(true)

    // The limit: its turn is stopped by the error, the relay holds the session.
    until = T0 + 3 * 60 * MIN
    held.add(sessionId)
    vi.setSystemTime(T0 + IDLE_MS + 2 * MIN)
    Object.assign(w.store.get(sessionId)!, { phase: 'idle', stopError: { at: Date.now(), reason: 'quota', text: "You've hit your session limit · resets 6am" } })
    w.bump()
    o.tick(Date.now())
    expect(o.list().find((x) => x.id === first.id)).toMatchObject({ state: 'queued', waiting: 'later', retryAt: until })
    // Mode « ask »: nothing starts on Claude or on Codex while the limit lasts, not even another accepted task.
    o.accept(second.id)
    mux.spawnWv.mockClear()
    o.tick(Date.now() + 10 * MIN)
    await new Promise((r) => setTimeout(r, 20))
    expect(mux.spawnWv).not.toHaveBeenCalled()
    expect(o.list().find((x) => x.id === second.id)).toMatchObject({ state: 'queued', waiting: 'later', retryAt: until })

    // The plan is approved: Codex, same worktree, inside bwrap, its login kept visible, no Claude argument.
    const to = await o.relayRun(sessionId, '[from:weevboss] Tu prends le relais. Plan validé : finir les tests.')
    expect(mux.spawnWv).toHaveBeenCalledTimes(1)
    const [name, cwd2, tool, , command] = mux.spawnWv.mock.calls[0] as [string, string, string, string, string[]]
    expect([cwd2, tool, to]).toEqual([cwd, 'codex', name])
    expect(command[0]).toBe('bwrap')
    expect(command).toContain('codex')
    expect(command).not.toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(command).not.toContain('--settings')
    expect(command.join(' ')).not.toContain(`--tmpfs ${path.join(os.homedir(), '.codex')}`)
    expect(command.at(-1)).toMatch(/^\[from:weevboss\] Tu prends le relais\. Plan validé : finir les tests\.\n\n/)
    expect(command.at(-1)).toContain('Do the thing, then stop and summarise.')
    expect(command.at(-1)).toMatch(/never push|ne pousse jamais/)
    expect(o.list().find((x) => x.id === first.id)).toMatchObject({ state: 'running', sessionId: name })
    expect(o.owns(name)).toBe(true)

    // Claude is back: what waited for it is released at once.
    until = 0
    o.poke()
    expect(o.list().find((x) => x.id === second.id)?.retryAt).toBeUndefined()

    // Mode « auto »: a queued task starts on Codex during the limit — only where the jail holds.
    until = T0 + 6 * 60 * MIN
    auto = true
    const bare = new Optimizers(w, new Memory(path.join(tmp, 'memory2.json')), { file: path.join(tmp, 'optimizers2.json'), sys: { load: () => 0.1, cpus: () => 4, free: () => 8 * 1024 ** 3, logged: () => true, jail: async () => false } })
    vi.mocked(smart).mockResolvedValueOnce(JSON.stringify([{ title: 'Watch indie game fairs', why: 'w', repo: null, kind: 'watch', prompt: 'Watch the fairs, then stop and summarise.' }]))
    await bare.round(T0)
    bare.accept(bare.list()[0].id)
    mux.spawnWv.mockClear()
    w.panes = []
    for (const t of w.store.all()) t.lastActivityAt = T0
    bare.tick(Date.now() + 20 * MIN)
    await new Promise((r) => setTimeout(r, 20))
    bare.tick(Date.now() + 21 * MIN)
    await new Promise((r) => setTimeout(r, 20))
    expect(mux.spawnWv).not.toHaveBeenCalled()
    expect(bare.list()[0]).toMatchObject({ state: 'queued', waiting: 'later' })
  })
})
