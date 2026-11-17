import type { ForYouItem } from '../../shared/foryou'
import { useT } from '../i18n'
import M from '../i18n/foryou'
export function TranslationStatus({ item }: { item: ForYouItem }) {
  const t = useT(M)
  const loc = item.localization
  if (!loc) return null
  if (loc.status !== 'translated') return <p className="in meta" role="status">{loc.status === 'failed' ? t.translationFailed : t.translationPending}</p>
  return <details className="in meta"><summary>{t.original}</summary>{Object.entries(loc.original).map(([k,v]) => <p key={k} lang={loc.source === 'unknown' ? undefined : loc.source} style={{ whiteSpace: 'pre-wrap' }}>{v}</p>)}</details>
}
