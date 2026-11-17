import type { Attachment } from './bits'

export interface PreviewView {
  url: string
  title: string
  scrollX: number
  scrollY: number
  width: number
  height: number
}
export interface PreviewCapture { file: Attachment; view: PreviewView; capturedAt: number }
export interface CaptureErrors { unavailable: string; unreadable: string; changed: string; failed: string }
type CroppableTrack = MediaStreamTrack & { cropTo(target: unknown): Promise<void> }
type CropAPI = { fromElement(element: Element): Promise<unknown> }

function readView(frame: HTMLIFrameElement): PreviewView | null {
  try {
    const w = frame.contentWindow
    if (!w || !/^https?:/.test(w.location.href)) return null
    return { url: w.location.href, title: w.document.title, scrollX: w.scrollX, scrollY: w.scrollY, width: w.innerWidth, height: w.innerHeight }
  } catch { return null }
}

/** A cooperative viewer bridge may report metadata, but is never treated as screenshot evidence.
 * The image below comes exclusively from pixels of the current browser tab, cropped by the browser. */
export async function previewView(frame: HTMLIFrameElement, error: string): Promise<PreviewView> {
  const local = readView(frame)
  if (local) return local
  const source = frame.contentWindow
  if (!source) throw new Error(error)
  const origin = new URL(frame.src, location.href).origin
  const nonce = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    const finish = () => { clearTimeout(timer); window.removeEventListener('message', receive) }
    const receive = (event: MessageEvent) => {
      if (event.source !== source || event.origin !== origin || event.data?.type !== 'weevils:preview-view' || event.data?.nonce !== nonce) return
      const v = event.data.view as PreviewView
      if (!v || typeof v.url !== 'string' || typeof v.title !== 'string' || ![v.scrollX,v.scrollY,v.width,v.height].every(Number.isFinite) || v.width <= 0 || v.height <= 0) return
      try { if (new URL(v.url).origin !== origin) return } catch { return }
      finish(); resolve(v)
    }
    const timer = setTimeout(() => { finish(); reject(new Error(error)) }, 1500)
    window.addEventListener('message', receive)
    source.postMessage({ type: 'weevils:preview-view?', nonce }, origin)
  })
}

/** No screenshot cache, DOM reconstruction, remote reload, or capture of an unrelated tab. */
export async function capturePreview(frame: HTMLIFrameElement | null, errors: CaptureErrors): Promise<PreviewCapture> {
  const crop = (globalThis as unknown as { CropTarget?: CropAPI }).CropTarget
  if (!frame || !frame.isConnected || !navigator.mediaDevices?.getDisplayMedia || !crop) throw new Error(errors.unavailable)
  // Must be called directly from the send gesture, before asynchronous routing/storage work.
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'browser' }, audio: false, preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude' } as DisplayMediaStreamOptions)
  } catch { throw new Error(errors.failed) }
  const video = document.createElement('video')
  try {
    const track = stream.getVideoTracks()[0] as CroppableTrack | undefined
    if (!track?.cropTo || track.getSettings().displaySurface !== 'browser') throw new Error(errors.unavailable)
    const before = await previewView(frame, errors.unreadable)
    // cropTo rejects targets belonging to a different tab: choosing a different window/tab cannot leak its image.
    await track.cropTo(await crop.fromElement(frame))
    video.muted = true; video.playsInline = true; video.srcObject = stream
    await video.play()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(errors.failed)), 3000)
      video.requestVideoFrameCallback(() => { clearTimeout(timer); resolve() })
    })
    const after = await previewView(frame, errors.unreadable)
    if (JSON.stringify(before) !== JSON.stringify(after) || !frame.isConnected) throw new Error(errors.changed)
    if (!video.videoWidth || !video.videoHeight) throw new Error(errors.failed)
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth; canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error(errors.failed)
    ctx.drawImage(video, 0, 0)
    const data = canvas.toDataURL('image/png')
    if (!data.startsWith('data:image/png;base64,') || data.length > 14_000_000) throw new Error(errors.failed)
    return { file: { name: 'preview.png', type: 'image/png', data: data.slice(data.indexOf(',') + 1) }, view: after, capturedAt: Date.now() }
  } catch (e) {
    if (e instanceof Error && Object.values(errors).includes(e.message)) throw e
    throw new Error(errors.failed, { cause: e })
  } finally {
    stream.getTracks().forEach(track => track.stop())
    video.pause(); video.srcObject = null
  }
}
