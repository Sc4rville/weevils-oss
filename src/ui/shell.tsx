import { motion } from 'motion/react'
import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { THEME_COLOR, useApp, type Theme } from './app-context'
import { spring } from './bits'
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

/** Page plein écran dans la couleur du projet. Glisser vers la droite = retour. */
export function Shell({
  slot,
  kicker,
  title,
  meta,
  children,
  foot,
  side,
  dock,
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
}) {
  const { back } = useApp()
  const t = useT(M)
  const heading = useRef<HTMLHeadingElement>(null)
  const page = useRef<HTMLDivElement>(null)
  useEffect(() => {
    heading.current?.focus({ preventScroll: true })
  }, [])
  usePageChrome(slot, page)
  return (
    <motion.div
      ref={page}
      className={side ? 'page split' : 'page'}
      style={color(slot)}
      initial={{ x: '100%' }}
      animate={{ x: 0 }}
      exit={{ x: '100%' }}
      transition={spring}
      drag="x"
      dragDirectionLock
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={{ left: 0, right: 0.9 }}
      dragSnapToOrigin
      onDragEnd={(_, info) => {
        if (info.offset.x > 110 || info.velocity.x > 600) {
          markSeen('g-back')
          back()
        }
      }}
      role="dialog"
      aria-modal="true"
      aria-label={typeof title === 'string' ? title : kicker}
    >
      <div className="page-head band tone">
        <div className="in">
          <button className="back" onClick={back} aria-label={t.back(kicker)}>
            <span aria-hidden>
              <Icon name="chevron" dir="left" />
            </span>
            <span className="meta" aria-hidden>
              {kicker}
            </span>
          </button>
          <h1 ref={heading} tabIndex={-1} className="h2" style={{ margin: 0 }}>
            {title}
          </h1>
          {meta && (
            <div className="meta" style={{ marginTop: 4 }}>
              {meta}
            </div>
          )}
        </div>
      </div>
      <div className="page-cols">
        <div className={dock && !foot ? 'page-main no-foot' : 'page-main'}>
          <div className="page-body" data-scroll>
            {children}
            <div className="fill" />
          </div>
          {dock && <div className="page-dock">{dock}</div>}
          {foot && <div className="page-foot">{foot}</div>}
        </div>
        {side && <aside className="page-side">{side}</aside>}
      </div>
    </motion.div>
  )
}

