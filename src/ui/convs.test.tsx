// @vitest-environment happy-dom
// Imported conversations: plain titles, the choice of agent without a terminal prompt marker, import reachable from the
// conversations page, one plain line to pick the export, filing errors without the raw server message.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationDetail, ConversationSummary, Snapshot } from '../../shared/api.ts'

const conv: ConversationSummary = { id: 'c1', source: 'chatgpt', title: 'Trip plan', projectId: null, updatedAt: 1_800_000_000_000, messageCount: 2, preview: '', status: 'none' }
const detail: ConversationDetail = { conversation: conv, messages: [{ id: 'm1', role: 'user', text: 'Hello', at: 1 }] } as ConversationDetail
vi.mock('../api', () => ({
  api: {
    conversations: async () => ({ conversations: [conv] }),
    conversation: async () => detail,
  },
}))

for (let p: object | null = HTMLElement.prototype; p; p = Object.getPrototypeOf(p)) if (Object.hasOwn(p, 'animate')) delete (p as { animate?: unknown }).animate
const { MotionGlobalConfig } = await import('motion/react')
MotionGlobalConfig.skipAnimations = true
const { ConversationsPage, ConversationPage, ImportPage } = await import('./convs')
const { Ctx } = await import('./app-context')
const { setLang } = await import('../i18n')

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  version: 1, now: 1_800_000_000_000, machines: [], projects: [], sessions: [], h24: [], conversations: [conv],
  conversationCounts: { total: 1, pending: 0, byProject: {} }, classifier: { running: false, queued: 0 }, main: [], mainWorking: false,
  mainHasScreen: false, mainQueued: 0, devil: { enabled: false, working: false }, pinnedRepos: [], config: { userName: '', exposeDomain: '', publicHost: '' },
  ...over,
})

let root: Root
let host: HTMLElement
let pushed: unknown[]

function render(node: React.ReactNode, s = snap()) {
  const ctx = {
    snap: s, now: s.now, offline: false, colors: {}, push: (p: unknown) => void pushed.push(p), replace: () => {}, back: () => {}, home: () => {},
    expanded: null, setExpanded: () => {}, h24Open: false, setH24Open: () => {}, theme: 'light' as const, setTheme: () => {}, refresh: () => {}, logout: () => {},
  }
  act(() => root.render(<Ctx.Provider value={ctx}>{node}</Ctx.Provider>))
}
const flush = () => act(() => new Promise((r) => setTimeout(r, 20)))
const rows = () => [...host.querySelectorAll('button.row')] as HTMLButtonElement[]

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

describe('conversations', () => {
  it('the list page has a plain title and the way to import', async () => {
    render(<ConversationsPage />)
    await flush()
    expect(host.querySelector('h1')!.textContent).toBe('conversations')
    const importLine = rows().find((r) => r.textContent!.includes('import conversations'))!
    await act(async () => importLine.click())
    expect(pushed).toEqual([{ kind: 'import' }])
  })

  it('inside a project, no import line', async () => {
    render(<ConversationsPage projectId="p" />)
    await flush()
    expect(rows().some((r) => r.textContent!.includes('import'))).toBe(false)
  })

  it('continue with: product names, the chosen one ticked, never a ">" prompt marker', async () => {
    render(<ConversationPage id="c1" />)
    await flush()
    const choices = rows().filter((r) => /^(Claude|Codex)$/.test(r.textContent!.replace(/[✓\s]/g, '')))
    expect(choices).toHaveLength(2)
    expect(host.querySelector('.row .st')?.textContent).not.toBe('>')
    expect([...host.querySelectorAll('.row .st')].some((s) => s.textContent === '>')).toBe(false)
    expect(host.querySelector<HTMLInputElement>('.composer input, .composer textarea')!.placeholder).toBe('continue with Claude')
    await act(async () => choices.find((r) => r.textContent!.includes('Codex'))!.click())
    expect(host.querySelector<HTMLInputElement>('.composer input, .composer textarea')!.placeholder).toBe('continue with Codex')
  })

  it('import page: one plain line to pick the export, filing errors without the raw message', () => {
    render(<ImportPage />, snap({ classifier: { running: false, queued: 3, lastError: 'spawn claude ENOENT' } }))
    expect(host.textContent).toContain('pick your ChatGPT or Claude.ai export')
    expect(host.textContent).not.toContain('.zip')
    expect(host.textContent).not.toContain('ENOENT')
    expect(host.textContent).toContain('Filing stopped before the end.')
  })
})
