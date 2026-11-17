// Living links (docs/LINKS.md): a link to a page weevils serves (/p/<kind>/<slug>) is bold, in its kind's colours,
// slowly drifting; a tap opens the page in place, full width, behind the weevils login.
import { useEffect, useSyncExternalStore } from 'react'
import { pageLink, type PageInfo, type PageKind } from '../../shared/pages'
import { useT } from '../i18n'
import M from '../i18n/living-link'
import { useApp } from './app-context'
import { Icon } from './icons'
import { Shell } from './shell'
import './living-link.css'
import { linkCss } from '../../shared/link-colors'

// The colours of each kind in each theme (shared/link-colors.ts), once per document.
if (typeof document !== 'undefined' && !document.getElementById('lk-colors')) {
  const style = document.createElement('style')
  style.id = 'lk-colors'
  style.textContent = linkCss()
  document.head.append(style)
}

/** A page link written in a message or a post, if it is one of this weevils' pages. */
export const livingLink = (href: string) => (typeof location === 'undefined' ? pageLink(href) : pageLink(href, [location.host]))

// The titles of the pages, for a bare link: fetched once, refreshed at most every minute.
let titles: Map<string, PageInfo> = new Map()
let fetchedAt = 0
const subs = new Set<() => void>()
function refresh() {
  if (Date.now() - fetchedAt < 60_000) return
  fetchedAt = Date.now()
  fetch('/api/pages', { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : null))
    .then((d: { pages?: PageInfo[] } | null) => {
      if (!d?.pages) return
      titles = new Map(d.pages.map((p) => [p.slug, p]))
      subs.forEach((f) => f())
    })
    .catch(() => {})
}
const subscribe = (f: () => void) => {
  subs.add(f)
  return () => void subs.delete(f)
}

export function LivingLink({ href, label }: { href: string; label?: string }) {
  const link = livingLink(href)!
  // Outside the app (a test, a static render) the link is a plain link.
  let app: ReturnType<typeof useApp> | null = null
  try {
    app = useApp()
  } catch {}
  const known = useSyncExternalStore(subscribe, () => titles.get(link.slug))
  useEffect(() => {
    if (!label || label === href) refresh()
  }, [label, href])
  const bare = !label || label === href
  const text = bare ? known?.title ?? link.slug.replace(/-/g, ' ') : label
  return (
    <a
      className={`living lk-${link.kind}`}
      href={link.path}
      onClick={(e) => {
        e.stopPropagation()
        if (!app || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
        e.preventDefault()
        app.push({ kind: 'webpage', path: link.path, title: text, pageKind: link.kind })
      }}
    >
      {text}
    </a>
  )
}

/** The page itself, in the app: its title, then the page. */
export function WebPage({ path, title, pageKind }: { path: string; title: string; pageKind: PageKind }) {
  const t = useT(M)
  return (
    <Shell
      slot="agent"
      kicker={t.kind(pageKind)}
      title={title}
      actions={
        <a className="key" href={path} target="_blank" rel="noreferrer" aria-label={t.openTab}>
          <Icon name="external" />
        </a>
      }
    >
      <div className="lp-frame">
        <iframe
          src={path}
          title={t.frame}
          sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
          allow="clipboard-write; fullscreen; autoplay"
          referrerPolicy="no-referrer"
        />
      </div>
    </Shell>
  )
}
