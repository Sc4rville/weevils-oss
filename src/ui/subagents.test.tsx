// @vitest-environment happy-dom
// Le travail d'arrière-plan d'une session dans son fil : une ligne par sous-agent, étape de workflow ou commande,
// les étapes rangées sous leur workflow, l'état en mots, le détail lu au dépliage ; le compte affiché sur la ligne de session.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session, Snapshot, Subagent, SubagentDetail } from '../../shared/api.ts'

const calls = vi.hoisted(() => ({ subagent: [] as string[], detail: null as SubagentDetail | null }))

vi.mock('../api', () => ({
  api: {
    subagent: async (id: string, subId: string) => {
      calls.subagent.push(`${id}/${subId}`)
      return calls.detail
    },
    session: async () => new Promise(() => {}),
    transcribeInfo: async () => ({ enabled: false }),
  },
}))

localStorage.setItem('weevils-lang', 'fr')
// happy-dom rejette chaque animation native annulée (AbortError non rattrapé) : motion repasse alors par ses animations JS.
for (let p: object | null = HTMLElement.prototype; p; p = Object.getPrototypeOf(p)) if (Object.hasOwn(p, 'animate')) delete (p as { animate?: unknown }).animate
globalThis.fetch = (async () => new Response('{}')) as typeof fetch

const { Background, groupSubagents } = await import('./subagents')
const { SessionRow } = await import('./bits')
const { Ctx } = await import('./app-context')
const { setLang } = await import('../i18n')
const { PageView } = await import('./pages')

const NOW = 1_800_000_000_000
const MIN = 60_000

const sub = (id: string, over: Partial<Subagent> = {}): Subagent => ({
  id,
  kind: 'agent',
  label: `agent ${id}`,
  activity: `fait ${id}`,
  status: 'working',
  startedAt: NOW - 5 * MIN,
  ...over,
})

const session = (subagents: Subagent[], over: Partial<Session> = {}): Session => ({
  id: 's1',
  projectId: 'p',
  repo: 'weevils',
  machineId: 'vps',
  tool: 'claude',
  title: 'refonte',
  status: 'working',
  cwd: '/x',
  openedAt: NOW - 60 * MIN,
  lastActivityAt: NOW - MIN,
  workStartedAt: NOW - 10 * MIN,
  origin: 'weevils',
  controllable: true,
  live: true,
  hasScreen: false,
  subagents,
  background: subagents.filter((a) => a.status === 'working').length,
  messageCount: 3,
  queued: 0,
  ...over,
})

const snap = (sessions: Session[]): Snapshot => ({
  version: 1,
  now: NOW,
  machines: [],
  projects: [],
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

function render(node: React.ReactNode, sessions: Session[] = []) {
  const ctx = {
    snap: snap(sessions),
    now: NOW,
    offline: false,
    colors: {},
    push: () => {},
    replace: () => {},
    back: () => {},
    home: () => {},
    expanded: null,
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
const rows = () => [...host.querySelectorAll<HTMLElement>('.sub')]
const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  calls.subagent = []
  calls.detail = null
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
  setLang('fr')
})

describe('groupSubagents', () => {
  it('range les étapes sous leur workflow, par phase, à la place de la première étape', () => {
    const items = groupSubagents([
      sub('a'),
      sub('s1', { kind: 'step', workflow: 'ultracode', phase: 'plan' }),
      sub('sh', { kind: 'shell' }),
      sub('s2', { kind: 'step', workflow: 'ultracode', phase: 'build' }),
      sub('s3', { kind: 'step', workflow: 'ultracode', phase: 'plan' }),
      sub('s4', { kind: 'step' }),
    ])
    expect(items.map((i) => (i.kind === 'one' ? i.a.id : `wf:${i.name}`))).toEqual(['a', 'wf:ultracode', 'sh', 's4'])
    const wf = items[1]
    expect(wf.kind === 'workflow' && wf.phases.map((p) => [p.phase, p.items.map((a) => a.id)])).toEqual([
      ['plan', ['s1', 's3']],
      ['build', ['s2']],
    ])
  })

  it('le workflow lui-même (aucune étape en cours) anime l’en-tête, sans ligne ni compte', () => {
    const items = groupSubagents([
      sub('wf_1', { kind: 'step', workflow: 'ultracode', label: 'ultracode', activity: '' }),
      sub('s1', { kind: 'step', workflow: 'ultracode', phase: 'plan', status: 'done', endedAt: NOW }),
    ])
    expect(items).toHaveLength(1)
    const wf = items[0]
    expect(wf.kind === 'workflow' && [wf.live, wf.phases.map((p) => p.items.map((a) => a.id))]).toEqual([true, [['s1']]])
  })
})

describe('bande d’arrière-plan dans le fil', () => {
  it('une ligne par sous-agent, étape et commande, avec nom, activité, état et durée', () => {
    const s = session([
      sub('a', { label: 'relire le serveur', activity: 'lit · server/core.ts' }),
      sub('sh', { kind: 'shell', label: 'npm test', activity: 'tourne', startedAt: NOW - 12 * MIN }),
      sub('st', { kind: 'step', workflow: 'ultracode', phase: 'build', label: 'build:page', status: 'done', endedAt: NOW - MIN, startedAt: NOW - 3 * MIN }),
    ])
    render(<Background session={s} />)
    const r = rows()
    expect(r.map((x) => x.dataset.kind)).toEqual(['agent', 'shell', 'step'])
    expect(text(r[0])).toContain('relire le serveur')
    expect(text(r[0])).toContain('travaille · lit · server/core.ts')
    expect(text(r[0].querySelector('.act'))).toBe('5m')
    expect(text(r[1].querySelector('.act'))).toBe('12m')
    expect(text(r[2])).toContain('build:page')
    expect(text(r[2])).toContain('fini')
    expect(text(r[2].querySelector('.act'))).toBe('2m')
    // Ce qui travaille tourne, ce qui est fini est coché.
    expect(r[0].querySelector('.st .spin')).not.toBeNull()
    expect(r[2].querySelector('.st .spin')).toBeNull()
  })

  it('les étapes sous l’en-tête de leur workflow, phase en sous-titre', () => {
    const s = session([
      sub('s1', { kind: 'step', workflow: 'ultracode', phase: 'plan', label: 'plan:archi', status: 'done', endedAt: NOW }),
      sub('s2', { kind: 'step', workflow: 'ultracode', phase: 'build', label: 'build:app' }),
      sub('s3', { kind: 'step', workflow: 'ultracode', phase: 'build', label: 'build:server' }),
    ])
    render(<Background session={s} />)
    const flow = host.querySelector('[data-workflow="ultracode"]')!
    expect(flow).not.toBeNull()
    expect(text(flow.querySelector('.sub-flow-head'))).toBe('ultracode · 2/3')
    expect([...flow.querySelectorAll('.sub-phase-head')].map(text)).toEqual(['plan', 'build'])
    expect(flow.querySelectorAll('.sub')).toHaveLength(3)
  })

  it('entre deux phases : l’en-tête tourne, « 0/1 », aucune ligne en plus', () => {
    const s = session([sub('wf_1', { kind: 'step', workflow: 'ultracode', label: 'ultracode', activity: '' }), sub('s1', { kind: 'step', workflow: 'ultracode', phase: 'plan', label: 'plan:archi', status: 'done', endedAt: NOW })])
    render(<Background session={s} />)
    const flow = host.querySelector('[data-workflow="ultracode"]')!
    expect(text(flow.querySelector('.sub-flow-head'))).toBe('ultracode · 0/1')
    expect(flow.querySelector('.sub-flow-head .spin')).not.toBeNull()
    expect(rows()).toHaveLength(1)
  })

  it('l’activité d’un outil est traduite comme dans le fil, une phrase reste telle quelle', () => {
    const s = session([sub('a', { activity: 'Read · /home/me/projects/weevils/server/core.ts' }), sub('b', { activity: 'Page built. Tests pass.' })])
    render(<Background session={s} />)
    expect(text(rows()[0].querySelector('.meta'))).toBe('travaille · lit · ~/projects/weevils/server/core.ts')
    expect(text(rows()[1].querySelector('.meta'))).toBe('travaille · Page built. Tests pass.')
  })

  it('les quatre états en mots, en français et en anglais', () => {
    const s = session([
      sub('w'),
      sub('d', { status: 'done', endedAt: NOW }),
      sub('f', { status: 'failed', endedAt: NOW }),
      sub('x', { status: 'stopped', endedAt: NOW }),
    ])
    render(<Background session={s} />)
    expect(rows().map((r) => text(r.querySelector('.meta .strong')))).toEqual(['travaille', 'fini', 'échoué', 'coupé'])
    act(() => setLang('en'))
    expect(rows().map((r) => text(r.querySelector('.meta .strong')))).toEqual(['working', 'done', 'failed', 'stopped'])
  })

  it('ouverte d’office quand quelque chose tourne, repliée sur une ligne quand tout est fini', () => {
    render(<Background session={session([sub('a')])} />)
    expect(rows()).toHaveLength(1)
    act(() => root.unmount())
    root = createRoot(host)
    render(<Background session={session([sub('a', { status: 'done', endedAt: NOW })])} />)
    expect(rows()).toHaveLength(0)
    expect(text(host.querySelector('[data-testid=background]'))).toContain('0 actif · 1 fini')
  })

  it('déplier lit le détail et montre ses pas ; relu toutes les 3 s tant que ça travaille, plus rien une fois replié', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    calls.detail = {
      subagent: sub('a/1'),
      steps: [
        { at: 1, role: 'assistant', text: 'Je regarde **le serveur**.' },
        { at: 2, role: 'tool', text: 'Read · /home/me/projects/weevils/server/core.ts' },
        { at: 3, role: 'result', text: '120 lignes' },
      ],
    }
    render(<Background session={session([sub('a/1', { label: 'relire' })])} />)
    expect(host.querySelector('[data-testid=sub-detail]')).toBeNull()
    await act(async () => rows()[0].querySelector('button')!.click())
    await flush()
    expect(calls.subagent).toEqual(['s1/a/1'])
    const d = host.querySelector('[data-testid=sub-detail]')!
    expect(text(d.querySelector('.text'))).toBe('Je regarde le serveur.')
    expect(text(d.querySelector('.tool'))).toBe('lit · ~/projects/weevils/server/core.ts')
    expect(text(d.querySelector('.result'))).toBe('120 lignes')
    expect(rows()[0].querySelector('button')!.getAttribute('aria-expanded')).toBe('true')

    await act(async () => void vi.advanceTimersByTime(3100))
    expect(calls.subagent).toHaveLength(2)

    await act(async () => rows()[0].querySelector('button')!.click())
    await act(async () => void vi.advanceTimersByTime(1000))
    const n = calls.subagent.length
    await act(async () => void vi.advanceTimersByTime(9000))
    expect(calls.subagent).toHaveLength(n)
  })

  it('un sous-agent fini est lu une fois, sans relecture', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    calls.detail = { subagent: sub('d', { status: 'done' }), steps: [] }
    render(<Background session={session([sub('d', { status: 'done', endedAt: NOW })])} />)
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid=background] > button')!.click())
    await act(async () => rows()[0].querySelector('button')!.click())
    await flush()
    await act(async () => void vi.advanceTimersByTime(10000))
    expect(calls.subagent).toEqual(['s1/d'])
  })

  it('rien quand la session n’a lancé aucun travail à côté', () => {
    render(<Background session={session([])} />)
    expect(host.querySelector('[data-testid=background]')).toBeNull()
  })
})

describe('ligne de session : compte d’arrière-plan', () => {
  it('« 2 en arrière-plan » en gras quand du travail tourne encore', () => {
    const s = session([sub('a'), sub('b'), sub('c', { status: 'done', endedAt: NOW })])
    render(<SessionRow session={s} />, [s])
    // À la suite du texte, pas dans la colonne de la durée (qui mangerait le titre sur téléphone).
    expect(host.querySelector('.act .bg')).toBeNull()
    const bg = host.querySelector('.title .bg')
    expect(text(bg)).toBe('· 2 en arrière-plan')
    expect(bg!.classList.contains('strong')).toBe(true)
    expect(host.querySelector('button')!.getAttribute('aria-label')).toContain('2 en arrière-plan')
    act(() => setLang('en'))
    expect(text(host.querySelector('.title .bg'))).toBe('· 2 in background')
  })

  it('rien quand plus rien ne tourne', () => {
    const s = session([sub('c', { status: 'done', endedAt: NOW })])
    render(<SessionRow session={s} />, [s])
    expect(host.querySelector('.bg')).toBeNull()
  })
})

describe('page de session : méta et fil', () => {
  it('« · 2 en arrière-plan » en gras à côté de l’état, et la bande dans le fil', () => {
    const s = session([sub('a'), sub('b', { kind: 'shell' })])
    render(<PageView page={{ kind: 'session', id: 's1' }} />, [s])
    const strong = [...host.querySelectorAll('.strong')].map(text)
    expect(strong).toContain('· 2 en arrière-plan')
    expect(rows()).toHaveLength(2)
  })

  it('rien dans la méta quand rien ne tourne à côté', () => {
    const s = session([], { status: 'idle', workStartedAt: null })
    render(<PageView page={{ kind: 'session', id: 's1' }} />, [s])
    expect(host.textContent).not.toContain('arrière-plan')
    expect(host.querySelector('[data-testid=background]')).toBeNull()
  })
})
