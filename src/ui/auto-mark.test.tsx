// @vitest-environment happy-dom
// AutoMark outside the drawer: a session run by an automation wears it instead of the green star (its row, its
// project's name); a project's job lines open the automation's page.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { H24Activity, Optimizer, Project, Session, Snapshot } from '../../shared/api.ts'

const pushed = vi.hoisted(() => [] as unknown[])
vi.mock('../api', () => ({ api: { transcribeInfo: async () => ({ enabled: false }) } }))
vi.mock('../push', () => ({ ensurePush: async () => {} }))
for (let p: object | null = HTMLElement.prototype; p; p = Object.getPrototypeOf(p)) if (Object.hasOwn(p, 'animate')) delete (p as { animate?: unknown }).animate
globalThis.fetch = (async () => new Response('{}')) as typeof fetch

const { SessionRow } = await import('./bits')
const { ProjectBand } = await import('./bands')
const { Ctx } = await import('./app-context')

const NOW = 1_800_000_000_000
const session = (over: Partial<Session>): Session => ({ id: 's1', projectId: 'p', repo: 'weevils', machineId: 'vps', tool: 'claude', title: 't', status: 'working', cwd: '/x', openedAt: NOW, lastActivityAt: NOW, workStartedAt: NOW, origin: 'weevils', controllable: true, live: true, hasScreen: false, subagents: [], background: 0, messageCount: 3, queued: 0, ...over })
const project: Project = { id: 'p', name: 'weevils', kind: 'repo', repos: ['weevils'], where: {}, lastActivityAt: NOW }
const auto: Optimizer = { id: 'a1', title: 'Clean deps', why: '', repo: 'weevils', kind: 'other', heavy: false, state: 'running', createdAt: NOW, startedAt: NOW, sessionId: 'sa' }
const job: H24Activity = { id: 'job:render', title: 'render', kind: 'job', projectId: 'p', schedule: '', enabled: true, runState: 'running', runStartedAt: NOW, lastEvent: '', canToggle: false }

let root: Root
let host: HTMLElement
function render(node: React.ReactNode, sessions: Session[], expanded: string | null = null) {
  const snap = { version: 1, now: NOW, machines: [], projects: [project], sessions, h24: [job], conversations: [], conversationCounts: { total: 0, pending: 0, byProject: {} }, classifier: { running: false, queued: 0 }, main: [], mainWorking: false, mainHasScreen: false, mainQueued: 0, devil: { enabled: false, working: false }, pinnedRepos: [], optimizers: [auto], config: { userName: '', exposeDomain: '', publicHost: '' } } as Snapshot
  const ctx = { snap, now: NOW, offline: false, colors: {}, push: (p: unknown) => void pushed.push(p), replace: () => {}, back: () => {}, home: () => {}, expanded, setExpanded: () => {}, h24Open: false, setH24Open: () => {}, theme: 'light' as const, setTheme: () => {}, refresh: () => {}, logout: () => {} }
  act(() => root.render(<Ctx.Provider value={ctx}>{node}</Ctx.Provider>))
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  pushed.length = 0
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('AutoMark outside the drawer', () => {
  it('a session run by an automation: AutoMark, not the star; a session of yours keeps the star', () => {
    render(<SessionRow session={session({ id: 'sa' })} />, [session({ id: 'sa' })])
    expect(host.querySelector('.st .auto-mark')).not.toBeNull()
    expect(host.querySelector('.st .spin.fluo')).toBeNull()
    render(<SessionRow session={session({ id: 'mine' })} />, [session({ id: 'mine' })])
    expect(host.querySelector('.st .auto-mark')).toBeNull()
    expect(host.querySelector('.st .spin.fluo')).not.toBeNull()
  })

  it("the project's name: the star when one of yours works, else AutoMark; its job lines open the automation page", async () => {
    render(<ProjectBand project={project} />, [session({ id: 'sa' }), session({ id: 'mine' })], 'p')
    expect(host.querySelector('.name .spin.fluo')).not.toBeNull()
    expect(host.querySelector('.name .auto-mark')).toBeNull()
    render(<ProjectBand project={project} />, [session({ id: 'sa' })], 'p')
    expect(host.querySelector('.name .auto-mark')).not.toBeNull()
    expect(host.querySelector('.name .spin.fluo')).toBeNull()
    const line = [...host.querySelectorAll('.row')].find((r) => r.textContent?.includes('render'))!
    expect(line.querySelector('.auto-mark')).not.toBeNull()
    await act(async () => void (line as HTMLElement).click())
    expect(pushed).toEqual([{ kind: 'auto', id: 'job:render' }])
  })
})
