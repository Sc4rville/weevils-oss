// What weevilsd does with a terminal screen, end to end, on recorded screens (test/fixtures/terminal/): it answers the
// safe dialogs itself, closes the menus nobody uses, turns the rest into one plain question with buttons, shows a calm
// status line for a usage limit, and never lets an unknown screen block a session silently. tmux is simulated.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tool } from '../shared/api.ts'

const mux = vi.hoisted(() => ({
  sendText: vi.fn(async (_name: string, _text: string, _submit?: 'Enter' | 'Tab') => {}),
  sendKey: vi.fn(async (_name: string, _key: string) => {}),
  capture: vi.fn(async (_name: string) => ''),
  spawnWv: vi.fn(async (..._args: unknown[]) => {}),
  killWv: vi.fn(async (_name: string) => {}),
  listWv: vi.fn(async () => [] as unknown[]),
  setOpt: vi.fn(async (..._args: unknown[]) => {}),
}))
vi.mock('./mux.ts', async (orig) => ({ ...(await orig<typeof import('./mux.ts')>()), ...mux }))
vi.mock('./voicepipe.ts', () => ({ keepWarm() {}, warmCues() {} }))
vi.mock('./fast.ts', () => ({ setCartesiaVoice() {} }))
vi.mock('./titles.ts', async (orig) => ({ ...(await orig<typeof import('./titles.ts')>()), llmTitles: async () => [] }))

const { Weevils } = await import('./core.ts')
const { DATA_DIR, HOME } = await import('./config.ts')
type Transcript = import('./transcripts.ts').Transcript

const NOW = Date.parse('2026-11-14T08:00:00Z')
const PANE = 'wv-demo-term01'
const cwd = path.join(HOME, 'projects', 'demo')
fs.mkdirSync(cwd, { recursive: true })
const FIX = path.join(import.meta.dirname, '..', 'test', 'fixtures', 'terminal')
const screen = (f: string) => fs.readFileSync(path.join(FIX, f), 'utf8')

let w: InstanceType<typeof Weevils>
let t: Transcript

function setup(tool: Tool = 'claude', createdAgo = 60_000) {
  fs.rmSync(path.join(DATA_DIR, 'state.json'), { force: true })
  w = new Weevils()
  t = {
    id: 's1', tool, file: '/nowhere/s1.jsonl', cwd, openedAt: NOW - 600_000, lastActivityAt: NOW - 300_000, workStartedAt: null,
    phase: 'idle', messages: [{ id: 'm0', role: 'user', text: 'earlier', at: NOW - 300_000 }], subagents: [], offset: 0, partial: '', queued: [],
  }
  w.store.byFile.set(t.file, t)
  const pane = { name: PANE, tool, sessionId: 's1', title: 't', cwd, createdAt: NOW - createdAgo }
  w.panes = [pane]
  mux.listWv.mockResolvedValue([pane])
}
const watch = () => (w as any).watchPanes() as Promise<void>
const keys = () => mux.sendKey.mock.calls.map((c) => c[1])
const session = () => w.sessions(Date.now()).find((s) => s.id === 's1')!

beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
  for (const f of Object.values(mux)) f.mockReset()
  mux.capture.mockResolvedValue('')
  setup()
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('answered by weevils', () => {
  it('folder trust: "Yes, I trust this folder" by its name (the cursor starts on "No, exit"), never a question', async () => {
    mux.capture.mockResolvedValue(screen('claude-live-C1-trust.txt'))
    await watch()
    await vi.advanceTimersByTimeAsync(1000)
    expect(keys()).toEqual(['down', 'enter'])
    expect(session().status).not.toBe('needs_user')
    // The same screen still there a poll later: no second answer in a row.
    await watch()
    await vi.advanceTimersByTimeAsync(1000)
    expect(keys()).toEqual(['down', 'enter'])
  })
  it('usage limit: waits for the reset (never credits or upgrade) and shows a calm status line', async () => {
    mux.capture.mockResolvedValue(screen('claude-live-R1-ratelimit.txt'))
    await watch()
    await vi.advanceTimersByTimeAsync(1000)
    expect(keys()).toEqual(['down', 'enter'])
    const s = session()
    expect(s.status).toBe('interrupted')
    expect(s.interrupted).toMatchObject({ reason: 'quota', detail: 'Paused until the usage limit resets (5am)' })
    expect(s.attention).toBeUndefined()
  })
  it('Codex update prompt: skipped, then the message goes', async () => {
    setup('codex')
    let shown = screen('codex-03-update-available-prompt-blocking-at-laun.txt')
    mux.capture.mockImplementation(async () => shown)
    mux.sendKey.mockImplementation(async (_p, k) => { if (k === 'enter') shown = '› Ask Codex to do anything\n\n  ← for agents · ? for shortcuts' })
    mux.sendText.mockImplementation(async (_p, text) => { shown = `› ${text}\n• Working (1s • esc to interrupt)\n\n› Ask Codex to do anything\n  ← for agents · ? for shortcuts`; t.messages.push({ id: 'm1', role: 'user', text, at: Date.now() }) })
    const sent = w.send('s1', 'hello there codex').catch((e: Error) => e)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await sent).toEqual({ id: 's1' })
    expect(keys().at(-1)).toBe('enter')
    expect(mux.sendText).toHaveBeenCalledTimes(1)
  })
})

describe('menus nobody uses', () => {
  it('a /model picker left open is closed with Escape once it has stayed a few seconds', async () => {
    mux.capture.mockResolvedValue(screen('claude-live-C5-model.txt'))
    await watch()
    expect(keys()).toEqual([])
    await vi.advanceTimersByTimeAsync(5000)
    await watch()
    expect(keys()).toEqual(['esc'])
    expect(session().status).not.toBe('needs_user')
  })
})

describe('plain questions', () => {
  it('a permission: what and why, plain buttons; a tap moves to the right option and confirms', async () => {
    mux.capture.mockResolvedValue(screen('claude-live-R4-dangerous-rm.txt'))
    await watch()
    const s = session()
    expect(s.status).toBe('needs_user')
    expect(s.attention).toBe('Claude wants to run a command: remove build output')
    expect(s.attentionDetail).toBe('rm -rf build dist · Dangerous rm operation on a path outside the project')
    expect(s.choices!.map((c) => c.label)).toEqual(['Allow', 'Deny'])
    await w.key('s1', `choice:${s.choices![1].id}`)
    expect(keys()).toEqual(['down', 'enter'])
  })
  it('a tap on an answer to a question that is gone is refused, never sent to another dialog', async () => {
    mux.capture.mockResolvedValue(screen('claude-live-R4-dangerous-rm.txt'))
    await watch()
    const id = session().choices![0].id
    mux.capture.mockResolvedValue(screen('claude-live-D3-bash.txt'))
    await expect(w.key('s1', `choice:${id}`)).rejects.toThrow(/already been answered/)
    expect(keys()).toEqual([])
  })
  it('a message sent while Claude asks a question with a free-text row is the answer', async () => {
    let shown = screen('claude-live-E1-ask.txt')
    mux.capture.mockImplementation(async () => shown)
    mux.sendText.mockImplementation(async () => { shown = '● Writing it there.\n\n────────────────\n❯ \n────────────────' })
    const sent = w.send('s1', 'In my Dropbox folder').catch((e: Error) => e)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await sent).toEqual({ id: 's1' })
    expect(keys()).toEqual(['down', 'down'])
    expect(mux.sendText.mock.calls.map((c) => c[1])).toEqual(['In my Dropbox folder'])
  })
  it('a pane waiting on a question is never closed by the idle cleanup', async () => {
    t.lastActivityAt = NOW - 5 * 3600_000
    mux.capture.mockResolvedValue(screen('claude-live-D3-bash.txt'))
    await watch()
    await (w as any).reapPanes()
    expect(mux.killWv).not.toHaveBeenCalled()
  })
})

describe('never a silent block', () => {
  const odd = 'Some brand new full-screen thing\n\n   [ press the magic key ]\n'
  it('an unknown screen that does not move becomes one plain question, and is kept for a later translation', async () => {
    mux.capture.mockResolvedValue(odd)
    await watch()
    expect(session().status).not.toBe('needs_user')
    vi.setSystemTime(NOW + 95_000)
    await watch()
    const s = session()
    expect(s.status).toBe('needs_user')
    expect(s.attention).toBe('Claude is waiting on a screen weevils doesn’t know')
    expect(s.choices!.map((c) => c.label)).toEqual(['Continue', 'Go back'])
    expect(fs.readdirSync(path.join(DATA_DIR, 'terminal-unknown')).length).toBeGreaterThan(0)
    await w.key('s1', `choice:${s.choices![0].id}`)
    expect(keys()).toEqual(['enter'])
  })
  it('an unknown menu is a question right away, with its own words', async () => {
    mux.capture.mockResolvedValue(['────────────────────────────────────────', '  Something brand new', '  ❯ 1. Do the new thing', '    2. Leave it', '  Enter to confirm · Esc to cancel'].join('\n'))
    await watch()
    expect(session()).toMatchObject({ status: 'needs_user', attention: 'Something brand new', choices: [{ label: 'Do the new thing' }, { label: 'Leave it' }] })
  })
  it('a hook says the session waits, the screen has no question and no input box: Continue / Go back right away', async () => {
    mux.capture.mockResolvedValue(odd)
    await watch()
    w.hook({ session_id: 's1', hook_event_name: 'Notification', message: 'Claude needs your attention' })
    const s = session()
    expect(s.status).toBe('needs_user')
    expect(s.choices!.map((c) => c.label)).toEqual(['Continue', 'Go back'])
    await w.key('s1', `choice:${s.choices![1].id}`)
    expect(keys()).toEqual(['esc'])
  })
  it('the fallback tap is refused once the screen has changed: never a blind key on another screen', async () => {
    mux.capture.mockResolvedValue(odd)
    await watch()
    w.hook({ session_id: 's1', hook_event_name: 'Notification', message: 'Claude needs your attention' })
    const s = session()
    mux.capture.mockResolvedValue(odd + '\n  something else now\n')
    await expect(w.key('s1', `choice:${s.choices![0].id}`)).rejects.toThrow()
    expect(keys()).toEqual([])
  })
  it('a hook says the session waits and the input box is on screen: no fallback buttons, the message field answers', async () => {
    mux.capture.mockResolvedValue(screen('claude-live-C3-idle.txt'))
    await watch()
    w.hook({ session_id: 's1', hook_event_name: 'Notification', message: 'Claude needs your attention' })
    const s = session()
    expect(s.status).toBe('needs_user')
    expect(s.choices).toBeUndefined()
  })
  it('signed out: a calm status line, not a question with login buttons', async () => {
    mux.capture.mockResolvedValue(screen('claude-live-R10-loginerr.txt'))
    await watch()
    expect(session()).toMatchObject({ status: 'interrupted', interrupted: { reason: 'auth', detail: 'Claude needs to be signed in again on this machine' } })
  })
})

describe('weevboss', () => {
  it('a question on weevboss’s own screen shows in its thread, and its answer reaches its pane', async () => {
    ;(w as any).orchestratorId = 's1'
    mux.capture.mockResolvedValue(screen('claude-live-D3-bash.txt'))
    await watch()
    const q = w.snapshot().mainQuestion!
    expect(q).toMatchObject({ id: PANE, attention: 'Claude wants to run a command: print hi', choices: [{ label: 'Allow' }, { label: 'Deny' }] })
    await w.key(q.id, `choice:${q.choices[0].id}`)
    expect(keys()).toEqual(['enter'])
  })
})

describe('self-healing (the 07:56 / 09:01 crash)', () => {
  it('sessions that vanish together are resumed, with one calm line instead of a cut-off alert each', async () => {
    const ids = ['h1', 'h2', 'h3']
    w = new Weevils()
    const panes = ids.map((id, i) => ({ name: `wv-demo-heal${i}`, tool: 'claude' as Tool, sessionId: id, title: id, cwd, createdAt: NOW - 3600_000 }))
    for (const [i, id] of ids.entries()) {
      const tr = {
        id, tool: 'claude' as Tool, file: `/nowhere/${id}.jsonl`, cwd, openedAt: NOW - 7200_000, lastActivityAt: NOW - 40 * 60_000, workStartedAt: NOW - 600_000,
        phase: (i < 2 ? 'working' : 'idle') as Transcript['phase'], messages: [{ id: 'm0', role: 'user' as const, text: 'go', at: NOW - 7200_000 }], subagents: [], offset: 0, partial: '', queued: [],
      }
      w.store.byFile.set(tr.file, tr)
      // At work: its process answers (a live pid), its last hook is a tool step.
      w.hooks.set(id, { event: i < 2 ? 'PostToolUse' : 'Stop', at: NOW - 1000, pid: process.pid } as any)
    }
    const resumed: string[] = []
    ;(w as any).resume = vi.fn(async (id: string) => { resumed.push(id); return { id } })
    const posts: string[] = []
    ;(w as any).foryou = { post: (text: string) => posts.push(text), sessionTurn: () => {}, resolveSession: () => {} }
    const pushes = vi.fn()
    ;(w as any).push = { enabled: true, send: pushes }
    // Alive with their panes…
    w.panes = panes
    mux.listWv.mockResolvedValue(panes)
    await (w as any).watchCuts()
    // …then the tmux server is closed: every pane is gone in the same pass, and the agents with it.
    mux.listWv.mockResolvedValue([])
    for (const [i, id] of ids.entries()) w.hooks.set(id, { event: i < 2 ? 'PostToolUse' : 'Stop', at: NOW - 1000, pid: 2 ** 22 + i } as any)
    await watch()
    await (w as any).watchCuts()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(resumed.sort()).toEqual(['h1', 'h2'])
    expect(posts).toEqual(['2 sessions stopped at the same moment: weevils restarted them and they pick up where they were.'])
    ;(w as any).announceCuts?.()
    expect(pushes).not.toHaveBeenCalled()
    expect(w.sessions(Date.now()).filter((s) => s.status === 'interrupted').map((s) => s.id)).toEqual([])
  })
  it('one session that stops alone keeps the ordinary cut-off handling', async () => {
    w = new Weevils()
    const tr = { ...t, id: 'solo', file: '/nowhere/solo.jsonl', phase: 'working' as Transcript['phase'], lastActivityAt: NOW - 40 * 60_000 }
    w.store.byFile.set(tr.file, tr)
    w.hooks.set('solo', { event: 'PostToolUse', at: NOW - 1000, pid: 2 ** 22 + 9 } as any)
    ;(w as any).resume = vi.fn()
    const pane = { name: 'wv-demo-solo', tool: 'claude' as Tool, sessionId: 'solo', title: 'solo', cwd, createdAt: NOW - 3600_000 }
    w.panes = [pane]
    await (w as any).watchCuts()
    mux.listWv.mockResolvedValue([])
    await watch()
    await (w as any).watchCuts()
    await vi.advanceTimersByTimeAsync(5000)
    expect((w as any).resume).not.toHaveBeenCalled()
    expect(w.sessions(Date.now()).find((s) => s.id === 'solo')?.status).toBe('interrupted')
  })
})
