// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Ctx } from './app-context'
import { GONE_MS, GoneBack } from './gone'
import { setLang } from '../i18n'

let root: Root
let host: HTMLElement
let moves: string[]
const render = () => act(() => root.render(<Ctx.Provider value={{ back: () => moves.push('back'), home: () => moves.push('home') } as never}><GoneBack /></Ctx.Provider>))

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  setLang('en')
  moves = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

it('a missing page says so in plain words, then takes the reader back on its own', () => {
  render()
  expect(host.textContent).toContain('This page was closed or has moved. Taking you back…')
  expect(host.textContent).not.toContain('not found')
  act(() => void vi.advanceTimersByTime(GONE_MS - 1))
  expect(moves).toEqual([])
  act(() => void vi.advanceTimersByTime(1))
  expect(moves).toEqual(['back'])
  // Nothing to go back to (still here): the stream.
  act(() => void vi.advanceTimersByTime(400))
  expect(moves).toEqual(['back', 'home'])
})

it('leaving before the delay cancels the return', () => {
  render()
  act(() => root.unmount())
  root = createRoot(host)
  act(() => void vi.advanceTimersByTime(GONE_MS + 1000))
  expect(moves).toEqual([])
})
