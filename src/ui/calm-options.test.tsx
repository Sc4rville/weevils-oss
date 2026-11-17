// @vitest-environment happy-dom
// Focused conversation options: weevboss has no app to preview, so no dead "browser" action; a session keeps
// "see the app", and the settings stay in the same menu.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Session, Snapshot } from '../../shared/api.ts'

vi.mock('../api', () => ({
  api: {
    session: async () => Promise.reject(new Error('absent')),
    modelControls: async () => ({ threadId: 's', tool: 'claude', models: [{ id: 'opus', label: 'opus', efforts: ['low', 'medium'], defaultEffort: 'medium' }, { id: 'sonnet', label: 'sonnet', efforts: ['low', 'medium'], defaultEffort: 'medium' }], selected: { model: 'sonnet', effort: 'medium' }, active: false, appliesTo: 'next-turn' }),
    transcribeInfo: async () => ({ enabled: false }),
    voices: async () => ({ voices: [], current: undefined }),
  },
}))
vi.mock('../push', () => ({ ensurePush: async () => {} }))
for (let p: object | null = HTMLElement.prototype; p; p = Object.getPrototypeOf(p)) if (Object.hasOwn(p, 'animate')) delete (p as { animate?: unknown }).animate
globalThis.fetch = (async () => new Response('{}')) as typeof fetch

const { setLang } = await import('../i18n')
const { CalmConv } = await import('./calm')
const { Ctx } = await import('./app-context')

const NOW = 1_800_000_000_000
const session: Session = { id: 's1', projectId: 'p', repo: 'weevils', machineId: 'vps', tool: 'claude', title: 'refonte', status: 'idle', cwd: '/x', openedAt: NOW, lastActivityAt: NOW, workStartedAt: null, origin: 'weevils', controllable: true, live: true, hasScreen: true, subagents: [], background: 0, messageCount: 1, queued: 0 }
const snap = { version: 1, now: NOW, machines: [], projects: [], sessions: [session], h24: [], conversations: [], conversationCounts: { total: 0, pending: 0, byProject: {} }, classifier: { running: false, queued: 0 }, main: [], mainWorking: false, mainHasScreen: true, mainQueued: 0, devil: { enabled: false, working: false }, pinnedRepos: [], config: { userName: '', exposeDomain: '', publicHost: '' } } as unknown as Snapshot

let root: Root
let host: HTMLElement
const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
function render(id: string, current: Snapshot = snap) {
  const ctx = { snap: current, now: NOW, offline: false, colors: {}, push: () => {}, replace: () => {}, back: () => {}, home: () => {}, expanded: null, setExpanded: () => {}, h24Open: false, setH24Open: () => {}, theme: 'light' as const, setTheme: () => {}, refresh: () => {}, logout: () => {} }
  act(() => root.render(<Ctx.Provider value={ctx as never}><CalmConv id={id} /></Ctx.Provider>))
  act(() => host.querySelector<HTMLButtonElement>('button[aria-label="options"]')!.click())
}
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  setLang('en')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  setLang(null)
})

it('weevboss options: no browser or app preview action, settings still there', () => {
  render('main')
  expect(text(host)).not.toMatch(/browser|see the app/)
  expect(host.querySelector('.settings')).not.toBeNull()
})

it('a session keeps "see the app", which opens the preview', () => {
  render('s1')
  const see = [...host.querySelectorAll('button')].find((b) => text(b) === 'see the app')!
  expect(see).toBeTruthy()
  act(() => see.click())
  expect([...host.querySelectorAll('button')].find((b) => text(b) === 'close the app')?.getAttribute('aria-pressed')).toBe('true')
})

it('a stopped session in its focused thread shows why and a way on, never an idle look; signed out offers « sign in again »', () => {
  const out = { ...session, status: 'interrupted', interrupted: { at: NOW, reason: 'auth' } } as Session
  render('s1', { ...snap, sessions: [out] })
  const band = host.querySelector('.cut-band')!
  expect(text(band.querySelector('.who'))).toBe('interrupted · signed out')
  expect([...band.querySelectorAll('button')].map(text)).toEqual(['sign in again', 'resume', 'dismiss'])
})
