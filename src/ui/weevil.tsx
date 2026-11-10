import { noticeKey } from '../../shared/notices.ts'
import { Notice } from './notice'
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from 'motion/react'
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import type { MemoryItem, WeevilQuestion } from '../../shared/api.ts'
import { api } from '../api'
import { useT } from '../i18n'
import M from '../i18n/weevil'
import { useApp } from './app-context'
import { Icon } from './icons'
import { VoiceLogo, voiceBusy } from './voice'
import { DEBUG_MS, RETRY_MS, RETURN_MS, TICK_MS, calm, gap, markFlown, nextAt, parseState, type Calm } from './weevil-schedule'
import './weevil.css'

// The weevil's questions: now and then, at a calm moment, a full colour panel slides up from the bottom with a short
// question (server/weevil.ts writes it from the memory and the real projects), the logo and a field. Answered by voice
// (the same voice logo as everywhere) or in writing, each answer feeds the memory; closed with ×, its question comes
// back later. Nothing drifts across the screen. When it may show: src/ui/weevil-schedule.ts.
//
// Test hook (QA, screenshots): « #weevil » in the URL, or localStorage « weevils-weevil-now » = « 1 », shows a question
// ~3 s after the app opens (and again ~3 s after each one), daily cap and gaps ignored. Calm is still required.

const KEY = 'weevils-weevil'
const DEBUG = 'weevils-weevil-now'
/** Pop palette slots for the label and the sheet (picked from the question id). */
const SLOTS = ['p0', 'p2', 'p4', 'p9', 'p11', 'p13']
/** After the last reply: the panel leaves after this pause (shorter once its reply has been spoken). */
const DONE_MS = 1800
const SPOKEN_MS = 700

type Line = { role: 'weevil' | 'user'; text: string }
interface Flight {
  q: WeevilQuestion
  slot: string
}
/** Short and soft, in and out (no bounce). */
const SLIDE_IN = { duration: 0.32, ease: [0.22, 1, 0.36, 1] } as const
const SLIDE_OUT = { duration: 0.24, ease: [0.4, 0, 1, 1] } as const

const read = (k: string) => {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
const loadState = () => parseState(read(KEY))
const saveState = (s: ReturnType<typeof parseState>) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* storage unavailable: the daily cap only lives in this run */
  }
}
const isDebug = () => /(^|[#&])weevil($|&)/.test(location.hash.slice(1)) || read(DEBUG) === '1'
const typing = (el: Element | null) => !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el as HTMLElement).isContentEditable)
/** On screen now: the first-steps intro (TourIntro) or band (TourBand), a tip card (Tips), a hint bubble (HintBubble), the gesture coach (GestureCoach). */
const overlay = () => !!document.querySelector('.tr-intro, .tr-band, .tip, .hint, .coach-ghost')
const slotOf = (id: string) => SLOTS[[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % SLOTS.length]

/** Mounted once, next to the tips. `paused`: a page is open. */
export function WeevilQuestions({ paused }: { paused: boolean }) {
  const { h24Open, expanded } = useApp()
  const [flight, setFlight] = useState<Flight | null>(null)
  const [shown, setShown] = useState(false)
  const reduce = !!useReducedMotion()
  const opened = useRef(Date.now())
  const target = useRef(0)
  const lastKey = useRef(0)
  const busy = useRef(false)
  const blocked = useRef({ paused, drawer: false })
  blocked.current = { paused, drawer: h24Open || expanded === 'agent' }
  busy.current = !!flight

  const moment = (): Calm => ({
    now: Date.now(),
    page: blocked.current.paused,
    drawer: blocked.current.drawer,
    overlay: overlay(),
    visible: document.visibilityState === 'visible',
    typing: typing(document.activeElement),
    lastKey: lastKey.current,
    voice: voiceBusy(),
  })

  // The clock: when it is time and everything is calm, ask weevilsd for the ready question, and fly.
  useEffect(() => {
    target.current = nextAt(loadState(), opened.current, Date.now(), isDebug())
    let fetching = false
    const onKey = () => (lastKey.current = Date.now())
    const onVisible = () => {
      if (document.visibilityState === 'visible') target.current = Math.max(target.current, Date.now() + (isDebug() ? DEBUG_MS : RETURN_MS))
    }
    const onHash = () => isDebug() && !busy.current && (target.current = Date.now() + DEBUG_MS)
    const tick = async () => {
      const now = Date.now()
      if (busy.current || fetching || now < target.current) return
      const debug = isDebug()
      if (!calm(moment())) return void (target.current = now + (debug ? DEBUG_MS : RETRY_MS))
      fetching = true
      try {
        const { question } = await api.weevil()
        if (!question) return void (target.current = Date.now() + (debug ? DEBUG_MS : gap()))
        if (!calm(moment())) return void (target.current = Date.now() + (debug ? DEBUG_MS : RETRY_MS))
        saveState(markFlown(loadState(), Date.now()))
        setFlight({ q: question, slot: slotOf(question.id) })
        setShown(true)
      } catch {
        target.current = Date.now() + (debug ? DEBUG_MS : gap())
      } finally {
        fetching = false
      }
    }
    const id = setInterval(() => void tick(), TICK_MS)
    window.addEventListener('keydown', onKey, { capture: true })
    window.addEventListener('hashchange', onHash)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(id)
      window.removeEventListener('keydown', onKey, { capture: true })
      window.removeEventListener('hashchange', onHash)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  /** The panel is gone (slid down): the next question is scheduled. */
  const gone = useCallback(() => {
    setFlight(null)
    target.current = nextAt(loadState(), opened.current, Date.now(), isDebug())
  }, [])

  /** Panel closed: answered, it just slides down; closed without a word, its question will come back. Once per
   * question shown: the panel stays mounted while it slides out, so a second Esc or scrim tap must not count a second
   * miss (a missed question comes back later with the same id). */
  const freed = useRef<Flight | null>(null)
  const answeredNow = useRef(false)
  const setFree = useCallback(
    (answered: boolean) => {
      if (!flight || freed.current === flight) return
      freed.current = flight
      if (!answered) void api.weevilMissed(flight.q.id).catch(() => undefined)
      setShown(false)
    },
    [flight],
  )

  // A page, the drawer or weevboss opens over it (a notification, a gesture): it slides away, its question comes back.
  const interrupted = !!flight && shown && (paused || h24Open || expanded === 'agent')
  useEffect(() => {
    if (interrupted) setFree(answeredNow.current)
  }, [interrupted, setFree])

  if (!flight) return null
  return (
    <MotionConfig reducedMotion="never">
      <AnimatePresence onExitComplete={gone}>
        {shown && <Sheet key={flight.q.id} f={flight} reduce={reduce} onLeave={setFree} onAnswered={() => (answeredNow.current = true)} />}
      </AnimatePresence>
    </MotionConfig>
  )
}

// ---------------------------------------------------------------- the exchange

function Sheet({ f, reduce, onLeave, onAnswered }: { f: Flight; reduce: boolean; onLeave: (answered: boolean) => void; onAnswered: () => void }) {
  const t = useT(M)
  const [lines, setLines] = useState<Line[]>([{ role: 'weevil', text: f.q.text }])
  const [learned, setLearned] = useState<MemoryItem[]>([])
  const [draft, setDraft] = useState('')
  const [waiting, setWaiting] = useState(false)
  const [done, setDone] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [reply, setReply] = useState<{ key?: string; text?: string }>({})
  const answered = useRef(false)
  const heard = useRef('')
  const seq = useRef(0)
  const input = useRef<HTMLInputElement>(null)
  const live = useRef({ lines, waiting, done, onLeave })
  live.current = { lines, waiting, done, onLeave }
  const leave = useCallback(() => live.current.onLeave(answered.current), [])

  // On a computer, the field is ready; on a phone, the keyboard waits for a tap (the voice logo is right there).
  useEffect(() => {
    if (matchMedia('(pointer: fine)').matches) input.current?.focus({ preventScroll: true })
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && leave()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [leave])

  // Finished: a short pause (its reply read out first, when it is spoken), then it slides down.
  useEffect(() => {
    if (!done) return
    let left = false
    let quietSince = 0
    const id = setInterval(() => {
      const now = Date.now()
      if (voiceBusy()) quietSince = 0
      else if (!quietSince) quietSince = now
      if (!left && quietSince && now - quietSince >= (reply.key ? SPOKEN_MS : DONE_MS)) {
        left = true
        leave()
      }
    }, 150)
    return () => clearInterval(id)
  }, [done])

  const send = async (text: string, voice = false) => {
    const said = text.trim()
    const { lines: history, waiting: w, done: d } = live.current
    if (!said || w || d) return
    setLines([...history, { role: 'user', text: said }])
    setDraft('')
    setErr(null)
    setWaiting(true)
    try {
      const r = await api.weevilAnswer(f.q.id, said, history)
      answered.current = true
      onAnswered()
      if (r.reply) setLines((l) => [...l, { role: 'weevil', text: r.reply }])
      if (r.learned.length) setLearned((l) => [...l, ...r.learned.filter((m) => !l.some((x) => x.id === m.id))])
      setReply(voice && r.reply ? { key: String(++seq.current), text: r.reply } : {})
      if (r.done) setDone(true)
    } catch (e) {
      setLines(history)
      setDraft(said)
      setErr((e as Error).message)
    } finally {
      setWaiting(false)
    }
  }
  const voiceText = (x: string) => {
    heard.current = heard.current ? `${heard.current} ${x}` : x
    setDraft(heard.current)
  }
  const voiceSend = () => {
    const q = heard.current.trim()
    heard.current = ''
    if (q) void send(q, true)
  }

  const slide = reduce
    ? { initial: { opacity: 0 }, animate: { opacity: 1, transition: SLIDE_IN }, exit: { opacity: 0, transition: SLIDE_OUT } }
    : { initial: { y: '100%' }, animate: { y: 0, transition: SLIDE_IN }, exit: { y: '100%', transition: SLIDE_OUT } }
  return (
    <>
      <motion.div className="weevil-scrim" onClick={leave} initial={{ opacity: 0 }} animate={{ opacity: 1, transition: SLIDE_IN }} exit={{ opacity: 0, transition: SLIDE_OUT }} aria-hidden />
      <div className="weevil-dock">
        <motion.section
          className="weevil-sheet"
          role="dialog"
          aria-label={f.q.text}
          style={{ '--c': `var(--${f.slot})` } as CSSProperties}
          {...slide}
        >
          <div className="weevil-head">
            <h2 className="weevil-q">{f.q.text}</h2>
            <button className="weevil-x" onClick={leave} aria-label={t.close}>
              <Icon name="close" />
            </button>
          </div>
          {(lines.length > 1 || waiting || err) && (
            <div className="weevil-lines" aria-live="polite">
              {lines.slice(1).map((l, i) => (
                <p key={i} className={`weevil-line ${l.role}`}>
                  {l.text}
                </p>
              ))}
              {learned.length > 0 && (
                <ul className="weevil-learned" aria-label={t.learned}>
                  {learned.map((m) => (
                    <li key={m.id}>
                      <span aria-hidden>+ </span>
                      {m.text}
                    </li>
                  ))}
                </ul>
              )}
              {waiting && (
                <span className="spin fluo weevil-wait">
                  <Icon name="star" />
                </span>
              )}
              {err && <Notice eventId={noticeKey("error:weevil", err)} className="weevil-err" role="alert">! {err}</Notice>}
            </div>
          )}
          <div className={done ? 'weevil-say done' : 'weevil-say'} inert={done}>
            <VoiceLogo take={() => ''} onText={voiceText} onSend={voiceSend} replyKey={reply.key} replyText={reply.text} working={waiting} />
            <form
              className="weevil-form"
              onSubmit={(e) => {
                e.preventDefault()
                heard.current = ''
                void send(draft)
              }}
            >
              <span className="strong" aria-hidden>
                <Icon name="chevron" dir="right" />
              </span>
              <input ref={input} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={t.answer} enterKeyHint="send" maxLength={1200} />
              <button type="submit" className="weevil-send" aria-label={t.send} disabled={!draft.trim() || waiting}>
                <Icon name="arrow" dir="up" />
              </button>
            </form>
          </div>
        </motion.section>
      </div>
    </>
  )
}
