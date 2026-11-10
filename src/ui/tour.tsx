import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Snapshot } from '../../shared/api.ts'
import { BRICK_OF, DEMOS, groupOf, type Tour, type TourId, type TourStep } from '../../shared/tour.ts'
import { api } from '../api'
import { useT, tr } from '../i18n'
import M from '../i18n/tour'
import { useApp } from './app-context'
import { Collapse, Line } from './bits'
import { flash, focusBoss, reveal, when } from './follow'
import { markSeen } from './hints'
import { Icon } from './icons'
import { WeevbossLogo } from './logo'
import { PhoneLink, device, runBrick, useFlow } from './setup'
import { openPreviewOf } from './preview'
import './tour.css'

// Premiers pas (contrat : shared/tour.ts, serveur : server/tour.ts). On apprend en faisant :
// - TourIntro, au tout premier lancement : ce qui est déjà là se coche tout seul (« déjà prêt »), puis une vraie
//   demande à weevboss, en un tap (une suggestion), à la voix ou au clavier. Si Claude Code manque, c'est le seul
//   bouton : sans lui, rien ne pense.
// - TourBand, sous la bande de weevboss : la progression (un carré par étape), puis la suite, une étape à la fois.
//   Pendant la première demande, elle la suit en direct (envoyé, il répond, une session s'ouvre, l'agent travaille…).
//   Chaque usage se joue d'abord (démo marquée « démo », retirée dès que la vraie brique est branchée), puis se
//   branche d'un bouton ; chaque geste se montre (doigt fantôme) et se coche quand on le fait.
// - TourLine, dans les réglages : rouvrir les premiers pas.

const ONBOARDED = 'weevils-onboarded'
const FIRST = 'weevils-tour-first'

const setOnboarded = () => {
  try {
    localStorage.setItem(ONBOARDED, '1')
  } catch {
    /* stockage indisponible */
  }
}

// ---------------------------------------------------------------- la première demande, suivie en direct

interface First {
  /** Envoyée à (ms) ; les messages et sessions d'avant ne comptent pas. */
  at: number
  /** Sessions qui existaient avant. */
  before: string[]
}

let first: First | null = (() => {
  try {
    return JSON.parse(sessionStorage.getItem(FIRST) ?? 'null') as First | null
  } catch {
    return null
  }
})()
const firstListeners = new Set<() => void>()
const setFirst = (f: First | null) => {
  first = f
  try {
    if (f) sessionStorage.setItem(FIRST, JSON.stringify(f))
    else sessionStorage.removeItem(FIRST)
  } catch {
    /* stockage indisponible */
  }
  firstListeners.forEach((l) => l())
}
const useFirst = () =>
  useSyncExternalStore(
    (l) => {
      firstListeners.add(l)
      return () => firstListeners.delete(l)
    },
    () => first,
  )

type Milestone = 'mSent' | 'mThinking' | 'mReply' | 'mSession' | 'mWorking' | 'mDone'

/** Où en est la première demande, d'après le fil et les sessions. */
function milestones(snap: Snapshot, f: First): { list: Milestone[]; reached: number; over: boolean; stale: boolean; session?: string } {
  const mine = snap.main.find((m) => m.role === 'user' && m.at >= f.at - 2000 && !m.demo)
  const reply = mine && snap.main.find((m) => m.role === 'assistant' && m.at > mine.at && !m.demo && !m.id.startsWith('setup-'))
  const fresh = snap.sessions.filter((s) => !f.before.includes(s.id) && s.openedAt >= f.at - 5000)
  const working = fresh.some((s) => s.status === 'working')
  const settled = fresh.length > 0 && fresh.every((s) => s.status !== 'working')
  const list: Milestone[] = fresh.length ? ['mSent', 'mThinking', 'mSession', 'mWorking', 'mDone'] : ['mSent', 'mThinking', 'mReply', 'mDone']
  let reached = 0
  if (mine) reached = 1
  if (mine && (snap.mainWorking || reply || fresh.length)) reached = 2
  if (fresh.length) {
    reached = Math.max(reached, 3)
    if (working || settled) reached = 4
    if (settled && !snap.mainWorking) reached = 5
  } else if (reply) {
    reached = 3
    if (!snap.mainWorking) reached = 4
  }
  // Fini quand le travail l'est ; « parler » ou « écrire » sans rien envoyer en 3 min : le suivi s'efface.
  return { list, reached, over: reached >= list.length, stale: !mine && Date.now() - f.at > 3 * 60_000, session: fresh[0]?.id }
}

// ---------------------------------------------------------------- actions communes

/** Là où weevboss répond (son aperçu, ou son fil ouvert), amené sous les yeux : la liste des premiers pas peut l'avoir
 * poussé hors de l'écran, plus haut. */
function showBoss() {
  reveal(document.querySelector('.band.agent .peek-wrap:not([hidden])') ?? document.querySelector('.band.agent #agent-body:not([hidden])'), { block: 'nearest' })
}

/** Envoie une vraie demande à weevboss et la suit. */
async function ask(snap: Snapshot, text: string) {
  showBoss()
  setFirst({ at: Date.now(), before: snap.sessions.map((s) => s.id) })
  await api.main(text).catch(() => setFirst(null))
}

/** Le champ de weevboss, pour écrire ou préremplir. */
const bossInput = () => document.querySelector<HTMLInputElement>('.band.agent form.composer input[enterkeyhint]')

function prefill(text: string) {
  const el = bossInput()
  if (!el) return
  // React suit la valeur par son setter natif : on passe par lui pour que le champ la voie.
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, text)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  // Sans saut : le champ arrive à l'écran en douceur et s'éclaire (l'exemple prérempli ne passe pas inaperçu).
  el.focus({ preventScroll: true })
  reveal(el.closest('form'), { block: 'nearest' })
  // Le début de la phrase à l'écran (sinon le champ montre la fin, coupée).
  el.setSelectionRange(0, 0)
  el.scrollLeft = 0
}

/** Parler à weevboss tout de suite : le logo, sans sa bulle d'explication (le geste est appris en le faisant). */
function talk() {
  markSeen('voice')
  // Le logo et ce qu'il entend (dans le champ de weevboss) à l'écran : la liste des premiers pas a pu les faire sortir.
  reveal(document.querySelector('.band.agent'), { block: 'start', flash: false })
  document.querySelector<HTMLButtonElement>('.voice-logo')?.click()
}

/** Les suggestions de la première demande : un projet réel s'il y en a, sinon de quoi voir un agent travailler. */
function suggestions(snap: Snapshot): string[] {
  const t = tr(M)
  const recent = [...snap.projects].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))[0]
  return recent ? [t.sugStatus(recent.name), t.sugNotes] : [t.sugNotes, t.sugWhat]
}

/** Joue la démo d'un usage. */
async function playDemo(id: TourId, snap: Snapshot, ui: { caption: (s: string | null) => void; openThread: () => void }) {
  if (id === 'github') return ask(snap, tr(M).sugNotes)
  const r = await api.tourDemo(id).catch(() => null)
  if (!r) return
  if (id === 'voice' && r.text) {
    ui.caption(r.text)
    // La légende reste au moins le temps de la lire, même si la voix finit (ou échoue) avant.
    const shown = Date.now()
    const end = () => window.setTimeout(() => ui.caption(null), Math.max(0, r.text!.length * 55 - (Date.now() - shown)))
    if (r.audio) {
      const a = new Audio(`data:audio/mpeg;base64,${r.audio}`)
      a.onended = end
      a.play().catch(() => speak(r.text!, end))
    } else speak(r.text, end)
  }
  if (id === 'devil') {
    window.dispatchEvent(new Event('weevils:devil-flash'))
    showBoss()
  }
  // Le pont : l'échange se lit en entier, fil ouvert en haut de l'écran (les deux bulles, celle de l'agent à sa couleur).
  if (id === 'mail') ui.openThread()
}

/** La voix du navigateur, quand le serveur n'en a pas encore. */
function speak(text: string, end: () => void) {
  const synth = window.speechSynthesis
  if (!synth) return void window.setTimeout(end, 6000)
  const u = new SpeechSynthesisUtterance(text)
  u.lang = document.documentElement.lang === 'fr' ? 'fr-FR' : 'en-US'
  u.rate = 1.08
  u.onend = end
  u.onerror = end
  synth.cancel()
  synth.speak(u)
}

/** Les faits d'une étape, en mots. */
function factsOf(s: TourStep, now: number): string {
  const t = tr(M)
  const f = s.facts ?? {}
  switch (s.id) {
    case 'install': {
      const ago = t.ago(Math.round((now - Number(f.at ?? now)) / 60_000))
      return f.by === 'agent' ? t.byAgent(String(f.agent ?? ''), ago) : f.by === 'script' ? t.byScript(ago) : t.byTerminal(ago)
    }
    case 'machine':
      return t.machineFacts(`${t.kind(String(f.kind ?? ''))}${f.provider ? ` ${String(f.provider).toLowerCase()}` : ''}`, Number(f.cpus ?? 1), Number(f.ram ?? 0), !!f.always)
    case 'claude':
      return s.state === 'todo' ? t.u_claude : t.plan(String(f.plan ?? ''))
    case 'history':
      return t.historyFacts(Number(f.projects ?? 0), Number(f.sessions ?? 0), Number(f.repos ?? 0))
    case 'phone':
      return s.state === 'todo' ? t.u_phone : t.connected
    case 'github':
      return f.login ? t.login(String(f.login)) : t.u_github
    default:
      return (t as Record<string, unknown>)[`u_${s.id}`] as string
  }
}

const stateLabel = (s: TourStep) => {
  const t = tr(M)
  return s.state === 'ready' ? t.ready : s.state === 'done' ? t.doneLabel : s.state === 'skip' ? t.skipped : s.played ? t.played : ''
}

// ---------------------------------------------------------------- l'état

/** Les premiers pas : le snapshot les porte une fois le premier calcul fait (GET /api/tour, au premier affichage). */
export function useTour(): Tour | null {
  const { snap } = useApp()
  const [local, setLocal] = useState<Tour | null>(null)
  const asked = useRef(false)
  useEffect(() => {
    if (asked.current) return
    asked.current = true
    void api.tour(device().mobile).then(setLocal, () => undefined)
  }, [])
  return snap.tour ?? local
}

// ---------------------------------------------------------------- le premier écran

export function TourIntro() {
  const tour = useTour()
  const { snap } = useApp()
  const t = useT(M)
  const reduce = useReducedMotion()
  const [phase, setPhase] = useState<'scan' | 'first'>('scan')
  const [gone, setGone] = useState(false)
  const shown = !!tour && tour.open && !tour.intro && !gone
  const base = tour?.steps.filter((s) => groupOf(s.id) === 'base' && (s.state !== 'todo' || s.id === 'claude')) ?? []
  const claudeOk = !!tour?.steps.find((s) => s.id === 'claude' && s.state !== 'todo')

  // Les premiers pas déjà vus sur un autre appareil : celui-ci n'a pas à les revoir.
  useEffect(() => {
    if (tour?.intro) setOnboarded()
  }, [tour?.intro])
  // Le scan : une ligne cochée toutes les 300 ms, puis la première demande.
  useEffect(() => {
    if (!shown || phase !== 'scan') return
    const id = window.setTimeout(() => setPhase('first'), reduce ? 300 : base.length * 300 + 900)
    return () => window.clearTimeout(id)
  }, [shown, phase, base.length, reduce])

  const finish = () => {
    setOnboarded()
    setGone(true)
    void api.tourAct('intro').catch(() => undefined)
  }
  const send = (text: string) => {
    finish()
    void ask(snap, text)
  }
  const sug = suggestions(snap)

  return (
    <AnimatePresence>
      {shown && (
        <motion.div className="ob tr-intro" role="dialog" aria-modal="true" aria-label={t.dialog} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, y: -40 }} onClick={() => phase === 'scan' && setPhase('first')}>
          <div className="tr-intro-in">
            <div className="tr-head">
              <WeevbossLogo className="tr-logo" />
              <button type="button" className="tr-skip" onClick={finish}>
                {t.skip} <Icon name="close" />
              </button>
            </div>
            <h1 className="tr-hello">{t.hello(snap.config.userName)}</h1>
            <p className="tr-sub">{phase === 'scan' ? t.scanning : t.scanned}</p>
            <ul className="tr-scan">
              {base.map((s, i) => (
                <motion.li key={s.id} className={`tr-row ${s.state === 'todo' ? 'todo' : ''}`} initial={reduce ? false : { opacity: 0, x: -24 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: reduce ? 0 : 0.25 + i * 0.3, type: 'spring', stiffness: 420, damping: 30 }}>
                  <motion.span className="tr-box" initial={reduce ? false : { scale: 0.4 }} animate={{ scale: 1 }} transition={{ delay: reduce ? 0 : 0.4 + i * 0.3, type: 'spring', stiffness: 600, damping: 18 }}>
                    {s.state !== 'todo' && <Icon name="check" />}
                  </motion.span>
                  <span className="tr-what">
                    <span className="tr-name">{(t as Record<string, unknown>)[`t_${s.id}`] as string}</span>
                    <span className="tr-facts">{factsOf(s, Date.now())}</span>
                  </span>
                  {s.state !== 'todo' && <span className="tr-stamp">{t.ready}</span>}
                </motion.li>
              ))}
            </ul>
            <AnimatePresence>
              {phase === 'first' && (
                <motion.div className="tr-first" initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} transition={{ type: 'spring', stiffness: 380, damping: 32 }}>
                  {claudeOk ? (
                    <>
                      <h2 className="tr-title">{t.firstTitle}</h2>
                      <p className="tr-line">{t.firstLine}</p>
                      <div className="tr-actions">
                        {sug.map((x, i) => (
                          <button key={x} type="button" className={i ? 'tr-alt' : 'tr-big'} onClick={() => send(x)}>
                            <span>{t.q(x)}</span> <Icon name="arrow" dir="right" />
                          </button>
                        ))}
                        <div className="tr-pair">
                          {snap.setup?.dictation !== false && (
                            <button
                              type="button"
                              className="tr-alt"
                              onClick={() => {
                                finish()
                                setFirst({ at: Date.now(), before: snap.sessions.map((s) => s.id) })
                                talk()
                              }}
                            >
                              <Icon name="mic" /> {t.talk}
                            </button>
                          )}
                          <button
                            type="button"
                            className="tr-alt"
                            onClick={() => {
                              // Le focus dans le geste même (sinon iOS n'ouvre pas le clavier), puis le champ s'éclaire.
                              const el = bossInput()
                              el?.focus({ preventScroll: true })
                              finish()
                              setFirst({ at: Date.now(), before: snap.sessions.map((s) => s.id) })
                              flash(el?.closest('form'))
                            }}
                          >
                            <Icon name="chevron" dir="right" /> {t.write}
                          </button>
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <h2 className="tr-title">{t.claudeFirst}</h2>
                      <div className="tr-actions">
                        <button
                          type="button"
                          className="tr-big"
                          onClick={() => {
                            finish()
                            void runBrick('claude')
                          }}
                        >
                          <span>{t.plugClaude}</span> <Icon name="arrow" dir="right" />
                        </button>
                      </div>
                    </>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// ---------------------------------------------------------------- la bande

/** Un carré par étape, rempli de gauche à droite : plein = fait ou déjà là, rayé = pour plus tard, vide = à faire ;
 * celui en cours bat. */
const RANK: Record<TourStep['state'], number> = { ready: 0, done: 1, skip: 3, todo: 2 }
function Bar({ steps, current }: { steps: TourStep[]; current?: TourId }) {
  const sorted = [...steps].sort((a, b) => RANK[a.state] - RANK[b.state] || Number(b.id === current) - Number(a.id === current))
  return (
    <span className="tr-bar" aria-hidden>
      {sorted.map((s) => (
        <motion.i key={s.id} className={`${s.state} ${s.id === current ? 'now' : ''}`} layout initial={false} animate={s.state === 'done' ? { scale: [1.6, 1] } : { scale: 1 }} />
      ))}
    </span>
  )
}

export function TourBand() {
  const tour = useTour()
  const { snap, expanded, setExpanded, push } = useApp()
  const flow = useFlow()
  /** La bande a ouvert le fil pour un branchement : il se referme quand les questions sont finies ou annulées, une
   * fois le résultat lu. */
  const openedThread = useRef(false)
  const hadFlow = useRef(false)
  const [closeLater, setCloseLater] = useState(false)
  useEffect(() => {
    if (flow) hadFlow.current = true
    else if (hadFlow.current) {
      hadFlow.current = false
      if (!openedThread.current) return
      openedThread.current = false
      setCloseLater(true)
    }
  }, [flow])
  // Pas tant que weevboss travaille (il installe, il répond), jamais sur un résultat qui propose de réessayer (ses
  // boutons ne sont que dans le fil), ni si l'utilisateur a touché le fil entre-temps : il lit, il le fermera.
  const last = snap.main.at(-1)
  const retry = !!last?.chips?.length
  const agentOpen = expanded === 'agent'
  useEffect(() => {
    if (!closeLater) return
    if (retry || !agentOpen) return setCloseLater(false)
    const band = document.querySelector('.band.agent')
    const touched = () => setCloseLater(false)
    band?.addEventListener('pointerdown', touched)
    const id = snap.mainWorking ? 0 : window.setTimeout(() => {
      setCloseLater(false)
      setExpanded(null)
    }, 4000)
    return () => {
      window.clearTimeout(id)
      band?.removeEventListener('pointerdown', touched)
    }
  }, [closeLater, retry, agentOpen, snap.mainWorking, last?.id, setExpanded])
  // Rouverts d'en bas (la ligne des réglages, une carte d'astuce) : la bande, tout en haut, vient sous les yeux.
  useEffect(() => {
    if (!tour?.open || !revealTour) return
    revealTour = false
    when(
      () => !!document.querySelector('.tr-band'),
      () => reveal(document.querySelector('.tr-band'), { block: 'start' }),
    )
  }, [tour?.open])
  // Le job de démo : suivi dans la bande tant qu'il tourne, puis son rapport une demi-minute.
  const demoJob = snap.h24.find((a) => a.demo && (a.runState === 'running' || Date.now() - (a.runStartedAt ?? 0) < 30_000))
  const t = useT(M)
  const f = useFirst()
  const [open, setOpen] = useState(false)
  const [caption, setCaption] = useState<string | null>(null)
  const [busy, setBusy] = useState<TourId | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [cheer, setCheer] = useState(false)
  const prevDone = useRef<number | null>(null)

  const steps = tour?.steps ?? []
  const n = steps.filter((s) => s.state === 'ready' || s.state === 'done').length
  const later = steps.filter((s) => s.state === 'skip').length
  const track = f && snap.tour ? milestones(snap, f) : null
  const firstStep = steps.find((s) => s.id === 'first')

  // La première demande aboutie : l'étape se coche, le suivi s'efface un peu après.
  useEffect(() => {
    if (track?.stale) return setFirst(null)
    // L'agent travaille (ou weevboss a répondu) : c'est réussi, l'étape se coche ; le suivi reste jusqu'au bout.
    if (track && track.reached >= track.list.length - 1 && firstStep?.state === 'todo') void api.tourAct('done', 'first').catch(() => undefined)
    if (!track?.over) return
    const id = window.setTimeout(() => setFirst(null), track.session ? 40_000 : 7000)
    return () => window.clearTimeout(id)
  }, [track?.over, track?.stale, track?.reached, track?.list.length, firstStep?.state]) // eslint-disable-line react-hooks/exhaustive-deps
  // Une étape cochée pendant qu'on regarde : un petit éclat.
  useEffect(() => {
    if (prevDone.current !== null && n > prevDone.current) {
      setCheer(true)
      const id = window.setTimeout(() => setCheer(false), 900)
      prevDone.current = n
      return () => window.clearTimeout(id)
    }
    prevDone.current = n
  }, [n])
  // Tout est fait : la bande le dit, puis s'en va.
  useEffect(() => {
    if (!tour?.finished || !tour.open) return
    const id = window.setTimeout(() => void api.tourAct('close').catch(() => undefined), 9000)
    return () => window.clearTimeout(id)
  }, [tour?.finished, tour?.open])

  // Fermée (×, fin, autre appareil) : elle se replie en douceur, ce qui est dessous remonte sans saut.
  const shown = !!tour?.open && !!tour.intro
  const todo = steps.filter((s) => s.state === 'todo')
  const next = todo[0]

  const act = async (s: TourStep, what: 'try' | 'plug' | 'later' | 'show') => {
    setNote(null)
    if (what === 'later') return void api.tourAct('skip', s.id).catch(() => undefined)
    if (what === 'show') {
      if (s.id === 'g-back') push({ kind: 'repos' })
      if (s.id === 'g-talk') return talk()
      window.setTimeout(() => window.dispatchEvent(new CustomEvent('weevils:coach', { detail: s.id === 'g-repos' ? 'repos' : s.id === 'g-calm' ? 'calm' : 'g-back' })), s.id === 'g-back' ? 700 : 0)
      return
    }
    if (s.id === 'first') return talk()
    setBusy(s.id)
    try {
      if (what === 'try') await playDemo(s.id, snap, { caption: setCaption, openThread: () => focusBoss() })
      else if (s.id === 'h24') prefill(t.h24Example)
      else {
        const b = s.id === 'phone' && s.facts?.reach === 'local' ? 'reach' : BRICK_OF[s.id]
        if (!b) return
        // runBrick ouvre le fil de weevboss en haut de l'écran (focusBoss), sauf les notifications (rien à y lire).
        if (b !== 'push') openedThread.current = true
        const r = await runBrick(b)
        if (r.note || !r.ok) setNote(r.note ?? t.failed)
      }
    } finally {
      setBusy(null)
    }
  }

  const actions = (s: TourStep) => {
    if (s.state !== 'todo') return null
    const g = groupOf(s.id)
    return (
      <span className="tr-acts">
        {g === 'gesture' && (
          <button type="button" className="tr-btn" onClick={() => void act(s, 'show')}>
            {t.showMe}
          </button>
        )}
        {s.id === 'first' && (
          <>
            {suggestions(snap)
              .slice(0, 1)
              .map((x) => (
                <button key={x} type="button" className="tr-btn" onClick={() => void ask(snap, x)}>
                  {t.q(x)}
                </button>
              ))}
            {snap.setup?.dictation !== false && (
              <button type="button" className="tr-btn ghost" onClick={() => void act(s, 'try')}>
                <Icon name="mic" /> {t.talk}
              </button>
            )}
          </>
        )}
        {g === 'use' && DEMOS.has(s.id) && !s.played && !(s.id === 'github' && firstStep?.state !== 'todo') && (
          <button type="button" className="tr-btn" disabled={busy === s.id} onClick={() => void act(s, 'try')}>
            {busy === s.id ? <span className="spin"><Icon name="star" /></span> : <Icon name="play" />} {t.try}
          </button>
        )}
        {(BRICK_OF[s.id] || s.id === 'h24') && (s.id !== 'phone' || s.facts?.reach === 'local') && (
          <button type="button" className={`tr-btn ${g === 'use' && DEMOS.has(s.id) && !s.played ? 'ghost' : ''}`} onClick={() => void act(s, 'plug')}>
            <Icon name="plus" /> {t.plug}
          </button>
        )}
        {s.id !== 'claude' && (
          <button type="button" className="tr-btn quiet" onClick={() => void act(s, 'later')}>
            {t.later}
          </button>
        )}
      </span>
    )
  }

  const card = (s: TourStep, big: boolean) => (
    <motion.div key={s.id} className={`tr-step ${s.state} ${big ? 'big' : ''}`} layout="position" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: -30 }}>
      <span className="tr-box">{s.state === 'skip' ? <Icon name="minus" /> : s.state !== 'todo' ? <Icon name="check" /> : null}</span>
      <span className="tr-what">
        <span className="tr-name">
          {(t as Record<string, unknown>)[`t_${s.id}`] as string}
          {stateLabel(s) && <span className="tr-tag">{stateLabel(s)}</span>}
        </span>
        <span className="tr-facts">{factsOf(s, Date.now())}</span>
        {big && s.id === 'phone' && !device().mobile && s.facts?.reach !== 'local' && <PhoneLink />}
        {big && actions(s)}
      </span>
    </motion.div>
  )

  return (
    <Collapse open={shown}>
    <section className={`band tr-band ${cheer ? 'cheer' : ''}`} aria-label={t.dialog}>
      <div className="in tr-top">
        <button type="button" className="tr-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <span className="tr-label">{t.dialog}</span>
          <span className="tr-count" aria-label={t.progressLabel(n, steps.length)}>
            {t.progress(n, steps.length)}
          </span>
          <Icon name="chevron" dir={open ? 'up' : 'down'} />
        </button>
        <button type="button" className="tr-x" onClick={() => void api.tourAct('close').catch(() => undefined)} aria-label={t.close}>
          <Icon name="close" />
        </button>
      </div>
      <div className="in">
        <Bar steps={steps} current={track ? 'first' : next?.id} />
      </div>
      {caption && (
        <div className="in tr-caption">
          <span className="tr-tag">{t.demo}</span> {caption}
        </div>
      )}
      {demoJob && !caption && (
        <div className="in tr-caption">
          <span className="tr-tag">{t.demo}</span> {demoJob.runState === 'running' ? <span className="spin"><Icon name="star" /></span> : <Icon name="check" />} {demoJob.lastEvent}
        </div>
      )}
      {note && <div className="in tr-caption">{note}</div>}
      <AnimatePresence mode="popLayout" initial={false}>
        {track && !open ? (
          <motion.ol key="track" className="in tr-track" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            {track.list.map((m, i) => (
              <li key={m} className={i < track.reached ? 'on' : i === track.reached ? 'now' : ''}>
                <span className="tr-box">{i < track.reached ? <Icon name="check" /> : i === track.reached ? <span className="spin"><Icon name="star" /></span> : null}</span>
                {t[m]}
              </li>
            ))}
            {track.over && track.session && (
              <li className="tr-onward">
                <button
                  type="button"
                  className="tr-btn"
                  onClick={() => {
                    openPreviewOf(track.session!)
                    push({ kind: 'session', id: track.session! })
                    setFirst(null)
                  }}
                >
                  {t.see} <Icon name="arrow" dir="right" />
                </button>
              </li>
            )}
            {track.reached >= 3 && !track.over && (
              <li className="tr-onward">
                <button type="button" className="tr-btn ghost" onClick={() => setFirst(null)}>
                  {t.onward} <Icon name="arrow" dir="right" />
                </button>
              </li>
            )}
          </motion.ol>
        ) : open ? (
          <motion.div key="all" className="tr-list" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            {steps.map((s) => card(s, s.state === 'todo'))}
          </motion.div>
        ) : next ? (
          card(next, true)
        ) : (
          <motion.div key="end" className="in tr-end" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
            <span className="tr-end-title">{t.endTitle}</span>
            <span className="tr-facts">{t.endLine(n, later)}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
    </Collapse>
  )
}

// ---------------------------------------------------------------- réglages

export function TourLine() {
  const tour = useTour()
  const t = useT(M)
  if (!tour) return null
  const n = tour.steps.filter((s) => s.state === 'ready' || s.state === 'done').length
  return (
    <Line ch="*" go={null} meta={t.progress(n, tour.steps.length)} onClick={openTour}>
      {t.dialog}
    </Line>
  )
}

/** Rouvert d'ailleurs (bas du flux, carte d'astuce) : TourBand amène la bande sous les yeux quand elle s'ouvre. */
let revealTour = false

/** Rouvre les premiers pas (réglages, astuces, weevboss). */
export const openTour = () => {
  const band = document.querySelector('.tr-band')
  if (band) reveal(band, { block: 'start' })
  else revealTour = true
  void api.tourAct('open').catch(() => (revealTour = false))
}
