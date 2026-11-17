// @vitest-environment happy-dom
// Sleep mode in the app: the « zzz » button sleeps and wakes (the server's state), the night look on the whole
// interface, the ghosts (sessions at work, a running automation) and the morning recap card, each line from a real state.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Optimizer, Project, Session, Snapshot } from '../../shared/api.ts'
import type { ForYouItem } from '../../shared/foryou.ts'

const calls = vi.hoisted(() => ({ sleep: [] as boolean[], trigger: [] as unknown[] }))
vi.mock('../api', () => ({
  api: {
    setSleep: async (on: boolean) => (calls.sleep.push(on), { on, since: on ? 1 : null }),
    autoTrigger: async (id: string, t: unknown) => (calls.trigger.push([id, t]), { item: {} }),
    transcribeInfo: async () => ({ enabled: false }),
  },
}))
for (let p: object | null = HTMLElement.prototype; p; p = Object.getPrototypeOf(p)) if (Object.hasOwn(p, 'animate')) delete (p as { animate?: unknown }).animate

const { NightBand, SleepButton, useNightChrome } = await import('./night')
const { Ctx } = await import('./app-context')
const { setLang } = await import('../i18n')

const NOW = 1_800_000_000_000
const MIN = 60_000
const session = (over: Partial<Session>): Session => ({ id: 's1', projectId: 'p', repo: 'weevils', machineId: 'vps', tool: 'claude', title: 'Fix the login', now: 'Running the tests', status: 'working', cwd: '/x', openedAt: NOW, lastActivityAt: NOW, workStartedAt: NOW - 42 * MIN, origin: 'weevils', controllable: true, live: true, hasScreen: false, subagents: [], background: 0, messageCount: 3, queued: 0, ...over })
const project: Project = { id: 'p', name: 'weevils', kind: 'repo', repos: ['weevils'], where: {}, lastActivityAt: NOW }
const auto: Optimizer = { id: 'a1', title: 'Night lens', why: '', repo: 'weevils', kind: 'explore', heavy: false, state: 'running', createdAt: NOW, startedAt: NOW - 10 * MIN, sessionId: 'sa', onSleep: true }

let root: Root
let host: HTMLElement
const pushed: unknown[] = []
function render(node: React.ReactNode, over: Partial<Snapshot> = {}) {
  const snap = { version: 1, now: NOW, machines: [], projects: [project], sessions: [session({}), session({ id: 'sa', title: 'auto run' }), session({ id: 'idle', status: 'idle' })], h24: [], conversations: [], conversationCounts: { total: 0, pending: 0, byProject: {} }, classifier: { running: false, queued: 0 }, main: [], mainWorking: false, mainHasScreen: false, mainQueued: 0, devil: { enabled: false, working: false }, pinnedRepos: [], optimizers: [auto], sleep: { on: true, since: NOW - 60 * MIN }, config: { userName: '', exposeDomain: '', publicHost: '' }, ...over } as Snapshot
  const ctx = { snap, now: NOW, offline: false, colors: { p: 'p4' }, push: (p: unknown) => void pushed.push(p), replace: () => {}, back: () => {}, home: () => {}, expanded: null, setExpanded: () => {}, h24Open: false, setH24Open: () => {}, theme: 'light' as const, setTheme: () => {}, refresh: () => {}, logout: () => {} }
  act(() => root.render(<Ctx.Provider value={ctx}>{node}</Ctx.Provider>))
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  setLang('en')
  calls.sleep.length = 0
  calls.trigger.length = 0
  pushed.length = 0
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('sleep mode', () => {
  it('the zzz button goes to sleep, then wakes, through the server', async () => {
    render(<SleepButton />, { sleep: { on: false, since: null } })
    const b = host.querySelector<HTMLButtonElement>('.sleep-btn')!
    expect(b.getAttribute('aria-label')).toBe('turn on sleep mode')
    expect(b.querySelector('svg')).not.toBeNull()
    await act(async () => b.click())
    expect(calls.sleep).toEqual([true])
    // Shown asleep at once, before the snapshot catches up.
    expect(b.getAttribute('aria-pressed')).toBe('true')
    render(<SleepButton />, { sleep: { on: true, since: NOW } })
    await act(async () => host.querySelector<HTMLButtonElement>('.sleep-btn')!.click())
    expect(calls.sleep).toEqual([true, false])
    // The server agrees: the tap's own state lets go.
    render(<SleepButton />, { sleep: { on: false, since: null } })
    expect(host.querySelector('.sleep-btn')!.getAttribute('aria-pressed')).toBe('false')
  })

  it('the night band: one ghost per agent at work (automation included, never twice), what it does and for how long; wake up', async () => {
    render(<NightBand />)
    const ghosts = [...host.querySelectorAll('.night-ghost')]
    expect(ghosts.map((g) => g.querySelector('.ghost-title')!.textContent)).toEqual(['Fix the login', 'Night lens'])
    expect(ghosts[0].querySelector('.ghost-doing')!.textContent).toBe('Running the tests · for 42 min')
    expect(host.querySelector('.night-title')!.textContent).toBe('2 ghosts are working while you sleep')
    await act(async () => (ghosts[1] as HTMLButtonElement).click())
    expect(pushed).toEqual([{ kind: 'auto', id: 'a1' }])
    await act(async () => host.querySelector<HTMLButtonElement>('.night-wake')!.click())
    expect(calls.sleep).toEqual([false])
    render(<NightBand />, { sleep: { on: false, since: null } })
    expect(host.querySelector('.night')).toBeNull()
  })

  it('the whole interface switches to the night look while asleep', () => {
    function Chrome({ on }: { on: boolean }) {
      useNightChrome(on)
      return null
    }
    render(<Chrome on />)
    expect(document.documentElement.dataset.sleep).toBe('1')
    render(<Chrome on={false} />)
    expect(document.documentElement.dataset.sleep).toBeUndefined()
  })
})

describe('the morning recap card', () => {
  it('the overnight tally is a readout, not content: it stays out of the stream', async () => {
    const { ForYouItemView } = await import('./foryou')
    const item: ForYouItem = {
      id: 'sleep:1', kind: 'stat', tone: 'magic', at: NOW, who: 'weevils', title: 'While you slept', text: 'Overnight: 1 result, 1 waiting for you.',
      recap: { from: NOW - 8 * 60 * MIN, to: NOW, more: 0, lines: [
        { state: 'done', src: 'auto', title: 'Night lens', detail: 'Report: 3 findings', open: { page: 'auto', id: 'a1' }, at: NOW },
      ] },
    }
    render(<ForYouItemView item={item} />)
    expect(host.querySelector('[data-fy-format]')).toBeNull()
  })

})
