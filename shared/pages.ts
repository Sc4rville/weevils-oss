// Living links (docs/LINKS.md): a small self-hosted page a session or an automation publishes with `weevils page`,
// opened at /p/<kind>/<slug> on the weevils host, behind the weevils login. Shared by the server and the app.

/** What a page opens; each kind has its own signature colour in the app (src/ui/living-link.css). */
export const PAGE_KINDS = ['opportunities', 'library', 'preview', 'report', 'render'] as const
export type PageKind = (typeof PAGE_KINDS)[number]

export const isPageKind = (k: unknown): k is PageKind => typeof k === 'string' && (PAGE_KINDS as readonly string[]).includes(k)

/** Public description of a page, as GET /api/pages lists it. */
export interface PageInfo {
  slug: string
  kind: PageKind
  title: string
  /** Path on the weevils host: /p/<kind>/<slug> */
  path: string
  updatedAt: number
}

const PATH_RE = new RegExp(`^/p/(${PAGE_KINDS.join('|')})/([a-z0-9][a-z0-9-]{0,79})/?$`)

export const pagePath = (kind: PageKind, slug: string) => `/p/${kind}/${slug}`

/** A link to a page, whatever host it was written with (the public address, or this machine's when there is none).
 * `hosts`: the hosts that are this weevils (the app's own, its public one). Loopback always counts: a link printed on a
 * machine without a domain is still ours. */
export function pageLink(href: string, hosts: string[] = []): { kind: PageKind; slug: string; path: string } | undefined {
  let u: URL
  try {
    u = new URL(href, 'http://local')
  } catch {
    return undefined
  }
  const m = PATH_RE.exec(u.pathname)
  if (!m) return undefined
  const host = u.host.toLowerCase()
  const ours = host === 'local' || /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(host) || hosts.some((h) => !!h && h.toLowerCase() === host)
  if (!ours) return undefined
  const kind = m[1] as PageKind
  return { kind, slug: m[2], path: pagePath(kind, m[2]) }
}

/** kebab-case, a-z0-9 only, at most 60 characters: a title becomes a stable address. */
export function slugOf(title: string): string {
  const s = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '')
  return s || 'page'
}
