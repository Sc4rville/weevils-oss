import { useEffect, useState, useSyncExternalStore } from 'react'
import { LiveSession, parkLive, primeLive, type LiveEnd, type LiveState } from '../live'
import { getLang, intlLocale, useT } from '../i18n'
import M from '../i18n/live'
import { KeyChip } from './setup'

// Live voice mode, the app's side: one conversation at a time, shared by every weevboss logo on screen (the band, a
// session header). A hold on the logo starts it, a tap ends it. Calm on purpose: a slow breath, one discreet line.

interface Live {
  state: LiveState
  startedAt: number
  usd: number
  caption: string
  fresh: boolean
}
interface Ended {
  why: LiveEnd
  at: number
  ms: number
  usd: number
}

let live: Live | null = null
let ended: Ended | null = null
let session: LiveSession | null = null
const subs = new Set<() => void>()
const emit = () => subs.forEach((f) => f())
const subscribe = (f: () => void) => {
  subs.add(f)
  return () => void subs.delete(f)
}
const set = (patch: Partial<Live>) => {
  if (!live) return
  live = { ...live, ...patch }
  emit()
}

export const useLive = () => useSyncExternalStore(subscribe, () => live, () => null)
export const useLiveEnded = () => useSyncExternalStore(subscribe, () => ended, () => null)

/** Inside the pointer-down gesture: wakes the audio (iOS) so a hold can start live without another tap. */
export const armLive = () => primeLive()
export const disarmLive = () => {
  if (!live) parkLive()
}

export function startLive() {
  if (live) return
  primeLive() // already done in the gesture; again in case the context was closed meanwhile
  ended = null
  live = { state: 'connecting', startedAt: Date.now(), usd: 0, caption: '', fresh: true }
  emit()
  const s = new LiveSession({
    state: (state) => set({ state }),
    cost: (usd) => set({ usd }),
    said: (text) => live && set({ caption: (live.fresh ? text : live.caption + text).slice(-160), fresh: false }),
    turn: () => set({ fresh: true }),
    ended: (why) => {
      const was = live
      live = null
      session = null
      ended = { why, at: Date.now(), ms: was ? Date.now() - was.startedAt : 0, usd: was?.usd ?? 0 }
      parkLive()
      emit()
    },
  })
  session = s
  s.start(getLang())
}

export function stopLive() {
  session?.stop()
}

export const clearLiveEnded = () => {
  ended = null
  emit()
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const cents = (usd: number) => `${new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(usd * 100)} ¢`

/** Under the logo: « live · 1:12 · 0.8 ¢ » while it runs, then why it ended (with the key button when one is missing). */
export function LiveLine() {
  const t = useT(M)
  const l = useLive()
  const e = useLiveEnded()
  const [, tick] = useState(0)
  useEffect(() => {
    if (!l) return
    const i = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(i)
  }, [!!l])
  // An ending note fades on its own; one that needs the user (a key, credits) stays a little longer.
  useEffect(() => {
    if (!e) return
    const keep = e.why === 'nokey' || e.why === 'auth' || e.why === 'billing' ? 20_000 : 6000
    const i = setTimeout(() => ended === e && clearLiveEnded(), keep)
    return () => clearTimeout(i)
  }, [e])
  if (l) {
    const status = l.state === 'connecting' ? t.connecting : l.state === 'thinking' ? t.thinking : null
    return (
      <div className="voice-live" role="status">
        <span className="voice-live-meta">
          {t.live} · {clock(Date.now() - l.startedAt)} · {cents(l.usd)}
          {status ? ` · ${status}` : ''}
        </span>
        {l.caption && <span className="voice-live-caption">{l.caption}</span>}
      </div>
    )
  }
  if (!e) return null
  // Ended by the user: a summary, unless it barely started.
  if ((e.why === 'user' || e.why === 'bye') && e.ms < 3000) return null
  const reason: Partial<Record<LiveEnd, string>> = { nokey: t.nokey, billing: t.billing, quota: t.quota, auth: t.auth, model: t.model, upstream: t.upstream, network: t.upstream, nohere: t.nohere, silence: t.silence, limit: t.limit, mic: t.mic }
  const text = reason[e.why] ?? t.summary(clock(e.ms), cents(e.usd))
  return (
    <div className="voice-live ended" role="status">
      <span className="voice-live-meta">{text}</span>
      {(e.why === 'nokey' || e.why === 'auth') && <KeyChip name="GEMINI_API_KEY" />}
    </div>
  )
}
