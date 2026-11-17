import { useRef, useState } from 'react'
import { useT } from '../i18n'
import M from '../i18n/lost-features'
import { useApp } from './app-context'
import { Line } from './bits'
import { Shell } from './shell'
import { ThinkPage } from './think'
import { useThinkEnabled } from './lost-features-store'
import './lost-features.css'

function ThinkIcon() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="7" cy="7" r="3"/><circle cx="17" cy="15" r="4"/><path d="m9 9 5 4M5 10l-1 8 9-1"/></svg>
}
export function LostFeaturesLine() {
  const { snap, push } = useApp()
  const t = useT(M)
  const [enabled] = useThinkEnabled(snap) // Persist the one-time migration, even if the menu is never opened.
  return <Line ch="?" meta={t.menuMeta(enabled ? t.enabled : t.disabled)} onClick={() => push({ kind: 'lost-features' })}>{t.title}</Line>
}
export function LostFeaturesPage() {
  const { snap, push, colors } = useApp()
  const t = useT(M)
  const [enabled, setEnabled] = useThinkEnabled(snap)
  const [error, setError] = useState(false)
  return <Shell slot={colors.__foot ?? 'p3'} kicker="weevils" title={t.title}>
    <section className="in lost-feature" aria-label={t.think}>
      <div className="lost-feature-head"><ThinkIcon /><h2>{t.think}</h2>
        <button type="button" role="switch" aria-checked={enabled} aria-label={t.toggle} className="lost-feature-toggle" onClick={() => {
          try { setEnabled(!enabled); setError(false) } catch { setError(true) }
        }}>{enabled ? t.enabled : t.disabled}</button>
      </div>
      <p>{t.description}</p><p className="meta">{t.scope}. {t.preserved}</p>
      {error && <p role="alert">{t.failed}</p>}
      {enabled && <button type="button" className="setup-chip" onClick={() => push({ kind: 'think' })}>{t.open}</button>}
    </section>
  </Shell>
}
/** Keep a previously opened board mounted but paused; never mount a disabled board from a deep link. */
export function ThinkGate() {
  const { snap } = useApp()
  const [enabled] = useThinkEnabled(snap)
  const opened = useRef(enabled)
  if (enabled) opened.current = true
  return <>
    {opened.current && <div hidden={!enabled} inert={!enabled}><ThinkPage enabled={enabled} /></div>}
    {!enabled && <LostFeaturesPage />}
  </>
}
