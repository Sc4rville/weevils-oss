import { motion, useReducedMotion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { useApp } from './app-context'
import { isSeen, markSeen } from './hints'
import { useFlow } from './setup'
import './coach.css'

// Les gestes de l'app, montrés plutôt qu'expliqués. Quand un geste devient utile (le fil des projets est vide : les
// repos sont à un glissé ; une page est ouverte : le retour est un glissé depuis le bord ; le fil de weevboss est ouvert :
// un mot se tape pour l'expliquer…), un doigt fantôme le mime une fois sur l'élément, sans un mot. Jamais si le geste a
// déjà été fait (hints.json, partagé par les appareils), jamais deux de suite : au plus un toutes les 25 s, après
// quelques secondes sans toucher l'écran, jamais pendant l'intro, une bulle, une carte d'astuce ou un branchement.

type Move = 'swipe-left' | 'swipe-right' | 'pull-down' | 'pinch' | 'tap' | 'press'

interface Gesture {
  /** Fait pour de vrai : hints.json (bulle de la page vue, ou markSeen à l'endroit du geste). */
  done: string
  move: Move
  /** Le contexte où il devient utile, et où le mimer (null : pas maintenant). */
  where: (c: Ctx) => DOMRect | null
}

interface Ctx {
  page: string | undefined
  agentOpen: boolean
  projects: number
  mainCount: number
}

/** La partie d'un élément vraiment à l'écran (sous le haut de la fenêtre, au-dessus du rail 24/7) : un grand élément
 * défilé (le flux, main.stack) a son haut bien au-dessus de l'écran, le doigt mimerait hors de la vue. */
function onScreen(r: DOMRect | undefined): DOMRect | null {
  if (!r || !r.width) return null
  const rail = document.documentElement.dataset.page ? undefined : document.querySelector('.h24-head')?.getBoundingClientRect().top
  const top = Math.max(r.top, 0)
  // Sous le rail (qui le recouvre) : rien de visible, pas de doigt.
  const bottom = Math.min(r.bottom, rail && rail > 0 ? rail : window.innerHeight)
  return bottom > top ? new DOMRect(r.left, top, r.width, bottom - top) : null
}

/** Le dernier élément qui correspond, s'il est à l'écran (sa partie visible). */
const rect = (sel: string) => onScreen([...document.querySelectorAll<HTMLElement>(sel)].at(-1)?.getBoundingClientRect())

const firstRect = (sel: string) => onScreen(document.querySelector<HTMLElement>(sel)?.getBoundingClientRect())

/** La page du dessus, si elle contient cet élément (les pages n'ont pas d'autre marque que leur contenu). */
const topPage = (inner: string) => {
  const page = [...document.querySelectorAll<HTMLElement>('.page')].at(-1)
  if (!page?.querySelector(inner)) return null
  const r = page.getBoundingClientRect()
  return r.width && r.height ? r : null
}

/** Le premier mot d'au moins 5 lettres du dernier message de weevboss visible : là où taper pour demander. */
function wordRect(): DOMRect | null {
  const bubbles = [...document.querySelectorAll<HTMLElement>('.band.agent .ask-thread [data-mid] .text')].reverse()
  for (const b of bubbles) {
    const box = b.getBoundingClientRect()
    if (box.bottom < 80 || box.top > window.innerHeight - 140) continue
    const walk = document.createTreeWalker(b, NodeFilter.SHOW_TEXT)
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const m = /\p{L}{5,}/u.exec(n.textContent ?? '')
      if (!m) continue
      const r = document.createRange()
      r.setStart(n, m.index)
      r.setEnd(n, m.index + m[0].length)
      const w = r.getBoundingClientRect()
      if (w.width && w.top > 80 && w.bottom < window.innerHeight - 140) return w
    }
  }
  return null
}

/** Par ordre de priorité : le premier utile dans le contexte du moment est mimé. */
const GESTURES: Gesture[] = [
  // La page des repos : les logiciels sont à un glissé de plus vers la gauche.
  { done: 'softwares', move: 'swipe-left', where: (c) => (c.page ? topPage('.repo-grid') : null) },
  // Une page ouverte : on revient en glissant depuis le bord gauche.
  { done: 'g-back', move: 'swipe-right', where: (c) => (c.page ? rect('.page') : null) },
  // Le fil de weevboss ouvert : un mot se tape pour l'expliquer ; on le referme en tirant vers le bas.
  { done: 'g-ask', move: 'tap', where: (c) => (c.agentOpen && !c.page ? wordRect() : null) },
  { done: 'g-collapse', move: 'pull-down', where: (c) => (c.agentOpen && !c.page ? rect('#agent-body .chat') : null) },
  { done: 'g-copy', move: 'press', where: (c) => (c.agentOpen && !c.page ? rect('.band.agent .ask-thread [data-mid]') : null) },
  // Le fil des projets : les repos sont à un glissé vers la gauche (surtout quand il est vide).
  { done: 'repos', move: 'swipe-left', where: (c) => (!c.agentOpen && !c.page ? rect('main.stack') : null) },
  // Des projets : un tap sur le nom les replie ; beaucoup de messages : pincer pour ne garder que la conversation.
  { done: 'g-fold', move: 'tap', where: (c) => (!c.agentOpen && !c.page && c.projects > 0 ? firstRect('.band[data-project] .head-name .name') : null) },
  // Le logo de weevboss : on lui parle d'un tap (la bulle dit la suite au premier tap).
  { done: 'voice', move: 'tap', where: (c) => (!c.page ? firstRect('.voice-logo') : null) },
  { done: 'calm', move: 'pinch', where: (c) => (!c.agentOpen && !c.page && c.mainCount >= 4 ? rect('main.stack') : null) },
]

/** Calme depuis tant de ms avant de mimer, et au plus un geste par tant de ms. */
const IDLE_MS = 3500
const GAP_MS = 25_000

export function GestureCoach() {
  const { snap, expanded } = useApp()
  const flow = useFlow()
  const reduce = useReducedMotion()
  const [ghost, setGhost] = useState<{ move: Move; r: DOMRect; key: number } | null>(null)
  const lastTouch = useRef(Date.now())
  const lastGhost = useRef(0)
  const ctx = useRef<Ctx>({ page: undefined, agentOpen: false, projects: 0, mainCount: 0 })
  ctx.current = { page: document.documentElement.dataset.page, agentOpen: expanded === 'agent', projects: snap.projects.length, mainCount: snap.main.length }
  const busy = useRef(false)
  busy.current = !!flow

  useEffect(() => {
    const touch = () => {
      lastTouch.current = Date.now()
      setGhost(null)
    }
    // Les premiers pas demandent un geste précis (« montre-moi ») : mimé tout de suite, où qu'on en soit.
    const show = (e: Event) => {
      const id = (e as CustomEvent<string>).detail
      const g = GESTURES.find((x) => x.done === id)
      const r = g?.where({ ...ctx.current, page: document.documentElement.dataset.page, agentOpen: false, mainCount: 99, projects: Math.max(1, ctx.current.projects) })
      if (!g || !r) return
      const now = Date.now()
      lastGhost.current = now
      setGhost({ move: g.move, r, key: now })
      window.setTimeout(() => setGhost((x) => (x?.key === now ? null : x)), 3200)
    }
    window.addEventListener('weevils:coach', show)
    window.addEventListener('pointerdown', touch, { capture: true })
    window.addEventListener('keydown', touch)
    window.addEventListener('scroll', touch, { capture: true, passive: true })
    const id = window.setInterval(() => {
      const now = Date.now()
      if (now - lastTouch.current < IDLE_MS || now - lastGhost.current < GAP_MS || busy.current || document.hidden) return
      if (document.querySelector('.ob, .hint, .tip') || localStorage.getItem('weevils-onboarded') !== '1') return
      const c = { ...ctx.current, page: document.documentElement.dataset.page }
      for (const g of GESTURES) {
        if (isSeen(g.done) || isSeen(`ghost-${g.done}`)) continue
        const r = g.where(c)
        if (!r) continue
        lastGhost.current = now
        markSeen(`ghost-${g.done}`)
        setGhost({ move: g.move, r, key: now })
        window.setTimeout(() => setGhost((x) => (x?.key === now ? null : x)), 3200)
        return
      }
    }, 700)
    return () => {
      window.clearInterval(id)
      window.removeEventListener('weevils:coach', show)
      window.removeEventListener('pointerdown', touch, { capture: true })
      window.removeEventListener('keydown', touch)
      window.removeEventListener('scroll', touch, { capture: true })
    }
  }, [])

  if (!ghost || reduce) return null
  return <Ghost key={ghost.key} move={ghost.move} r={ghost.r} />
}

/** Un doigt (un carré d'encre, plat) qui mime le geste deux fois, puis s'efface. */
function Ghost({ move, r }: { move: Move; r: DOMRect }) {
  const cx = r.left + r.width / 2
  const cy = r.top + Math.min(r.height / 2, 260)
  const loop = { duration: 1.2, repeat: 1, repeatDelay: 0.35, ease: [0.4, 0, 0.2, 1] as const }
  const dot = (x: number[], y: number[], extra: Record<string, number[]> = {}, delay = 0) => (
    <motion.span
      className="coach-dot"
      style={{ left: 0, top: 0 }}
      initial={{ x: x[0] - 13, y: y[0] - 13, opacity: 0 }}
      animate={{ x: x.map((v) => v - 13), y: y.map((v) => v - 13), opacity: [0, 1, 1, 0], ...extra }}
      transition={{ ...loop, delay, times: [0, 0.15, 0.8, 1] }}
    />
  )
  return (
    <div className="coach-ghost" data-move={move} aria-hidden>
      {move === 'swipe-left' && dot([r.right - 70, r.right - 70, r.left + 50, r.left + 50], [cy, cy, cy, cy])}
      {move === 'swipe-right' && dot([r.left + 4, r.left + 4, r.left + 170, r.left + 170], [cy, cy, cy, cy])}
      {move === 'pull-down' && dot([cx, cx, cx, cx], [r.top + 30, r.top + 30, r.top + 200, r.top + 200])}
      {move === 'pinch' && (
        <>
          {dot([cx - 90, cx - 90, cx - 22, cx - 22], [cy - 90, cy - 90, cy - 22, cy - 22])}
          {dot([cx + 90, cx + 90, cx + 22, cx + 22], [cy + 90, cy + 90, cy + 22, cy + 22])}
        </>
      )}
      {move === 'tap' && dot([cx, cx, cx, cx], [r.top + r.height / 2, r.top + r.height / 2, r.top + r.height / 2, r.top + r.height / 2], { scale: [1.4, 0.8, 1, 1] })}
      {move === 'press' && dot([cx, cx, cx, cx], [cy, cy, cy, cy], { scale: [0.8, 0.8, 1.7, 1.7] })}
    </div>
  )
}
