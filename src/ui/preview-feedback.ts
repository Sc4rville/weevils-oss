import { api } from '../api'
import { outboxSnapshot } from '../outbox'
import { loadPayload, removePayload, storePayload } from '../outbox-payload'
import type { PreviewCapture } from './preview-capture'

export interface PreviewTarget { sessionId: string | null; title: string }
export interface FrozenFeedback {
  draft: string
  target: PreviewTarget
  body: { text: string; files: PreviewCapture['file'][] }
  fingerprint: string
  at: number
}
export const feedbackKey = (viewer: string) => `preview-feedback:${viewer}`
export async function readFeedback(viewer: string): Promise<FrozenFeedback | null> {
  return (await loadPayload(feedbackKey(viewer)) as FrozenFeedback | undefined) ?? null
}
export function feedbackDelivered(value: FrozenFeedback): boolean {
  return outboxSnapshot().some(row => row.fingerprint === value.fingerprint && row.status === 'delivered')
}
export async function freezeFeedback(viewer: string, draft: string, target: PreviewTarget, capture: PreviewCapture, contextLabel: string): Promise<FrozenFeedback> {
  const view = capture.view
  const text = `${draft}\n\n${contextLabel}: ${view.url}\n${view.title}\nViewport: ${view.width} × ${view.height}; scroll: ${view.scrollX}, ${view.scrollY}; captured: ${new Date(capture.capturedAt).toISOString()}`
  const body = { text, files: [capture.file] }
  const url = target.sessionId ? `/api/sessions/${encodeURIComponent(target.sessionId)}/attach` : '/api/main/attach'
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${url}\n${JSON.stringify(body)}`))
  const fingerprint = Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join('')
  const value = { draft, target, body, fingerprint, at: capture.capturedAt }
  // Persist the destination and image together before the first possible POST.
  await storePayload(feedbackKey(viewer), value)
  return value
}
export async function deliverFeedback(viewer: string, value: FrozenFeedback, noTarget: string) {
  // Also reject legacy prepared payloads that used null as a boss fallback. Never retarget a retry.
  if (!value.target.sessionId) throw new Error(noTarget)
  if (!feedbackDelivered(value)) {
    await api.attach(value.target.sessionId, value.body.text, value.body.files)
  }
  // Outbox owns its own persisted payload and retry identity after acceptance.
  await removePayload(feedbackKey(viewer)).catch(() => undefined)
}
