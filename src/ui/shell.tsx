import { noticeKey } from '../../shared/notices.ts'
import { Notice } from './notice'
import { AnimatePresence, motion, useReducedMotion, type Variants } from 'motion/react'
import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { THEME_COLOR, useApp, type Theme } from './app-context'
import { Collapse, spring } from './bits'
import { flash } from './follow'
import { Icon } from './icons'
import { markSeen } from './hints'
import { useT } from '../i18n'
import M from '../i18n/shell'

const color = (slot: string) => ({ '--c': `var(--${slot})` }) as CSSProperties

/**
 * Pages ouvertes, la plus haute en dernier. Tant qu'une page est ouverte, tout ce qui pourrait dépasser (fond de la fenêtre
 * sous le clavier iOS, zone de rebond, barre d'état) prend sa couleur : rien d'un autre écran ne transparaît.
 */
const open: { slot: string; el: HTMLElement | null }[] = []
function applyTop(theme: Theme) {
  const top = open[open.length - 1]
  const root = document.documentElement
  const meta = document.querySelector('meta[name="theme-color"]')
  if (!top) {
    root.style.removeProperty('--page-c')
    delete root.dataset.page
    meta?.setAttribute('content', THEME_COLOR[theme])
    return
  }
  root.style.setProperty('--page-c', `var(--${top.slot})`)
  root.dataset.page = top.slot
  if (top.el) meta?.setAttribute('content', getComputedStyle(top.el).backgroundColor)
}

/** Une page ouverte teinte toute la fenêtre (fond, barre d'état) et masque le fil : à appeler depuis chaque page plein écran. */
export function usePageChrome(slot: string, page: React.RefObject<HTMLElement | null>) {
  const { theme } = useApp()
  useEffect(() => {
    const entry = { slot, el: page.current }
    open.push(entry)
    applyTop(theme)
    return () => {
      open.splice(open.indexOf(entry), 1)
      applyTop(theme)
    }
  }, [slot, theme, page])
}

/** La page suivante remplace celle-ci (session lancée depuis « nouvelle session », conversation reprise) : l'une s'efface
 * sur place et l'autre apparaît, au lieu d'un aller-retour qui laisse voir le flux derrière. À appeler juste avant replace(). */
let swapUntil = 0
export const swapPage = () => void (swapUntil = Date.now() + 600)
const swapping = () => Date.now() < swapUntil
// Fonctions de variante : lues au moment où l'animation part (la sortie de l'ancienne page, l'entrée de la nouvelle).
const slide: Variants = {
  enter: () => (swapping() ? { opacity: 0 } : { x: '100%' }),
  shown: { x: 0, opacity: 1 },
  leave: () => (swapping() ? { opacity: 0, transition: { duration: 0.15 } } : { x: '100%' }),
}

/** Une erreur d'action, au-dessus de la saisie (là où est le regard), mise en avant à chaque nouvelle erreur. */
export function FootError({ text }: { text: string | null }) {
  const last = useRef(text)
  if (text) last.current = text
  const band = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (text) flash(band.current)
  }, [text])
  return (
    <Collapse open={!!text}>
      <Notice eventId={noticeKey("foot-error", location.pathname, location.hash, text)} ref={band} className="band invert" role="alert">
        <div className="in meta" style={{ paddingBlock: 12 }}>
          ! {last.current}
        </div>
      </Notice>
    </Collapse>
  )
}

/** Le volet à côté du fil (navigateur intégré) : il s'ouvre et se referme en glissant, le fil se partage en douceur.
 * `split` : la page est partagée (vrai aussi pendant que le volet se referme). */
export function useSplit(open: boolean) {
  const [split, setSplit] = useState(open)
  if (open && !split) setSplit(true)
  return [split, () => setSplit(false)] as const
}

export function SidePane({ side, onGone }: { side?: ReactNode; onGone: () => void }) {
  const still = useReducedMotion()
  const hidden = { flexGrow: 0, flexBasis: '0%', minHeight: '0%', opacity: 0 }
  return (
    <AnimatePresence initial={false} onExitComplete={onGone}>
      {side && (
        <motion.aside
          key="side"
          className="page-side"
          initial={still ? false : hidden}
          animate={{ flexGrow: 1, flexBasis: '50%', minHeight: '45%', opacity: 1 }}
          exit={still ? { opacity: 0, transition: { duration: 0 } } : hidden}
          transition={spring}
        >
          {side}
        </motion.aside>
      )}
    </AnimatePresence>
  )
}

function BackButton({ kicker, onClick, label }: { kicker: string; onClick: () => void; label: string }) {
  return (
    <button className="back" onClick={onClick} aria-label={label}>
      <span aria-hidden>
        <Icon name="chevron" dir="left" />
      </span>
      <span className="meta" aria-hidden>
        {kicker}
      </span>
    </button>
  )
}

/** Page plein écran dans la couleur du projet. Glisser vers la droite = retour ; vers la gauche = la page suivante, s'il y en a une (onSwipeLeft). */
export function Shell({
  slot,
  kicker,
  title,
  meta,
  children,
  foot,
  side,
  dock,
  float,
  bodyRef,
  onSwipeLeft,
  actions,
  scrollHeading = false,
}: {
  slot: string
  kicker: string
  title: ReactNode
  meta?: ReactNode
  children: ReactNode
  foot?: ReactNode
  /** Volet à côté du fil (navigateur intégré) : la page se partage en deux. */
  side?: ReactNode
  /** Le logo de weevboss : il flotte en bas à gauche de la page, au-dessus de la saisie, sans prendre de place (jamais en haut à droite). */
  dock?: ReactNode
  /** Bouton qui flotte en bas à droite du fil, au-dessus de la saisie (« du nouveau en bas »). */
  float?: ReactNode
  /** Le conteneur qui défile (le fil), pour qui doit le garder en bas. */
  bodyRef?: RefObject<HTMLDivElement | null>
  /** La page suivante de la suite des glissés (fil → repos → logiciels) : sans elle, rien ne bouge vers la gauche. */
  onSwipeLeft?: () => void
  /** Icon buttons at the right of the back-button row (pause, run now…). */
  actions?: ReactNode
  /** Keep only navigation fixed; long session context scrolls with its messages. */
  scrollHeading?: boolean
}) {
  const { back } = useApp()
  const t = useT(M)
  const heading = useRef<HTMLHeadingElement>(null)
  const page = useRef<HTMLDivElement>(null)
  useEffect(() => {
    heading.current?.focus({ preventScroll: true })
  }, [])
  usePageChrome(slot, page)
  const [split, unsplit] = useSplit(!!side)
  const details = (
    <>
      <h1 ref={heading} tabIndex={-1} className="h2" style={{ margin: 0 }}>
        {title}
      </h1>
      {meta && <div className="meta" style={{ marginTop: 4 }}>{meta}</div>}
    </>
  )
  return (
    <motion.div
      ref={page}
      className={split ? 'page split' : 'page'}
      style={color(slot)}
      variants={slide}
      initial="enter"
      animate="shown"
      exit="leave"
      transition={spring}
      drag="x"
      dragDirectionLock
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={{ left: onSwipeLeft ? 0.18 : 0, right: 0.9 }}
      dragSnapToOrigin
      onDragEnd={(_, info) => {
        if (info.offset.x > 110 || info.velocity.x > 600) {
          markSeen('g-back')
          back()
        } else if (onSwipeLeft && (info.offset.x < -90 || info.velocity.x < -600)) onSwipeLeft()
      }}
      role="dialog"
      aria-modal="true"
      aria-label={typeof title === 'string' ? title : kicker}
    >
      <div className="page-head band tone">
        <div className="in">
          {actions ? (
            <div className="page-acts">
              <BackButton kicker={kicker} onClick={back} label={t.back(kicker)} />
              <div className="chars">{actions}</div>
            </div>
          ) : (
            <BackButton kicker={kicker} onClick={back} label={t.back(kicker)} />
          )}
          {!scrollHeading && details}
        </div>
      </div>
      <div className="page-cols">
        <div className={dock && !foot ? 'page-main no-foot' : 'page-main'}>
          <div ref={bodyRef} className="page-body" data-scroll>
            {scrollHeading && <div className="in session-heading">{details}</div>}
            {children}
            <div className="fill" />
          </div>
          {dock && <div className="page-dock">{dock}</div>}
          {float && <div className={foot ? 'page-float' : 'page-float no-foot'}>{float}</div>}
          {foot && <div className="page-foot">{foot}</div>}
        </div>
        <SidePane side={side} onGone={unsplit} />
      </div>
    </motion.div>
  )
}

