// @vitest-environment happy-dom
import { act } from 'react'
import { MotionGlobalConfig } from 'motion/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Session } from '../../shared/api'
const mocks = vi.hoisted(() => ({ session: vi.fn(), attach: vi.fn(), mainAttach: vi.fn(), previewTarget: vi.fn(), capture: vi.fn(), payloads: new Map<string, unknown>(), store: vi.fn() }))
vi.mock('../api', () => ({ api: mocks }))
vi.mock('./preview-capture', () => ({ capturePreview: mocks.capture }))
vi.mock('../outbox-payload', () => ({ loadPayload: async (key: string) => mocks.payloads.get(key), storePayload: async (key: string, value: unknown) => { mocks.store(); mocks.payloads.set(key, value) }, removePayload: async (key: string) => { mocks.payloads.delete(key) } }))
vi.mock('./app-context', () => ({ useApp: () => ({ snap: { main: [], setup: {}, config: {}, projects: [], sessions: [] }, push: vi.fn(), colors: {} }) }))
vi.mock('./outbox-status', () => ({ OutboxStatus: () => null }))
import { Preview } from './preview'
import { setLang } from '../i18n'
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let host: HTMLDivElement, root: Root
const session = { id: 'existing', title: 'Website', projectId: 'project', tool: 'codex', controllable: true } as Session
const capture = { file: { name: 'preview.png', type: 'image/png', data: 'exact-pixels' }, view: { url: 'https://website.example/current#section', title: 'Current page', scrollX: 0, scrollY: 420, width: 390, height: 640 }, capturedAt: 1 }
beforeEach(() => {
 MotionGlobalConfig.skipAnimations = true
 setLang('en'); sessionStorage.clear(); vi.clearAllMocks(); mocks.payloads.clear(); mocks.store.mockImplementation(() => {})
 mocks.session.mockResolvedValue({ session, messages: [{ id: 'reply', role: 'assistant', text: 'The heading is updated.', at: 2 }] })
 mocks.attach.mockResolvedValue({ id: session.id }); mocks.mainAttach.mockResolvedValue({ id: 'boss' })
 mocks.previewTarget.mockResolvedValue({ session }); mocks.capture.mockResolvedValue(capture)
 host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); MotionGlobalConfig.skipAnimations = false; setLang(null) })
const render = (url = 'https://website.example/start', full = false) => act(async () => root.render(<Preview full={full} url={url} suggestions={[]} onUrl={() => {}} onClose={() => {}} session={session} />))
const type = async (text: string) => {
 const field = host.querySelector<HTMLInputElement>('.composer input')!
 await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, text); field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new Event('change', { bubbles: true })) })
 return field
}
const submit = () => act(async () => { host.querySelector('.composer')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await new Promise(resolve => setTimeout(resolve, 25)) })
it('uses only the standard composer, keeps iframe/draft through full screen and locale, and sends current captured pixels automatically', async () => {
 await render(); const frame = host.querySelector('iframe')!
 expect(host.querySelector('select')).toBeNull(); expect(host.querySelector('.preview-chat-toggle')).toBeNull()
 expect(host.textContent).not.toContain('Chat about this preview')
 const field = await type('Make this smaller')
 await render('https://website.example/start', true)
 await act(async () => setLang('fr')); expect(field.value).toBe('Make this smaller')
 expect(host.querySelector('iframe')).toBe(frame)
 await submit()
 expect(mocks.previewTarget).toHaveBeenCalledExactlyOnceWith({ projectId: 'project', sessionId: 'existing', repo: undefined })
 expect(mocks.attach).toHaveBeenCalledOnce()
 const [id, text, files] = mocks.attach.mock.calls[0]
 expect(id).toBe('existing'); expect(text).toContain(capture.view.url); expect(text).toContain('scroll: 0, 420')
 expect(files).toEqual([capture.file])
 expect(host.textContent).toContain('The heading is updated.')
 expect(host.querySelector('iframe')).toBe(frame)
})
it('does not send anything if exact capture is unavailable and retains the draft across reload', async () => {
 await render(); await type('Keep my draft')
 mocks.capture.mockRejectedValueOnce(new Error('Capture unavailable'))
 await submit()
 expect(mocks.attach).not.toHaveBeenCalled(); expect(mocks.mainAttach).not.toHaveBeenCalled()
 expect(host.textContent).toContain('Capture unavailable')
 await act(async () => root.render(null)); await render()
 expect(host.querySelector<HTMLInputElement>('.composer input')!.value).toBe('Keep my draft')
})
it('reuses persisted image, context and destination on retry after reload and navigation, without another capture or routing lookup', async () => {
 await render(); await type('Fix it'); mocks.attach.mockRejectedValueOnce(new Error('Offline')); await submit()
 const first = mocks.attach.mock.calls[0]
 expect(mocks.payloads.size).toBe(1)
 await act(async () => root.render(null)); await render('https://website.example/elsewhere')
 mocks.previewTarget.mockResolvedValue({ session: { ...session, id: 'different' } })
 await submit()
 expect(mocks.attach.mock.calls[1]).toEqual(first)
 expect(mocks.capture).toHaveBeenCalledOnce(); expect(mocks.previewTarget).toHaveBeenCalledOnce()
 expect(mocks.payloads.size).toBe(0)
})
it('keeps the draft and sends nothing when no existing target matches', async () => {
 mocks.previewTarget.mockResolvedValue({ session: null })
 await render(); await type('Fix this page'); await submit()
 expect(mocks.attach).not.toHaveBeenCalled(); expect(mocks.mainAttach).not.toHaveBeenCalled()
 expect(host.textContent).toContain('No suitable session')
 expect(host.querySelector<HTMLInputElement>('.composer input')!.value).toBe('Fix this page')
 expect(mocks.payloads.size).toBe(0)
 expect(host.querySelector('select')).toBeNull()
})
it('blocks double submission while capture/acceptance is pending', async () => {
 await render(); await type('Once')
 let release!: (r: unknown) => void
 mocks.attach.mockReturnValue(new Promise(resolve => { release = resolve }))
 await act(async () => { const form = host.querySelector('.composer')!; for (let i = 0; i < 2; i++) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
 await act(async () => vi.waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce()))
 expect(mocks.capture).toHaveBeenCalledOnce()
 await act(async () => release({ id: session.id }))
})
it('does not send an unpersisted capture if storage fails', async () => {
 await render(); await type('Do not lose this')
 mocks.store.mockImplementation(() => { throw new Error('Storage full') })
 await submit()
 expect(mocks.attach).not.toHaveBeenCalled(); expect(mocks.mainAttach).not.toHaveBeenCalled()
 expect(host.querySelector<HTMLInputElement>('.composer input')!.value).toBe('Do not lose this')
})

it('refuses a legacy null-target payload on retry without silently moving it to another session', async () => {
 mocks.payloads.set('preview-feedback:session:existing', { draft: 'Old draft', target: { sessionId: null, title: 'weevboss' }, body: { text: 'Old draft', files: [capture.file] }, fingerprint: 'legacy', at: 1 })
 await render(); await type('Old draft'); await submit()
 expect(mocks.attach).not.toHaveBeenCalled(); expect(mocks.mainAttach).not.toHaveBeenCalled()
 expect(mocks.previewTarget).not.toHaveBeenCalled(); expect(mocks.capture).not.toHaveBeenCalled()
 expect(host.textContent).toContain('No suitable session')
 expect(host.querySelector<HTMLInputElement>('.composer input')!.value).toBe('Old draft')
 expect(mocks.payloads.size).toBe(1)
})

it('retains the draft without freezing or sending when the resolved target is read-only', async () => {
 mocks.previewTarget.mockResolvedValue({ session: { ...session, sourceAccess: { repo: 'source', machineId: 'm', canExecute: false, reason: 'not-writable' } } })
 await render(); await type('Keep this feedback'); await submit()
 expect(host.textContent).toContain('Read-only source')
 expect(host.querySelector<HTMLInputElement>('.composer input')!.value).toBe('Keep this feedback')
 expect(mocks.store).not.toHaveBeenCalled()
 expect(mocks.attach).not.toHaveBeenCalled()
 expect(mocks.mainAttach).not.toHaveBeenCalled()
})
