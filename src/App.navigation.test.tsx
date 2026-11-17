// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MotionGlobalConfig } from 'motion/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useApp, type Page } from './ui/app-context'
import { focusBoss, bossOnReturn } from './ui/follow'
const live = vi.hoisted(() => ({ snap: { version: 1, now: 1, sessions: [], projects: [], h24: [], main: [], config: {}, devil: { enabled: false } }, authed: true, refresh: () => {}, setAuthed: () => {} }))
vi.mock('./api', () => ({ useLive: () => live, api: {} }))
vi.mock('./push', () => ({ ensurePush: async () => {} }))
vi.mock('./ui/hints', () => ({ loadHints: async () => {}, HintBubble: () => null, markSeen: () => {} }))
vi.mock('./ui/relay', () => ({ RelayBand: () => null }))
vi.mock('./ui/h24', () => ({ H24Rail: () => null }))
vi.mock('./ui/tips', () => ({ Tips: () => null }))
vi.mock('./ui/coach', () => ({ GestureCoach: () => null }))
vi.mock('./ui/auto-talk', () => ({ TalkProvider: ({ children }: { children: React.ReactNode }) => children }))
vi.mock('./ui/bands', () => ({ AgentBand: () => <Probe />, ProjectBand: () => null, FootBand: () => null }))
vi.mock('./ui/pages', () => ({ PageView: ({ page }: { page: Page }) => <PageProbe page={page} /> }))
vi.mock('./ui/follow', async (original) => ({ ...await original<typeof import('./ui/follow')>(), toTop: () => window.scrollTo({ top: 0 }), when: (_: unknown, done: () => void) => done(), reveal: () => {}, flashBossMessage: () => {} }))
import App from './App'
function Probe() {
  const c = useApp()
  const [draft, setDraft] = useState('draft preserved')
  return <section data-open={c.expanded === 'agent'}><input value={draft} onChange={e => setDraft(e.target.value)} /><button id="open" onClick={() => c.setExpanded('agent')}>open</button><button id="close" onClick={() => c.setExpanded(null)}>close</button><button id="feed" onClick={() => c.push({ kind: 'foryou' })}>feed</button><button id="overview" onClick={() => c.push({ kind: 'calm' })}>legacy overview</button><button id="conversation" onClick={() => c.push({ kind: 'calmconv', id: 'existing-session' })}>conversation</button></section>
}
function PageProbe({ page }: { page: Page }) {
  const c = useApp()
  return <div className="page" data-kind={page.kind} data-target={'id' in page ? page.id : undefined}><button id="page-overview" onClick={() => c.push({ kind: 'calm' })}>legacy overview</button><button id="replace-overview" onClick={() => c.replace({ kind: 'calm' })}>replace overview</button><button id="back" onClick={c.back}>back</button><button id="home" onClick={c.home}>projects</button><button id="boss" onClick={() => focusBoss({ flash: false })}>boss</button></div>
}
let host: HTMLDivElement, root: Root, entries: unknown[], cursor: number, y: number
const flush = () => act(() => new Promise(r => setTimeout(r, 30)))
const click = async (id: string) => { await act(async () => host.querySelector<HTMLButtonElement>(`#${id}`)!.click()); await flush() }
const open = () => host.querySelector('section')?.getAttribute('data-open') === 'true'
beforeEach(async () => {
  localStorage.clear(); sessionStorage.clear()
  MotionGlobalConfig.skipAnimations = true
  entries = [{ w: 0 }]; cursor = 0; y = 0
  vi.spyOn(history, 'replaceState').mockImplementation(state => { entries[cursor] = state })
  vi.spyOn(history, 'pushState').mockImplementation(state => { entries.splice(cursor + 1); entries.push(state); cursor++ })
  const go = (delta = 0) => { cursor = Math.max(0, cursor + delta); window.dispatchEvent(new PopStateEvent('popstate', { state: entries[cursor] })) }
  vi.spyOn(history, 'go').mockImplementation(go)
  vi.spyOn(history, 'back').mockImplementation(() => go(-1))
  vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => y)
  vi.spyOn(window, 'scrollTo').mockImplementation((options: ScrollToOptions | number) => { y = typeof options === 'number' ? options : options.top ?? 0 })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(<App />))
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks() })
it('fullscreen → feed → boss → close returns to projects and restores the previous scroll and draft', async () => {
  y = 360
  await click('open'); expect(open()).toBe(true); expect(cursor).toBe(1)
  await click('feed'); expect(cursor).toBe(2)
  await click('boss'); expect(open()).toBe(true); expect(cursor).toBe(1)
  await click('close'); expect(open()).toBe(false); expect(cursor).toBe(0); expect(y).toBe(360)
  expect(host.querySelector('input')!.value).toBe('draft preserved')
  expect(host.querySelector('main')!.inert).toBe(false)
})
it('projects exits both fullscreen layers, while browser back restores the preceding fullscreen view', async () => {
  await click('open'); await click('feed')
  await act(async () => history.back()); await flush()
  expect(open()).toBe(true); expect(cursor).toBe(1)
  await click('feed'); await click('home')
  expect(cursor).toBe(0); expect(open()).toBe(false); expect(host.querySelector('main')!.inert).toBe(false)
})
it('feed opened from home returns home; Escape closes fullscreen without leaving the app', async () => {
  await click('feed'); await click('back'); expect(cursor).toBe(0); expect(open()).toBe(false)
  await click('open')
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
  await flush(); expect(cursor).toBe(0); expect(open()).toBe(false)
})

it('repeated feed taps add one page and an explicit projects exit overrides a queued boss notification', async () => {
  await act(async () => { host.querySelector<HTMLButtonElement>('#feed')!.click(); host.querySelector<HTMLButtonElement>('#feed')!.click() })
  expect(cursor).toBe(1)
  bossOnReturn({ flash: false })
  await click('home')
  expect(cursor).toBe(0); expect(open()).toBe(false)
})

it('the feed chevron returns to fullscreen boss, then closing returns to the normal page',async()=>{
 await click('open');await click('feed');await click('back')
 expect(open()).toBe(true)
 await click('close')
 expect(open()).toBe(false)
 expect(host.querySelector('main')!.inert).toBe(false)
})
it('reloading from fullscreen leaves a usable normal page and the next feed chevron still returns',async()=>{
 await click('open');await click('feed')
 await act(async()=>root.unmount())
 root=createRoot(host)
 await act(async()=>root.render(<App/>));await flush()
 expect(open()).toBe(false)
 expect(host.querySelector('main')!.inert).toBe(false)
 await click('feed');await click('back')
 expect(host.querySelector('.page')).toBeNull()
 expect(host.querySelector('main')!.inert).toBe(false)
})


it('ignores retired overview entrypoints without adding history, hiding the origin or losing its draft/scroll', async () => {
 y = 420
 await click('overview')
 expect(cursor).toBe(0); expect(host.querySelector('.page')).toBeNull(); expect(y).toBe(420)
 expect(host.querySelector('main')!.inert).toBe(false)
 expect(host.querySelector('input')!.value).toBe('draft preserved')
 await click('feed')
 const page = host.querySelector('.page')
 await click('page-overview'); await click('replace-overview')
 expect(cursor).toBe(1); expect(host.querySelector('.page')).toBe(page)
 await act(async () => history.back()); await flush()
 expect(cursor).toBe(0); expect(host.querySelector('main')!.inert).toBe(false)
})
it('retains a targeted legacy conversation route with a direct back to its original fullscreen context', async () => {
 await click('open'); await click('conversation')
 expect(host.querySelector('.page')?.getAttribute('data-kind')).toBe('calmconv')
 expect(host.querySelector('.page')?.getAttribute('data-target')).toBe('existing-session')
 expect(cursor).toBe(2)
 await click('back'); expect(open()).toBe(true); expect(cursor).toBe(1)
 await click('close'); expect(cursor).toBe(0)
})
it('keeps session deep links direct and removes no session data', async () => {
 const before = JSON.stringify(live.snap)
 await act(async () => root.unmount())
 location.hash = '#s=existing-session'
 root = createRoot(host)
 await act(async () => root.render(<App />)); await flush()
 expect(host.querySelector('.page')?.getAttribute('data-kind')).toBe('session')
 expect(host.querySelector('.page')?.getAttribute('data-target')).toBe('existing-session')
 expect(cursor).toBe(1)
 await click('back'); expect(host.querySelector('.page')).toBeNull()
 expect(JSON.stringify(live.snap)).toBe(before)
 location.hash = ''
})
it('a pinch on the normal page no longer opens a second overview', async () => {
 const main = host.querySelector('main')!
 const touch = (type: string, distance: number) => {
   const event = new Event(type, { bubbles: true })
   Object.defineProperty(event, 'touches', { value: [{ clientX: 0, clientY: 0 }, { clientX: distance, clientY: 0 }] })
   main.dispatchEvent(event)
 }
 await act(async () => { touch('touchstart', 200); touch('touchmove', 80); touch('touchend', 0) })
 expect(cursor).toBe(0); expect(host.querySelector('.page')).toBeNull()
})
