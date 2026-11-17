import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type RefObject } from 'react'
import { localeHeaders, useT } from '../i18n'
import M from '../i18n/hints'
import { FOCUS_BOSS } from './follow'
import './hints.css'

// First-tap hints. The first time someone taps an element (the voice logo, the star, the +…), a short bubble
// says what it is and what to do with it, instead of acting: the next tap acts. Pages reached by a gesture (repos,
// conversation mode) get theirs the first time they open. Each hint shows once, ever: weevilsd keeps the seen ids
// (GET/POST /api/hints), shared by every device. Gone after a few seconds or at the next touch. Never before weevboss's welcome.
//
// Also, on load: the server's install id. A different one than the device knew (server reinstalled or reset from
// scratch) → the device forgets everything it kept about the old one (weevils-* in localStorage) and reloads.

export type HintId = 'voice' | 'star' | 'newSession' | 'attention' | 'h24' | 'repos' | 'calm' | 'devil'

/** Every hint, for a device that already knew weevils before hints existed (they are all marked seen at once). */
export const HINT_IDS: HintId[] = ['voice', 'star', 'newSession', 'attention', 'h24', 'repos', 'calm', 'devil']

const INSTALL = 'weevils-install'
/** Shown at least this long, plus a little per character, at most MAX_MS. */
const MIN_MS = 4500
const PER_CHAR_MS = 45
const MAX_MS = 9000
/** Page hints wait for the page to settle. */
const VIEW_DELAY_MS = 650

interface Shown {
  id: HintId
  /** Variant text key (defaults to the id). */
  key: keyof (typeof M)['en']
  anchor: DOMRect | null
  at: number
}

let seen: Set<string> | null = null
let shown: Shown | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

const read = (k: string) => {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
const post = (body: { seen: string[]; reset?: boolean }) =>
  fetch('/api/hints', { method: 'POST', credentials: 'same-origin', headers: { ...localeHeaders(), 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => undefined)

/** The first-launch intro is open or not finished: no hint competes with it. */
const introActive = () => read('weevils-onboarded') !== '1'

/** Forgets what this device kept about a previous server (weevils-* keys). */
function forgetDevice() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('weevils')) localStorage.removeItem(k)
  } catch {
    /* storage unavailable */
  }
}

/** Once signed in: the seen hints, and the install check. */
export async function loadHints() {
  let r: { seen: string[]; touched: boolean; install: string }
  try {
    const res = await fetch('/api/hints', { credentials: 'same-origin', headers: localeHeaders() })
    if (!res.ok) return
    r = await res.json()
  } catch {
    return
  }
  const known = read(INSTALL)
  if (known && known !== r.install) {
    forgetDevice()
    try {
      localStorage.setItem(INSTALL, r.install)
    } catch {
      /* storage unavailable */
    }
    location.reload()
    return
  }
  try {
    localStorage.setItem(INSTALL, r.install)
  } catch {
    /* storage unavailable */
  }
  seen = new Set(r.seen)
  // First time this server hears about hints: a device already welcomed is no newcomer.
  if (!r.touched) {
    const veteran = read('weevils-onboarded') === '1'
    if (veteran) for (const id of HINT_IDS) seen.add(id)
    void post({ seen: veteran ? HINT_IDS : [] })
  }
  emit()
}

function show(id: HintId, el: Element | null, key: Shown['key'] = id): boolean {
  if (!seen || seen.has(id) || introActive()) return false
  seen.add(id)
  void post({ seen: [id] })
  shown = { id, key, anchor: el?.getBoundingClientRect() ?? null, at: Date.now() }
  emit()
  return true
}

/** A gesture or an element was used for real: its hint, or the animation that shows it, will never come. */
export function markSeen(id: string) {
  if (!seen || seen.has(id)) return
  seen.add(id)
  void post({ seen: [id] })
  emit()
}
/** Already seen or done (true until the list is loaded: nothing is shown before). */
export const isSeen = (id: string) => !seen || seen.has(id)

/**
 * First tap on an element: shows its hint and returns true (the caller then does nothing else this time).
 * Already seen, not loaded yet, or weevboss has not welcomed yet: false, the tap acts as usual.
 */
export const tapHint = (id: HintId, el: Element | null, variant?: Shown['key']) => show(id, el, variant)

/** A page's hint, the first time it opens (anchored to `anchor` when given, otherwise at the bottom of the screen).
 * `off`: a setting this page needs is missing; the bubble then sends to weevboss, and `onOff` asks him to explain. */
export function useViewHint(id: HintId, anchor?: RefObject<Element | null>, off?: { variant: Shown['key']; onOff: () => void } | false) {
  useEffect(() => {
    const t = setTimeout(() => {
      if (show(id, anchor?.current ?? null, off ? off.variant : id) && off) off.onOff()
    }, VIEW_DELAY_MS)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, anchor, !!off])
}

const hide = () => {
  if (!shown) return
  shown = null
  emit()
}

// Le fil de weevboss s'ouvre en haut (focusBoss) et l'écran défile : une bulle posée sur un élément pointerait dans le
// vide. Elle repart en bas de l'écran (fondu), le temps d'être lue.
if (typeof window !== 'undefined')
  window.addEventListener(FOCUS_BOSS, () => {
    if (!shown?.anchor) return
    shown = { ...shown, anchor: null, at: Date.now() }
    emit()
  })
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** Where the bubble goes: under the element when there is room, otherwise above; the notch points at its center. */
function place(anchor: DOMRect | null, w: number, h: number): { style: CSSProperties; notch: number | null; below: boolean } {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const margin = 10
  // A page's hint: at the bottom, where a page is mostly empty, never over its title or its first lines.
  if (!anchor) return { style: { left: Math.max(margin, (vw - w) / 2), bottom: 'calc(var(--safe-b) + 28px)' }, notch: null, below: true }
  const cx = anchor.left + anchor.width / 2
  const left = Math.min(Math.max(margin, cx - w / 2), vw - w - margin)
  const below = anchor.bottom + 12 + h < vh - margin || anchor.top - 12 - h < margin
  const top = below ? anchor.bottom + 12 : anchor.top - 12 - h
  return { style: { left, top }, notch: Math.min(Math.max(14, cx - left), w - 14), below }
}

/** The bubble, mounted once. */
export function HintBubble() {
  const t = useT(M)
  const cur = useSyncExternalStore(subscribe, () => shown, () => null)
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)

  useLayoutEffect(() => {
    setSize(null)
  }, [cur])
  useLayoutEffect(() => {
    if (cur && !size && box.current) setSize({ w: box.current.offsetWidth, h: box.current.offsetHeight })
  })

  // Gone by itself, or at the next touch anywhere (that touch still does what it does).
  useEffect(() => {
    if (!cur) return
    const text = t[cur.key]
    const timer = setTimeout(hide, Math.min(MAX_MS, MIN_MS + text.length * PER_CHAR_MS))
    // The touch that opened the bubble came before it (pointerdown, then click): any touch now is a new one.
    const onDown = () => hide()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && hide()
    window.addEventListener('pointerdown', onDown, { capture: true })
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', hide)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('pointerdown', onDown, { capture: true })
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', hide)
    }
  }, [cur, t])

  const at = cur && size ? place(cur.anchor, size.w, size.h) : null
  return (
    <div className="hint-live" aria-live="polite">
      <AnimatePresence>
        {cur && (
          <motion.div
            key={cur.at}
            ref={box}
            className={`hint ${at?.below === false ? 'above' : 'below'}`}
            role="status"
            style={{ ...(at?.style ?? { left: 0, top: 0, visibility: 'hidden' }), ['--notch' as string]: at?.notch != null ? `${at.notch}px` : undefined }}
            initial={{ opacity: 0, y: at?.below === false ? 6 : -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            onClick={hide}
          >
            {at?.notch != null && <span className="hint-notch" aria-hidden />}
            <p className="hint-text">{t[cur.key]}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
