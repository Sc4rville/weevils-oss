import { describe, expect, it, vi } from 'vitest'
import type { Session, Snapshot } from '../shared/api.ts'
import type { LoadSample, MachineLoad } from '../shared/tips.ts'
import { actOn, IDLE_SESSION_MS, MIN_SAMPLES, personalTips, saturation, toCard, WAITING_MS, type TipInput } from './tips.ts'
import { setLang } from './i18n.ts'

// The real setLang writes prefs.json in the user's data dir: the language is switched in memory only.
vi.mock('./i18n.ts', async (orig) => {
  const real = await orig<typeof import('./i18n.ts')>()
  let lang: 'en' | 'fr' = 'en'
  return { ...real, setLang: (l: 'en' | 'fr') => void (lang = l), tr: (m: Record<string, unknown>) => m[lang] }
})

const NOW = new Date(2026, 10, 9, 15, 0).getTime()
const H = 3600_000

const session = (over: Partial<Session> = {}): Session => ({
  id: 's1',
  projectId: 'arcade',
  repo: 'arcade',
  machineId: 'vps',
  tool: 'claude',
  title: 'fix the jump',
  status: 'working',
  cwd: '/home/u/projects/arcade',
  openedAt: NOW - 2 * H,
  lastActivityAt: NOW - 60_000,
  workStartedAt: null,
  origin: 'weevils',
  controllable: true,
  live: true,
  hasScreen: true,
  subagents: [],
  messageCount: 3,
  queued: 0,
  ...over,
})

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  version: 1,
  now: NOW,
  machines: [
    { id: 'vps', name: 'vps', online: true },
    { id: 'pc', name: 'pc', online: true },
  ],
  projects: [],
  sessions: [session()],
  h24: [],
  conversations: [],
  conversationCounts: { total: 0, pending: 0, byProject: {} },
  classifier: { running: false, queued: 0 },
  main: [],
  mainWorking: false,
  mainHasScreen: false,
  mainQueued: 0,
  devil: { enabled: false, working: false },
  pinnedRepos: [],
  config: { userName: '', exposeDomain: '', publicHost: '' },
  ...over,
})

// Automatic pane cleanup turned off by default here (WEEVILS_KILL_AFTER_MIN raised), so the idle rule can speak.
const input = (over: Partial<TipInput> = {}): TipInput => ({ snap: snap(), now: NOW, loads: [], dictation: true, reapMs: Infinity, ...over })
const rules = (i: TipInput) => personalTips(i).map((c) => c.rule)

const load = (n: number, hot: (k: number) => boolean, cores = 4): MachineLoad => ({
  machineId: 'vps',
  name: 'vps',
  cores,
  samples: Array.from({ length: n }, (_, k): LoadSample => [NOW - k * 60_000, hot(k) ? cores * 2 : 0.3, 0.5]),
})

describe('tips — rules', () => {
  setLang('en')

  it('a quiet, well set-up state yields no card', () => {
    expect(personalTips(input())).toEqual([])
  })

  it('saturated machine: over 20 % of hot samples, with at least 12 h of data', () => {
    expect(rules(input({ loads: [load(24 * 60, (k) => k % 3 === 0)] }))).toEqual(['saturated'])
    expect(rules(input({ loads: [load(24 * 60, (k) => k % 10 === 0)] }))).toEqual([])
    // A fresh install with an hour of samples: no verdict, even fully hot.
    expect(rules(input({ loads: [load(60, () => true)] }))).toEqual([])
    expect(rules(input({ loads: [load(MIN_SAMPLES - 1, () => true)] }))).toEqual([])
    // One 2 h build in the last 12 h: under the share.
    expect(rules(input({ loads: [load(12 * 60, (k) => k < 120)] }))).toEqual([])
    // Low memory counts too; the message gives the real window, not a made-up 24 h.
    const mem: MachineLoad = { machineId: 'pc', name: 'pc', cores: 8, samples: Array.from({ length: 13 * 60 }, (_, k): LoadSample => [NOW - k * 60_000, 0.1, 0.05]) }
    const [card] = personalTips(input({ loads: [mem] }))
    expect(card.id).toBe('saturated:pc')
    expect(card.action).toEqual({ kind: 'boss', text: expect.stringContaining('100% of the time over the last 13 h') })
    expect(card.text).toContain('pc')
    // Same machine a week later: the same card, never shown twice.
    expect(personalTips(input({ loads: [mem], now: NOW + 7 * 24 * H }))).toEqual([])
    const later = { ...mem, samples: mem.samples.map(([at, l, f]) => [at + 7 * 24 * H, l, f] as LoadSample) }
    expect(personalTips(input({ loads: [later], now: NOW + 7 * 24 * H }))[0].id).toBe(card.id)
  })

  it('saturation ignores samples older than 24 h', () => {
    const old: MachineLoad = { ...load(MIN_SAMPLES, () => true), samples: load(MIN_SAMPLES, () => true).samples.map(([at, l, f]) => [at - 25 * H, l, f] as LoadSample) }
    expect(saturation(old, NOW)).toBeNull()
  })

  it('idle sessions: live weevils panes idle for more than 12 h, id built from their ids', () => {
    const idle = [
      session({ id: 'a', status: 'done', lastActivityAt: NOW - 20 * H }),
      session({ id: 'b', status: 'idle', lastActivityAt: NOW - IDLE_SESSION_MS - 60_000 }),
      session({ id: 'c', status: 'done', live: false, lastActivityAt: NOW - 30 * H }), // already closed
      session({ id: 'd', status: 'idle', hasScreen: false, lastActivityAt: NOW - 30 * H }), // not a weevils pane
      session({ id: 'e', status: 'needs_user', lastActivityAt: NOW - 20 * H }), // waiting, other rule
    ]
    const cards = personalTips(input({ snap: snap({ sessions: idle }) }))
    const card = cards.find((c) => c.rule === 'idle-sessions')!
    expect(card.data).toEqual(['a', 'b'])
    expect(card.text).toBe('2 sessions idle for over 12 h — close them?')
    expect(card.action).toEqual({ kind: 'server' })
    expect(toCard(card)).not.toHaveProperty('data')
    // Same situation → same id; another set of sessions → another card.
    expect(personalTips(input({ snap: snap({ sessions: idle }) })).find((c) => c.rule === 'idle-sessions')!.id).toBe(card.id)
    expect(personalTips(input({ snap: snap({ sessions: idle.slice(0, 1) }) })).find((c) => c.rule === 'idle-sessions')!.id).not.toBe(card.id)
  })

  it('no idle-sessions card while weevilsd closes idle panes on its own sooner (default 2 h)', () => {
    const sessions = [session({ id: 'a', status: 'done', lastActivityAt: NOW - 20 * H })]
    expect(rules(input({ snap: snap({ sessions }), reapMs: 2 * H }))).toEqual([])
  })

  it('idle terminal sessions (out of the cleanup and of weevils reach): handed to weevboss, even with the 2 h cleanup', () => {
    const term = (over: Partial<Session>) => session({ origin: 'terminal', controllable: false, hasScreen: false, status: 'idle', ...over })
    const sessions = [
      term({ id: 't1', title: 'refactor the parser', machineId: 'pc', cwd: '/home/u/projects/parser', lastActivityAt: NOW - 20 * H }),
      term({ id: 't2', lastActivityAt: NOW - IDLE_SESSION_MS - 60_000 }),
      term({ id: 't3', lastActivityAt: NOW - 2 * H }), // quiet, not for long
      term({ id: 't4', live: false, status: 'done', lastActivityAt: NOW - 30 * H }), // its process is gone
      term({ id: 't5', status: 'needs_user', lastActivityAt: NOW - 20 * H }), // waiting, other rule
      session({ id: 'w1', status: 'done', lastActivityAt: NOW - 20 * H }), // a weevils pane: the cleanup's job
    ]
    const i = input({ snap: snap({ sessions }), reapMs: 2 * H })
    const card = personalTips(i).find((c) => c.rule === 'idle-unmanaged')!
    expect(rules(i)).toEqual(['waiting', 'idle-unmanaged'])
    expect(card.text).toBe('2 terminal sessions idle for over 12 h — weevils can’t close them')
    expect(card.accept).toBe('ask weevboss')
    expect(card.action).toEqual({ kind: 'boss', text: expect.stringContaining('- “refactor the parser” on pc, in /home/u/projects/parser (session t1, nothing for 20 h)') })
    expect(card.action).toEqual({ kind: 'boss', text: expect.stringContaining('close nothing without my go-ahead') })
    expect(card.action).toEqual({ kind: 'boss', text: expect.not.stringContaining('t3') })
    // Nothing to run on the server: weevils can't close those.
    return expect(actOn(card.id, i, { close: async () => ({ ok: true }) })).rejects.toThrow('no longer applies')
  })

  it('one idle terminal session since yesterday, in French', () => {
    setLang('fr')
    try {
      const s = session({ id: 't1', origin: 'terminal', controllable: false, hasScreen: false, status: 'idle', lastActivityAt: NOW - 20 * H })
      const [card] = personalTips(input({ snap: snap({ sessions: [s] }), reapMs: 2 * H }))
      expect(card.text).toBe('une session de terminal dort depuis hier — weevils ne peut pas la fermer')
      expect(card.action).toEqual({ kind: 'boss', text: expect.stringContaining('ne ferme rien sans mon accord') })
    } finally {
      setLang('en')
    }
  })

  it('idle since yesterday when every session went quiet before midnight', () => {
    const cards = personalTips(input({ snap: snap({ sessions: [session({ id: 'a', status: 'done', lastActivityAt: NOW - 20 * H })] }) }))
    expect(cards[0].text).toBe('one session idle since yesterday — close it?')
  })

  it('closing the idle sessions goes through the session close, and the card must still apply', async () => {
    const sessions = [session({ id: 'a', status: 'done', lastActivityAt: NOW - 20 * H }), session({ id: 'b', status: 'done', lastActivityAt: NOW - 20 * H })]
    const i = input({ snap: snap({ sessions }) })
    const id = personalTips(i)[0].id
    const close = vi.fn(async () => ({ ok: true }))
    expect(await actOn(id, i, { close })).toBe('2 sessions closed')
    expect(close.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['a', 'b'])
    await expect(actOn(id, input(), { close })).rejects.toThrow('no longer applies')
    await expect(actOn('saturated:vps:1', i, { close })).rejects.toThrow()
  })

  it('a session waiting for you for a long time opens it', () => {
    const s = session({ id: 'w', status: 'needs_user', title: 'a very long session title that keeps going on', lastActivityAt: NOW - 2 * H })
    const [card] = personalTips(input({ snap: snap({ sessions: [s] }) }))
    expect(card.rule).toBe('waiting')
    expect(card.action).toEqual({ kind: 'open', page: 'session', id: 'w' })
    expect(card.text).toMatch(/for 2 h$/)
    expect(card.text).toContain('…')
    expect(rules(input({ snap: snap({ sessions: [{ ...s, lastActivityAt: NOW - WAITING_MS + 1000 }] }) }))).toEqual([])
  })

  it('unsorted imported conversations', () => {
    const [card] = personalTips(input({ snap: snap({ conversationCounts: { total: 40, pending: 12, byProject: {} } }) }))
    expect(card).toMatchObject({ id: 'unsorted:2', rule: 'unsorted', action: { kind: 'open', page: 'conversations' } })
  })

  it('only one machine, once it is used', () => {
    const one = [{ id: 'vps', name: 'vps', online: true }]
    expect(rules(input({ snap: snap({ machines: one }) }))).toEqual(['one-machine'])
    expect(rules(input({ snap: snap({ machines: one, sessions: [] }) }))).toEqual([])
  })

  it('dictation without an OpenAI key', () => {
    expect(rules(input({ dictation: false }))).toEqual(['no-dictation'])
  })

  it('cards follow the user language', () => {
    setLang('fr')
    expect(personalTips(input({ dictation: false }))[0].text).toContain('pour dicter')
    setLang('en')
  })
})
