import { useState, type ReactNode } from 'react'
import type { ForYouItem } from '../../shared/foryou'
import { intlLocale, useT } from '../i18n'
import M from '../i18n/foryou-result'
import { FullImage } from './foryou-formats'
import { TranslationStatus } from './foryou-localization'
import './foryou-result.css'

export function ResultCard({ item, sourceControls }: { item: ForYouItem; sourceControls: (source: ForYouItem) => ReactNode }) {
  const t = useT(M)
  const group = item.resultGroup!
  const storage = `weevils-result-history:${group.key}`
  const [expanded, setExpanded] = useState(() => { try { return localStorage.getItem(storage) === 'open' } catch { return false } })
  return <section className="fy-result in" aria-label={t.title}>
    <h2>{t.title}</h2><p>{t.intro}</p>
    <p className="meta">{t.quality}</p>
    <time dateTime={new Date(group.finalAt).toISOString()}>{new Date(group.finalAt).toLocaleString(intlLocale())}</time>
    {group.final ? <FullImage media={group.final} description={t.title} /> : <p role="status">{t.unavailable}</p>}
    {group.newerUpdate && <p role="status">{t.newer}</p>}
    <details open={expanded} onToggle={e => {
      const open = e.currentTarget.open
      setExpanded(open)
      try { localStorage.setItem(storage, open ? 'open' : 'closed') } catch { /* private storage */ }
    }}>
      <summary>{t.history} · {group.history.length}</summary>
      {group.history.map(source => <article key={source.id} data-source-id={source.id}>
        <p className="meta">{t.source} · <time dateTime={new Date(source.at).toISOString()}>{new Date(source.at).toLocaleString(intlLocale())}</time></p>
        {source.title && <p>{source.title}</p>}{source.text && <p>{source.text}</p>}
        {source.body && source.body !== source.text && <p className="fy-result-source">{source.body}</p>}
        <TranslationStatus item={source} />
        {source.media?.length ? source.media.map(media => <FullImage key={media.id} media={media} description={t.title} />) : <p>{t.missing}</p>}
        {sourceControls(source)}
      </article>)}
    </details>
    {!!group.otherMedia.length && <section aria-label={t.other} className="fy-result-other"><p className="meta">{t.other}</p>
      {group.otherMedia.map(media => <FullImage key={media.id} media={media} description={media.name === 'studio_p.png' ? t.studio : media.name} />)}
    </section>}
  </section>
}
