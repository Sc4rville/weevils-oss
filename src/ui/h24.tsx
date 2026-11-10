import { animate, motion, useDragControls, useMotionValue } from 'motion/react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useApp } from './app-context'
import { spring } from './bits'
import { ago, durLong } from './format'
import { Icon } from './icons'
import { useT } from '../i18n'
import M from '../i18n/h24'
import B from '../i18n/bits'
import { tapHint } from './hints'

/** Bande H24 collée en bas : on la tire vers le haut (ou on la touche) pour voir les activités permanentes. */
export function H24Rail() {
  const { snap, now, refresh, h24Open: open, setH24Open: setOpen } = useApp()
  const t = useT(M)
  const tb = useT(B)
  const list = snap.h24
  const stats = { running: list.filter((a) => a.runState === 'running').length, total: list.length }
  const y = useMotionValue(0)
  const drawer = useRef<HTMLDivElement>(null)
  const probe = useRef<HTMLDivElement>(null)
  const dragged = useRef(false)
  const controls = useDragControls()
  const [closedY, setClosedY] = useState(0)

  const measure = useCallback(() => {
    const h = drawer.current?.offsetHeight ?? 0
    const visible = probe.current?.offsetHeight ?? 56
    setClosedY(Math.max(0, h - visible))
  }, [])

  useLayoutEffect(() => {
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [measure])

  // Position initiale sans animation, puis ressort à chaque ouverture/fermeture.
  const first = useRef(true)
  useEffect(() => {
    const target = open ? 0 : closedY
    if (first.current) {
      y.set(target)
      first.current = false
      return
    }
    const ctrl = animate(y, target, spring)
    return () => ctrl.stop()
  }, [open, closedY, y])

  const summary = stats.total ? t.summary(stats.running, stats.total - stats.running) : t.nothing

  return (
    <>
      {open && <div className="catcher" onClick={() => setOpen(false)} aria-hidden />}
      <motion.div
        ref={drawer}
        className="h24 band"
        style={{ y }}
        drag="y"
        dragListener={false}
        dragControls={controls}
        dragConstraints={{ top: 0, bottom: closedY }}
        dragElastic={{ top: 0.05, bottom: 0.2 }}
        dragMomentum={false}
        onDragStart={() => (dragged.current = true)}
        onDragEnd={(_, info) => {
          const current = y.get()
          const next = info.velocity.y < -300 ? true : info.velocity.y > 300 ? false : current < closedY / 2
          if (next === open) animate(y, next ? 0 : closedY, spring)
          setOpen(next)
        }}
        role="region"
        aria-label={t.region}
      >
        <div ref={probe} className="h24-probe" />
        <button
          className="h24-head"
          onPointerDown={(e) => {
            dragged.current = false
            controls.start(e)
          }}
          onClick={(e) => {
            if (dragged.current) {
              dragged.current = false
              return
            }
            if (!open && tapHint('h24', e.currentTarget)) return
            setOpen(!open)
          }}
          aria-expanded={open}
          aria-controls="h24-body"
          aria-label={t.head(summary, open)}
        >
          <span className="h24-grip" aria-hidden>
            <Icon name="grip" />
          </span>
          <span className="in" aria-hidden>
            <span className="h2">{t.title}</span>
            <span className="meta" style={{ flex: 1 }}>
              {summary}
            </span>
            <span className="h2" style={{ fontWeight: 500 }}>
              <Icon name="arrow" dir={open ? 'down' : 'up'} />
            </span>
          </span>
        </button>

        <div id="h24-body" className="h24-body" inert={!open}>
          {list.map((a) => {
            const running = a.runState === 'running'
            const paused = a.runState === 'paused'
            return (
              <div key={a.id} className="band tone" style={{ marginBottom: 2 }}>
                <div className="in" style={{ display: 'flex', alignItems: 'center', gap: 12, paddingBlock: 12 }}>
                  <span className="h2" aria-hidden style={{ width: 28, textAlign: 'center' }}>
                    {running ? <span className="spin"><Icon name="star" /></span> : <Icon name={paused ? 'pause' : a.kind === 'job' ? 'check' : 'idle'} />}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="strong ellipsis" style={{ fontSize: '1.0625rem' }}>
                      {a.title}
                      {a.demo && <span className="tr-tag">{tb.demo}</span>}
                    </div>
                    <div className="meta">
                      {a.kind === 'job'
                        ? running
                          ? t.running(a.runStartedAt ? durLong(now - a.runStartedAt) : null)
                          : t.finished(a.runStartedAt ? ago(now - a.runStartedAt) : '')
                        : `${paused ? t.paused : t.scheduled} · ${a.schedule}`}
                    </div>
                    <div className="small ellipsis">{a.lastEvent}</div>
                  </div>
                  {a.canToggle && (
                    <button
                      className="ch"
                      onClick={() => void api.toggleH24(a.id).then(refresh)}
                      aria-label={paused ? t.resume(a.title) : t.pause(a.title)}
                    >
                      <Icon name={paused ? 'play' : 'pause'} />
                    </button>
                  )}
                </div>
              </div>
            )
          })}
          {list.length === 0 && <div className="in meta empty">{t.empty}</div>}
          <div style={{ height: 14 }} />
        </div>
      </motion.div>
    </>
  )
}
