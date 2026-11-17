// Sleep mode in the app: the « zzz » button beside the devil (one tap before bed), the night look (html[data-sleep],
// night.css), and the night band under weevboss: the agents at work drawn as softly glowing ghosts, each with what it
// is doing and for how long, and the way to wake up. Nothing is blocked: weevboss and the sessions answer as usual.
// The state is the server's (snap.sleep, POST /api/sleep): every device goes to sleep and wakes up together.
import { useEffect, useState, type CSSProperties } from 'react'
import { api } from '../api'
import { useT } from '../i18n'
import S from '../i18n/sleep'
import { useApp } from './app-context'
import { at } from './auto-model'
import { durLong } from './format'
import { FilledIcon, Icon } from './icons'
import './night.css'

/** The iOS status bar at night (theme-color): weevboss's band at night (--agent in night.css). */
export const NIGHT_COLOR = '#16123a'

let pending: { on: boolean; until: number } | null = null
const CHANGE = 'weevils:sleep'

/** Asleep, as the server says, or as just tapped (until the server's answer arrives). */
export function useSleep(): { on: boolean; since: number | null; set: (on: boolean) => Promise<void> } {
  const { snap, refresh } = useApp()
  const [, render] = useState(0)
  useEffect(() => {
    const f = () => render((n) => n + 1)
    window.addEventListener(CHANGE, f)
    return () => window.removeEventListener(CHANGE, f)
  }, [])
  const server = !!snap.sleep?.on
  if (pending && (pending.on === server || Date.now() > pending.until)) pending = null
  const on = pending ? pending.on : server
  const set = async (next: boolean) => {
    pending = { on: next, until: Date.now() + 8000 }
    window.dispatchEvent(new Event(CHANGE))
    try {
      await api.setSleep(next)
      refresh()
    } catch (e) {
      pending = null
      window.dispatchEvent(new Event(CHANGE))
      throw e
    }
  }
  return { on, since: snap.sleep?.since ?? null, set }
}

/** html[data-sleep]: the whole interface switches to the night palette; the status bar follows. */
export function useNightChrome(on: boolean) {
  useEffect(() => {
    const root = document.documentElement
    if (on) root.dataset.sleep = '1'
    else delete root.dataset.sleep
    const meta = document.querySelector('meta[name="theme-color"]')
    const before = meta?.getAttribute('content') ?? null
    // A page closing puts the theme's colour back (src/ui/shell.tsx): at night, the home screen's is the night's.
    const night = () => {
      if (on && meta && !root.dataset.page && meta.getAttribute('content') !== NIGHT_COLOR) meta.setAttribute('content', NIGHT_COLOR)
    }
    night()
    const watch = on && meta && typeof MutationObserver !== 'undefined' ? new MutationObserver(night) : null
    if (watch && meta) watch.observe(meta, { attributes: true, attributeFilter: ['content'] })
    return () => {
      watch?.disconnect()
      if (on && before && meta?.getAttribute('content') === NIGHT_COLOR) meta.setAttribute('content', before)
    }
  }, [on])
}

/** The three « z », with the main controls: one tap to sleep, one to wake. */
export function SleepButton() {
  const t = useT(S)
  const { on, set } = useSleep()
  return (
    <button className={`sleep-btn${on ? ' on' : ''}`} onClick={() => void set(!on).catch(() => undefined)} aria-pressed={on} aria-label={on ? t.wakeUpLabel : t.goToSleep}>
      <Icon name="sleep" />
    </button>
  )
}

/** What a ghost is: a session at work, or an automation running. */
interface Ghost {
  key: string
  title: string
  doing: string
  since: number | null
  slot: string
  open: () => void
  auto?: boolean
}

/** The night band, right under weevboss while asleep. */
export function NightBand() {
  const t = useT(S)
  const { snap, now, colors, push } = useApp()
  const { on, since, set } = useSleep()
  const [err, setErr] = useState<string | null>(null)
  if (!on) return null
  const running = (snap.optimizers ?? []).filter((o) => o.state === 'running')
  const autoSessions = new Set(running.map((o) => o.sessionId).filter(Boolean))
  const ghosts: Ghost[] = [
    ...snap.sessions
      .filter((s) => !s.archived && s.status === 'working' && !autoSessions.has(s.id))
      .map((s) => ({
        key: s.id,
        title: s.title,
        doing: s.now || snap.projects.find((p) => p.id === s.projectId)?.name || '',
        since: s.workStartedAt,
        slot: colors[s.projectId] ?? 'p8',
        open: () => push({ kind: 'session', id: s.id }),
      })),
    ...running.map((o) => ({ key: `auto:${o.id}`, title: o.title, doing: t.ghostAuto, since: o.startedAt ?? null, slot: 'auto-fluo', open: () => push({ kind: 'auto', id: o.id }), auto: true })),
  ]
  const wake = () => {
    setErr(null)
    set(false).catch(() => setErr(t.failed))
  }
  return (
    <section className="band night" aria-label={t.ghosts(ghosts.length)}>
      <div className="night-sky" aria-hidden>
        {STARS.map((s, i) => (
          <i key={i} style={{ left: `${s[0]}%`, top: `${s[1]}%`, animationDelay: `${s[2]}s` } as CSSProperties} />
        ))}
      </div>
      <div className="in night-head">
        <div className="night-moon" aria-hidden>
          <Icon name="sleep" />
        </div>
        <div>
          <h2 className="night-title">{t.ghosts(ghosts.length)}</h2>
          <div className="meta">{since ? t.asleepSince(at(since, now)) : ''}</div>
        </div>
      </div>
      {ghosts.length > 0 && (
        <ul className="night-ghosts">
          {ghosts.map((g, i) => (
            <li key={g.key} style={{ ['--g' as string]: `var(--${g.slot})`, ['--i' as string]: i } as CSSProperties}>
              <button className="night-ghost" onClick={g.open} aria-label={t.openGhost(g.title)}>
                <span className="ghost-fig" aria-hidden>
                  <FilledIcon name="ghost" />
                </span>
                <span className="ghost-text">
                  <span className="ghost-title ellipsis">{g.title}</span>
                  <span className="ghost-doing ellipsis">{[g.doing, g.since ? t.ghostFor(durLong(now - g.since)) : ''].filter(Boolean).join(' · ')}</span>
                </span>
                <span className="ghost-trail" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="in night-foot">
        <p className="meta">{t.quiet}</p>
        <button className="night-wake" onClick={wake} aria-label={t.wakeUpLabel}>
          {t.wakeUp}
        </button>
        {err && <p className="meta" role="alert">! {err}</p>}
      </div>
    </section>
  )
}

/** Fixed stars (x %, y %, twinkle delay s): the same sky every night. */
const STARS: [number, number, number][] = [
  [6, 18, 0], [14, 62, 1.8], [22, 30, 3.1], [31, 80, 0.7], [38, 12, 2.4], [47, 48, 4.2], [55, 22, 1.1], [63, 70, 3.6],
  [71, 35, 0.4], [79, 14, 2.9], [86, 58, 1.5], [93, 26, 3.9], [10, 88, 2.2], [44, 92, 0.9], [68, 90, 3.3], [97, 78, 1.9],
]
