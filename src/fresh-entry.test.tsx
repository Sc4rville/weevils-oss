// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useLive } from './api'
import { Login } from './ui/login'
import { setLang } from './i18n'

// Exercise the real authentication hook and login form with empty device storage.
// No account, CLI state, provider key or model request is available to this client.
let root: Root, host: HTMLDivElement, authenticated: boolean
let requests: { path: string; body?: string }[]
const snapshot = { version: 1, now: 1, sessions: [], projects: [], machines: [{ id: 'fresh', name: 'fresh' }], main: [{ id: 'hello', role: 'assistant', text: 'server greeting', at: 1 }], config: { userName: '', publicHost: '' } }
function Entry() {
  const live = useLive()
  if (live.authed === false) return <Login onDone={() => live.setAuthed(true)} />
  return <output>{live.snap ? JSON.stringify(live.snap) : 'connecting'}</output>
}
const flush = () => act(() => new Promise(resolve => setTimeout(resolve, 10)))
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); setLang('en')
  history.replaceState(null, '', '/')
  authenticated = false; requests = []
  vi.stubGlobal('EventSource', class extends EventTarget { close() {} })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    const path = String(url)
    requests.push({ path, body: typeof options?.body === 'string' ? options.body : undefined })
    const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
    if (path === '/api/me') return response({ authed: authenticated })
    if (path === '/api/login') {
      authenticated = JSON.parse(String(options?.body)).secret === 'fresh-access-code'
      return authenticated ? response({ ok: true }) : response({ error: 'Access code refused' }, 401)
    }
    if (path === '/api/snapshot') return authenticated ? response(snapshot) : response({ error: 'not signed in' }, 401)
    throw new Error(`Unexpected route: ${path}`)
  })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); setLang(null); history.replaceState(null, '', '/') })
async function type(value: string) {
  const input = host.querySelector('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
it('starts at login, preserves a refused code for correction, then loads only the blank instance', async () => {
  await act(async () => root.render(<Entry />)); await flush()
  expect(host.querySelector('form')).not.toBeNull()
  expect(requests.some(r => r.path === '/api/snapshot')).toBe(false)
  await type('wrong-code')
  await act(async () => host.querySelector('form')!.requestSubmit()); await flush()
  expect(host.querySelector('input')!.value).toBe('wrong-code')
  expect(host.querySelector('[role=alert]')?.textContent).toContain('Access code refused')
  await type('fresh-access-code')
  await act(async () => host.querySelector('form')!.requestSubmit()); await flush()
  const loaded = JSON.parse(host.querySelector('output')!.textContent!)
  expect(loaded.sessions).toEqual([]); expect(loaded.projects).toEqual([])
  expect(loaded.config.userName).toBe('')
  expect(loaded.main[0].text).not.toBe('server greeting')
  expect(requests.every(r => ['/api/me', '/api/login', '/api/snapshot'].includes(r.path))).toBe(true)
  expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain('fresh-access-code')
})
it.each([['fresh-access-code', true], ['invalid-code', false]] as const)('consumes the QR access code %s without keeping it in the URL or device storage', async (code, accepted) => {
  history.replaceState(null, '', `/#k=${code}`)
  await act(async () => root.render(<Entry />)); await flush()
  expect(location.hash).toBe('')
  expect(host.querySelector('form') !== null).toBe(!accepted)
  expect(requests.filter(r => r.path === '/api/login')).toHaveLength(1)
  expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(code)
})
