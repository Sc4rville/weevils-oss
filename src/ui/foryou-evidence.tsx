import type { ForYouItem } from '../../shared/foryou'
import { shownEvidence } from '../../shared/evidence'
import { useT } from '../i18n'
import M from '../i18n/foryou-evidence'
import './foryou-evidence.css'

/**
 * How far a result was seen working, right under its claim: a short label (with where it ran, or the environment it
 * was checked in), what it means on a deliberate tap, and its stated limits always in sight, word for word.
 * The label comes from the server's structured evidence only (shared/evidence.ts), re-checked here.
 */
export function EvidenceLine({ item }: { item: ForYouItem }) {
  const t = useT(M)
  const e = shownEvidence(item.evidence)
  if (!e) return null
  const place = e.level === 'verified' ? e.environment : e.level === 'demonstrated' ? e.where : undefined
  const about = e.level === 'verified' ? t.aboutVerified(e.environment!) : e.level === 'demonstrated' ? t.aboutDemonstrated(e.where!) : t.aboutImplemented
  return (
    <div className={`fy-evidence fy-ev-${e.level}`} data-evidence={e.level}>
      <details className="fy-ev-more" onClick={(ev) => ev.stopPropagation()}>
        <summary>
          <span className="fy-ev-label">{t[e.level]}</span>
          {place && <span className="fy-ev-place"> · {place}</span>}
        </summary>
        <p className="fy-ev-about">{about}</p>
        <p className="fy-ev-about">{t.supplied}</p>
      </details>
      {!!e.limits?.length && (
        <ul className="fy-ev-limits" aria-label={t.limits}>
          {e.limits.map((l) => <li key={l}>{l}</li>)}
        </ul>
      )}
    </div>
  )
}
