import { useCallback, useEffect, useRef, useSyncExternalStore, type RefObject } from 'react'
import { useT } from '../i18n'
import M from '../i18n/save-media'
import { Icon } from './icons'
import './save-media.css'

// A photo or a video of the stream, saved to the phone's camera roll: the original file (never a reduced preview), with
// its real type and a clean name, handed to the system share sheet (« Save Image » / « Save Video » on an iPhone).
// Where no share sheet takes files (a desktop browser), the same file is downloaded (?download=1: attachment).
//
// iOS opens the sheet only from the tap itself: a file still loading when the tap ends loses it. The file is then kept,
// and the button says « Ready: tap to save »; a long press starts loading as soon as the finger lands.

export interface SaveTarget {
  url: string
  name: string
  type: 'image' | 'video'
}
export type SaveState = 'idle' | 'saving' | 'again' | 'failed'

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
}

/** The original's address: no retry counter or other variant, the very file the server keeps. */
export const originalUrl = (url: string) => url.split(/[?#]/)[0]

/** A clean file name with the extension its type calls for (« clip » + video/mp4 → « clip.mp4 »). */
export function fileName(name: string, mime: string): string {
  const want = MIME_EXT[mime.split(';')[0].trim().toLowerCase()]
  const base = name.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'weevils'
  const ext = /\.([a-z0-9]{2,5})$/i.exec(base)?.[1]?.toLowerCase()
  if (!want || ext === want || (want === 'jpg' && ext === 'jpeg')) return base
  return `${ext && Object.values(MIME_EXT).includes(ext) ? base.slice(0, -(ext.length + 1)) : base}.${want}`
}

const loading = new Map<string, Promise<File>>()
const ready = new Map<string, File>()
const states = new Map<string, SaveState>()
/** Whole percent of a file still loading, when its size is known (a long video on a phone network takes a while). */
const progress = new Map<string, number>()
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((l) => l())
const setState = (key: string, s: SaveState) => {
  if (s !== 'saving') progress.delete(key)
  if (states.get(key) === s) return
  if (s === 'idle') states.delete(key)
  else states.set(key, s)
  notify()
}
const setProgress = (key: string, pct: number) => {
  if (progress.get(key) === pct) return
  progress.set(key, pct)
  if (states.get(key) === 'saving') notify()
}

/** The body, read piece by piece so the button can say how far it is; the whole blob at once where streams are missing. */
async function readBody(key: string, r: Response, size: number): Promise<Blob> {
  const reader = size > 0 ? r.body?.getReader() : undefined
  if (!reader) return r.blob()
  const parts: BlobPart[] = []
  let got = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
    got += value.byteLength
    setProgress(key, Math.min(99, Math.floor((got / size) * 100)))
  }
  return new Blob(parts, { type: r.headers.get('content-type') ?? '' })
}

/** A saved file leaves memory (a video can weigh hundreds of MB); the next save fetches it again. */
const forget = (key: string) => {
  ready.delete(key)
  loading.delete(key)
}

/** The original file, fetched once and kept for the next tap. */
export function loadFile(t: SaveTarget): Promise<File> {
  const key = originalUrl(t.url)
  let job = loading.get(key)
  if (!job) {
    // A fresh fetch starts from zero (an earlier one may have stopped half way).
    progress.delete(key)
    job = fetch(key, { credentials: 'same-origin' }).then(async (r) => {
      if (!r.ok) throw new Error(String(r.status))
      const blob = await readBody(key, r, Number(r.headers.get('content-length')) || 0)
      const type = (blob.type || r.headers.get('content-type') || '').split(';')[0].trim()
      const file = new File([blob], fileName(t.name, type), { type })
      ready.set(key, file)
      return file
    })
    job.catch(() => loading.delete(key))
    loading.set(key, job)
  }
  return job
}

const sharesFiles = (f: File) => {
  try {
    return typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [f] })
  } catch {
    return false
  }
}

function download(t: SaveTarget) {
  const a = document.createElement('a')
  a.href = `${originalUrl(t.url)}?download=1`
  a.download = fileName(t.name, '')
  a.rel = 'noopener'
  document.body.append(a)
  a.click()
  a.remove()
}

async function share(key: string, t: SaveTarget, file: File) {
  if (!sharesFiles(file)) {
    download(t)
    forget(key)
    return setState(key, 'idle')
  }
  try {
    await navigator.share({ files: [file] })
    forget(key)
    setState(key, 'idle')
  } catch (e) {
    const name = (e as { name?: string })?.name
    // Closed by the user: nothing to say. Refused because the tap was spent while loading: one more tap.
    setState(key, name === 'AbortError' ? 'idle' : name === 'NotAllowedError' ? 'again' : 'failed')
  }
}

/** Call it from the tap (or the end of a long press) itself: the sheet opens at once when the file is already here. */
export async function saveMedia(t: SaveTarget): Promise<void> {
  const key = originalUrl(t.url)
  const now = ready.get(key)
  if (now) return share(key, t, now)
  setState(key, 'saving')
  let file: File
  try {
    file = await loadFile(t)
  } catch {
    return setState(key, 'failed')
  }
  return share(key, t, file)
}

const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l))

export function useSaveState(url: string): SaveState {
  const key = originalUrl(url)
  return useSyncExternalStore(subscribe, () => states.get(key) ?? 'idle', () => 'idle')
}

/** Whole percent loaded while preparing, when the size is known; undefined otherwise. */
export function useSaveProgress(url: string): number | undefined {
  const key = originalUrl(url)
  return useSyncExternalStore(subscribe, () => progress.get(key), () => undefined)
}

/** Tests only. */
export function resetSaves() {
  loading.clear()
  ready.clear()
  states.clear()
  progress.clear()
}

export const LONG_PRESS_MS = 450

/** A long press on a media: loading starts when the finger lands, the sheet opens when it lifts (a tap is not a long
 * press: it still opens the media). Returns a click guard for the element's onClickCapture. */
export function useLongPressSave(el: RefObject<HTMLElement | null>, t: SaveTarget) {
  const held = useRef(false)
  const target = useRef(t)
  target.current = t
  useEffect(() => {
    const node = el.current
    if (!node) return
    let timer = 0
    let start: { x: number; y: number } | null = null
    const cancel = () => {
      window.clearTimeout(timer)
      start = null
    }
    const down = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return
      held.current = false
      start = { x: e.clientX, y: e.clientY }
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        held.current = true
        void loadFile(target.current).catch(() => undefined)
        try {
          navigator.vibrate?.(12)
        } catch {
          /* not allowed here */
        }
      }, LONG_PRESS_MS)
    }
    const move = (e: PointerEvent) => {
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel()
    }
    // The finger lifting is the tap the share sheet needs.
    const up = () => {
      window.clearTimeout(timer)
      start = null
      if (held.current) void saveMedia(target.current)
    }
    // Android and desktop menus on a long press: the save replaces them.
    const menu = (e: Event) => e.preventDefault()
    node.addEventListener('pointerdown', down)
    node.addEventListener('pointermove', move)
    node.addEventListener('pointerup', up)
    node.addEventListener('pointercancel', cancel)
    node.addEventListener('contextmenu', menu)
    return () => {
      cancel()
      node.removeEventListener('pointerdown', down)
      node.removeEventListener('pointermove', move)
      node.removeEventListener('pointerup', up)
      node.removeEventListener('pointercancel', cancel)
      node.removeEventListener('contextmenu', menu)
    }
  }, [el])
  // A long press is not also a tap that opens the media.
  return useCallback((e: { preventDefault(): void; stopPropagation(): void }) => {
    if (!held.current) return
    held.current = false
    e.preventDefault()
    e.stopPropagation()
  }, [])
}

/** The small discreet button on a photo or a video. */
export function SaveMediaButton({ target, className = '' }: { target: SaveTarget; className?: string }) {
  const t = useT(M)
  const state = useSaveState(target.url)
  const pct = useSaveProgress(target.url)
  const label = t.save(target.type === 'video')
  const said = state === 'saving' ? t.saving(pct) : state === 'again' ? t.again : state === 'failed' ? t.failed : ''
  return (
    <button
      type="button"
      className={`save-media ${state} ${className}`.trim()}
      aria-label={said ? `${label} · ${said}` : label}
      aria-busy={state === 'saving'}
      // Loading starts as soon as the finger lands: often ready by the time it lifts.
      onPointerDown={() => void loadFile(target).catch(() => undefined)}
      onClick={(e) => {
        e.stopPropagation()
        if (state !== 'saving') void saveMedia(target)
      }}
    >
      <Icon name="save" />
      {said && <span className="save-media-said" role="status">{said}</span>}
    </button>
  )
}
