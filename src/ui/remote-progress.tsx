import { useEffect, useState } from 'react'
import type { SessionProgress } from '../../shared/api'
import { useT, intlLocale } from '../i18n'
import M from '../i18n/remote-progress'
import { useApp } from './app-context'
import { Icon } from './icons'
import { ago } from './format'

/** A live observer is not evidence that the remote job is advancing. */
export function progressPhase(p: SessionProgress, now: number, offline = false) {
  if (p.state === 'done' || p.state === 'error') return p.state
  if (offline) return 'offline'
  const age = now - p.updatedAt
  if (!Number.isFinite(age) || age < -30000 || age > p.staleAfterMs) return 'stale'
  const deltaAge = p.lastProgressAt == null ? Infinity : now - p.lastProgressAt
  return p.state === 'working' && deltaAge >= -30000 && deltaAge <= 90000 ? 'working' : 'waiting'
}
export function RemoteProgress({ progress: p }: { progress: SessionProgress }) {
  const t = useT(M)
  const { offline } = useApp()
  // Independent of SSE: an interrupted connection cannot leave an infinite animation on screen.
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const tick = () => setNow(Date.now())
    const timer = window.setInterval(tick, 5000)
    document.addEventListener('visibilitychange', tick)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', tick) }
  }, [])
  const phase = progressPhase(p, Math.max(now, Date.now()), offline)
  const completed = p.completed != null && Number.isFinite(p.completed) ? Math.max(0, p.completed) : null
  const total = p.total != null && Number.isFinite(p.total) && p.total > 0 ? p.total : null
  // Older snapshots carried localized prose. Extract only its numeric fact, never show stale-language labels.
  const legacyVerified = /^(\d+) (?:images vérifiées et récupérées|images verified and downloaded|verified frames)$/.exec(p.detail ?? '')
  const verified = p.verified ?? (legacyVerified ? Number(legacyVerified[1]) : null)
  const number = (n: number) => new Intl.NumberFormat(intlLocale()).format(n)
  const reason = p.pauseReason === 'worker-stopped' ? t.workerStopped : p.pauseReason === 'capacity' ? t.capacity : t.pausedUnknown
  // One plain line: when it last moved (or, failing that, when it was last seen).
  const at = p.lastProgressAt != null && Number.isFinite(p.lastProgressAt) ? p.lastProgressAt : p.updatedAt
  const seen = Math.max(now, Date.now())
  return <section className="remote-progress in" data-progress-state={phase} aria-label={t.source}>
    <details className="remote-progress-details">
      <summary className="remote-progress-title"><span className={phase === 'working' ? 'spin fluo' : ''} aria-hidden><Icon name={phase === 'done' ? 'check' : phase === 'working' ? 'star' : 'pause'} /></span><strong role="status">{t[phase]}</strong><span className="remote-progress-chevron" aria-hidden><Icon name="chevron" dir="down" /></span></summary>
      <div className="remote-progress-facts">
        {completed !== null && <div>{total === null ? t.reported(number(completed)) : t.fraction(number(completed), number(total))}</div>}
        {completed !== null && total !== null && <progress value={Math.min(completed, total)} max={total} aria-label={t.reported(number(completed))} />}
        {verified != null && Number.isFinite(verified) && <div>{t.verified(number(verified))}</div>}
        {Number.isFinite(at) && <div className="meta"><time dateTime={new Date(at).toISOString()}>{t.updated(ago(Math.max(0, seen - at)))}</time></div>}
      </div>
    </details>
    {phase === 'error' && <p className="remote-progress-reason">{reason}</p>}
  </section>
}
