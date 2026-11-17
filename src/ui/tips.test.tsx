// @vitest-environment happy-dom
// A tip card says its thing: no "tip" / "for you" kind label printed on top of every card.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({ api: { transcribeInfo: async () => ({ enabled: false }), push: async () => ({ enabled: false }) } }))
for (let p: object | null = HTMLElement.prototype; p; p = Object.getPrototypeOf(p)) if (Object.hasOwn(p, 'animate')) delete (p as { animate?: unknown }).animate
const { MotionGlobalConfig } = await import('motion/react')
MotionGlobalConfig.skipAnimations = true
const { Tips } = await import('./tips')
const { Ctx } = await import('./app-context')
const { setLang } = await import('../i18n')

let root: Root
let host: HTMLElement

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers({ toFake: ['setInterval', 'setTimeout', 'Date'] })
  setLang('en')
  localStorage.clear()
  localStorage.setItem('weevils-tips-debug', '1')
  localStorage.setItem('weevils-onboarded', '1')
  globalThis.fetch = (async () => new Response(JSON.stringify({ tips: [{ id: 'srv:1', rule: 'unread', personal: true, text: 'Two sessions finished overnight' }] }))) as typeof fetch
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
  setLang(null)
})

it('shows the card text and its close button, without a kind label', async () => {
  const ctx = { snap: { projects: [] }, h24Open: false, push: () => {}, refresh: () => {}, colors: {} }
  act(() => root.render(<Ctx.Provider value={ctx as never}><Tips paused={false} /></Ctx.Provider>))
  for (let i = 0; i < 4 && !host.querySelector('.tip'); i++) await act(async () => void (await vi.advanceTimersByTimeAsync(6_000)))
  const card = host.querySelector('.tip')!
  expect(card.textContent).toContain('Two sessions finished overnight')
  expect(card.querySelector('.tip-kind')).toBeNull()
  expect(card.querySelector('.tip-top')!.textContent).not.toMatch(/for you|tip/)
  expect(card.querySelector('.tip-x')).not.toBeNull()
})
