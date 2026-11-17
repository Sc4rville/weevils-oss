// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('./setup', () => ({ KeyChip: ({ name }: { name: string }) => <button type="button">{name}</button> }))
import { LiveLine, startLive, stopLive } from './live'
import { setLang } from '../i18n'
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

// A fake /api/live: the first server message is chosen by each test.
let first = ''
let sent: unknown[] = []
class FakeSocket {
  static OPEN = 1
  readyState = 1
  binaryType = ''
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(public url: string) {
    setTimeout(() => this.onmessage?.({ data: first }), 0)
  }
  send(d: unknown) {
    sent.push(d)
  }
  close() {}
}

let root: Root, host: HTMLDivElement
beforeEach(() => {
  setLang('en')
  sent = []
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('AudioContext', class { state = 'running'; resume = async () => {}; suspend = async () => {} })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  setLang(null)
})

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 10))))

it('without a Gemini key: a calm line and the masked-key button, no microphone', async () => {
  first = JSON.stringify({ t: 'nokey' })
  const getUserMedia = vi.fn()
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  await act(async () => root.render(<LiveLine />))
  await act(async () => startLive())
  await settle()
  expect(host.textContent).toContain('to talk live, add your Gemini key')
  expect(host.querySelector('button')?.textContent).toBe('GEMINI_API_KEY')
  expect(getUserMedia).not.toHaveBeenCalled()
})

it('a billing refusal says what to do, in the app’s language', async () => {
  setLang('fr')
  first = JSON.stringify({ t: 'error', code: 'billing' })
  await act(async () => root.render(<LiveLine />))
  await act(async () => startLive())
  await settle()
  expect(host.textContent).toContain('crédits Gemini épuisés')
  expect(host.querySelector('button')).toBeNull()
})

it('a tap ends it and tells the server', async () => {
  first = JSON.stringify({ t: 'cost', usd: 0.004 })
  await act(async () => root.render(<LiveLine />))
  await act(async () => startLive())
  await settle()
  expect(host.textContent).toMatch(/live · 0:0\d · 0\.4 ¢/)
  await act(async () => stopLive())
  expect(sent).toContain(JSON.stringify({ t: 'bye' }))
  expect(host.textContent).not.toContain('live ·')
})
