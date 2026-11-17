// @vitest-environment happy-dom
// The app preview: address chips the phone can actually open (no localhost, no ports), host name only; a plain
// placeholder instead of "https://".
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({ api: {} }))
const { setLang } = await import('../i18n')
const { Preview } = await import('./preview')

let root: Root
let host: HTMLElement
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
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

it('offers only reachable addresses as host-name chips, and a chip opens the full address', () => {
  const onUrl = vi.fn()
  const suggestions = ['http://localhost:5173/', 'https://app.example.com/dashboard', 'http://127.0.0.1:3000', 'https://app.example.com/other', 'https://demo.dev:8443/a', 'http://0.0.0.0:8080']
  act(() => root.render(<Preview url="" suggestions={suggestions} onUrl={onUrl} onClose={() => {}} />))
  const chips = [...host.querySelectorAll<HTMLButtonElement>('.preview-hints button')]
  expect(chips.map((b) => b.textContent)).toEqual(['app.example.com', 'demo.dev'])
  expect(host.textContent).not.toMatch(/localhost|127\.0\.0\.1|0\.0\.0\.0|:\d{4}/)
  act(() => chips[1].click())
  expect(onUrl).toHaveBeenCalledWith('https://demo.dev:8443/a')
  expect(host.querySelector('input')!.placeholder).toBe('app address')
  act(() => setLang('fr'))
  expect(host.querySelector('input')!.placeholder).toBe('adresse de l’appli')
})
