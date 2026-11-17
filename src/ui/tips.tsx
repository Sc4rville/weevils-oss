import { AnimatePresence, motion, type PanInfo } from 'motion/react'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import type { TipCard } from '../../shared/tips.ts'
import { api } from '../api'
import { ensurePush, pushSupported } from '../push'
import { localeHeaders, getLang, tr, useT } from '../i18n'
import M from '../i18n/tips'
import { useApp } from './app-context'
import { Line } from './bits'
import { Icon, type Dir, type IconName } from './icons'
import { askSetup } from './setup'
import { flash, toTop, when } from './follow'
import { setTop } from './foryou-top'
import { CHECK_MS, EMPTY_RETRY_MS, SHOW_MS, markShown, parseState, pick, ready, type TipsState } from './tips-schedule'
import './tips.css'

// Floating tips and action cards: when you sit idle on the feed, now and then one small card slides in from a random
// edge. General tips (a catalog of true things about weevils) and personalized cards (weevilsd rules on the real state,
// GET /api/tips). Tap accepts (action) or dismisses (tip), a swipe dismisses. Rare: see tips-schedule.ts.

const KEY = 'weevils-tips'
const DEBUG = 'weevils-tips-debug'
const CHANGE = 'weevils:tips'
/** Seconds the confirmation stays after an action. */
const FEEDBACK_MS = 1600
/** Swipe past this distance (px) or speed (px/s) to dismiss. */
const SWIPE_PX = 80
const SWIPE_V = 500
/** Pop palette slots for the cards (picked from the card id: stable, varied). */
const SLOTS = ['p0', 'p2', 'p4', 'p6', 'p9', 'p11', 'p13', 'p14']

type Env = { touch: boolean; standalone: boolean; dictation: boolean; selfRepo: boolean }

/** General tips: an icon and a condition each; their text lives in src/i18n/tips.ts (tip_<key>). */
const GENERAL: { key: GeneralKey; icon: IconName; dir?: Dir; when?: (e: Env) => boolean }[] = [
  // Only true when weevils' own repo is a project weevboss can hand to a session.
  { key: 'liveUi', icon: 'theme', when: (e) => e.selfRepo },
  { key: 'dictate', icon: 'mic', when: (e) => e.dictation },
  { key: 'photo', icon: 'plus' },
  { key: 'swipeBack', icon: 'arrow', dir: 'right', when: (e) => e.touch },
  { key: 'repos', icon: 'arrow', dir: 'left', when: (e) => e.touch },
  { key: 'h24', icon: 'arrow', dir: 'up' },
  { key: 'ultracode', icon: 'agents' },
  { key: 'homeScreen', icon: 'external', when: (e) => e.touch && !e.standalone },
  { key: 'import', icon: 'quote' },
]
type GeneralKey = 'liveUi' | 'dictate' | 'photo' | 'swipeBack' | 'repos' | 'h24' | 'ultracode' | 'homeScreen' | 'import'

/** Icon of each personalized rule (server/tips.ts, plus the client-side "push" rule). */
const RULE_ICON: Record<string, [IconName, Dir?]> = {
  waiting: ['waits'],
  'idle-sessions': ['pause'],
  'idle-unmanaged': ['pause'],
  saturated: ['machine'],
  unsorted: ['quote'],
  'one-machine': ['plus'],
  'no-dictation': ['mic'],
  push: ['bang'],
}

// ---------------------------------------------------------------- device state

const read = (k: string) => {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
const loadState = () => parseState(read(KEY))
const saveState = (s: TipsState) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* storage unavailable: nothing remembered, nothing shown twice in this run anyway */
  }
  window.dispatchEvent(new Event(CHANGE))
}
const isDebug = () => read(DEBUG) === '1'

export const setTipsOff = (off: boolean) => saveState({ ...loadState(), off })
const subscribe = (f: () => void) => {
  window.addEventListener(CHANGE, f)
  window.addEventListener('storage', f)
  return () => {
    window.removeEventListener(CHANGE, f)
    window.removeEventListener('storage', f)
  }
}
const useTipsOff = () => useSyncExternalStore(subscribe, () => loadState().off, () => false)

const standalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true
const typing = (el: Element | null) => !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el as HTMLElement).isContentEditable)
/** The first-launch intro is open, or not finished yet. */
// Avant l'accueil de weevboss, pas de carte d'astuce : une chose à la fois.
const introActive = () => read('weevils-onboarded') !== '1'

const getJson = async <T,>(method: string, url: string, body?: unknown): Promise<T> => {
  const res = await fetch(url, { method, credentials: 'same-origin', headers: { ...localeHeaders(), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(data.error ?? res.statusText)
  return data
}

/** Every candidate card, in the current language: the server's, the client-side rules, the general tips. */
async function candidates(selfRepo: boolean): Promise<TipCard[]> {
  const t = tr(M)
  const [server, dictation, pushOn] = await Promise.all([
    getJson<{ tips: TipCard[] }>('GET', `/api/tips?lang=${getLang()}`).then((r) => r.tips, () => [] as TipCard[]),
    api.transcribeInfo().then((r) => r.enabled, () => false),
    pushSupported() && Notification.permission === 'default' ? api.push().then((r) => r.enabled, () => false) : Promise.resolve(false),
  ])
  const env: Env = { touch: matchMedia('(pointer: coarse)').matches, standalone: standalone(), dictation, selfRepo }
  const ios = /iphone|ipad/i.test(navigator.userAgent)
  const client: TipCard[] = pushOn && (!ios || env.standalone) ? [{ id: 'push-off', rule: 'push', personal: true, text: t.pushText, accept: t.pushAccept, action: { kind: 'push' } }] : []
  const general = GENERAL.filter((g) => !g.when || g.when(env)).map((g): TipCard => ({ id: `tip:${g.key}`, rule: g.key, text: t[`tip_${g.key}`], personal: false }))
  return [...server, ...client, ...general]
}

// ---------------------------------------------------------------- the card

type Side = 'left' | 'right'
interface Shown {
  tip: TipCard
  side: Side
}

/** A pop color from the card id, never the bottom band's own hue nor a close one (the card mostly sits over it). */
const slotOf = (id: string, foot?: string) => {
  const f = Number(foot?.slice(1))
  const near = (slot: string) => Number.isFinite(f) && Math.min((Number(slot.slice(1)) - f + 16) % 16, (f - Number(slot.slice(1)) + 16) % 16) <= 2
  const ok = SLOTS.filter((x) => !near(x))
  return ok[[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % ok.length]
}
const iconOf = (tip: TipCard): [IconName, Dir?] => {
  const g = GENERAL.find((x) => x.key === tip.rule)
  return RULE_ICON[tip.rule] ?? (g ? [g.icon, g.dir] : ['star'])
}

/** Mounted once on the feed. `paused`: a page is open. */
export function Tips({ paused }: { paused: boolean }) {
  const { h24Open, push, refresh, colors, snap } = useApp()
  const t = useT(M)
  const off = useTipsOff()
  const [shown, setShown] = useState<Shown | null>(null)
  const [feedback, setFeedback] = useState<{ text: string; ok: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  /** Exit direction (−1 left, 1 right), set by a swipe. */
  const [exitDir, setExitDir] = useState(0)
  const lastInput = useRef(Date.now())
  const checking = useRef(false)
  const emptyUntil = useRef(0)
  const dragged = useRef(0)
  const blockedRef = useRef(false)
  blockedRef.current = paused || h24Open
  const showingRef = useRef(false)
  const selfRepo = useRef(false)
  selfRepo.current = snap.projects.some((p) => p.repos.includes('weevils'))
  showingRef.current = !!shown

  const hide = useCallback(() => {
    setShown(null)
    setFeedback(null)
    setBusy(false)
  }, [])

  // Anything the user does on the page resets the idle clock.
  useEffect(() => {
    const on = () => (lastInput.current = Date.now())
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'] as const
    for (const e of events) window.addEventListener(e, on, { capture: true, passive: true })
    const onVisible = () => document.visibilityState === 'visible' && on()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      for (const e of events) window.removeEventListener(e, on, { capture: true })
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  // Now and then, if everything is quiet, one card.
  useEffect(() => {
    if (off) return
    const blocked = () => blockedRef.current || document.visibilityState !== 'visible' || typing(document.activeElement) || introActive()
    const moment = () => ({ now: Date.now(), lastInput: lastInput.current, showing: showingRef.current, blocked: blocked(), debug: isDebug() })
    const tick = async () => {
      if (checking.current || Date.now() < emptyUntil.current || !ready(loadState(), moment())) return
      checking.current = true
      const requestedLang = getLang()
      try {
        const tip = pick(await candidates(selfRepo.current), loadState())
        if (requestedLang !== getLang()) return
        // Every card already seen: no new question to weevilsd every few seconds while the feed sits idle.
        if (!tip) emptyUntil.current = Date.now() + (isDebug() ? CHECK_MS : EMPTY_RETRY_MS)
        // Still quiet after the fetch?
        if (!tip || !ready(loadState(), moment())) return
        saveState(markShown(loadState(), tip.id, Date.now()))
        setExitDir(0)
        setShown({ tip, side: Math.random() < 0.5 ? 'left' : 'right' })
      } finally {
        checking.current = false
      }
    }
    const id = setInterval(() => void tick(), CHECK_MS)
    return () => clearInterval(id)
  }, [off])

  // Turned off, a page opens, the 24/7 drawer opens: the card leaves.
  useEffect(() => {
    if (off || paused || h24Open) hide()
  }, [off, paused, h24Open, hide])

  // Ignored: it slides away after a while (it was already counted as seen).
  useEffect(() => {
    if (!shown || feedback || busy) return
    const id = setTimeout(hide, SHOW_MS)
    return () => clearTimeout(id)
  }, [shown, feedback, busy, hide])

  // The confirmation stays a moment, then the card leaves.
  useEffect(() => {
    if (!feedback) return
    const id = setTimeout(hide, FEEDBACK_MS)
    return () => clearTimeout(id)
  }, [feedback, hide])

  const accept = async () => {
    if (!shown || busy || feedback || Date.now() - dragged.current < 250) return
    const a = shown.tip.action
    if (!a) return hide()
    if (a.kind === 'open') {
      hide()
      return push(a.page === 'session' ? { kind: 'session', id: a.id } : { kind: 'conversations' })
    }
    if (a.kind === 'setup') {
      hide()
      // askSetup ferme les pages, remonte en haut et ouvre le fil de weevboss (focusBoss).
      return askSetup(a.brick)
    }
    setBusy(true)
    try {
      if (a.kind === 'boss') {
        // La réponse arrive dans l'aperçu de weevboss, tout en haut du flux : on y remonte en douceur et il s'éclaire
        // (sans ouvrir le fil : envoyer ne l'ouvre jamais).
        // Sur « pour toi », l'aperçu revient sur le fil de weevboss : c'est là que la réponse se verra.
        setTop('boss')
        const boss = () => document.querySelector('.band.agent .peek-wrap:not([hidden])') ?? document.querySelector('.band.agent .chat')
        if (window.scrollY > 4) {
          toTop()
          when(() => window.scrollY < 4, () => flash(boss()), 900)
        } else flash(boss())
        await api.main(a.text)
        setFeedback({ text: t.sentToBoss, ok: true })
      } else if (a.kind === 'server') {
        const r = await getJson<{ done: string }>('POST', `/api/tips/act?lang=${getLang()}`, { id: shown.tip.id })
        setFeedback({ text: r.done || t.done, ok: true })
        refresh()
      } else if (a.kind === 'push') {
        await ensurePush({ ask: true, test: true })
        setFeedback({ text: t.pushOn, ok: true })
      }
    } catch (e) {
      setFeedback({ text: (e as Error).message, ok: false })
    } finally {
      setBusy(false)
    }
  }

  const onDragEnd = (_: unknown, info: PanInfo) => {
    dragged.current = Date.now()
    if (Math.abs(info.offset.x) > SWIPE_PX || Math.abs(info.velocity.x) > SWIPE_V) {
      setExitDir(Math.sign(info.offset.x || info.velocity.x))
      hide()
    }
  }

  const tip = shown?.tip
  const from = shown?.side === 'left' ? -1 : 1
  const [icon, dir] = tip ? iconOf(tip) : ['star' as IconName]

  return (
    <div className="tips-live" aria-live="polite">
      <AnimatePresence custom={exitDir || from}>
        {shown && tip && (
          <motion.aside
            key={tip.id}
            className={`tip ${shown.side} ${tip.action ? 'act' : ''}`}
            style={{ '--c': `var(--${slotOf(tip.id, colors.__foot)})` } as CSSProperties}
            aria-label={tip.personal ? t.personal : t.general}
            custom={exitDir || from}
            variants={{
              out: (d: number) => ({ x: `${d * 115}%`, opacity: 0 }),
              in: { x: 0, opacity: 1 },
            }}
            initial={{ x: `${from * 115}%`, opacity: 0 }}
            animate="in"
            exit="out"
            transition={{ type: 'spring', stiffness: 380, damping: 30, mass: 0.9 }}
            drag={feedback ? false : 'x'}
            dragSnapToOrigin
            dragElastic={0.6}
            onDragStart={() => (dragged.current = Date.now())}
            onDragEnd={onDragEnd}
          >
            <div className="tip-top">
              <span className="tip-ic" aria-hidden>
                <Icon name={feedback ? (feedback.ok ? 'check' : 'bang') : icon} dir={feedback ? undefined : dir} />
              </span>
              {!feedback && (
                <button className="tip-x" onClick={hide} aria-label={t.dismiss}>
                  <Icon name="close" />
                </button>
              )}
            </div>
            {feedback ? (
              <p className="tip-text" role="status">
                {feedback.text}
              </p>
            ) : (
              <button className="tip-body" onClick={() => void accept()} aria-label={tip.accept ? `${tip.text} · ${tip.accept}` : `${tip.text} · ${t.dismiss}`}>
                <span className="tip-text">{tip.text}</span>
                {tip.accept && (
                  <span className="tip-go">
                    <span>{busy ? '…' : tip.accept}</span>
                    <Icon name="arrow" dir="right" />
                  </span>
                )}
              </button>
            )}
          </motion.aside>
        )}
      </AnimatePresence>
    </div>
  )
}

/** Settings line (bottom band): tips on / off. */
export function TipsLine() {
  const t = useT(M)
  const off = useTipsOff()
  return (
    <Line ch={<Icon name="more" />} go={null} meta={off ? t.lineOff : t.lineOn} onClick={() => setTipsOff(!off)}>
      {t.line} · {off ? t.off : t.on}
    </Line>
  )
}
