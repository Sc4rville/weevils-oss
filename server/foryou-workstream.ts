import type { Snapshot, WorkstreamIdentity } from '../shared/api.ts'
import type { ForYouItem } from '../shared/foryou.ts'

/** Identity is supplied by the repository classifier. A more specific but
 * unclassified target must never inherit a broad project's identity. */
export function feedWorkstream(item: ForYouItem, snap: Snapshot): WorkstreamIdentity | undefined {
  if (item.work && !['session', 'auto'].includes(item.work.open?.page ?? '')) return undefined
  const target = item.work?.open ?? item.open
  if (target?.page === 'auto') return snap.optimizers?.find(o => o.id === target.id)?.workstream
  const sessionId = item.work?.open?.page === 'session' ? item.work.open.id
    : item.sessionId ?? (target?.page === 'session' ? target.id : undefined)
  if (sessionId) return snap.sessions.find(s => s.id === sessionId)?.workstream
  if (item.work) return undefined // An unbound intent is not a verified repository target.
  return item.projectId ? snap.projects.find(p => p.id === item.projectId)?.workstream : undefined
}

export function projectFeedWorkstream(item: ForYouItem, snap: Snapshot): ForYouItem {
  const { workstream: _previous, ...rest } = item
  const workstream = feedWorkstream(item, snap)
  return workstream ? { ...rest, workstream } : rest
}
