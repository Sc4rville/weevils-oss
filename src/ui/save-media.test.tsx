// @vitest-environment happy-dom
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setLang } from '../i18n'
import { LONG_PRESS_MS, SaveMediaButton, fileName, originalUrl, resetSaves, saveMedia, useLongPressSave, useSaveState } from './save-media'

let root: Root
let host: HTMLElement
let shared: File[][]
let shareImpl: (d: { files: File[] }) => Promise<void>
let fetched: string[]
const nav = navigator as unknown as Record<string, unknown>

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  setLang('en')
  resetSaves()
  shared = []
  fetched = []
  shareImpl = async () => undefined
  nav.share = vi.fn((d: { files: File[] }) => { shared.push(d.files); return shareImpl(d) })
  nav.canShare = vi.fn((d: { files?: File[] }) => !!d.files?.length)
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    fetched.push(url)
    return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'content-type': url.includes('m2') ? 'video/mp4' : 'image/png' } })
  }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  delete nav.share
  delete nav.canShare
})

const flush = () => act(() => new Promise((r) => setTimeout(r, 0)))

it('names the file after its real type and always takes the original, never a variant', () => {
  expect(fileName('clip', 'video/mp4')).toBe('clip.mp4')
  expect(fileName('rendu final.png', 'image/png')).toBe('rendu final.png')
  expect(fileName('shot.png', 'image/jpeg')).toBe('shot.jpg')
  expect(fileName('photo.jpeg', 'image/jpeg')).toBe('photo.jpeg')
  expect(fileName('a/b:c?.webm', 'video/webm')).toBe('a b c .webm')
  expect(originalUrl('/api/foryou/media/m1?attempt=2')).toBe('/api/foryou/media/m1')
})

it('a tap hands the full file, with its type and name, to the share sheet (Save Image / Save Video)', async () => {
  await act(() => saveMedia({ url: '/api/foryou/media/m2?attempt=1', name: 'title screen', type: 'video' }))
  expect(fetched).toEqual(['/api/foryou/media/m2'])
  expect(shared).toHaveLength(1)
  const [file] = shared[0]
  expect(file).toMatchObject({ name: 'title screen.mp4', type: 'video/mp4', size: 4 })
})

it('when loading spent the tap (iOS refuses the sheet), the file is kept and the next tap opens the sheet at once', async () => {
  shareImpl = async () => { throw Object.assign(new Error('no gesture'), { name: 'NotAllowedError' }) }
  render(<SaveMediaButton target={{ url: '/api/foryou/media/m1', name: 'render.png', type: 'image' }} />)
  const button = host.querySelector<HTMLButtonElement>('button.save-media')!
  expect(button.getAttribute('aria-label')).toBe('Save photo')
  await act(async () => button.click())
  await flush()
  expect(button.className).toContain('again')
  expect(host.textContent).toContain('Ready: tap to save')
  shareImpl = async () => undefined
  await act(async () => button.click())
  await flush()
  expect(fetched).toHaveLength(1)
  expect(shared).toHaveLength(2)
  expect(button.className).not.toContain('again')
})

it('a closed sheet says nothing; without a share sheet for files, the same file is downloaded', async () => {
  shareImpl = async () => { throw Object.assign(new Error('closed'), { name: 'AbortError' }) }
  render(<SaveMediaButton target={{ url: '/api/foryou/media/m1', name: 'render.png', type: 'image' }} />)
  await act(async () => host.querySelector<HTMLButtonElement>('button.save-media')!.click())
  await flush()
  expect(host.querySelector('.save-media')!.className.trim()).toBe('save-media idle')
  delete nav.canShare
  const clicks: string[] = []
  const spy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicks.push(`${this.getAttribute('href')} ${this.download}`) })
  await act(() => saveMedia({ url: '/api/foryou/media/m9', name: 'other.png', type: 'image' }))
  expect(clicks).toEqual(['/api/foryou/media/m9?download=1 other.png'])
  spy.mockRestore()
})

it('a long file says how far it is while preparing, then leaves memory once saved', async () => {
  let push: (b: Uint8Array | null) => void = () => undefined
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    fetched.push(url)
    const body = new ReadableStream<Uint8Array>({ start(c) { push = (b) => (b ? c.enqueue(b) : c.close()) } })
    return new Response(body, { headers: { 'content-type': 'video/mp4', 'content-length': '8' } })
  }))
  render(<SaveMediaButton target={{ url: '/api/foryou/media/m2', name: 'long clip', type: 'video' }} />)
  const button = host.querySelector<HTMLButtonElement>('button.save-media')!
  await act(async () => button.click())
  await flush()
  await act(async () => push(new Uint8Array([1, 2, 3])))
  await flush()
  expect(host.textContent).toContain('Preparing… 37%')
  await act(async () => { push(new Uint8Array([4, 5, 6, 7, 8])); push(null) })
  await flush()
  expect(shared).toHaveLength(1)
  expect(shared[0][0]).toMatchObject({ name: 'long clip.mp4', type: 'video/mp4', size: 8 })
  expect(host.textContent).not.toContain('Preparing')
  // Saved: the file is not kept around; another save fetches it again.
  await act(async () => button.click())
  await flush()
  expect(fetched).toHaveLength(2)
})

it('a load that broke half way, unseen, does not lend its old percent to the next one', async () => {
  const pushes: Array<(b: Uint8Array | null | Error) => void> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    fetched.push(url)
    const body = new ReadableStream<Uint8Array>({ start(c) { pushes.push((b) => (b instanceof Error ? c.error(b) : b ? c.enqueue(b) : c.close())) } })
    return new Response(body, { headers: { 'content-type': 'video/mp4', 'content-length': '10' } })
  }))
  render(<SaveMediaButton target={{ url: '/api/foryou/media/m2', name: 'clip', type: 'video' }} />)
  const button = host.querySelector<HTMLButtonElement>('button.save-media')!
  // The finger lands (loading starts), then lifts off without a tap: the load breaks half way, unseen.
  await act(async () => { button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' })) })
  await flush()
  await act(async () => pushes[0](new Uint8Array([1, 2, 3, 4, 5])))
  await flush()
  await act(async () => pushes[0](new Error('network')))
  await flush()
  await act(async () => button.click())
  await flush()
  expect(fetched).toHaveLength(2)
  expect(host.textContent).toContain('Preparing…')
  expect(host.textContent).not.toContain('50%')
})

function Tile({ onOpen }: { onOpen: () => void }) {
  const el = useRef<HTMLDivElement>(null)
  const guard = useLongPressSave(el, { url: '/api/foryou/media/m1', name: 'render.png', type: 'image' })
  const state = useSaveState('/api/foryou/media/m1')
  return <div ref={el} data-state={state}><button className="open" onClickCapture={guard} onClick={onOpen}>open</button></div>
}

it('a long press saves instead of opening; a tap still opens', async () => {
  vi.useFakeTimers()
  const opened = vi.fn()
  render(<Tile onOpen={opened} />)
  const el = host.querySelector<HTMLElement>('.open')!
  const press = async (ms: number) => {
    await act(async () => { el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: 5, clientY: 5 })) })
    await act(async () => { vi.advanceTimersByTime(ms) })
    await act(async () => { el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' })) })
    await act(async () => { el.click() })
    await act(async () => { await vi.runAllTimersAsync() })
  }
  await press(100)
  expect(opened).toHaveBeenCalledTimes(1)
  expect(shared).toHaveLength(0)
  await press(LONG_PRESS_MS + 50)
  expect(opened).toHaveBeenCalledTimes(1)
  expect(shared).toHaveLength(1)
  expect(shared[0][0]).toMatchObject({ name: 'render.png', type: 'image/png' })
})

function render(node: React.ReactNode) {
  act(() => root.render(node))
}
