// @vitest-environment happy-dom
// A session's settings are its model and effort only, applied by the server in one tap (no slash command typed from
// the app); fast mode, « tidy up » and « start over » are gone (Scarville, 2026-11-17).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const chosen: unknown[] = []
const controls = (model: string, effort: string) => ({ threadId: 's1', tool: 'claude', models: ['fable', 'opus', 'sonnet', 'haiku'].map((id) => ({ id, label: id, efforts: ['low', 'medium', 'high', 'max'], defaultEffort: 'medium' })), selected: { model, effort }, active: false, appliesTo: 'next-turn' })
vi.mock('../api', () => ({ api: { transcribeInfo: async () => ({ enabled: false }), modelControls: async () => controls('sonnet', 'medium'), setModelControls: async (_id: string, sel: { model: string; effort: string }) => { chosen.push(sel); return controls(sel.model, sel.effort) } } }))
for (let p: object | null = HTMLElement.prototype; p; p = Object.getPrototypeOf(p)) if (Object.hasOwn(p, 'animate')) delete (p as { animate?: unknown }).animate

const { setLang } = await import('../i18n')
const { Settings } = await import('./settings')

let root: Root
let host: HTMLElement
const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
const button = (label: string) => [...host.querySelectorAll<HTMLElement>('button, [role=button]')].find((b) => text(b) === label)!
const flush = () => act(() => new Promise((r) => setTimeout(r, 0)))

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  chosen.length = 0
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

it('one tap on a model is the whole action: sent to the server, no slash command, nothing else in the sheet', async () => {
  act(() => root.render(<Settings id="s1" />))
  await flush()
  expect(text(host)).not.toMatch(/fast mode|tidy up|start over|\//)
  expect(button('sonnet').getAttribute('aria-pressed')).toBe('true')
  act(() => button('opus').click())
  await flush()
  expect(chosen).toEqual([{ model: 'opus', effort: 'medium' }])
  expect(button('opus').getAttribute('aria-pressed')).toBe('true')
  act(() => button('high').click())
  await flush()
  expect(chosen.at(-1)).toEqual({ model: 'opus', effort: 'high' })
})
