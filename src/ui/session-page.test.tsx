// @vitest-environment happy-dom
// Session page cleanup: no terminal affordance (screen band, >_ glyph, key names), no raw ids in the header, one way
// to open the settings, plain words everywhere; the real functions (settings, app preview, archive) stay reachable.
import { resetNotices } from './notice-store'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Session, Snapshot } from '../../shared/api.ts'

const calls = vi.hoisted(() => ({ commands: [] as string[], screen: 0, release: null as null | (() => void) }))

vi.mock('../api', () => ({
  api: {
    session: async () => Promise.reject(new Error('absent')),
    modelControls: async () => ({ threadId: 's', tool: 'claude', models: [{ id: 'opus', label: 'opus', efforts: ['low', 'medium'], defaultEffort: 'medium' }, { id: 'sonnet', label: 'sonnet', efforts: ['low', 'medium'], defaultEffort: 'medium' }], selected: { model: 'sonnet', effort: 'medium' }, active: false, appliesTo: 'next-turn' }),
    command: async (_id: string, c: string) => (calls.commands.push(c), { ok: true }),
    send: (id: string) => new Promise((resolve) => { calls.release = () => resolve({ ok: true, id, delivery: { messageId: 'm1', status: 'accepted' } }) }),
    screen: async () => (calls.screen++, { screen: 'RAW TERMINAL' }),
    transcribeInfo: async () => ({ enabled: false }),
    repos: async () => ({ repos: [] }),
    files: async () => ({ files: [...Array.from({ length: 600 }, (_, i) => `f${String(i).padStart(3, '0')}.ts`), 'src/ui/pages.tsx', 'src/main.ts'] }),
    file: async (_repo: string, path: string) => ({ path, content: 'line one', binary: false, truncated: true, size: 4_200_000, editable: false }),
  },
}))
vi.mock('../push', () => ({ ensurePush: async () => {} }))

for (let p: object | null = HTMLElement.prototype; p; p = Object.getPrototypeOf(p)) if (Object.hasOwn(p, 'animate')) delete (p as { animate?: unknown }).animate
globalThis.fetch = (async () => new Response('{}')) as typeof fetch

const { setLang } = await import('../i18n')
const { PageView } = await import('./pages')
const { Ctx } = await import('./app-context')

const NOW = 1_800_000_000_000
const MIN = 60_000

const session = (over: Partial<Session> = {}): Session => ({
  id: 's1',
  projectId: 'p',
  repo: 'weevils',
  machineId: 'vps-machine-42',
  tool: 'claude',
  title: 'refonte',
  status: 'idle',
  cwd: '/home/alex/projects/weevils',
  openedAt: NOW - 60 * MIN,
  lastActivityAt: NOW - 3 * MIN,
  workStartedAt: null,
  origin: 'weevils',
  controllable: true,
  live: true,
  hasScreen: true,
  subagents: [],
  background: 0,
  messageCount: 3,
  queued: 0,
  ...over,
})
const project: Project = { id: 'p', name: 'weevils', kind: 'repo', repos: ['weevils'], where: { weevils: 'vps-machine-42' }, lastActivityAt: NOW - 3 * MIN }

const snap = (sessions: Session[], projects: Project[] = [project]): Snapshot => ({
  version: 1,
  now: NOW,
  machines: [{ id: 'vps-machine-42', name: 'vps', online: true } as never],
  projects,
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

function render(node: React.ReactNode, sessions: Session[], projects?: Project[]) {
  const ctx = {
    snap: snap(sessions, projects),
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
  act(() => root.render(<Ctx.Provider value={ctx as never}>{node}</Ctx.Provider>))
}
const flush = () => act(() => new Promise((r) => setTimeout(r, 20)))
const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
const buttons = () => [...host.querySelectorAll<HTMLButtonElement>('button')]
const byText = (s: string) => buttons().find((b) => text(b) === s)

beforeEach(() => {
  resetNotices()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  calls.commands = []
  calls.screen = 0
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

describe('session page: no terminal', () => {
  it('a session running in a weevils pane shows no terminal screen band, glyph or key names, and never polls the screen', async () => {
    render(<PageView page={{ kind: 'session', id: 's1' }} />, [session()])
    await flush()
    const all = text(host)
    expect(all).not.toMatch(/terminal/i)
    expect(all).not.toContain('>_')
    expect(all).not.toMatch(/up arrow|escape|enter\b/)
    expect(host.querySelector('pre.screen')).toBeNull()
    expect(calls.screen).toBe(0)
    // The settings it used to share the page with still open from the header.
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-controls="session-settings"]')!.click())
    await flush()
    expect(host.querySelector('#session-settings .model-controls')).not.toBeNull()
    expect(text(host)).not.toMatch(/terminal/i)
  })
})

describe('session page header', () => {
  it('no machine id, no background count, one settings control, plain words for the app preview and queued messages', async () => {
    localStorage.removeItem('weevils-preview:s1')
    render(<PageView page={{ kind: 'session', id: 's1' }} />, [session({ background: 2, queued: 3 })])
    await flush()
    const all = text(host)
    expect(all).not.toContain('vps-machine-42')
    expect(all).not.toContain('in background')
    expect(all).toContain('3 messages waiting')
    expect(byText('settings')).toBeUndefined()
    expect(host.querySelectorAll('button[aria-controls="session-settings"]')).toHaveLength(1)
    expect(byText('browser')).toBeUndefined()
    // The header chip opens the settings; « see the app » and archive live there, out of the status line.
    const chip = host.querySelector<HTMLButtonElement>('button[aria-controls="session-settings"]')!
    await act(async () => chip.click())
    expect(chip.getAttribute('aria-pressed')).toBe('true')
    const see = byText('see the app')!
    await act(async () => see.click())
    expect(byText('close the app')?.getAttribute('aria-pressed')).toBe('true')
    await act(async () => chip.click())
    expect(chip.getAttribute('aria-pressed')).toBe('false')
  })

  it('an unknown project falls back to "sessions", never to the raw project id', async () => {
    render(<PageView page={{ kind: 'session', id: 's1' }} />, [session({ projectId: 'p-7f3a9c' })], [])
    await flush()
    expect(text(host)).not.toContain('p-7f3a9c')
  })

  it('a session opened outside weevils says so in plain words', async () => {
    render(<PageView page={{ kind: 'session', id: 's1' }} />, [session({ controllable: false })])
    await flush()
    expect(host.querySelector<HTMLInputElement>('.composer input')!.placeholder).toBe('opened outside weevils: read only')
  })
})

const multi: Project = { id: 'm', name: 'suite', kind: 'repo', repos: ['front', 'back'], where: { front: 'vps-machine-42', back: 'vps-machine-42' }, lastActivityAt: NOW }

describe('files and new session pages', () => {
  it('a project with several folders: "Folders", no count, no machine id', async () => {
    render(<PageView page={{ kind: 'files', projectId: 'm' }} />, [], [multi])
    await flush()
    const all = text(host)
    expect(all).toContain('Folders')
    expect(all).not.toMatch(/repos|vps-machine-42|\/ /)
    expect(text(host)).toContain('front')
  })

  it('a folder: its name without slashes, a file count without machine id, and a button for the rest', async () => {
    render(<PageView page={{ kind: 'files', projectId: 'p' }} />, [], [project])
    await flush()
    const all = text(host)
    expect(all).not.toContain('vps-machine-42')
    expect(all).not.toContain('/ weevils')
    expect(all).toContain('602 files')
    expect(all).not.toMatch(/not shown/)
    expect(host.querySelectorAll('.row')).toHaveLength(1 + 500 + 1)
    const more = byText('show 100 more')!
    await act(async () => more.click())
    expect(host.querySelectorAll('.row')).toHaveLength(1 + 600)
    expect(byText('show 100 more')).toBeUndefined()
    render(<PageView page={{ kind: 'files', projectId: 'p', repo: 'weevils', dir: 'src/ui' }} />, [], [project])
    await flush()
    expect(text(host)).not.toMatch(/\/ui|weevils\/src/)
    expect(text(host)).toContain('ui')
  })

  it('a file: no size, and a plain line when only its beginning is shown', async () => {
    render(<PageView page={{ kind: 'file', projectId: 'p', repo: 'weevils', path: 'src/ui/pages.tsx' }} />, [], [project])
    await flush()
    const all = text(host)
    expect(all).toContain('only the beginning is shown')
    expect(all).not.toMatch(/MB|KB|truncated|weevils\/src/)
  })

  it('new session: plain title, "who works on it" with tool names, "project" instead of repo, no machine id', async () => {
    render(<PageView page={{ kind: 'new', projectId: 'm' }} />, [], [multi])
    await flush()
    const all = text(host)
    expect(all).toContain('New session')
    expect(all).not.toContain('+ new session')
    expect(all).toContain('who works on it')
    expect(byText('Claude')).toBeTruthy()
    expect(byText('Codex')).toBeTruthy()
    expect(all).toContain('project')
    expect(all).not.toMatch(/\brepo\b|\btool\b|vps-machine-42/)
  })
})

describe('session page: a sent message says it arrived', () => {
  const typeAndSend = async (value: string) => {
    const field = host.querySelector<HTMLInputElement | HTMLTextAreaElement>('form input:not([type=file]), form textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!.call(field, value)
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => void host.querySelector('form')!.requestSubmit())
  }
  const bubble = () => text([...host.querySelectorAll('.session-message')].find((m) => text(m).includes('ship it')) ?? null)
  it('no label while on its way (the notice below speaks), then « received » once the server has it', async () => {
    render(<PageView page={{ kind: 'session', id: 's1' }} />, [session()])
    await flush()
    await typeAndSend('ship it')
    await flush()
    expect(bubble()).toContain('ship it')
    expect(bubble()).not.toMatch(/you ·|received/)
    await act(async () => calls.release?.())
    await flush()
    expect(bubble()).toContain('you · received')
  })
  it('the agent busy: received, and it will read it in a moment, never « sending… »', async () => {
    render(<PageView page={{ kind: 'session', id: 's1' }} />, [session({ status: 'working', turnWorking: true, workStartedAt: NOW - MIN })])
    await flush()
    await typeAndSend('ship it')
    await act(async () => calls.release?.())
    await flush()
    expect(bubble()).toContain('queued, it will read it in a moment')
    expect(text(host)).not.toContain('sending…')
  })
})

describe('session page header (r162)', () => {
  it('one plain status line, no agent name, no « idle », no pill; the composer names no agent', async () => {
    render(<PageView page={{ kind: 'session', id: 's1' }} />, [session({ status: 'working', workStartedAt: NOW - 3 * MIN, now: 'QA pass on ad videos' })])
    await flush()
    expect(host.querySelector('.session-now')).toBeNull()
    const meta = text(host.querySelector('.session-heading'))
    expect(meta).not.toMatch(/\bclaude\b|idle|see the app|archive/i)
    expect(meta).toContain('working · 3 min')
    expect(host.querySelector('textarea, input[enterkeyhint]')?.getAttribute('placeholder')).toBe('write a message')
  })

  it('names the plan as its product does: « prolite » reads Pro Lite, Claude’s « Max 20x » unchanged', async () => {
    const { planName } = await import('./infra')
    expect(planName('prolite')).toBe('Pro Lite')
    expect(planName('plus')).toBe('Plus')
    expect(planName('Max 20x')).toBe('Max 20x')
    expect(planName('some_new_plan')).toBe('Some new plan')
  })
})
