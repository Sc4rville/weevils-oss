import { resetNotices } from './notice-store'
// @vitest-environment happy-dom
// Relais Codex pendant la limite de Claude : la bande d'alerte du flux, la vue groupée des plans (valider, ajuster,
// attendre Claude, un par un ou d'un coup), le réglage, le signe « relais » sur la ligne d'une session Codex.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RelayPlan, RelayView, Session, Snapshot } from '../../shared/api.ts'

const calls = vi.hoisted(() => ({ fail: false, decide: [] as unknown[][], set: [] as unknown[], request: [] as string[], pushed: [] as unknown[] }))
vi.mock('../api', () => ({
  api: {
    relayDecide: async (...a: unknown[]) => { calls.decide.push(a); if (calls.fail) throw new Error('network down'); return { ok: true } },
    relaySet: async (o: unknown) => (calls.set.push(o), { ok: true }),
    relayRequest: async (id: string) => (calls.request.push(id), { ok: true }),
    session: async () => Promise.reject(new Error('absent')),
    transcribeInfo: async () => ({ enabled: false }),
  },
}))
vi.mock('../push', () => ({ ensurePush: async () => {} }))

localStorage.setItem('weevils-language', 'fr')
for (let p: object | null = HTMLElement.prototype; p; p = Object.getPrototypeOf(p)) if (Object.hasOwn(p, 'animate')) delete (p as { animate?: unknown }).animate
globalThis.fetch = (async () => new Response('{}')) as typeof fetch

const { RelayBand, RelayPage, ThreadPlans, SessionRelay } = await import('./relay')
const { SessionRow } = await import('./bits')
const { Ctx } = await import('./app-context')

const NOW = new Date(2026, 10, 10, 15, 0).getTime()
const plan = (over: Partial<RelayPlan> = {}): RelayPlan => ({ sessionId: 's1', title: 'refonte du panier', projectId: 'p', state: 'ready', text: 'Fait\n- le modèle\nReste\n- les tests', at: NOW, ...over })
const relay = (over: Partial<RelayView> = {}): RelayView => ({ mode: 'ask', codex: true, switchAt: 97, limit: { kind: 'limit', since: NOW - 60_000, until: new Date(2026, 10, 10, 18, 0).getTime() }, boss: true, plans: [plan(), plan({ sessionId: 's2', title: 'les tests' })], ...over })
const session = (over: Partial<Session> = {}): Session => ({ id: 'c1', projectId: 'p', repo: 'weevils', machineId: 'vps', tool: 'codex', title: 'refonte du panier', status: 'working', cwd: '/x', openedAt: NOW, lastActivityAt: NOW, workStartedAt: NOW, origin: 'weevils', controllable: true, live: true, hasScreen: true, subagents: [], background: 0, messageCount: 1, queued: 0, ...over })
const snap = (r: RelayView | undefined, sessions: Session[] = []): Snapshot => ({
  version: 1,
  now: NOW,
  machines: [],
  projects: [{ id: 'p', name: 'weevils', kind: 'repo', repos: ['weevils'], where: { weevils: 'vps' }, lastActivityAt: NOW }],
  sessions,
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
  relay: r,
})

let root: Root
let host: HTMLElement
function render(node: React.ReactNode, s: Snapshot) {
  const ctx = { snap: s, now: NOW, offline: false, colors: {}, push: (p: unknown) => void calls.pushed.push(p), replace: () => {}, back: () => {}, home: () => {}, expanded: null, setExpanded: () => {}, h24Open: false, setH24Open: () => {}, theme: 'light' as const, setTheme: () => {}, refresh: () => {}, logout: () => {} }
  act(() => root.render(<Ctx.Provider value={ctx as never}>{node}</Ctx.Provider>))
}
const flush = () => act(() => new Promise((r) => setTimeout(r, 20)))
const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
const button = (label: string, within: Element = host) => [...within.querySelectorAll('button')].find((b) => text(b) === label)!

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  resetNotices()
  calls.fail = false
  calls.decide = []
  calls.set = []
  calls.request = []
  calls.pushed = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('relais Codex', () => {
  it('bande du flux : absente quand Claude va bien ou que le relais est coupé ; sinon une ligne qui ouvre la vue', () => {
    render(<RelayBand />, snap(relay({ limit: undefined, boss: false, plans: [] })))
    expect(host.querySelector('.relay-band')).toBeNull()
    render(<RelayBand />, snap(relay({ mode: 'never' })))
    expect(host.querySelector('.relay-band')).toBeNull()
    render(<RelayBand />, snap(relay()))
    expect(text(host.querySelector('.relay-band'))).toBe('⇄limite Claude atteinte · jusqu’à 18 h · weevboss répond par Codex · 2 plans à valider→')
    act(() => host.querySelector<HTMLButtonElement>('.relay-band-row')!.click())
    expect(calls.pushed).toEqual([{ kind: 'relay' }])
    render(<RelayBand />, snap(relay({ limit: { kind: 'near', since: NOW, until: null, percent: 97, window: 'session' }, boss: true, plans: [plan({ state: 'preparing', text: undefined })] })))
    expect(text(host.querySelector('.relay-band'))).toBe('⇄Claude à 97 % de sa limite · weevboss répond par Codex · 1 plan en préparation→')
  })

  it('automatic relay never asks for approval in the feed, thread or plan page', () => {
    const automatic = snap(relay({ mode: 'auto', limit: { kind: 'near', since: NOW, until: null, percent: 97, window: 'week' }, plans: [plan(), plan({ sessionId: 's2', state: 'preparing', text: undefined }), plan({ sessionId: 's3', state: 'waiting' })] }))
    render(<RelayBand />, automatic)
    expect(host.querySelector('.relay-band')).toBeNull()
    render(<ThreadPlans />, automatic)
    expect(host.querySelector('.relay-thread')).toBeNull()
    render(<RelayPage />, automatic)
    expect(host.querySelectorAll('.relay-plan')).toHaveLength(3)
    expect([...host.querySelectorAll('button')].filter((b) => /^(valider|ajuster|attendre Claude|tout valider|tout laisser à Claude)$/.test(text(b)))).toEqual([])
    expect(button('reprendre seul').getAttribute('aria-pressed')).toBe('true')
    expect(calls.decide).toEqual([])
  })

  it('closing the quota banner persists through percentage/reset updates and never changes relay mode', async () => {
    const r = relay()
    render(<RelayBand />, snap(r))
    await act(async () => host.querySelector<HTMLButtonElement>('.notice-close')!.click())
    expect(host.querySelector('.relay-band')).toBeNull()
    render(<RelayBand />, snap({ ...r, limit: { ...r.limit!, percent: 100, until: r.limit!.until! + 19 } }))
    expect(host.querySelector('.relay-band')).toBeNull()
    expect(calls.decide).toEqual([])
    expect(calls.set).toEqual([])
    render(<RelayBand />, snap({ ...r, limit: { ...r.limit!, since: NOW + 60_000 } }))
    expect(host.querySelector('.relay-band')).not.toBeNull()
  })
  it('plans use their decisions, without a cross on every request', () => {
    render(<ThreadPlans />, snap(relay()))
    expect(host.querySelectorAll('.relay-plan')).toHaveLength(2)
    expect(host.querySelector('.relay-plan .notice-close')).toBeNull()
    expect(calls.decide).toEqual([])
  })

  it('vue groupée : chaque plan avec valider / ajuster / attendre Claude, et tout valider d’un coup', async () => {
    render(<RelayPage />, snap(relay()))
    const cards = [...host.querySelectorAll('.relay-plan')]
    expect(cards).toHaveLength(2)
    expect(text(cards[0])).toContain('refonte du panier')
    expect(text(cards[0])).toContain('plan prêt · weevils')
    expect(text(cards[0])).toContain('le modèle')
    act(() => button('valider', cards[0]).click())
    await flush()
    expect(calls.decide).toEqual([['s1', 'go', undefined]])
    // Ajuster : un champ, puis la note part avec la décision.
    act(() => button('ajuster', cards[1]).click())
    const area = cards[1].querySelector('textarea')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, 'ne touche pas au CI')
      area.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => button('envoyer', cards[1]).click())
    await flush()
    expect(calls.decide.at(-1)).toEqual(['s2', 'adjust', 'ne touche pas au CI'])
    expect(host.querySelectorAll('.relay-plan')).toHaveLength(0)
    render(<RelayPage />, snap(relay()))
    expect(host.querySelectorAll('.relay-plan')).toHaveLength(0)
    // A new request, even for the same session, can notify again.
    render(<RelayPage />, snap(relay({ plans: [plan({ at: NOW + 1 }), plan({ sessionId: 's2', at: NOW + 1 })] })))
    act(() => button('tout valider').click())
    await flush()
    expect(calls.decide.at(-1)).toEqual(['all', 'go'])
    expect(host.querySelectorAll('.relay-plan')).toHaveLength(0)
  })

  it('failed individual and grouped decisions retain the cards, show the error and allow retry', async () => {
    calls.fail = true
    const snapshot = snap(relay())
    render(<RelayPage />, snapshot)
    await act(async () => button('valider', host.querySelector('.relay-plan')!).click())
    expect(host.querySelectorAll('.relay-plan')).toHaveLength(2)
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('network down')
    expect(button('valider', host.querySelector('.relay-plan')!).disabled).toBe(false)
    await act(async () => button('tout valider').click())
    expect(host.querySelectorAll('.relay-plan')).toHaveLength(2)
    expect(host.querySelector('.relay-all [role="alert"]')?.textContent).toContain('network down')
    calls.fail = false
    await act(async () => button('tout laisser à Claude').click())
    expect(calls.decide.at(-1)).toEqual(['all', 'wait'])
    expect(host.querySelectorAll('.relay-plan')).toHaveLength(0)
    render(<RelayPage />, snapshot)
    expect(host.querySelectorAll('.relay-plan')).toHaveLength(0)
  })

  it('réglage : reprendre seul / me demander d’abord / jamais, et le seuil de bascule, sans ligne d’aide permanente', async () => {
    render(<RelayPage />, snap(relay({ plans: [] })))
    expect(button('me demander d’abord').getAttribute('aria-pressed')).toBe('true')
    expect(text(host)).not.toContain('rien n’est touché avant ton oui')
    expect(text(host)).toContain('passer la main quand Claude atteint')
    act(() => button('reprendre seul').click())
    act(() => button('95 %').click())
    await flush()
    expect(calls.set).toEqual([{ mode: 'auto' }, { switchAt: 95 }])
    expect(button('97 %').getAttribute('aria-pressed')).toBe('true')
  })

  it('un plan en cours d’écriture ne se valide pas encore ; un plan repris par Codex mène à sa session ; sous le fil de weevboss, seuls ceux à décider', () => {
    const plans = [plan({ state: 'preparing', text: undefined }), plan({ sessionId: 's2', state: 'running', relayTo: 'c1' }), plan({ sessionId: 's3', state: 'waiting' })]
    render(<RelayPage />, snap(relay({ plans })))
    const cards = [...host.querySelectorAll('.relay-plan')]
    expect(button('valider', cards[0]).disabled).toBe(true)
    expect(text(cards[1])).toContain('attend le retour de Claude')
    expect(text(cards[2])).toContain('Codex a pris le relais')
    expect(text(cards[2])).not.toContain('le modèle')
    act(() => button('voir la session Codex →', cards[2]).click())
    expect(calls.pushed.at(-1)).toEqual({ kind: 'session', id: 'c1' })
    render(<ThreadPlans />, snap(relay({ plans })))
    expect(host.querySelectorAll('.relay-plan')).toHaveLength(1)
  })

  it('ligne d’une session Codex en relais : le signe « relais »', () => {
    render(<SessionRow session={session({ relayOf: 's1' })} />, snap(relay()))
    expect(text(host.querySelector('.relay-sign'))).toBe('⇄ relais')
    render(<SessionRow session={session()} />, snap(relay()))
    expect(host.querySelector('.relay-sign')).toBeNull()
  })

  it('dans une session : « demander un plan à Codex » et « reprend « titre » » en mots simples', async () => {
    const cut = session({ id: 's1', tool: 'claude', status: 'interrupted' })
    render(<SessionRelay session={cut} onError={() => {}} />, snap(relay({ plans: [] }), [cut]))
    await act(async () => button('⇄ demander un plan à Codex').click())
    expect(calls.request.at(-1)).toBe('s1')
    render(<SessionRelay session={session({ relayOf: 's1' })} onError={() => {}} />, snap(relay({ plans: [] }), [cut]))
    expect(text(host)).toBe('⇄ reprend « refonte du panier »')
  })
})
