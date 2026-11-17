// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('../api', () => ({ api: {} }))
import { Composer, type Attachment } from './bits'
import { setLang } from '../i18n'
import { CAPTURE_OFFER_MS } from './capture-suggestion'

let root: Root
let host: HTMLDivElement
let send = vi.fn<(text: string) => void>()
let attach = vi.fn<(text: string, files: Attachment[]) => void>()
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  setLang('en')
  sessionStorage.clear()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  send = vi.fn(); attach = vi.fn()
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { headers: { 'content-type': 'application/json' } }))
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:clipboard-proposal')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})
afterEach(() => {
  act(() => root.unmount()); host.remove()
  vi.useRealTimers(); vi.restoreAllMocks(); setLang(null)
})
const render = (draft?: { text: string; n: number }) => act(() => root.render(<Composer label="message" placeholder="message" horizontal captureSuggestions onSend={send} onAttach={attach} draft={draft} />))
const pasted = (file?: File) => {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { files: file ? [file] : [] } })
  act(() => host.querySelector('textarea')!.dispatchEvent(event))
  return event
}
const proposal = () => host.querySelector<HTMLButtonElement>('.capture-offer')

it('offers a pasted photo for ten seconds, without attaching or sending, then restores +', () => {
  vi.useFakeTimers(); render()
  expect(pasted(new File(['photo'], 'capture.png', { type: 'image/png' })).defaultPrevented).toBe(true)
  expect(proposal()).not.toBeNull(); expect(attach).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled()
  act(() => vi.advanceTimersByTime(CAPTURE_OFFER_MS - 1)); expect(proposal()).not.toBeNull()
  act(() => vi.advanceTimersByTime(1)); expect(proposal()).toBeNull()
  expect(host.querySelector('[aria-label="attach a photo"]')).not.toBeNull()
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:clipboard-proposal')
})
it('only attaches after touching the proposal, and only sends after explicit submit', async () => {
  render({ text: 'look at this', n: 1 })
  pasted(new File(['photo'], 'capture.png', { type: 'image/png' }))
  await act(async () => { proposal()!.click() })
  expect(proposal()).toBeNull(); expect(host.textContent).toContain('1 photo')
  expect(attach).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled()
  await act(async () => host.querySelector('form')!.requestSubmit())
  expect(attach).toHaveBeenCalledWith('look at this', [expect.objectContaining({ name: 'capture.png', type: 'image/png' })])
  expect(send).not.toHaveBeenCalled()
})
it('leaves text paste and native selection alone, isolates text gestures, and protects composing Enter', async () => {
  render({ text: 'long draft '.repeat(80), n: 1 })
  const field = host.querySelector('textarea')!
  expect(field.getAttribute('wrap')).toBe('off'); expect(field.getAttribute('rows')).toBe('1')
  expect(pasted().defaultPrevented).toBe(false)
  field.setSelectionRange(20, 35); expect(field.selectionStart).toBe(20); expect(field.selectionEnd).toBe(35)
  const pageGesture = vi.fn(); document.addEventListener('touchmove', pageGesture)
  act(() => field.dispatchEvent(new Event('touchmove', { bubbles: true, cancelable: true })))
  expect(pageGesture).not.toHaveBeenCalled()
  document.removeEventListener('touchmove', pageGesture)
  act(() => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true })))
  expect(send).not.toHaveBeenCalled()
  await act(async () => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(send).toHaveBeenCalledTimes(1)
})
it('does not read the clipboard when persistent access is unavailable or denied', async () => {
  const read = vi.fn()
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  vi.spyOn(navigator.permissions, 'query').mockResolvedValue({ state: 'denied' } as PermissionStatus)
  Object.defineProperty(navigator.clipboard, 'read', { value: read, configurable: true })
  render()
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(read).not.toHaveBeenCalled(); expect(proposal()).toBeNull()
})

it('does not poll or request access when the browser does not support persistent clipboard permissions', async () => {
  const read = vi.fn()
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  vi.spyOn(navigator.permissions, 'query').mockRejectedValue(new TypeError('unsupported permission'))
  Object.defineProperty(navigator.clipboard, 'read', { value: read, configurable: true })
  render()
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(read).not.toHaveBeenCalled()
  expect(proposal()).toBeNull()
  pasted(new File(['photo'], 'manual.png', { type: 'image/png' }))
  expect(proposal()).not.toBeNull()
})
it('offers an authorized clipboard image at focus, then does not resurface the same expired image', async () => {
  vi.useFakeTimers()
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  vi.spyOn(navigator.permissions, 'query').mockResolvedValue({ state: 'granted' } as PermissionStatus)
  const blob = new Blob(['photo'], { type: 'image/png' })
  const read = vi.fn().mockResolvedValue([{ types: ['image/png'], getType: async () => blob }])
  Object.defineProperty(navigator.clipboard, 'read', { value: read, configurable: true })
  vi.spyOn(crypto.subtle, 'digest').mockResolvedValue(new Uint8Array([1, 2, 3]).buffer)
  render()
  expect(read).not.toHaveBeenCalled()
  await act(async () => { window.dispatchEvent(new Event('focus')) })
  expect(proposal()).not.toBeNull()
  expect(attach).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled()
  act(() => vi.advanceTimersByTime(CAPTURE_OFFER_MS))
  expect(proposal()).toBeNull()
  await act(async () => { window.dispatchEvent(new Event('focus')) })
  expect(read).toHaveBeenCalledTimes(2)
  expect(proposal()).toBeNull()
})
it('does not re-offer an explicitly pasted image when returning to the app after expiry', async () => {
  vi.useFakeTimers()
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  vi.spyOn(navigator.permissions, 'query').mockResolvedValue({ state: 'granted' } as PermissionStatus)
  const file = new File(['photo'], 'manual.png', { type: 'image/png' })
  const read = vi.fn().mockResolvedValue([{ types: ['image/png'], getType: async () => file }])
  Object.defineProperty(navigator.clipboard, 'read', { value: read, configurable: true })
  vi.spyOn(crypto.subtle, 'digest').mockResolvedValue(new Uint8Array([4, 5, 6]).buffer)
  render()
  await act(async () => { pasted(file) })
  expect(proposal()).not.toBeNull()
  act(() => vi.advanceTimersByTime(CAPTURE_OFFER_MS))
  await act(async () => { window.dispatchEvent(new Event('focus')) })
  expect(read).toHaveBeenCalledOnce()
  expect(proposal()).toBeNull()
})

it('locks synchronous duplicate submits and preserves the draft until acknowledgement', async () => {
  let acknowledge!: () => void
  send.mockImplementation(() => new Promise<void>((resolve) => { acknowledge = resolve }))
  render({ text: 'one message', n: 1 })
  act(() => {
    host.querySelector('form')!.requestSubmit()
    host.querySelector('form')!.requestSubmit()
  })
  expect(send).toHaveBeenCalledTimes(1)
  expect(host.querySelector('textarea')!.value).toBe('one message')
  expect(sessionStorage.getItem('weevils-draft:message')).toBe('one message')
  expect(host.querySelector('form')!.getAttribute('aria-busy')).toBe('true')
  await act(async () => acknowledge())
  expect(host.querySelector('textarea')!.value).toBe('')
  expect(sessionStorage.getItem('weevils-draft:message')).toBeNull()
})

it('keeps the original draft on rejection and a new dictation arriving during acknowledgement', async () => {
  let reject!: (e: Error) => void
  send.mockImplementation(() => new Promise<void>((_, fail) => { reject = fail }))
  render({ text: 'keep this', n: 1 })
  act(() => host.querySelector('form')!.requestSubmit())
  render({ text: 'and this too', n: 2 })
  await act(async () => reject(new Error('offline')))
  expect(host.querySelector('textarea')!.value).toBe('keep this and this too')
  expect(sessionStorage.getItem('weevils-draft:message')).toBe('keep this and this too')
  expect(host.querySelector('button.send')!.hasAttribute('disabled')).toBe(false)
})

it('sends the final IME value present in the field, even before React onChange', async () => {
  render({ text: 'unfinished', n: 1 })
  host.querySelector('textarea')!.value = 'final composition'
  await act(async () => host.querySelector('form')!.requestSubmit())
  expect(send).toHaveBeenCalledWith('final composition')
})

it('keeps one draft per conversation: switching and reloading never moves text between sessions', () => {
  sessionStorage.clear()
  const as = (id: string) => act(() => root.render(<Composer draftKey={`session:${id}`} label="message" placeholder="message" horizontal onSend={send} />))
  const type = (v: string) => act(() => {
    const f = host.querySelector('textarea')!
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(f, v)
    f.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const shown = () => host.querySelector('textarea')!.value
  as('A'); type('draft for A')
  as('B'); expect(shown()).toBe('')
  type('draft for B')
  as('A'); expect(shown()).toBe('draft for A')
  expect(sessionStorage.getItem('weevils-draft:session:A')).toBe('draft for A')
  expect(sessionStorage.getItem('weevils-draft:session:B')).toBe('draft for B')
  // reload: fresh mount reads each session's own draft
  act(() => root.unmount()); root = createRoot(host)
  as('B'); expect(shown()).toBe('draft for B')
  as('A'); expect(shown()).toBe('draft for A')
})
