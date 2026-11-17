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
let requests: { path: string; body?: string; locale: string | null }[]
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
    requests.push({ path, locale: new Headers(options?.headers).get('X-Weevils-Locale'), body: typeof options?.body === 'string' ? options.body : undefined })
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

it('normal entry carries selected locale and refreshes FR→EN→FR without replacing its mounted view',async()=>{
 authenticated=true
 setLang('fr')
 await act(async()=>root.render(<Entry/>));await flush()
 const output=host.querySelector('output')!
 const french=output.textContent
 await act(async()=>setLang('en'));await flush()
 expect(host.querySelector('output')).toBe(output)
 expect(output.textContent).not.toBe(french)
 await act(async()=>setLang('fr'));await flush()
 expect(output.textContent).toBe(french)
 expect(requests.filter(r=>r.path==='/api/snapshot').map(r=>r.locale)).toEqual(['fr','en','fr'])
 expect(requests.some(r=>r.path==='/api/prefs')).toBe(false)
})

it('refreshes translated titles and activities after an asynchronous source update without remounting', async () => {
 authenticated = true
 let events!: EventTarget
 vi.stubGlobal('EventSource', class extends EventTarget { constructor() { super(); events = this } close() {} })
 let translated = false
 const base = vi.mocked(fetch).getMockImplementation()!
 vi.mocked(fetch).mockImplementation(async (url, options) => {
  if (String(url) !== '/api/snapshot') return base(url, options)
  const locale = new Headers(options?.headers).get('X-Weevils-Locale')
  const en = translated && locale === 'en'
  return new Response(JSON.stringify({ ...snapshot, version: translated ? 2 : 1, sessions: [{ id: 'stable-session', title: en ? 'Folder management' : 'Gestion dossiers', now: en ? 'Checks files' : 'Vérifie les fichiers' }] }), { headers: { 'content-type': 'application/json' } })
 })
 await act(async () => root.render(<Entry />)); await flush()
 const output = host.querySelector('output')!
 expect(output.textContent).toContain('Gestion dossiers')
 translated = true
 await act(async () => events.dispatchEvent(new MessageEvent('version', { data: '2' }))); await flush()
 expect(host.querySelector('output')).toBe(output)
 expect(output.textContent).toContain('Folder management')
 expect(output.textContent).toContain('Checks files')
 await act(async () => setLang('fr')); await flush()
 expect(output.textContent).toContain('Gestion dossiers')
 expect(output.textContent).toContain('stable-session')
 expect(host.querySelector('output')).toBe(output)
})
