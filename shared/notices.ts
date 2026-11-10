import type { Session } from './api.ts'
import type { ForYouItem } from './foryou.ts'

/** Stable, opaque identity: presentation, counters and translations are not events. */
export function noticeKey(kind: string, ...parts: unknown[]): string {
  const text = JSON.stringify(parts)
  let a = 2166136261, b = 5381
  for (const c of text) { a = Math.imul(a ^ c.codePointAt(0)!, 16777619); b = Math.imul(b, 33) ^ c.codePointAt(0)! }
  return `notice:${kind}:${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}`
}
export const quotaReset = (at: number) => Math.round(at / 60_000) * 60_000
export const canonicalAlertId = (id: string) => id.startsWith('alert:usage:') ? id.replace(/:(\d+)$/, (_, at: string) => `:${quotaReset(Number(at))}`) : id
export function sessionNoticeKey(s: Session): string {
  return s.noticeId ?? noticeKey(s.status === 'interrupted' ? 'cut' : 'question', s.id, s.status === 'interrupted' ? [s.interrupted?.at, s.interrupted?.reason] : [s.attention, s.choices?.map((c) => c.id)])
}
export function feedNoticeKey(i: ForYouItem): string {
  return i.eventId ?? noticeKey('feed', canonicalAlertId(i.id), i.live ? (i.cards?.map((c) => c.id).sort() ?? null) : i.at)
}

/** A notification whose request is fulfilled by its answer (information stays available). */
export const isRequestNotice = (i: ForYouItem) => i.tone === 'question' || i.tone === 'alert' || !!i.actions?.length
export const relayPlanNoticeKey = (p: { sessionId: string; at: number }) => noticeKey('relay-plan', p.sessionId, p.at)

export const closableFeedNotice = (i: ForYouItem) => i.kind === 'alert' && !!i.live
