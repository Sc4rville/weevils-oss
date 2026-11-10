import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'

// Le regard suit l'action : trois outils partagés par toute l'app.
// - useFollow : un fil qui défile garde sa fin sous les yeux pendant qu'elle s'écrit, sauf si l'utilisateur remonte lire.
// - reveal : un élément hors du champ y est amené d'un défilement court, puis mis en avant un instant.
// - focusBoss : un parcours (branchement) ou une action qui répond dans le fil de weevboss : le fil s'ouvre en haut de
//   l'écran, d'où qu'on vienne (une page par-dessus, le bas du flux), et sa prochaine réponse est mise en avant.

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** Dernier geste de défilement de l'utilisateur (doigt qui glisse, molette, touches) : un défilement décidé par l'app ne
 * vient jamais contrarier un défilement qu'il est en train de faire. */
let scrolledAt = 0
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])
if (typeof window !== 'undefined') {
  const mark = () => void (scrolledAt = Date.now())
  window.addEventListener('touchmove', mark, { capture: true, passive: true })
  window.addEventListener('wheel', mark, { capture: true, passive: true })
  window.addEventListener('keydown', (e) => SCROLL_KEYS.has(e.key) && mark(), { capture: true, passive: true })
}
const userScrolling = (since = Date.now() - 700) => scrolledAt > since
const behavior = (): ScrollBehavior => (reduced() ? 'auto' : 'smooth')

/**
 * Garde la fin d'un fil visible. `open` : le fil est affiché (à l'ouverture, on y est déjà, sans défilement visible).
 * On suit tout ce qui allonge le contenu (nouveau message qui se déplie, réponse qui s'écrit, indicateur de travail) et
 * ce qui raccourcit le conteneur (clavier qui s'ouvre, navigateur intégré dessous), image par image : le mouvement suit
 * l'animation du contenu, sans saut. Seul un geste de l'utilisateur (doigt, molette, clavier) peut décrocher le suivi,
 * quand il remonte à plus de `stick` px du bas ; revenir en bas le raccroche.
 * - `grow` : une clé qui change quand le contenu s'allonge (suivi immédiat au rendu, en plus de l'observateur de taille).
 * - `hold` : suivi suspendu (un mot sélectionné et sa réponse sous un message : on ne les pousse pas hors de l'écran).
 * - Un tap dans le fil qui déplie quelque chose (« lire tout », code, étapes) : le bloc s'ouvre vers le bas, on ne le
 *   repousse pas vers le haut pendant qu'il se déplie.
 * Renvoie `reading` (il relit plus haut), `behind` (état React : du nouveau est arrivé en bas pendant qu'il relisait
 * ou qu'une sélection tenait le fil)
 * et `toEnd()` (redescendre en douceur, ex. après un envoi : un glissé, jamais un saut).
 */
export function useFollow(ref: RefObject<HTMLElement | null>, open = true, stick = 80, grow?: unknown, hold = false) {
  const reading = useRef(false)
  const held = useRef(hold)
  held.current = hold
  const [behind, setBehind] = useState(false)
  const behindRef = useRef(false)
  const setB = (v: boolean) => {
    if (behindRef.current === v) return
    behindRef.current = v
    setBehind(v)
  }
  const user = useRef({ touching: false, until: 0, tapAt: 0, gliding: false, stopGlide: () => undefined as void })
  /** Un glissé vers le bas, image par image : la cible (le bas) est relue à chaque image, donc ce qui arrive pendant le
   * glissé le prolonge au lieu de le relancer (un scrollTo doux relancé à chaque image n'avance presque pas, puis saute). */
  const glide = () => {
    const el = ref.current
    const u = user.current
    if (!el) return
    if (reduced()) {
      el.scrollTop = el.scrollHeight
      return
    }
    if (u.gliding) return
    u.gliding = true
    const end = Date.now() + 1600
    let stop = false
    u.stopGlide = () => void (stop = true)
    const tick = () => {
      const target = el.scrollHeight - el.clientHeight
      const d = target - el.scrollTop
      if (stop || !el.isConnected || Math.abs(d) < 1 || Date.now() > end) {
        if (!stop && el.isConnected) el.scrollTop = target
        u.gliding = false
        return
      }
      // Doux au départ comme à l'arrivée : jamais plus de 90 px par image (un long trajet prend quelques images de plus).
      el.scrollTop += Math.sign(d) * Math.min(90, Math.max(2, Math.abs(d) * 0.18))
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }
  const far = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight > stick
  // La sélection relâchée : ce qui est arrivé pendant qu'elle tenait le fil est rejoint en glissant, pas d'un saut.
  const wasHeld = useRef(hold)
  useEffect(() => {
    const el = ref.current
    if (wasHeld.current && !hold && el && open && !reading.current && far(el)) {
      setB(false)
      glide()
    }
    wasHeld.current = hold
  }, [hold]) // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !open) return
    el.scrollTop = el.scrollHeight
    reading.current = false
    setB(false)
  }, [ref, open]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const u = user.current
    const mark = (ms: number) => () => (u.until = Date.now() + ms)
    const down = () => {
      u.touching = true
      u.stopGlide()
    }
    const up = () => {
      u.touching = false
      u.until = Date.now() + 1200 // l'élan du doigt continue de défiler
    }
    const wheel = () => {
      u.stopGlide()
      mark(400)()
    }
    const key = mark(600)
    const onScroll = () => {
      const isFar = far(el)
      if (!isFar) {
        reading.current = false
        setB(false)
      }
      if (u.gliding || (!u.touching && Date.now() > u.until)) return // notre propre défilement, ou le contenu qui bouge
      reading.current = isFar
    }
    // Un tap sur un bouton du fil (déplier, « lire tout », étapes, code) : ce qui s'ouvre s'ouvre vers le bas.
    const tap = (e: Event) => {
      const t = e.target as Element | null
      if (t?.closest?.('button, [role="button"], summary, a')) u.tapAt = Date.now()
    }
    const pin = (fromSize: boolean) => {
      if (!el.isConnected || el.clientHeight === 0) return
      if (reading.current || held.current) {
        if (fromSize && far(el)) setB(true)
        return
      }
      if (u.gliding || (fromSize && Date.now() - u.tapAt < 900)) return
      el.scrollTop = el.scrollHeight
    }
    // Le contenu grandit, ou le fil raccourcit (clavier, panneau dessous) : on suit, à chaque changement de taille.
    const ro = new ResizeObserver(() => pin(true))
    const watch = () => {
      ro.disconnect()
      ro.observe(el)
      for (const c of Array.from(el.children)) ro.observe(c)
    }
    watch()
    const mo = new MutationObserver(() => {
      watch()
      pin(true)
    })
    mo.observe(el, { childList: true })
    el.addEventListener('touchstart', down, { passive: true })
    el.addEventListener('touchmove', down, { passive: true })
    el.addEventListener('touchend', up, { passive: true })
    el.addEventListener('touchcancel', up, { passive: true })
    el.addEventListener('pointerdown', down, { passive: true })
    el.addEventListener('pointerup', up, { passive: true })
    el.addEventListener('wheel', wheel, { passive: true })
    el.addEventListener('keydown', key)
    el.addEventListener('click', tap, true)
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      ro.disconnect()
      mo.disconnect()
      el.removeEventListener('touchstart', down)
      el.removeEventListener('touchmove', down)
      el.removeEventListener('touchend', up)
      el.removeEventListener('touchcancel', up)
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('wheel', wheel)
      el.removeEventListener('keydown', key)
      el.removeEventListener('click', tap, true)
      el.removeEventListener('scroll', onScroll)
    }
  }, [ref]) // eslint-disable-line react-hooks/exhaustive-deps
  // Ce qui allonge le contenu, connu de l'appelant (dernier message, indicateur de travail) : on suit aussi au rendu,
  // sans attendre l'observateur de taille.
  useEffect(() => {
    const el = ref.current
    if (!el || !open) return
    if (reading.current || held.current) {
      if (grow !== undefined && far(el)) setB(true)
      return
    }
    if (user.current.gliding) return
    el.scrollTop = el.scrollHeight
  }, [ref, open, grow]) // eslint-disable-line react-hooks/exhaustive-deps
  return {
    reading,
    behind,
    /** Redescendre en douceur et reprendre le suivi (après un envoi : sa réponse arrive en bas). Pendant le glissé,
     * ce qui arrive prolonge le même mouvement doux au lieu de sauter. */
    toEnd: () => {
      reading.current = false
      setB(false)
      glide()
    },
  }
}

/** Les bords réellement libres de l'écran : sous la barre d'état (status-cover), au-dessus du rail 24/7 (sauf page
 * ouverte, qui le recouvre) et du clavier (visualViewport). */
function viewBounds() {
  const vv = window.visualViewport
  const vTop = vv?.offsetTop ?? 0
  const top = Math.max(vTop, document.querySelector('.status-cover')?.getBoundingClientRect().bottom ?? 0)
  let bottom = vTop + (vv?.height ?? window.innerHeight)
  if (!document.documentElement.dataset.page) {
    const rail = document.querySelector('.h24-head')?.getBoundingClientRect().top
    if (rail && rail > top) bottom = Math.min(bottom, rail)
  }
  return { top, bottom }
}

/** L'élément est-il entièrement visible, dans la fenêtre (bords libres) et dans ses conteneurs qui défilent ?
 * Sa marge `scroll-margin-bottom` compte (un bouton flottant posé dessus, comme le logo des pages). */
function inView(el: Element) {
  const r = el.getBoundingClientRect()
  const mb = parseFloat(getComputedStyle(el).scrollMarginBottom) || 0
  const v = viewBounds()
  if (r.top < v.top || r.bottom + mb > v.bottom) return false
  for (let p = el.parentElement; p; p = p.parentElement) {
    const s = getComputedStyle(p)
    if (!/(auto|scroll|hidden)/.test(s.overflowY)) continue
    const b = p.getBoundingClientRect()
    if (r.top < b.top - 1 || r.bottom + mb > b.bottom + 1) return false
  }
  return true
}

/**
 * Garde un élément à la même place à l'écran pendant que la mise en page bouge autour (une bande au-dessus qui se
 * replie, l'ordre qui change) : la fenêtre défile d'autant, image par image, pendant `ms`. Un geste de l'utilisateur
 * l'arrête. Renvoie `fix()`, à appeler aussi juste après le rendu (avant l'affichage) pour un changement instantané.
 */
export function keepInPlace(el: Element | null | undefined, ms = 650): () => void {
  if (!el) return () => undefined
  const top0 = el.getBoundingClientRect().top
  const start = Date.now()
  const end = start + ms
  let stop = false
  const off = () => (stop = true)
  window.addEventListener('touchstart', off, { once: true, passive: true })
  window.addEventListener('wheel', off, { once: true, passive: true })
  const fix = () => {
    if (userScrolling(start)) stop = true
    if (stop || !el.isConnected) return
    const d = el.getBoundingClientRect().top - top0
    if (Math.abs(d) >= 1) window.scrollBy(0, d)
  }
  const tick = () => {
    fix()
    if (!stop && Date.now() < end) requestAnimationFrame(tick)
    else {
      window.removeEventListener('touchstart', off)
      window.removeEventListener('wheel', off)
    }
  }
  requestAnimationFrame(tick)
  return fix
}

/**
 * Amène un élément sous les yeux (défilement doux, seulement s'il n'y est pas déjà) et le met en avant un instant.
 * `block` : où le poser s'il faut défiler ('nearest' par défaut : le plus petit mouvement possible).
 */
export function reveal(el: Element | null | undefined, opts: { block?: ScrollLogicalPosition; flash?: boolean } = {}) {
  if (!el) return
  // Il défile lui-même en ce moment (un reveal différé, après une animation) : on ne l'en détourne pas.
  if (!inView(el) && !userScrolling()) el.scrollIntoView({ behavior: behavior(), block: opts.block ?? 'nearest' })
  if (opts.flash !== false) flash(el)
}

/** Une brève mise en avant (la bande s'éclaire puis revient) : « c'est ici ». */
export function flash(el: Element | null | undefined) {
  if (!el || reduced()) return
  el.classList.remove('wv-flash')
  void (el as HTMLElement).offsetWidth // relance l'animation si elle tournait déjà
  el.classList.add('wv-flash')
  window.setTimeout(() => el.classList.remove('wv-flash'), 1100)
}

/** Le fil de weevboss, ouvert en haut de l'écran, d'où qu'on soit (App.tsx l'écoute). `mid` : le message à mettre en
 * avant (sinon, le prochain qui arrive). */
export const FOCUS_BOSS = 'weevils:focus-boss'
export interface FocusBoss {
  /** Le message à mettre en avant ; sans : le prochain qui arrive. */
  mid?: string
  /** false : ouvrir seulement, sans mise en avant (un tap sur l'aperçu). */
  flash?: boolean
}
export const focusBoss = (o: FocusBoss = {}) => window.dispatchEvent(new CustomEvent<FocusBoss>(FOCUS_BOSS, { detail: o }))

/** Une réponse de weevboss arrivée pendant qu'une page le cachait : elle est mise sous les yeux au retour (App.tsx). */
let onReturn: { o: FocusBoss; at: number } | null = null
export const bossOnReturn = (o: FocusBoss = {}) => void (onReturn = { o, at: Date.now() })
/** Pris au retour sur le flux ; oublié au bout de 2 min (un retour bien plus tard n'a plus rien à voir). */
export const takeBossOnReturn = () => {
  const r = onReturn
  onReturn = null
  return r && Date.now() - r.at < 120_000 ? r.o : null
}

/** focusBoss, ou au retour sur le flux si une page est ouverte maintenant : une réponse lente (installation, parcours)
 * ne ferme jamais une page que l'utilisateur a ouverte entre-temps. */
export const focusBossSoon = (o: FocusBoss = {}) => (document.documentElement.dataset.page ? bossOnReturn(o) : focusBoss(o))

/** Attend qu'une condition soit vraie (image par image), au plus `ms`, puis appelle `then` (même si elle ne l'est pas). */
export function when(ok: () => boolean, then: () => void, ms = 800) {
  const end = Date.now() + ms
  const tick = () => (ok() || Date.now() > end ? then() : requestAnimationFrame(tick))
  tick()
}

/** Dans le fil ouvert de weevboss : met en avant le message `mid`, ou le prochain message qui arrive (6 s au plus). */
export function flashBossMessage(mid?: string) {
  const chat = () => document.querySelector<HTMLElement>('.band.agent .chat')
  const all = () => Array.from(chat()?.querySelectorAll<HTMLElement>('[data-mid]') ?? [])
  const before = new Set(all().map((e) => e.dataset.mid))
  let found: HTMLElement | undefined
  when(
    () => {
      found = mid ? all().find((e) => e.dataset.mid === mid) : all().find((e) => !before.has(e.dataset.mid))
      return !!found
    },
    () => {
      if (!found) return
      // Le message vient de se déplier (Appear) : on le met en avant une fois posé.
      const el = found
      window.setTimeout(() => reveal(el, { block: 'nearest' }), 260)
    },
    6000,
  )
}

/** Fait défiler la fenêtre (le flux des bandes) en douceur jusqu'en haut, où vit weevboss. */
export const toTop = () => window.scrollTo({ top: 0, behavior: behavior() })
