// @vitest-environment happy-dom
// Session coupée en plein travail : couleur d'alerte sur sa ligne et dans la bande du projet (même repliée), jamais
// l'étoile verte ni « terminée » ; reprise en un geste depuis la ligne et depuis son fil ; « laisser » dans le fil.
import { resetNotices } from './notice-store'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Session, Snapshot } from '../../shared/api.ts'

const calls = vi.hoisted(() => ({ resume: [] as string[], dismiss: [] as string[], pushed: [] as unknown[], setup: [] as unknown[][] }))

vi.mock('../api', () => ({
  api: {
    resume: async (id: string) => (calls.resume.push(id), { id }),
    dismiss: async (id: string) => (calls.dismiss.push(id), { ok: true }),
    setupAsk: async (...a: unknown[]) => (calls.setup.push(a), { ok: true, flow: false }),
    // Le détail ne vient pas (session distante) : la page s'appuie sur l'instantané ; les bandes d'état s'affichent.
    session: async () => Promise.reject(new Error('absent')),
    transcribeInfo: async () => ({ enabled: false }),
  },
}))
vi.mock('../push', () => ({ ensurePush: async () => {} }))

localStorage.setItem('weevils-language', 'fr')
for (let p: object | null = HTMLElement.prototype; p; p = Object.getPrototypeOf(p)) if (Object.hasOwn(p, 'animate')) delete (p as { animate?: unknown }).animate
globalThis.fetch = (async () => new Response('{}')) as typeof fetch

const { SessionRow } = await import('./bits')
const { ProjectBand } = await import('./bands')
const { PageView } = await import('./pages')
const { Ctx } = await import('./app-context')
const { status } = await import('./format')

const NOW = 1_800_000_000_000
const MIN = 60_000

const session = (over: Partial<Session> = {}): Session => ({
  id: 's1',
  projectId: 'p',
  repo: 'weevils',
  machineId: 'vps',
  tool: 'claude',
  title: 'refonte',
  status: 'interrupted',
  interrupted: { at: NOW - 3 * MIN, reason: 'died' },
  cwd: '/x',
  openedAt: NOW - 60 * MIN,
  lastActivityAt: NOW - 3 * MIN,
  workStartedAt: null,
  origin: 'weevils',
  controllable: true,
  live: false,
  hasScreen: false,
  subagents: [],
  background: 0,
  messageCount: 3,
  queued: 0,
  ...over,
})
const project: Project = { id: 'p', name: 'weevils', kind: 'repo', repos: ['weevils'], where: { weevils: 'vps' }, lastActivityAt: NOW - 3 * MIN }

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

let root: Root
let host: HTMLElement

function render(node: React.ReactNode, sessions: Session[], expanded: string | null = null) {
  const ctx = {
    snap: snap(sessions),
    now: NOW,
    offline: false,
    colors: {},
    push: (p: unknown) => void calls.pushed.push(p),
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
  act(() => root.render(<Ctx.Provider value={ctx}>{node}</Ctx.Provider>))
}
const flush = () => act(() => new Promise((r) => setTimeout(r, 20)))
const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()

beforeEach(() => {
  resetNotices()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  calls.resume = []
  calls.dismiss = []
  calls.pushed = []
  localStorage.removeItem('weevils-collapsed')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('session coupée en plein travail', () => {
  it('état à part : « interrompue », caractère ×, jamais « terminée »', () => {
    expect(status.interrupted.label).toBe('interrompue')
    expect(status.interrupted.ch).toBe('×')
    expect(status.interrupted.label).not.toBe(status.done.label)
  })

  it('ligne en couleur d’alerte, sans étoile verte, avec « reprendre » qui relance et ouvre le fil', async () => {
    render(<SessionRow session={session()} />, [session()])
    const row = host.querySelector('.row')!
    expect(row.classList.contains('cut')).toBe(true)
    expect(row.classList.contains('live')).toBe(false)
    expect(host.querySelector('.fluo')).toBeNull()
    const btn = host.querySelector<HTMLButtonElement>('.cut-wrap > .resume')!
    expect(text(btn)).toBe('reprendre')
    await act(async () => btn.click())
    await flush()
    expect(calls.resume).toEqual(['s1'])
    expect(calls.pushed).toEqual([{ kind: 'session', id: 's1' }])
  })

  it('bande du projet : pastille rouge avec le compte, en tête et dans le résumé replié ; la session est dans les actives', () => {
    const done = session({ id: 's2', status: 'done', interrupted: undefined })
    render(<ProjectBand project={project} />, [session(), done])
    const band = host.querySelector('.band')!
    expect(band.classList.contains('has-cut')).toBe(true)
    expect(band.classList.contains('busy')).toBe(false)
    const chip = host.querySelector('.ch.alert-ch')!
    expect(text(chip)).toBe('1')
    expect(chip.querySelector('svg')).not.toBeNull()
    expect(chip.getAttribute('aria-label')).toBe('1 session coupée en plein travail')
    expect(host.querySelectorAll('.cut-wrap .row.cut')).toHaveLength(1)
    // Repliée : le résumé commence par la pastille.
    localStorage.setItem('weevils-collapsed', JSON.stringify({ p: true }))
    act(() => root.unmount())
    root = createRoot(host)
    render(<ProjectBand project={project} />, [session(), done])
    expect(text(host.querySelector('.alert-pill'))).toBe('× 1 interrompue')
  })

  it('fil de la session : bande d’alerte avec la raison, « reprendre » sur place et « laisser »', async () => {
    render(<PageView page={{ kind: 'session', id: 's1' }} />, [session({ interrupted: { at: NOW - MIN, reason: 'quota', detail: 'Claude usage limit reached' } })])
    await flush() // les bandes d'état arrivent avec le fil (ici : détail absent)
    const band = host.querySelector('.cut-band')!
    expect(text(band.querySelector('.who'))).toBe('interrompue · limite d’usage atteinte')
    // The tool's raw error stays one tap away, folded.
    expect(band.querySelector('details.cut-detail')?.hasAttribute('open')).toBe(false)
    expect(text(band.querySelector('.text'))).toBe('Claude usage limit reached')
    await act(async () => band.querySelector<HTMLButtonElement>('.resume')!.click())
    await flush()
    expect(calls.resume).toEqual(['s1'])
    expect(calls.pushed).toEqual([])
    expect(host.querySelector('.cut-band')).toBeNull()
    render(<PageView page={{ kind: 'session', id: 's1' }} />, [session({ noticeId: 'another-cut' })])
    await flush()
    await act(async () => host.querySelector<HTMLButtonElement>('.cut-band .cut-actions .link')!.click())
    await flush()
    expect(calls.dismiss).toEqual(['s1'])
    expect(host.querySelector('.cut-band')).toBeNull()
  })
})

describe('compte déconnecté', () => {
  it('« me reconnecter » lance la connexion dans le fil de weevboss, sans changer d’outil ; « reprendre » reste pour après', async () => {
    calls.setup.length = 0
    const out = session({ tool: 'codex', interrupted: { at: NOW - MIN, reason: 'auth', detail: 'Codex needs to be signed in again' } })
    render(<PageView page={{ kind: 'session', id: 's1' }} />, [out])
    await flush()
    const band = host.querySelector('.cut-band')!
    expect(text(band.querySelector('.who'))).toBe('interrompue · compte déconnecté')
    const sign = band.querySelector<HTMLButtonElement>('.sign-in')!
    expect(text(sign)).toBe('me reconnecter')
    expect(band.querySelector('.resume:not(.sign-in)')).not.toBeNull()
    await act(async () => sign.click())
    await flush()
    expect(calls.setup).toHaveLength(1)
    expect(calls.setup[0][0]).toBe('codex')
    expect(calls.setup[0][2]).toBe(true)
  })
  it('les autres coupures n’ont pas de bouton de connexion', async () => {
    render(<PageView page={{ kind: 'session', id: 's1' }} />, [session({ interrupted: { at: NOW - MIN, reason: 'quota' } })])
    await flush()
    expect(host.querySelector('.cut-band .sign-in')).toBeNull()
  })
})

it('keeps read-only session navigation and history accessible while blocking resume and message entry', async () => {
 const restricted = session({ sourceAccess: { repo: 'weevils', machineId: 'vps', canExecute: false, reason: 'not-writable' } })
 render(<SessionRow session={restricted} />, [restricted])
 const resume = host.querySelector<HTMLButtonElement>('button.resume')!
 expect(resume.disabled).toBe(true)
 await act(async () => resume.click())
 expect(calls.resume).toEqual([])
 render(<PageView page={{ kind: 'session', id: 's1' }} />, [restricted])
 await flush()
 expect(host.textContent).toContain('refonte')
 expect(host.querySelector<HTMLInputElement>('.composer input')!.disabled).toBe(true)
 expect(calls.resume).toEqual([])
 render(<PageView page={{ kind: 'session', id: 's1' }} />, [{ ...restricted, sourceAccess: { ...restricted.sourceAccess!, canExecute: true, reason: 'owned-writable' } }])
 await flush()
 expect(host.querySelector<HTMLInputElement>('.composer input')!.disabled).toBe(false)
})

it('blocks a deep link to new work on an informational installation without inventing a repository', async () => {
 const original = { ...project }
 try {
  Object.assign(project, { kind: 'installation', repos: [], where: {}, sourceAccess: { repo: null, machineId: 'vps', canExecute: false, reason: 'no-checkout' }, installation: { id: 'own', machineId: 'vps', source: 'artifact' } })
  render(<PageView page={{ kind: 'new', projectId: 'p' }} />, [])
  await flush()
  expect(host.querySelector<HTMLInputElement>('.composer input')!.disabled).toBe(true)
 } finally {
  Object.assign(project, original)
  delete project.sourceAccess; delete project.installation
 }
})
