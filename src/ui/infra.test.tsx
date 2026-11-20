// @vitest-environment happy-dom
// Machine, files and subscription pages: no ssh command to copy, no reverse DNS, no load average or swap, no terminal
// prompt glyph, no port as a server's name, no « machine:/path » kicker, no raw error text. What stays reachable:
// opening a server, walking the files, adding a machine, opening a session from the usage list.
import { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Snapshot } from '../../shared/api'
import type { FsListing, InfraDetail, UsageInfo, UsageToday } from '../../shared/infra'

const state = vi.hoisted(() => ({
  snap: null as unknown as Snapshot,
  push: vi.fn(),
  infra: null as unknown as InfraDetail | Error,
  said: [] as string[],
  fs: null as unknown as FsListing | Error,
  usage: null as unknown as UsageInfo | Error,
  today: { rows: [] } as UsageToday,
  setup: [] as string[],
}))
vi.mock('./app-context', () => ({ useApp: () => ({ snap: state.snap, push: state.push, now: Date.now(), colors: {} }) }))
vi.mock('./shell', () => ({
  Shell: ({ children, title, kicker, meta }: { children: React.ReactNode; title: string; kicker?: string; meta?: string }) => (
    <section>
      <p data-kicker>{kicker}</p>
      <h1>{title}</h1>
      <p data-meta>{meta}</p>
      {children}
    </section>
  ),
}))
vi.mock('./setup', () => ({ askSetup: (b: string) => void state.setup.push(b) }))
vi.mock('../api', () => ({
  api: {
    infra: async () => (state.infra instanceof Error ? Promise.reject(state.infra) : state.infra),
    fs: async () => (state.fs instanceof Error ? Promise.reject(state.fs) : state.fs),
    usage: async () => (state.usage instanceof Error ? Promise.reject(state.usage) : state.usage),
    usageToday: async () => state.today,
    main: async (text: string) => (state.said.push(text), { id: 'm1' }),
  },
}))

for (let p: object | null = HTMLElement.prototype; p; p = Object.getPrototypeOf(p)) if (Object.hasOwn(p, 'animate')) delete (p as { animate?: unknown }).animate
const { MotionGlobalConfig } = await import('motion/react')
MotionGlobalConfig.skipAnimations = true
const { setLang } = await import('../i18n')
const { InfraPage, FsPage, UsageLine, UsagePage, forgetUsage } = await import('./infra')
const { Icon } = await import('./icons')

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const terminalIcon = renderToStaticMarkup(<Icon name="terminal" />).match(/ d="([^"]+)"/)![1]

const detail = (over: Partial<InfraDetail> = {}): InfraDetail => ({
  id: 'vps',
  name: 'vps',
  weevboss: true,
  facts: { hostname: 'srv1', user: 'scarville', os: 'Ubuntu 26.04', kernel: '7.0', arch: 'x86_64', virt: 'kvm', ip: '203.0.113.7', publicIp: true, rdns: 'srv1.hstgr.cloud', sshPort: 2222, ssh: [] },
  offer: null,
  reach: [{ from: 'pc', alias: 'vps' }] as InfraDetail['reach'],
  cores: 4,
  memTotal: 16 * 1024 ** 3,
  memUsed: 8 * 1024 ** 3,
  swapTotal: 2 * 1024 ** 3,
  swapUsed: 1024 ** 3,
  diskTotal: 0,
  diskUsed: 0,
  cpu: 42,
  load: [0.52, 0.31, 0.2],
  uptime: 3600_000,
  day: [],
  episodes: [],
  days: [],
  servers: [
    { port: 4173, name: 'vite', dir: '/home/alex/projects/mygame', url: 'https://mygame.example.tech' },
    { port: 8080, name: 'caddy' },
  ],
  consumers: [{ kind: 'process', label: 'node', count: 1, mem: 1024 ** 3, cpu: 12, parts: [] }] as unknown as InfraDetail['consumers'],
  advice: [],
  ...over,
})

let root: Root, host: HTMLDivElement
beforeEach(() => {
  setLang('en')
  forgetUsage()
  state.push.mockClear()
  state.setup = []
  state.said = []
  state.snap = { machines: [{ id: 'vps', name: 'vps', online: true }], sessions: [], projects: [{ id: 'p', name: 'mygame', repos: ['mygame'] }] } as unknown as Snapshot
  state.infra = detail()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  setLang(null)
})
const render = async (node: React.ReactNode) => {
  await act(async () => root.render(node))
  await act(async () => new Promise((r) => setTimeout(r, 10)))
}
const rows = () => [...host.querySelectorAll('button')]
const row = (txt: string) => rows().find((b) => b.textContent?.includes(txt))

const tapRow = async (txt: string) => {
  await act(async () => row(txt)!.click())
  await act(async () => new Promise((r) => setTimeout(r, 10)))
}

it('machines page: one line per machine, name and online / offline, nothing technical until a tap', async () => {
  state.snap.machines = [{ id: 'vps', name: 'vps', online: true }, { id: 'pc', name: 'laptop', online: false }] as Snapshot['machines']
  await render(<InfraPage />)
  expect(host.querySelector('h1')?.textContent).toBe('machines')
  const text = host.textContent ?? ''
  expect(text).toContain('vpsonline')
  expect(text).toContain('laptopoffline')
  // The default view: names and states only.
  for (const gone of ['CPU', 'GB', 'Ubuntu', 'srv1', '203.0.113.7', 'node', 'mygame', 'caddy', '4173', 'x86_64', 'kvm', 'up for']) expect(text).not.toContain(gone)
  expect(host.querySelector('.strong')?.textContent).toBe('vps')
  expect(host.innerHTML).not.toContain(terminalIcon)
})

it('machines page: a tap opens memory, disk, up for and the host, never the CPU, OS, servers or processes', async () => {
  state.infra = detail({ diskTotal: 100 * 1024 ** 3, diskUsed: 40 * 1024 ** 3, advice: ['Swap 60% used: memory is short.'], facts: { ...detail().facts, provider: 'Hostinger' } as InfraDetail['facts'] })
  await render(<InfraPage />)
  await tapRow('vps')
  const text = host.textContent ?? ''
  expect(text).toContain('Swap 60% used')
  expect(text).toContain('memory8.0 GB / 16.0 GB')
  expect(text).toContain('disk40.0 GB / 100 GB')
  expect(text).toContain('hostHostinger')
  for (const gone of ['CPU', '42', 'Ubuntu', 'node', 'mygame', 'caddy', 'srv1']) expect(text).not.toContain(gone)
  // weevboss runs on it: this weevils cannot remove itself.
  expect(row('remove')).toBeUndefined()
})

it('machines page: « remove » asks twice, then hands it to weevboss in its thread', async () => {
  state.snap.machines = [{ id: 'vps', name: 'vps', online: true }, { id: 'pc', name: 'laptop', online: true }] as Snapshot['machines']
  state.infra = detail({ id: 'pc', name: 'laptop', weevboss: false })
  await render(<InfraPage />)
  await tapRow('laptop')
  await tapRow('remove')
  expect(state.said).toEqual([])
  await tapRow('sure? tap again')
  expect(state.said).toEqual(['Remove the machine « laptop » from weevils.'])
  expect(host.textContent).toContain('asked weevboss')
})

it('machines page: one plain « add a machine » line, still asking weevboss', async () => {
  await render(<InfraPage />)
  await act(async () => row('add a machine')!.click())
  expect(state.setup).toEqual(['machine'])
})

it('machines page: a failed read says so in plain words, never the raw error', async () => {
  state.infra = new Error('failed (502) ECONNREFUSED')
  await render(<InfraPage machine="vps" />)
  expect(host.textContent).toContain('not reachable')
  expect(host.textContent).not.toContain('ECONNREFUSED')
  // Unreachable: still removable.
  expect(row('remove')).toBeTruthy()
})

it('files: folder name as kicker, no « machine:/path », « home folder » instead of ~, plain error', async () => {
  state.fs = { path: '/home/alex/projects', home: '/home/alex', entries: [{ name: 'mygame', dir: true, size: 0 }] }
  await render(<FsPage machine="vps" path="/home/alex/projects" />)
  expect(host.querySelector('[data-kicker]')!.textContent).toBe('alex')
  expect(host.querySelector('[data-meta]')!.textContent).toBe('1 item')
  expect(host.textContent).not.toContain('vps:')
  await act(async () => row('mygame/')!.click())
  expect(state.push).toHaveBeenCalledWith({ kind: 'fs', machine: 'vps', path: '/home/alex/projects/mygame' })

  state.fs = { path: '/', home: '/home/alex', entries: [], error: 'EACCES: permission denied' }
  await render(<FsPage machine="vps" path="/" />)
  expect(host.textContent).not.toContain('~')
  expect(host.textContent).not.toContain('EACCES')
  expect(host.textContent).toContain('can’t open this folder')
  await act(async () => row('home folder')!.click())
  expect(state.push).toHaveBeenCalledWith({ kind: 'fs', machine: 'vps', path: '/home/alex' })
})

it('subscription: one figure per tool, no lone « ! », no raw error, no machine id or terminal glyph', async () => {
  state.usage = {
    claude: { ok: true, windows: [{ kind: 'week', percent: 40, resetsAt: null }, { kind: 'session', percent: 12, resetsAt: null }], source: 'x', at: Date.now() },
    codex: { ok: true, windows: [{ kind: 'week', percent: 3, resetsAt: null }], source: 'x', at: Date.now() },
  } as UsageInfo
  await render(<UsageLine />)
  expect(host.textContent).toContain('Claude 40% · Codex 3%')
  expect(host.textContent).not.toContain('5 h')

  // Nothing ever known (a fresh install, Claude refusing): the page says so.
  forgetUsage()
  state.usage = { claude: { ok: false, windows: [], source: 'x', at: 0, error: 'HTTP 429' }, codex: { ok: false, windows: [], source: 'x', at: 0 } } as UsageInfo
  await render(<UsageLine />)
  expect(host.textContent).not.toContain('!')

  state.snap.sessions = [{ id: 's1', title: 'refonte' }] as Snapshot['sessions']
  state.today = { rows: [{ id: 's1', machine: 'vps-7f3a', tool: 'codex', projectId: 'p', title: 'refonte', weight: 1, tokens: 1000 }] } as UsageToday
  await render(<UsagePage />)
  const text = host.textContent ?? ''
  expect(text).toContain('no figures yet')
  expect(text).not.toContain('trying again')
  expect(text).not.toContain('HTTP 429')
  expect(text).not.toContain('vps-7f3a')
  // A share of today's use, never a raw token count.
  expect(text).toContain('100%')
  expect(text).not.toMatch(/tokens|1 k\b/)
  expect(host.innerHTML).not.toContain(terminalIcon)
  // Today by project only: no per-session list, no per-model list, no pace sentence.
  expect(text).not.toContain('refonte')
  expect(text).not.toMatch(/by session|by model|API prices/)
})

it('subscription: a Claude answer with no window still says something (never an empty section)', async () => {
  state.usage = {
    claude: { ok: true, plan: 'Max 20x', windows: [], source: 'x', at: Date.now() },
    codex: { ok: true, windows: [{ kind: 'week', percent: 3, resetsAt: null }], source: 'x', at: Date.now() },
  } as UsageInfo
  await render(<UsagePage />)
  expect(host.textContent).toContain('Claude · Max 20xno figures yet')
})

it('subscription: figures once known stay on screen, with their age, through a failed read or an empty answer (r41, r42)', async () => {
  const at = Date.now() - 20 * 60_000
  state.usage = {
    claude: { ok: true, plan: 'Max 20x', windows: [{ kind: 'week', percent: 74, resetsAt: null }], source: 'x', at },
    codex: { ok: true, windows: [{ kind: 'week', percent: 84, resetsAt: null }], source: 'x', at },
  } as UsageInfo
  await render(<UsagePage />)
  // Twenty minutes old: said so, never passed off as fresh.
  expect(host.textContent).toContain('week 74 %')
  expect(host.textContent).toContain('20 min ago')

  // weevils restarts with nothing to say: the page keeps the figures instead of « no figures yet ».
  state.usage = { claude: { ok: false, windows: [], source: 'x', at: Date.now(), error: 'HTTP 429' }, codex: { ok: true, windows: [], source: 'x', at: Date.now() } } as UsageInfo
  await act(async () => root.unmount())
  root = createRoot(host)
  await render(<UsagePage />)
  expect(host.textContent).toContain('week 74 %')
  expect(host.textContent).toContain('week 84 %')
  expect(host.textContent).not.toContain('no figures yet')
  expect(host.textContent).not.toContain('HTTP 429')
})

it('subscription: healthy figures a few minutes old (between two server reads) never say « last known » (r41, r42)', async () => {
  const at = Date.now() - 7 * 60_000
  state.usage = {
    claude: { ok: true, windows: [{ kind: 'week', percent: 74, resetsAt: null }], source: 'x', at },
    codex: { ok: true, windows: [{ kind: 'week', percent: 84, resetsAt: null }], source: 'x', at },
  } as UsageInfo
  await render(<UsagePage />)
  expect(host.textContent).toContain('week 74 %')
  expect(host.textContent).not.toContain('ago')
})

it('subscription: a reopened app shows the last figures at once, even while weevils does not answer (r41, r42)', async () => {
  state.usage = {
    claude: { ok: true, windows: [{ kind: 'week', percent: 40, resetsAt: null }], source: 'x', at: Date.now() },
    codex: { ok: true, windows: [{ kind: 'week', percent: 3, resetsAt: null }], source: 'x', at: Date.now() },
  } as UsageInfo
  await render(<UsageLine />)
  expect(localStorage.getItem('weevils-usage-v1')).toContain('"percent":40')

  // A new page load (the memory copy is gone, the phone's copy stays) while the server is restarting.
  const saved = localStorage.getItem('weevils-usage-v1')!
  vi.resetModules()
  localStorage.setItem('weevils-usage-v1', saved)
  const fresh = await import('./infra')
  state.usage = new Error('offline')
  await act(async () => root.unmount())
  root = createRoot(host)
  await render(<fresh.UsageLine />)
  expect(host.textContent).toContain('Claude 40% · Codex 3%')
})
