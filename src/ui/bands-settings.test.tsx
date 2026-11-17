// @vitest-environment happy-dom
// The settings band and an open project band: machines by their name (never their id), one machines line, a job's
// state in words (never the raw last line of its log), one conversations line (import lives on its page).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { H24Activity, Machine, Project, Session, Snapshot } from '../../shared/api.ts'

vi.mock('../api', () => ({ api: { usageRate: async () => ({ step: 15_000, end: Date.now(), buckets: [] }) } }))
vi.mock('../push', () => ({ ensurePush: async () => {} }))
vi.mock('./infra', async (orig) => ({ ...(await orig<typeof import('./infra')>()), UsageLine: () => null }))

for (let p: object | null = HTMLElement.prototype; p; p = Object.getPrototypeOf(p)) if (Object.hasOwn(p, 'animate')) delete (p as { animate?: unknown }).animate
const { MotionGlobalConfig } = await import('motion/react')
MotionGlobalConfig.skipAnimations = true
const { FootBand, ProjectBand } = await import('./bands')
const { Ctx } = await import('./app-context')
const { setLang } = await import('../i18n')

const NOW = 1_800_000_000_000
const H = 3_600_000

const session = (over: Partial<Session> = {}): Session => ({
  id: 's1', projectId: 'p', repo: 'shop', machineId: 'm-7f3a9c', tool: 'claude', title: 'refonte', status: 'working', cwd: '/x',
  openedAt: NOW - H, lastActivityAt: NOW - 60_000, workStartedAt: null, origin: 'weevils', controllable: true, live: true, hasScreen: false,
  subagents: [], background: 0, messageCount: 3, queued: 0, ...over,
})
const project: Project = { id: 'p', name: 'Shop', kind: 'repo', repos: ['shop'], where: { shop: 'm-7f3a9c' }, lastActivityAt: NOW - 60_000 }
const job: H24Activity = { id: 'job:render', title: 'Render', kind: 'job', projectId: 'p', schedule: '', enabled: true, runState: 'waiting', runStartedAt: null, lastEvent: 'npm ERR! code ELIFECYCLE', canToggle: false, nextRunAt: NOW + H, lastRunAt: NOW - 2 * H }

const snap = (machines: Machine[], over: Partial<Snapshot> = {}): Snapshot => ({
  version: 1, now: NOW, machines, projects: [project], sessions: [session()], h24: [job], conversations: [],
  conversationCounts: { total: 120, pending: 0, byProject: {} }, classifier: { running: false, queued: 0 }, main: [], mainWorking: false,
  mainHasScreen: false, mainQueued: 0, devil: { enabled: false, working: false }, pinnedRepos: [], config: { userName: '', exposeDomain: '', publicHost: '' },
  ...over,
})

let root: Root
let host: HTMLElement
let pushed: unknown[]

function render(node: React.ReactNode, s: Snapshot, expanded: string | null = null) {
  const ctx = {
    snap: s, now: NOW, offline: false, colors: {}, push: (p: unknown) => void pushed.push(p), replace: () => {}, back: () => {}, home: () => {},
    expanded, setExpanded: () => {}, h24Open: false, setH24Open: () => {}, theme: 'light' as const, setTheme: () => {}, refresh: () => {}, logout: () => {},
  }
  act(() => root.render(<Ctx.Provider value={ctx}>{node}</Ctx.Provider>))
}
const rows = () => [...host.querySelectorAll('button.row')].map((r) => r.textContent!.replace(/\s+/g, ' ').trim())
const click = (el: Element | undefined) => act(async () => void (el as HTMLElement).click())

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  setLang('en')
  pushed = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  setLang(null)
})

describe('settings band', () => {
  it('is headed settings, with one machines line that says how many are online', async () => {
    render(<FootBand />, snap([{ id: 'm-7f3a9c', name: 'vps', online: true }, { id: 'm-2', name: 'laptop', online: false }]))
    expect(host.querySelector('h2')!.textContent).toBe('settings')
    const machines = rows().filter((r) => r.includes('machines'))
    expect(machines).toHaveLength(1)
    expect(machines[0]).toContain('1 of 2 online')
    expect(rows().some((r) => r.includes('vps') || r.includes('laptop'))).toBe(false)
    await click([...host.querySelectorAll('button.row')].find((r) => r.textContent!.includes('machines')))
    expect(pushed).toEqual([{ kind: 'machine', projectId: '' }])
  })

  it('one machine: its name alone, "offline" only when it is', () => {
    render(<FootBand />, snap([{ id: 'm-7f3a9c', name: 'vps', online: true }]))
    expect(rows().find((r) => r.includes('vps'))).not.toMatch(/online|offline/)
    render(<FootBand />, snap([{ id: 'm-7f3a9c', name: 'vps', online: false }]))
    expect(rows().find((r) => r.includes('vps'))).toContain('offline')
  })

  it('exactly machines, subscriptions, theme, requests and log out: each a label and its value, nothing under it', async () => {
    render(<FootBand />, snap([{ id: 'm-7f3a9c', name: 'vps', online: true }], { asksOpen: 3 }))
    // UsageLine is mocked out here (it reads the quotas); the four others are the band.
    expect(rows()).toEqual(['machinesvps', 'themelight', 'requests3', 'log out'])
    expect(host.querySelectorAll('button.row .meta')).toHaveLength(0)
    await click([...host.querySelectorAll('button.row')].find((r) => r.textContent!.startsWith('requests')))
    expect(pushed).toEqual([{ kind: 'requests' }])
  })
})

describe('open project band', () => {
  it('only its sessions: no machines, no code folders, no jobs, no ids', () => {
    render(<ProjectBand project={project} />, snap([{ id: 'm-7f3a9c', name: 'vps' }]), 'p')
    expect(host.textContent).not.toContain('m-7f3a9c')
    expect(host.textContent).not.toContain('npm ERR!')
    expect(rows().find((r) => r.includes('Render'))).toBeUndefined()
    expect(rows().find((r) => r.startsWith('shop'))).toBeUndefined()
    // Only « / » (the repo explorer) and « > » (the project's page) stay by the name.
    expect([...host.querySelectorAll('.chars button')].map((b) => b.getAttribute('aria-label'))).toEqual([expect.stringMatching(/files/), expect.stringMatching(/^open /)])
  })
})
