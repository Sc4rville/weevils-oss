// @vitest-environment happy-dom
// The memory page: newest first, « + » then Enter keeps a memory, a tap opens it in place (origin shown), an edit saves
// on Enter, Esc cancels, « forget » takes two taps, a selection asks with kind memory.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExplainRequest, MemoryItem, Snapshot } from '../../shared/api.ts'

const db = vi.hoisted(() => ({ items: [] as MemoryItem[], calls: [] as string[], explained: [] as ExplainRequest[] }))

vi.mock('../api', () => ({
  api: {
    memory: async () => ({ items: db.items.map((m) => ({ ...m })) }),
    addMemory: async (text: string) => {
      db.calls.push(`add ${text}`)
      if (text.includes('sk-')) throw new Error('looks like a secret: not kept')
      const item: MemoryItem = { id: `n${db.items.length}`, text, source: 'manual', at: 9e12, updatedAt: 9e12 }
      db.items.push(item)
      return { item }
    },
    editMemory: async (id: string, text: string) => {
      db.calls.push(`edit ${id} ${text}`)
      if (text.includes('sk-')) throw new Error('looks like a secret: not kept')
      const m = db.items.find((x) => x.id === id)!
      m.text = text
      return { item: { ...m } }
    },
    deleteMemory: async (id: string) => {
      db.calls.push(`delete ${id}`)
      db.items = db.items.filter((x) => x.id !== id)
      return { ok: true }
    },
    explain: async (req: ExplainRequest) => {
      db.explained.push(req)
      return { text: 'because you said so' }
    },
  },
}))
vi.mock('./voice', () => ({ VoiceLogo: () => null }))

// No animation in happy-dom (a canceled Web Animation rejects there).
const { MotionGlobalConfig } = await import('motion/react')
MotionGlobalConfig.skipAnimations = true
const { MemoryPage } = await import('./memory')
const { Ctx } = await import('./app-context')

const snap = (count: number): Snapshot => ({
  version: 1,
  now: Date.now(),
  machines: [],
  projects: [],
  sessions: [],
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
  memoryCount: count,
  config: { userName: '', exposeDomain: '', publicHost: '' },
})

let root: Root
let host: HTMLElement

function render(count: number) {
  const ctx = {
    snap: snap(count),
    now: Date.now(),
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
  act(() =>
    root.render(
      <Ctx.Provider value={ctx}>
        <MemoryPage />
      </Ctx.Provider>,
    ),
  )
}

const flush = () => act(() => new Promise((r) => setTimeout(r, 30)))
const rows = () => [...host.querySelectorAll('.mem-text')].map((n) => n.textContent)
const setValue = async (field: HTMLTextAreaElement, text: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, text)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const key = (field: HTMLElement, k: string) => act(async () => void field.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })))
const click = (el: Element) => act(async () => void (el as HTMLElement).click())

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.setItem('weevils-lang', 'en')
  db.items = [
    { id: 'a', text: 'climbs on Sundays', source: 'manual', at: 1000, updatedAt: 5000 },
    { id: 'b', text: 'wants to ship a mobile game', source: 'answer', q: 'and in ten years?', a: 'a game a year', at: 2000, updatedAt: 2000 },
  ]
  db.calls = []
  db.explained = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('memory page', () => {
  it('lists newest first and adds with Enter', async () => {
    render(2)
    await flush()
    expect(rows()).toEqual(['wants to ship a mobile game', 'climbs on Sundays'])
    const field = host.querySelector<HTMLTextAreaElement>('.mem-add textarea')!
    await setValue(field, '  likes   tea ')
    await key(field, 'Enter')
    await flush()
    expect(db.calls).toEqual(['add likes tea'])
    expect(rows()[0]).toBe('likes tea')
    expect(field.value).toBe('')
  })

  it('opens in place with its origin; Enter saves an edit, Esc cancels one', async () => {
    render(2)
    await flush()
    await click(host.querySelector('.mem-row')!)
    await flush()
    const field = host.querySelector<HTMLTextAreaElement>('.mem-edit textarea')!
    expect(field.value).toBe('wants to ship a mobile game')
    expect(host.querySelector('.mem-from')!.textContent).toContain('“and in ten years?”')

    act(() => field.focus())
    await setValue(field, 'wants to ship two games')
    await key(field, 'Enter')
    await flush()
    expect(db.calls).toEqual(['edit b wants to ship two games'])
    // A hand edit keeps where the memory came from.
    expect(host.querySelector('.mem-from')!.textContent).toContain('“and in ten years?”')

    // Esc cancels the edit and stays on the page (App closes the page on an Esc reaching the window).
    const closed = vi.fn()
    window.addEventListener('keydown', closed)
    act(() => field.focus())
    await setValue(field, 'nope')
    await key(field, 'Escape')
    await flush()
    window.removeEventListener('keydown', closed)
    expect(closed).not.toHaveBeenCalled()
    expect(db.calls).toHaveLength(1)
    expect(field.value).toBe('wants to ship two games')
  })

  it('a refused write shows its reason a moment under its field, then it goes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))
    const notes = () => [...host.querySelectorAll('[role="alert"]')].map((n) => n.textContent)
    try {
      render(2)
      await tick(30)
      const field = host.querySelector<HTMLTextAreaElement>('.mem-add textarea')!
      await setValue(field, 'my key is sk-abcdefghijklmnop')
      await key(field, 'Enter')
      await tick(30)
      expect(notes()).toEqual(['! looks like a secret: not kept'])
      // Right under « + », and what was typed stays to be fixed.
      expect(host.querySelector('.mem-add')!.nextElementSibling!.textContent).toBe('! looks like a secret: not kept')
      expect(field.value).toBe('my key is sk-abcdefghijklmnop')
      expect(rows()).toHaveLength(2)
      await tick(4000)
      expect(notes()).toEqual([])

      // An edit: under the open memory, which keeps its words.
      await click(host.querySelector('.mem-row')!)
      await tick(30)
      const edit = host.querySelector<HTMLTextAreaElement>('.mem-edit textarea')!
      act(() => edit.focus())
      await setValue(edit, 'ships with sk-abcdefghijklmnop')
      await key(edit, 'Enter')
      await tick(30)
      expect(host.querySelector('.mem-item.open [role="alert"]')!.textContent).toBe('! looks like a secret: not kept')
      expect(edit.value).toBe('wants to ship a mobile game')
      await tick(4000)
      expect(notes()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('forgets on the second tap only', async () => {
    render(2)
    await flush()
    await click(host.querySelectorAll('.mem-row')[1])
    await flush()
    const del = host.querySelector('.mem-del')!
    // Plain words, no "x" glyph in front.
    expect(del.textContent).toBe('forget')
    await click(del)
    expect(db.calls).toEqual([])
    expect(del.className).toContain('on')
    expect(del.textContent).toBe('sure?')
    await click(del)
    await flush()
    expect(db.calls).toEqual(['delete a'])
    expect(rows()).toEqual(['wants to ship a mobile game'])
    expect(host.querySelector('.mem-edit')).toBeNull()
  })

  it('a selection shows the question bar, explained with kind memory', async () => {
    render(2)
    await flush()
    await click(host.querySelector('.mem-row')!)
    await flush()
    const field = host.querySelector<HTMLTextAreaElement>('.mem-edit textarea')!
    await act(async () => {
      field.focus()
      field.setSelectionRange(16, 22)
      field.dispatchEvent(new Event('select', { bubbles: true }))
    })
    await flush()
    const explain = [...host.querySelectorAll('.qa-bar .word')].find((b) => b.textContent === 'explain')
    expect(explain).toBeTruthy()
    await click(explain!)
    await flush()
    expect(db.explained[0]).toMatchObject({ kind: 'memory', path: 'b', selection: 'mobile', mode: 'explain' })
    expect(host.querySelector('.qa-text')!.textContent).toBe('because you said so')
  })

  it('a short line when empty', async () => {
    db.items = []
    render(0)
    await flush()
    // In place of the count, under the title; nothing in the page itself.
    expect([...host.querySelectorAll('.meta')].map((n) => n.textContent)).toContain('no memories yet')
    expect(host.querySelectorAll('.mem-item')).toHaveLength(0)
  })
})
