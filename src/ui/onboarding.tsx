import { AnimatePresence, motion, useReducedMotion, type PanInfo, type Variants } from 'motion/react'
import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { Machine } from '../../shared/api.ts'
import { api } from '../api'
import { useT } from '../i18n'
import M from '../i18n/onboarding'
import { useApp } from './app-context'
import { Line } from './bits'
import { Icon } from './icons'
import { WeevbossLogo } from './logo'
import './onboarding.css'

// Premier lancement : trois cartes plein écran (une machine, une session, weevboss). Courtes, visuelles, rejouables depuis les réglages.

const KEY = 'weevils-onboarded'
const REPLAY = 'weevils:onboarding'
/** « En ajouter une autre » : juste après l'intro, weevboss ouvre son fil sur le branchement d'une machine (src/ui/setup.tsx). */
export const WANT_MACHINE = 'weevils-want-machine'
/** Une couleur de la palette par étape. */
const COLORS = ['p9', 'p2', 'agent'] as const
const ACCENTS = ['p4', 'p12', 'p6'] as const
/** Taille des machines selon leur nombre (fantôme « + » compris) : tout tient en 375 px. */
const TILE: Record<number, number> = { 2: 116, 3: 92, 4: 72 }

const isDone = () => {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return true // sans stockage, on ne force rien
  }
}
const markDone = () => {
  try {
    localStorage.setItem(KEY, '1')
  } catch {
    /* stockage indisponible */
  }
}

/** Rouvre l'intro (ligne des réglages). */
export const replayOnboarding = () => window.dispatchEvent(new Event(REPLAY))

/** Champ de saisie de la bande weevboss (sans toucher à bands.tsx). */
const bossInput = () => document.querySelector<HTMLInputElement>('.band.agent form.composer input[enterkeyhint]')

const slide: Variants = {
  enter: (d: number) => ({ x: d > 0 ? '100%' : '-100%', zIndex: 2 }),
  center: { x: 0, zIndex: 1 },
  exit: (d: number) => ({ x: d > 0 ? '-35%' : '35%', zIndex: 0 }),
}

const vars = (step: number) => ({ '--c': `var(--${COLORS[step]})`, '--a': `var(--${ACCENTS[step]})` }) as CSSProperties

export function Onboarding() {
  const { snap, push } = useApp()
  const t = useT(M)
  // Un fil déjà peuplé (sessions et projets, ou weevboss déjà sollicité) = déjà accueilli : l'intro ne s'impose pas.
  const populated = (snap.sessions.length > 0 && snap.projects.length > 0) || snap.main.some((m) => m.role === 'user')
  const [open, setOpen] = useState(() => !isDone() && !populated)
  const [step, setStep] = useState(0)
  const [dir, setDir] = useState(1)
  /** Partie ouvrir la page « nouvelle session » : l'intro attend le retour au fil. */
  const [away, setAway] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (populated && !isDone()) markDone()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const ticks = [snap.machines.some((m) => m.online !== false), snap.sessions.length > 0, snap.main.some((m) => m.role === 'user')]

  const close = useCallback((restore = true) => {
    markDone()
    setOpen(false)
    setAway(false)
    if (restore) setTimeout(() => opener.current?.focus?.({ preventScroll: true }), 60)
  }, [])

  const go = useCallback(
    (to: number) => {
      if (to < 0) return
      if (to > 2) return close()
      setDir(to > step ? 1 : -1)
      setStep(to)
    },
    [step, close],
  )

  // Rejouer depuis les réglages.
  useEffect(() => {
    const onReplay = () => {
      opener.current = document.activeElement as HTMLElement | null
      setDir(1)
      setStep(0)
      setAway(false)
      setOpen(true)
    }
    window.addEventListener(REPLAY, onReplay)
    return () => window.removeEventListener(REPLAY, onReplay)
  }, [])

  // De retour au fil après la page « nouvelle session » : l'intro revient où elle était.
  useEffect(() => {
    if (!away) return
    const root = document.documentElement
    let seen = !!root.dataset.page
    const obs = new MutationObserver(() => {
      if (root.dataset.page) seen = true
      else if (seen) setAway(false)
    })
    obs.observe(root, { attributes: true, attributeFilter: ['data-page'] })
    return () => obs.disconnect()
  }, [away])

  const visible = open && !away

  // Échap ferme, flèches pour changer d'étape.
  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation()
        close()
      } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !(e.target instanceof HTMLInputElement)) {
        go(step + (e.key === 'ArrowRight' ? 1 : -1))
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [visible, step, go, close])

  // Le focus entre dans la boîte de dialogue à l'ouverture et à chaque étape.
  useEffect(() => {
    if (!visible) return
    if (!opener.current) opener.current = document.activeElement as HTMLElement | null
    const id = setTimeout(() => document.getElementById(`ob-t${step}`)?.focus({ preventScroll: true }), 80)
    return () => clearTimeout(id)
  }, [visible, step])

  // Le focus reste dans la boîte de dialogue (Tab boucle).
  const trap = (e: ReactKeyboardEvent) => {
    if (e.key !== 'Tab' || !box.current) return
    const els = [...box.current.querySelectorAll<HTMLElement>('button:not(:disabled), input, [tabindex="0"]')].filter((el) => el.offsetParent !== null)
    if (!els.length) return
    const first = els[0]
    const last = els[els.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.x < -70 || info.velocity.x < -500) go(step + 1)
    else if (info.offset.x > 70 || info.velocity.x > 500) go(step - 1)
  }

  const newSession = () => {
    setAway(true)
    push({ kind: 'new', projectId: '__any' })
  }

  // Écrire à weevboss : le champ prend le focus pendant le tap (sinon iOS n'ouvre pas le clavier), l'intro s'efface.
  const talk = () => {
    close(false)
    window.scrollTo({ top: 0 })
    bossInput()?.focus({ preventScroll: true })
  }

  const [sendErr, setSendErr] = useState<string | null>(null)
  const suggest = async () => {
    setSendErr(null)
    try {
      await api.main(t.suggestion)
      // Sending to weevboss never opens it full screen: the message and the reply show in its live preview.
      close(false)
      window.scrollTo({ top: 0 })
    } catch (e) {
      setSendErr((e as Error).message)
    }
  }

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="ob"
          ref={box}
          className="ob"
          style={vars(step)}
          role="dialog"
          aria-modal="true"
          aria-label={t.dialog}
          onKeyDown={trap}
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 40 }}
        >
          <AnimatePresence initial={false} custom={dir}>
            <motion.section
              key={step}
              className="ob-card"
              style={vars(step)}
              custom={dir}
              variants={slide}
              initial="enter"
              animate="center"
              exit="exit"
              drag="x"
              dragDirectionLock
              dragConstraints={{ left: 0, right: 0 }}
              dragElastic={0.4}
              onDragEnd={onDragEnd}
              aria-labelledby={`ob-t${step}`}
            >
              {step === 0 && <MachineStep machines={snap.machines} />}
              {step === 1 && (
                <Step n={1} title={t.sessionTitle} line={ticks[1] ? t.sessionDoneLine : t.sessionLine} visual={<SessionVisual done={ticks[1]} />}>
                  {ticks[1] ? <Big onClick={() => go(2)} label={t.onward} /> : <Big onClick={newSession} label={t.newSession} icon="plus" />}
                </Step>
              )}
              {step === 2 && (
                <Step n={2} title={t.bossTitle} line={ticks[2] ? t.bossDoneLine : t.bossLine} visual={<BossVisual done={ticks[2]} />}>
                  {!ticks[2] && (
                    <button className="ob-chip" onClick={() => void suggest()} aria-label={t.suggestionLabel(t.suggestion)}>
                      <Icon name="quote" />
                      <span>{t.suggestion}</span>
                    </button>
                  )}
                  {sendErr && (
                    <p className="ob-err" role="alert">
                      <Icon name="bang" /> {sendErr}
                    </p>
                  )}
                  {ticks[2] ? <Big onClick={() => close()} label={t.finish} /> : <Big onClick={talk} label={t.talk} />}
                </Step>
              )}
            </motion.section>
          </AnimatePresence>

          <header className="ob-top">
            <div className="ob-bars" role="group" aria-label={t.progress(step + 1, 3)}>
              {[0, 1, 2].map((i) => (
                <button key={i} className={`ob-bar ${i <= step ? 'on' : ''}`} onClick={() => go(i)} aria-label={t.progress(i + 1, 3)} aria-current={i === step ? 'step' : undefined}>
                  <span className="ob-bar-box">
                    <motion.span initial={false} animate={{ scaleX: i <= step ? 1 : 0 }} />
                  </span>
                </button>
              ))}
            </div>
            <button className="ob-skip" onClick={() => close()} aria-label={t.skipLabel}>
              {t.skip}
              <Icon name="close" />
            </button>
          </header>

          <nav className="ob-nav">
            <button className="ob-arrow" onClick={() => go(step - 1)} disabled={step === 0} aria-label={t.prev}>
              <Icon name="arrow" dir="left" />
            </button>
            <span className="ob-count" aria-hidden>
              {step + 1}/3
            </span>
            <button className="ob-arrow" onClick={() => go(step + 1)} aria-label={step === 2 ? t.finish : t.next}>
              <Icon name={step === 2 ? 'check' : 'arrow'} dir={step === 2 ? 'up' : 'right'} />
            </button>
          </nav>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// ---------------------------------------------------------------------------

function Step({ n, title, line, visual, children }: { n: number; title: string; line: string; visual: React.ReactNode; children: React.ReactNode }) {
  return (
    <>
      <div className="ob-visual" aria-hidden>
        {visual}
      </div>
      <div className="ob-text">
        <h2 id={`ob-t${n}`} className="ob-title" tabIndex={-1}>
          {title}
        </h2>
        <p className="ob-line">{line}</p>
      </div>
      <div className="ob-actions">{children}</div>
    </>
  )
}

function Big({ label, onClick, icon = 'arrow' }: { label: string; onClick: () => void; icon?: 'arrow' | 'plus' | 'check' | 'file' }) {
  return (
    <motion.button className="ob-big" onClick={onClick} whileTap={{ scale: 0.97 }}>
      <span>{label}</span>
      <Icon name={icon} dir={icon === 'arrow' ? 'right' : 'up'} />
    </motion.button>
  )
}

const pop = (i: number) => ({ initial: { scale: 0, rotate: -12 }, animate: { scale: 1, rotate: 0 }, transition: { type: 'spring' as const, stiffness: 520, damping: 18, delay: 0.12 + i * 0.09 } })

// ---- 1. Machine

function MachineStep({ machines }: { machines: Machine[] }) {
  const t = useT(M)
  const [adding, setAdding] = useState(false)
  const shown = machines.slice(0, 3)
  // Rien à copier ni à taper : weevboss pose les questions (hébergeur, adresse, mot de passe) juste après l'intro.
  const add = () => {
    try {
      localStorage.setItem(WANT_MACHINE, '1')
    } catch {
      /* stockage indisponible : la page machine garde son bouton */
    }
    setAdding(true)
  }

  return (
    <>
      <div className={`ob-visual ${adding ? 'small' : ''}`} style={{ ['--tile-max' as string]: `${TILE[shown.length + 1]}px`, ['--n' as string]: shown.length + 1 }}>
        <ul className="ob-machines" aria-label={t.machineTitle}>
          <motion.span className="ob-wire" aria-hidden initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ delay: 0.1 }}>
            <motion.i animate={{ left: ['0%', '100%'] }} transition={{ duration: 1.6, repeat: Infinity, ease: 'linear' }} />
          </motion.span>
          {shown.map((m, i) => (
            <motion.li key={m.id} className={`ob-machine ${m.online === false ? 'off' : ''}`} {...pop(i)}>
              <span className="ob-tile">
                <Icon name="machine" />
                {m.online !== false && (
                  <motion.span className="ob-check" {...pop(i + 3)}>
                    <Icon name="check" />
                  </motion.span>
                )}
              </span>
              <span className="ob-mname">{m.name}</span>
              <span className="ob-mstate">{i === 0 ? t.thisOne : m.online === false ? t.offline : t.online}</span>
            </motion.li>
          ))}
          <motion.li className="ob-machine ghost" {...pop(shown.length)}>
            <motion.button className="ob-tile" onClick={add} aria-label={t.addOther} animate={{ y: [0, -6, 0] }} transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}>
              <Icon name="plus" />
            </motion.button>
          </motion.li>
        </ul>
      </div>
      <div className="ob-text">
        <h2 id="ob-t0" className="ob-title" tabIndex={-1}>
          {t.machineTitle}
        </h2>
        <p className="ob-line">{adding ? t.addLine : t.machineLine}</p>
      </div>
      <div className="ob-actions">
        <Big onClick={add} label={adding ? t.addNoted : t.addOther} icon={adding ? 'check' : 'plus'} />
        {adding && (
          <span className="ob-sr" role="status">
            {t.addNoted}
          </span>
        )}
      </div>
    </>
  )
}

// ---- 2. Session

function SessionVisual({ done }: { done: boolean }) {
  // Mouvement réduit : les lignes restent posées (la boucle finirait à zéro).
  const still = useReducedMotion() || done
  return (
    <div className="ob-screen">
      <div className="ob-screen-bar">
        <Icon name="terminal" />
        <motion.span className="ob-spin" animate={{ rotate: 360 }} transition={{ duration: 3, repeat: Infinity, ease: 'linear' }}>
          <Icon name="star" />
        </motion.span>
      </div>
      {[0.82, 0.56, 0.7].map((w, i) => (
        <motion.span
          key={i}
          className={`ob-row ${i === 1 ? 'accent' : ''}`}
          initial={{ scaleX: 0 }}
          animate={{ scaleX: still ? w : [0, w, w, 0] }}
          transition={still ? { type: 'spring', stiffness: 300, damping: 24, delay: i * 0.08 } : { duration: 3.2, times: [0, 0.25, 0.85, 1], repeat: Infinity, delay: i * 0.35, ease: 'easeOut' }}
        />
      ))}
      <AnimatePresence>
        {done && (
          <motion.span key="stamp" className="ob-stamp" initial={{ scale: 2.4, rotate: -30, opacity: 0 }} animate={{ scale: 1, rotate: -10, opacity: 1 }} transition={{ type: 'spring', stiffness: 380, damping: 16 }}>
            <Icon name="check" />
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  )
}

// ---- 3. weevboss

function BossVisual({ done }: { done: boolean }) {
  return (
    <div className="ob-boss">
      <motion.span className="ob-bubble me" {...pop(0)}>
        <i />
        <i />
      </motion.span>
      <motion.span className="ob-logo" animate={{ rotate: [0, -6, 4, 0], y: [0, -8, 0] }} transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}>
        <WeevbossLogo />
      </motion.span>
      <motion.span className="ob-bubble it" {...pop(1)}>
        {done ? (
          <Icon name="check" />
        ) : (
          [0, 1, 2].map((i) => <motion.b key={i} animate={{ y: [0, -6, 0] }} transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.15 }} />)
        )}
      </motion.span>
    </div>
  )
}

// ---- Réglages

/** Ligne des réglages : revoir l'intro. */
export function OnboardingLine() {
  const t = useT(M)
  return (
    <Line ch="*" go={null} meta={t.replayMeta} onClick={replayOnboarding}>
      {t.replay}
    </Line>
  )
}
