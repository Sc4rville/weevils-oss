import type { Snapshot } from '../shared/api.ts'
import type { ForYouItem } from '../shared/foryou.ts'
import type { Software } from '../shared/softwares.ts'
import { publicWebUrl, webLinks } from '../shared/web-link.ts'

export interface SoftwareCatalog { at: number; items: (Software & { deploymentUrls?: string[] })[] }
/** Resolve deployed results through repository/machine identities or an exact
 * catalogued URL origin. Never derive a URL from a project name or quoted prose. */
export function softwareResult(item: ForYouItem, snap: Snapshot, catalog: SoftwareCatalog, now: number): ForYouItem['software'] {
  if (item.work || item.tone === 'question' || item.tone === 'alert' || !['boss','session','media','milestone'].includes(item.kind)) return undefined
  const session = snap.sessions.find(s => s.id === item.sessionId)
  const project = snap.projects.find(p => p.id === item.projectId)
  const urls = webLinks([item.text, item.body, item.title].filter(Boolean).join('\n')).flatMap(link => link.url ? [new URL(link.url)] : [])
  if (item.tone !== 'result' && !urls.length) return undefined
  if (item.kind === 'media' && !urls.length) return undefined
  const web = catalog.items.filter(sw => sw.kind === 'web')
  const repo = session?.repo
  const byRepo = repo ? web.filter(sw => sw.machine === session!.machineId && [sw.repo, ...sw.repos].includes(repo)) : []
  const byProject = project ? web.filter(sw => [sw.repo,...sw.repos].some(r => project.repos.includes(r)) && (!session || sw.machine === session.machineId)) : []
  const byUrl = web.filter(sw => {
    const addresses = [sw.url, ...(sw.deploymentUrls ?? [])].flatMap(value => value && publicWebUrl(value) ? [new URL(publicWebUrl(value)!)] : [])
    return addresses.some(address => urls.some(url => url.origin === address.origin && (address.pathname === '/' || url.pathname === address.pathname || url.pathname.startsWith(address.pathname.replace(/\/$/, '') + '/'))))
  })
  // A cited URL disambiguates several deployments, but must not contradict a known repo.
  const candidates = byRepo.length ? byRepo : byProject.length ? byProject : byUrl
  const narrowed = candidates.length > 1 ? candidates.filter(sw => byUrl.includes(sw)) : candidates
  if (narrowed.length !== 1) return undefined
  const sw = narrowed[0]
  const url = sw.url && publicWebUrl(sw.url)
  const protectedPage = !!sw.url && /^\/api\/site\/[^/]+\/[^/]+\//u.test(sw.url)
  const live = now - catalog.at <= 60_000 && sw.run === 'running' && (!!url || protectedPage)
  return { id: sw.id, name: sw.name, state: live ? 'running' : 'unavailable', ...(live && url ? { url } : {}) }
}
