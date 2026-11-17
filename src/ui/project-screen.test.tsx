// @vitest-environment happy-dom
// The open project: what runs now (one bold line per working session, newest first, at most 4), then the to-do (the
// user's open requests sent to this project, by weight), nothing at all when nothing runs and nothing is open.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../../shared/api.ts'
import type { LedgerView } from '../../shared/ledger.ts'

const ledger: { v: LedgerView } = { v: { goals: [], asks: [], pending: [], trace: [], knowledge: [], digestTokens: 0 } }
vi.mock('../api', () => ({ api: { ledger: async () => ledger.v } }))
localStorage.setItem('weevils-language', 'en')
for (let p: object | null = HTMLElement.prototype; p; p = Object.getPrototypeOf(p)) if (Object.hasOwn(p, 'animate')) delete (p as { animate?: unknown }).animate

const { ProjectNow, feedOf, todoOf } = await import('./project-screen')
const { Ctx } = await import('./app-context')

const NOW = 1_800_000_000_000
const MIN = 60_000
const project = { id: 'p', name: 'weevils' }

const session = (id: string, over: Partial<Session> = {}): Session => ({
  id, projectId: 'p', repo: 'weevils', machineId: 'vps', tool: 'claude', title: `title ${id}`, status: 'working', cwd: '/x',
  openedAt: NOW - 60 * MIN, lastActivityAt: NOW - MIN, workStartedAt: NOW - MIN, origin: 'weevils', controllable: true,
  live: true, hasScreen: true, subagents: [], background: 0, messageCount: 1, queued: 0, ...over,
})
type Row = LedgerView['asks'][number]
const ask = (id: string, over: Partial<Row> = {}): Row => ({
  id, text: `text ${id}`, quote: `words ${id}`, src: 'j1', from: 'user', at: NOW - 10 * MIN, kind: 'task', status: 'dispatched',
  dispatches: [], progressAt: NOW, stale: false, ...over,
})
const sent = (sessionId: string, label?: string) => [{ session: sessionId, label, at: NOW - 5 * MIN }]

describe('feed', () => {
  it('working sessions only, newest first, their current activity, at most 4', () => {
    const xs = [
      session('a', { now: 'running tests', lastActivityAt: NOW - 3 * MIN }),
      session('b', { now: 'rewriting the install page', lastActivityAt: NOW - MIN }),
      session('c', { status: 'idle' }),
      session('d', { now: '' }),
      session('e'), session('f'),
    ]
    const f = feedOf(xs)
    expect(f).toHaveLength(4)
    expect(f[0].text).toBe('rewriting the install page')
    expect(f.map((x) => x.id)).not.toContain('c')
    expect(f.find((x) => x.id === 'd')?.text).toBe('title d')
  })
})

describe('to-do', () => {
  const others = session('other', { projectId: 'q' })
  it('belongs by the session it was sent to, by its label when that session is gone, by name when never sent', () => {
    const asks = [
      ask('mine', { dispatches: sent('a') }),
      ask('theirs', { dispatches: sent('other') }),
      ask('gone', { dispatches: sent('zz', 'weevils · claude · old work') }),
      ask('goneElse', { dispatches: sent('zz', 'content · claude · episode') }),
      ask('named', { status: 'open', text: 'make the weevils install page calmer' }),
      ask('unnamed', { status: 'open', text: 'buy milk' }),
      ask('closed', { status: 'done', dispatches: sent('a') }),
    ]
    expect(todoOf(asks, project, [session('a'), others]).map((x) => x.a.id).sort()).toEqual(['gone', 'mine', 'named'])
  })
  it('waiting on you first, then what moves, what sleeps last', () => {
    const asks = [
      ask('stale', { dispatches: sent('i'), stale: true, at: NOW }),
      ask('run', { dispatches: sent('w') }),
      ask('you', { dispatches: sent('n'), at: NOW - 30 * MIN }),
    ]
    const xs = [session('w'), session('n', { status: 'needs_user' }), session('i', { status: 'idle' })]
    expect(todoOf(asks, project, xs).map((x) => `${x.a.id}:${x.chip}`)).toEqual(['you:needs', 'run:running', 'stale:paused'])
  })
})

let root: Root
let host: HTMLElement
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function render(sessions: Session[], pushed: unknown[] = []) {
  const ctx = { snap: { sessions, version: 1, asksOpen: 1 }, push: (p: unknown) => pushed.push(p) } as never
  await act(async () => root.render(<Ctx.Provider value={ctx}><ProjectNow project={project} sessions={sessions} /></Ctx.Provider>))
  await act(async () => new Promise((r) => setTimeout(r, 10)))
}

describe('screen', () => {
  it('nothing running and nothing open: nothing at all', async () => {
    ledger.v = { ...ledger.v, asks: [] }
    await render([session('i', { status: 'idle' })])
    expect(host.innerHTML).toBe('')
  })
  it('bold lines for what runs, the user’s words for the to-do, weight for its state (bold only when it waits on you), a tap opens the session', async () => {
    ledger.v = { ...ledger.v, asks: [ask('r', { quote: 'fix the  install\npage', dispatches: sent('w') }), ask('s', { dispatches: sent('i'), stale: true })] }
    const pushed: unknown[] = []
    await render([session('w', { now: 'running tests' }), session('i', { status: 'idle' })], pushed)
    const feed = [...host.querySelectorAll('.pj-feed .pj-line')]
    expect(feed.map((e) => e.textContent)).toEqual(['running tests'])
    expect(feed[0].classList.contains('on')).toBe(true)
    const todo = [...host.querySelectorAll<HTMLButtonElement>('.pj-todo .pj-line')]
    expect(todo.map((e) => e.textContent)).toEqual(['“fix the install page”', '“words s”'])
    expect(todo[0].className).toBe('pj-line ') // in progress: regular, the bold is for the lines above
    expect(todo[1].classList.contains('rest')).toBe(true)
    act(() => todo[0].click())
    expect(pushed).toEqual([{ kind: 'session', id: 'w' }])
    expect(host.textContent).not.toMatch(/\d+ (more|session)/)
  })
})

describe('page', () => {
  it('what runs, the to-do, then every session: open ones first, finished ones newest first, 6 then the rest on a tap', async () => {
    const { ProjectPage } = await import('./project-screen')
    ledger.v = { ...ledger.v, asks: [ask('r', { dispatches: sent('w') })] }
    const done = Array.from({ length: 8 }, (_, i) => session(`d${i}`, { status: 'done', title: `done ${i}`, lastActivityAt: NOW - (i + 2) * 60 * MIN }))
    const sessions = [...done, session('w', { now: 'running tests' }), session('a', { status: 'archived' as never, archived: true })]
    const ctx = { snap: { sessions, projects: [{ id: 'p', name: 'weevils', kind: 'repo', repos: ['weevils'], where: {}, lastActivityAt: NOW }], machines: [], version: 1, asksOpen: 1 }, colors: {}, now: NOW, push: () => {}, back: () => {} } as never
    await act(async () => root.render(<Ctx.Provider value={ctx}><ProjectPage projectId="p" /></Ctx.Provider>))
    await act(async () => new Promise((r) => setTimeout(r, 10)))
    expect([...host.querySelectorAll('.pj-feed .pj-line')].map((e) => e.textContent)).toEqual(['running tests'])
    expect(host.querySelectorAll('.pj-todo .pj-line')).toHaveLength(1)
    const names = () => [...host.querySelectorAll('.session-name')].map((e) => e.textContent)
    expect(names()).toEqual(['title w', 'done 0', 'done 1', 'done 2', 'done 3', 'done 4', 'done 5'])
    const older = host.querySelector<HTMLButtonElement>('.pj-older button')!
    expect(older.textContent).toBe('2 older sessions')
    act(() => older.click())
    expect(names()).toHaveLength(9)
  })
})
