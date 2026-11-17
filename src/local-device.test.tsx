// @vitest-environment happy-dom
// This machine's own browser, opened without the login link: trusted by the server, but only a device may write to
// weevboss (server/boss-door.ts). The app claims one at start; an automated browser never does, and says so on
// every request, so a test script driving the app can never speak as the user.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api, useLive } from './api'
import { setLang } from './i18n'

let root: Root, host: HTMLDivElement
let requests: { path: string; method: string; automated: string | null }[]
let me: { authed: boolean; device?: boolean }
const snapshot = { version: 1, now: 1, sessions: [], projects: [], machines: [], main: [], config: { userName: '', publicHost: '' } }
function Entry() {
  const live = useLive()
  return <output>{String(live.authed)}</output>
}
const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 10)))
beforeEach(() => {
  setLang('en'); history.replaceState(null, '', '/')
  requests = []; me = { authed: true, device: false }
  // happy-dom says it is automated, as a test browser should: these tests choose.
  Object.defineProperty(navigator, 'webdriver', { value: false, configurable: true })
  vi.stubGlobal('EventSource', class extends EventTarget { close() {} })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    const path = String(url)
    requests.push({ path, method: options?.method ?? 'GET', automated: new Headers(options?.headers).get('x-weevils-automated') })
    const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
    if (path === '/api/me') return response(me)
    if (path === '/api/login/local') return response({ ok: true })
    if (path === '/api/snapshot') return response(snapshot)
    return response({})
  })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove()
  vi.restoreAllMocks(); vi.unstubAllGlobals(); setLang(null)
  Object.defineProperty(navigator, 'webdriver', { value: false, configurable: true })
})

it('a real browser on this machine claims a device before it loads', async () => {
  await act(async () => root.render(<Entry />)); await flush()
  const claim = requests.findIndex((r) => r.path === '/api/login/local')
  expect(claim).toBeGreaterThan(-1)
  expect(requests[claim].method).toBe('POST')
  expect(claim).toBeLessThan(requests.findIndex((r) => r.path === '/api/snapshot'))
  expect(requests.every((r) => r.automated === null)).toBe(true)
})

it('a device already, or not trusted at all: nothing to claim', async () => {
  me = { authed: true, device: true }
  await act(async () => root.render(<Entry />)); await flush()
  expect(requests.some((r) => r.path === '/api/login/local')).toBe(false)
})

it('an automated browser never claims a device and marks every request', async () => {
  Object.defineProperty(navigator, 'webdriver', { value: true, configurable: true })
  await act(async () => root.render(<Entry />)); await flush()
  expect(requests.some((r) => r.path === '/api/login/local')).toBe(false)
  await api.me()
  expect(requests.at(-1)).toMatchObject({ path: '/api/me', automated: '1' })
})
