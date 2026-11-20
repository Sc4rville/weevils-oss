// @vitest-environment happy-dom
// Le flux ne bouge pas sous le doigt : deux sessions (ou deux projets) qui écrivent tour à tour ne permutent pas, seul
// un changement de rang (ce qui t'attend) réordonne, et rien ne bouge pendant un geste. Les « terminées » se replient
// par défaut, même dans une bande ouverte sans session active.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Session, Snapshot } from '../../shared/api.ts'

vi.mock('../api', () => ({ api: {} }))
vi.mock('../push', () => ({ ensurePush: async () => {} }))

localStorage.setItem('weevils-language', 'fr')
for (let p: object | null = HTMLElement.prototype; p; p = Object.getPrototypeOf(p)) if (Object.hasOwn(p, 'animate')) delete (p as { animate?: unknown }).animate

const { ProjectBand } = await import('./bands')
const { Ctx, stableOrder, setSettledNow } = await import('./app-context')

const NOW = 1_800_000_000_000
const MIN = 60_000

const session = (id: string, over: Partial<Session> = {}): Session => ({
  id,
  projectId: 'p',
  repo: 'weevils',
  machineId: 'vps',
  tool: 'claude',
  title: id,
  status: 'working',
  cwd: '/x',
  openedAt: NOW - 60 * MIN,
  lastActivityAt: NOW - MIN,
  workStartedAt: NOW - MIN,
  origin: 'weevils',
  controllable: true,
  live: true,
  hasScreen: false,
  subagents: [],
  background: 0,
  messageCount: 3,
  queued: 0,
  ...over,
})
const project: Project = { id: 'p', name: 'weevils', kind: 'repo', repos: ['weevils'], where: { weevils: 'vps' }, lastActivityAt: NOW - MIN }

const snap = (sessions: Session[]): Snapshot => ({
  version: 1,
  now: NOW,
  machines: [],
  projects: [project],
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
})

describe('stableOrder', () => {
  const id = (x: { id: string }) => x.id
  const rank = (x: { r: number }) => x.r
  const fresh = (a: { at: number }, b: { at: number }) => b.at - a.at
  const ids = (xs: { id: string }[]) => xs.map(id).join(' ')

  it('premier affichage : rang, puis activité', () => {
    const xs = [
      { id: 'a', r: 1, at: 1 },
      { id: 'b', r: 1, at: 3 },
      { id: 'c', r: 0, at: 2 },
    ]
    expect(ids(stableOrder(xs, id, rank, fresh, []))).toBe('c b a')
  })

  it('l’activité seule ne fait pas permuter ; un changement de rang, si', () => {
    const xs = [
      { id: 'a', r: 1, at: 9 },
      { id: 'b', r: 1, at: 3 },
      { id: 'c', r: 2, at: 1 },
    ]
    expect(ids(stableOrder(xs, id, rank, fresh, ['b', 'a', 'c']))).toBe('b a c')
    xs[2].r = 0
    expect(ids(stableOrder(xs, id, rank, fresh, ['b', 'a', 'c']))).toBe('c b a')
  })

  it('un nouveau venu se place en tête de son rang', () => {
    const xs = [
      { id: 'a', r: 1, at: 1 },
      { id: 'n', r: 1, at: 0 },
      { id: 'z', r: 0, at: 0 },
    ]
    expect(ids(stableOrder(xs, id, rank, fresh, ['z', 'a']))).toBe('z n a')
  })

  it('pendant un geste, rien ne bouge ; les nouveaux venus vont à la fin', () => {
    const xs = [
      { id: 'a', r: 2, at: 1 },
      { id: 'b', r: 0, at: 1 },
      { id: 'n', r: 0, at: 5 },
    ]
    expect(ids(stableOrder(xs, id, rank, fresh, ['a', 'b'], true))).toBe('a b n')
  })
})

let root: Root
let host: HTMLElement

function render(sessions: Session[], expanded: string | null = null, optimizers: Snapshot['optimizers'] = []) {
  const ctx = {
    snap: { ...snap(sessions), optimizers },
    now: NOW,
    offline: false,
    colors: {},
    push: () => {},
    replace: () => {},
    back: () => {},
    home: () => {},
    expanded,
    setExpanded: () => {},
    h24Open: false,
    setH24Open: () => {},
    theme: 'light' as const,
    setTheme: () => {},
    refresh: () => {},
    logout: () => {},
  }
  act(() => root.render(<Ctx.Provider value={ctx}><ProjectBand project={project} /></Ctx.Provider>))
}
const order = () =>
  Array.from(host.querySelectorAll('.row'))
    .map((r) => r.getAttribute('aria-label') ?? '')
    .filter((l) => /alpha|beta/.test(l))
    .map((l) => (l.includes('alpha') ? 'alpha' : 'beta'))
    .join(' ')

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  setSettledNow(true)
  localStorage.removeItem('weevils-collapsed')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('bande projet', () => {
  it('deux sessions qui écrivent tour à tour gardent leur place ; celle qui travaille reste avant celle qui t’attend', () => {
    const a = session('alpha', { openedAt: NOW - 30 * MIN })
    const b = session('beta', { openedAt: NOW - 20 * MIN })
    render([a, b])
    expect(order()).toBe('beta alpha')
    // Le serveur renvoie alpha en premier (activité plus récente) : rien ne bouge.
    render([{ ...a, lastActivityAt: NOW }, b])
    expect(order()).toBe('beta alpha')
    render([{ ...a, status: 'needs_user', attention: 'ok ?' }, b])
    expect(order()).toBe('beta alpha')
  })

  it('puts real work before idle, relay and waiting sessions, then keeps each group stable', () => {
    const idle = session('idle', { status: 'idle', openedAt: NOW })
    const relay = session('relay', { status: 'interrupted', openedAt: NOW })
    const waiting = session('waiting', { status: 'needs_user', openedAt: NOW })
    const a = session('alpha', { openedAt: NOW - 30 * MIN })
    const b = session('beta', { openedAt: NOW - 20 * MIN })
    const done = session('done-session', { status: 'done' })
    const rows = () => [...host.querySelectorAll('.row .title')].map((r) => r.textContent)
    render([idle, relay, waiting, a, b, done])
    expect(rows()).toEqual(['beta', 'alpha', 'relay', 'waiting', 'idle'])
    render([{ ...a, lastActivityAt: NOW }, idle, b, waiting, relay, done])
    expect(rows()).toEqual(['beta', 'alpha', 'relay', 'waiting', 'idle'])
    // An idle session really starts: only its status, never the activity timestamp, promotes it.
    render([{ ...idle, status: 'working' }, a, b, relay, waiting, done])
    expect(rows()).toEqual(['beta', 'alpha', 'idle', 'relay', 'waiting'])
    expect(host.textContent).not.toContain('1 session')
  })

  it('defers status reordering during a gesture and applies it when settled', () => {
    const a = session('alpha', { status: 'idle' })
    const b = session('beta', { status: 'working' })
    render([a, b])
    expect(order()).toBe('beta alpha')
    setSettledNow(false)
    render([{ ...a, status: 'working' }, { ...b, status: 'idle' }])
    expect(order()).toBe('beta alpha')
    // Releasing the gesture must apply the deferred order without another server snapshot.
    act(() => setSettledNow(true))
    expect(order()).toBe('alpha beta')
  })

  it('finished sessions are not on the home screen at all, even in an open band (Scarville, 2026-11-17)', () => {
    const d = session('fini', { status: 'done', live: false, workStartedAt: null })
    render([d], 'p')
    expect(host.textContent).not.toMatch(/\bsessions?\b/)
    expect(host.querySelectorAll('.session-item')).toHaveLength(0)
  })

  it('a « > » right of the « / » opens the project page; the band itself keeps its own tap (Scarville, 2026-11-17)', () => {
    render([session('a')])
    const chars = [...host.querySelectorAll('.chars .ch')].map((b) => b.getAttribute('aria-label'))
    expect(chars.slice(0, 2)).toEqual(['fichiers de weevils', 'ouvrir weevils'])
    expect(host.querySelector('.pj')).toBeNull()
  })
})

it.each(['light','dark','zen','graphite'])('keeps the recursive signature static until verified work and stops it again in %s', async theme=>{
 const identity={kind:'self-improvement' as const,installationId:'own',target:{machineId:'vps',projectId:'p',repo:'weevils'},evidence:'repository-identity' as const}
 project.workstream=identity
 document.documentElement.dataset.theme=theme
 try {
  await render([session('s',{status:'idle',workstream:identity})])
  expect(host.querySelector('.recursive-identity')).not.toBeNull()
  expect(host.querySelector('.recursive-active')).toBeNull()
  await render([session('s',{status:'working',workstream:identity})])
  expect(host.querySelector('.recursive-active')).not.toBeNull()
  expect(host.querySelector('.recursive-active .spin')).not.toBeNull()
  await render([session('s',{status:'interrupted',workstream:identity})])
  expect(host.querySelector('.recursive-active')).toBeNull()
 } finally {delete project.workstream;delete document.documentElement.dataset.theme}
})

it('preserves the automation mark while improving, without treating a past run as current',()=>{
 const identity={kind:'self-improvement' as const,installationId:'own',target:{machineId:'vps',projectId:'p',repo:'weevils'},evidence:'repository-identity' as const}
 project.workstream=identity
 try {
  const run={id:'auto',state:'running',sessionId:'s'} as NonNullable<Snapshot['optimizers']>[number]
  render([session('s',{workstream:identity})],null,[run])
  expect(host.querySelector('.recursive-active .name .auto-mark')).not.toBeNull()
  expect(host.querySelector('.recursive-active .name .spin')).toBeNull()
  render([session('s',{workstream:identity})],null,[{...run,state:'done'}])
  expect(host.querySelector('.recursive-active .name .auto-mark')).toBeNull()
  expect(host.querySelector('.recursive-active .name .spin')).not.toBeNull()
 } finally {delete project.workstream}
})
it('localizes the current activity without changing project identity or claiming work after stop',async()=>{
 const {setLang}=await import('../i18n')
 const identity={kind:'self-improvement' as const,installationId:'own',target:{machineId:'vps',projectId:'p',repo:'weevils'},evidence:'repository-identity' as const}
 project.workstream=identity
 try {
  for(const [lang,label] of [['en','Improving weevils'],['fr','amélioration de weevils en cours'],['en','Improving weevils']] as const){
   act(()=>setLang(lang));render([session('s',{workstream:identity})])
   expect(host.querySelector('.name')?.getAttribute('title')).toBe(label)
   expect(host.querySelector('[data-project="p"]')).not.toBeNull()
  }
  render([session('s',{status:'idle',workstream:identity})])
  expect(host.querySelector('.name')?.hasAttribute('title')).toBe(false)
 }finally{delete project.workstream;act(()=>setLang('fr'))}
})
