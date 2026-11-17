// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { capturePreview } from './preview-capture'
const errors = { unavailable: 'unavailable', unreadable: 'unreadable', changed: 'changed', failed: 'failed' }
let frame: HTMLIFrameElement
const view = { href: 'https://site.test/current#section', scrollX: 0, scrollY: 420, width: 390, height: 640 }
const stop = vi.fn(), cropTo = vi.fn(), drawImage = vi.fn()
const target = {}, stream = { getVideoTracks: () => [{ cropTo, stop, getSettings: () => ({ displaySurface: 'browser' }) }], getTracks: () => [{ stop }] }
beforeEach(() => {
 vi.clearAllMocks(); cropTo.mockResolvedValue(undefined)
 frame = document.createElement('iframe'); document.body.append(frame)
 Object.defineProperty(frame, 'contentWindow', { configurable: true, get: () => ({ location: { href: view.href }, document: { title: 'Current page' }, scrollX: view.scrollX, scrollY: view.scrollY, innerWidth: view.width, innerHeight: view.height }) })
 vi.stubGlobal('CropTarget', { fromElement: vi.fn(async () => target) })
 vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: vi.fn(async () => stream) } })
 vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
 vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
 const create = document.createElement.bind(document)
 vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
   const element = create(tag)
   if (tag === 'video') Object.defineProperties(element, { srcObject: { value: null, writable: true }, videoWidth: { value: 390 }, videoHeight: { value: 640 }, requestVideoFrameCallback: { value: (callback: VideoFrameRequestCallback) => { callback(1, {} as VideoFrameCallbackMetadata); return 1 } } })
   return element
 }) as typeof document.createElement)
 vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D)
 vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,cGl4ZWxz')
})
afterEach(() => { frame.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); view.scrollY = 420 })
it('captures the live iframe region with current page and scroll, then stops all capture tracks', async () => {
 const captured = await capturePreview(frame, errors)
 expect(cropTo).toHaveBeenCalledExactlyOnceWith(target)
 expect(drawImage.mock.calls[0][0]).toBeInstanceOf(HTMLVideoElement)
 expect(captured.file).toEqual({ name: 'preview.png', type: 'image/png', data: 'cGl4ZWxz' })
 expect(captured.view).toMatchObject({ url: view.href, scrollY: 420, width: 390, height: 640 })
 expect(stop).toHaveBeenCalledOnce()
})
it('refuses unsupported browsers instead of substituting a cached image', async () => {
 vi.stubGlobal('CropTarget', undefined)
 await expect(capturePreview(frame, errors)).rejects.toThrow('unavailable')
 expect(navigator.mediaDevices.getDisplayMedia).not.toHaveBeenCalled()
 expect(drawImage).not.toHaveBeenCalled()
})
it('never draws pixels if a different tab was selected or browser cropping fails', async () => {
 cropTo.mockRejectedValue(new Error('wrong tab'))
 await expect(capturePreview(frame, errors)).rejects.toThrow('failed')
 expect(drawImage).not.toHaveBeenCalled(); expect(stop).toHaveBeenCalledOnce()
})
it('rejects changed scroll/navigation while capture was being prepared', async () => {
 cropTo.mockImplementation(async () => { view.scrollY = 900 })
 await expect(capturePreview(frame, errors)).rejects.toThrow('changed')
 expect(drawImage).not.toHaveBeenCalled(); expect(stop).toHaveBeenCalledOnce()
})
