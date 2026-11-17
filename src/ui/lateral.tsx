import { animate, motion, useMotionValue, useTransform, type MotionValue } from 'motion/react'
import { createContext, useCallback, useContext, useEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from 'react'
import { spring } from './bits'
import { markSeen } from './hints'
import { ReposPage } from './repos'
import { SoftwaresPage } from './softwares'

/**
 * The lateral chain: the main screen, then the repos, then the software previews. Each screen after the main one is a
 * full-screen drawer pulled from the right edge (to the left) and pushed back to the right, with the spring of the
 * automations drawer. A long press on any of the three zooms out into an overview of the three side by side: swipe
 * between them, tap one to go there. Gestures only, one finger; transforms only.
 */

/** Inside a lateral screen: its place in the chain and how to push it back (the Shell's back button). */
export const LateralCtx = createContext<{ index: number; close: () => void } | null>(null)
export const useLateral = () => useContext(LateralCtx)

const SCREENS = [ReposPage, SoftwaresPage]
const LAST = SCREENS.length
/** A screen's size in the overview, and the distance between two screens' centres (in screen widths). */
const S = 0.46
const GAP = S + 0.06
const EDGE = 26
const PRESS_MS = 420
/** Never long-pressed: what has its own press (buttons, links, fields) and the text of messages (selection). */
const NO_PRESS = 'button, a, input, textarea, select, label, [contenteditable], [role="button"], [role="slider"], [data-mid], .h24, .msg, .peek'

const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
const go = (mv: MotionValue<number>, to: number, velocity = 0) => {
  if (reduced()) return void mv.set(to)
  animate(mv, to, { ...spring, velocity })
}
const W = () => window.innerWidth || 1
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
/** Past an end, the finger moves the layer at a third of its speed. */
const rubber = (v: number, lo: number, hi: number) => (v < lo ? lo - (lo - v) / 3 : v > hi ? hi + (v - hi) / 3 : v)

/** One-finger horizontal tracking: direction-locked, a vertical start lets the list scroll. */
function track(e: RPointerEvent, h: { move: (dx: number) => void; end: (dx: number, vx: number) => void; tap?: () => void; accept?: (dx: number) => boolean }) {
  if (e.pointerType === 'mouse' && e.button !== 0) return
  const x0 = e.clientX
  const y0 = e.clientY
  const id = e.pointerId
  const target = e.currentTarget as HTMLElement
  let on = false
  let dead = false
  let last = { x: x0, t: performance.now() }
  let prev = last
  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== id || dead) return
    const dx = ev.clientX - x0
    const dy = ev.clientY - y0
    if (!on) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) return void (dead = true)
      if (Math.abs(dx) < 8 || (h.accept && !h.accept(dx))) return
      on = true
      try {
        target.setPointerCapture(id)
      } catch {
        /* already gone */
      }
    }
    prev = last
    last = { x: ev.clientX, t: performance.now() }
    h.move(dx)
  }
  const up = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', up)
    const dt = Math.max(1, last.t - prev.t)
    const vx = performance.now() - last.t > 100 ? 0 : ((last.x - prev.x) / dt) * 1000
    if (on) h.end(ev.clientX - x0, ev.type === 'pointercancel' ? 0 : vx)
    else if (!dead && ev.type === 'pointerup' && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 8) h.tap?.()
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', up)
}

/** Long press anywhere calm (not on a button, a field or a message's text): a held finger that does not move. */
function usePress(fire: () => void, enabled: boolean) {
  const timer = useRef(0)
  return useCallback(
    (e: RPointerEvent) => {
      if (!enabled || (e.pointerType === 'mouse' && e.button !== 0)) return
      if ((e.target as Element | null)?.closest?.(NO_PRESS)) return
      const x0 = e.clientX
      const y0 = e.clientY
      const stop = () => {
        clearTimeout(timer.current)
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', stop)
        window.removeEventListener('pointercancel', stop)
        window.removeEventListener('scroll', stop, true)
      }
      const move = (ev: PointerEvent) => {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 8) stop()
      }
      clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        stop()
        // The lift that follows is not a tap on what lies under the finger.
        const eat = (ev: Event) => {
          ev.preventDefault()
          ev.stopPropagation()
        }
        window.addEventListener('click', eat, { capture: true, once: true })
        setTimeout(() => window.removeEventListener('click', eat, { capture: true }), 600)
        window.getSelection()?.removeAllRanges()
        navigator.vibrate?.(8)
        fire()
      }, PRESS_MS)
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', stop)
      window.addEventListener('pointercancel', stop)
      window.addEventListener('scroll', stop, true)
    },
    [fire, enabled],
  )
}

export interface LateralNav {
  /** Where the chain rests: 0 the main screen, 1 the repos, 2 the previews. */
  rest: number
  overview: boolean
  mounted: number
  pos: MotionValue<number>
  zoom: MotionValue<number>
  sel: MotionValue<number>
  goTo: (i: number) => void
  mount: (n: number) => void
  enter: () => void
  pick: (i: number) => void
  press: (e: RPointerEvent) => void
  mainStyle: { x: MotionValue<number>; scale: MotionValue<number> }
}

/** The chain's state, held by the app (the main screen takes its transform and its long press). */
export function useLateralNav(active: boolean, main: React.RefObject<HTMLElement | null>): LateralNav {
  const pos = useMotionValue(0)
  const zoom = useMotionValue(0)
  const sel = useMotionValue(0)
  const [rest, setRest] = useState(0)
  const [overview, setOverview] = useState(false)
  const [mounted, setMounted] = useState(0)
  const restRef = useRef(0)
  restRef.current = rest

  const goTo = useCallback(
    (i: number) => {
      const to = clamp(Math.round(i), 0, LAST)
      setMounted((m) => Math.max(m, to))
      setRest(to)
      if (to >= 1) markSeen('repos')
      if (to >= 2) markSeen('softwares')
      go(pos, to)
    },
    [pos],
  )

  useEffect(() => {
    document.documentElement.dataset.lat = String(overview ? -1 : rest)
  }, [rest, overview])

  const mount = useCallback((n: number) => setMounted((m) => Math.max(m, n)), [])

  // The main screen is the scrolled document: in the overview it shrinks around the part on screen, cut to it.
  const frame = useCallback(
    (on: boolean) => {
      const el = main.current
      if (!el) return
      if (!on) {
        el.style.transformOrigin = ''
        el.style.clipPath = ''
        return
      }
      const y = window.scrollY
      el.style.transformOrigin = `50% ${y + window.innerHeight / 2}px`
      el.style.clipPath = `inset(${y}px 0 ${Math.max(0, el.offsetHeight - y - window.innerHeight)}px 0)`
    },
    [main],
  )

  const enter = useCallback(() => {
    if (!active) return
    frame(true)
    setMounted(LAST)
    sel.set(restRef.current)
    setOverview(true)
    go(zoom, 1)
  }, [active, frame, sel, zoom])

  const pick = useCallback(
    (i: number) => {
      const to = clamp(Math.round(i), 0, LAST)
      pos.set(to)
      sel.set(to)
      setRest(to)
      setOverview(false)
      if (reduced()) {
        zoom.set(0)
        frame(false)
        return
      }
      animate(zoom, 0, { ...spring, onComplete: () => zoom.get() < 0.01 && frame(false) })
    },
    [pos, sel, zoom, frame],
  )

  // A page opened over the chain (a repo's files, a session): the overview closes under it at once.
  useEffect(() => {
    if (!active && overview) {
      setOverview(false)
      zoom.set(0)
      frame(false)
    }
  }, [active, overview, zoom, frame])

  const press = usePress(enter, active && !overview)
  const x = useTransform(() => (0 - sel.get()) * W() * GAP * zoom.get())
  const scale = useTransform(() => 1 + (S - 1) * zoom.get())
  return { rest, overview, mounted, pos, zoom, sel, goTo, mount, enter, pick, press, mainStyle: { x, scale } }
}

function Layer({ i, nav, children }: { i: number; nav: LateralNav; children: ReactNode }) {
  const { pos, zoom, sel, rest, overview, goTo } = nav
  const x = useTransform(() => {
    const drawer = clamp(i - pos.get(), 0, 1) * W()
    const over = (i - sel.get()) * W() * GAP
    return drawer + (over - drawer) * zoom.get()
  })
  const scale = useTransform(() => 1 + (S - 1) * zoom.get())
  // Hidden while fully off to the right and not zoomed out: nothing of it is painted or reachable.
  const hidden = useTransform(() => (zoom.get() < 0.001 && pos.get() <= i - 1 + 0.001 ? 'hidden' : 'visible'))
  const live = rest === i && !overview
  const close = useCallback(() => goTo(i - 1), [goTo, i])
  return (
    <motion.div
      className="lat-layer"
      style={{ x, scale, visibility: hidden, zIndex: 25 + i }}
      inert={!live}
      aria-hidden={!live || undefined}
      onPointerDown={(e) => {
        nav.press(e)
        if (!live) return
        // Pushed back to the right from anywhere, except the very left edge (iOS back swipe).
        if (e.clientX < 24) return
        track(e, {
          accept: (dx) => dx > 0,
          move: (dx) => pos.set(rubber(i - dx / W(), i - 1, i)),
          end: (_dx, vx) => {
            const cur = pos.get()
            const to = vx > 400 ? i - 1 : vx < -400 ? i : cur < i - 0.5 ? i - 1 : i
            nav.goTo(to)
            if (to === i) go(pos, i, -vx / W())
          },
        })
      }}
    >
      <LateralCtx.Provider value={{ index: i, close }}>{children}</LateralCtx.Provider>
    </motion.div>
  )
}

/** The lateral screens, the right-edge grip that pulls the next one, and the overview's touch surface. */
export function LateralDeck({ nav, active }: { nav: LateralNav; active: boolean }) {
  const { pos, sel, rest, overview, mounted, goTo, pick } = nav
  const pull = (e: RPointerEvent) => {
    const base = rest
    const grip = e.currentTarget as HTMLElement
    track(e, {
      accept: (dx) => dx < 0,
      move: (dx) => {
        const p = rubber(base - dx / W(), base, base + 1)
        if (p > base) nav.mount(Math.ceil(p))
        pos.set(p)
      },
      end: (_dx, vx) => {
        const cur = pos.get()
        const to = vx < -400 ? base + 1 : vx > 400 ? base : cur > base + 0.5 ? base + 1 : base
        goTo(to)
      },
      // A tap on the visible grip opens the next screen; elsewhere on the edge it is a tap on what is under it.
      tap: () => {
        const bar = grip.firstElementChild?.getBoundingClientRect()
        if (bar && Math.abs(e.clientY - (bar.top + bar.height / 2)) < 56) return goTo(base + 1)
        grip.style.pointerEvents = 'none'
        const under = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
        grip.style.pointerEvents = ''
        under?.click()
      },
    })
  }

  const browse = (e: RPointerEvent) => {
    const base = sel.get()
    const unit = W() * GAP
    track(e, {
      move: (dx) => sel.set(rubber(base - dx / unit, 0, LAST)),
      end: (_dx, vx) => {
        const cur = sel.get()
        const to = clamp(vx < -300 ? Math.ceil(cur) : vx > 300 ? Math.floor(cur) : Math.round(cur), 0, LAST)
        go(sel, to, -vx / unit)
      },
      tap: () => {
        const off = (e.clientX - window.innerWidth / 2) / (W() * GAP)
        const i = Math.round(sel.get() + off)
        if (i < 0 || i > LAST || Math.abs(sel.get() + off - i) > S / GAP / 2) return
        if (Math.abs((e.clientY - window.innerHeight / 2) / window.innerHeight) > S / 2) return pick(Math.round(sel.get()))
        pick(i)
      },
    })
  }

  return (
    <>
      <motion.div className="lat-back" style={{ opacity: nav.zoom }} aria-hidden />
      {SCREENS.map((Screen, k) =>
        k + 1 <= mounted ? (
          <Layer key={k} i={k + 1} nav={nav}>
            <Screen />
          </Layer>
        ) : null,
      )}
      {active && !overview && rest < LAST && <div className="lat-edge" style={{ width: EDGE }} onPointerDown={pull} aria-hidden>
          <span className="lat-grip" />
        </div>}
      {overview && <div className="lat-over" onPointerDown={browse} aria-hidden />}
    </>
  )
}
