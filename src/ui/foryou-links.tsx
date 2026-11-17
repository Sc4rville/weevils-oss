import type { ReactNode } from 'react'
import type { ForYouItem } from '../../shared/foryou'
import { publicWebUrl, webLinks } from '../../shared/web-link'
import { useT } from '../i18n'
import M from '../i18n/foryou-links'
import { useApp } from './app-context'
import { useForYouOpen } from './foryou-open'
import './foryou-links.css'
import { LivingLink, livingLink } from './living-link'

/** Text stays text: React escapes it, only validated HTTP(S) spans become links. */
export function FeedText({ text, item }: { text: string; item?: ForYouItem }) {
  const { push } = useApp()
  const parts: ReactNode[] = []
  let end = 0
  for (const link of webLinks(text)) {
    parts.push(text.slice(end, link.start))
    if (livingLink(link.text)) parts.push(<LivingLink key={`${link.start}:${link.text}`} href={link.text} />)
    else if (!link.url) parts.push(link.text)
    else {
      const software = item?.software
      const viewer = software?.state === 'running' && software.url && publicWebUrl(software.url) === link.url
      parts.push(<a key={`${link.start}:${link.url}`} className="fy-web-link" href={link.url} target={viewer ? undefined : '_blank'} rel="noopener noreferrer"
        onClick={event => {
          event.stopPropagation()
          if (viewer && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
            event.preventDefault()
            push({ kind: 'software', id: software!.id })
          }
        }}>{link.text}</a>)
    }
    end = link.end
  }
  parts.push(text.slice(end))
  return <>{parts}</>
}

/** Opens the current software viewer with GETs only, never openSoftware/launch. */
export function SoftwareResultLink({ item }: { item: ForYouItem }) {
  const t = useT(M)
  const { push } = useApp()
  const conversation = useForYouOpen()
  const software = item.software
  if (!software) return null
  return <div className="fy-software-links">
    {software.state === 'running'
      ? <button type="button" className="fy-btn" onClick={() => push({ kind: 'software', id: software.id })}>{t.open(software.name)}</button>
      : <span className="meta" role="status">{t.unavailable}</span>}
    {item.open && <button type="button" className="meta fy-software-conversation" onClick={() => conversation(item.open!, item.projectId)}>{t.conversation}</button>}
  </div>
}
