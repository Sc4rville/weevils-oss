import { storePayload, loadPayload, removePayload } from './outbox-payload'
import { useSyncExternalStore } from 'react'
import { getLang, localeHeaders, tr, type Lang } from './i18n'
import M from './i18n/outbox'
import { automatedHeaders } from './automated'

export type DeliveryState = 'sending' | 'accepted' | 'delivering' | 'delivered' | 'uncertain' | 'failed'
export interface Receipt {
  messageId: string
  status: DeliveryState
  acceptedAt?: number
  updatedAt: number
  id?: string
  result?: { id?: string; ok?: boolean }
  error?: string
  /** Held by the server (OutboxDeferred): it has the message and tries again by itself at this time. */
  retryAt?: number
}
/** stuck: automatic resumes gave up (RESUME_GIVE_UP_MS); only an explicit « try again » sends it now. */
export interface LocalReceipt extends Receipt { stuck?: boolean; dismissed?: boolean; locale?: Lang; url: string; fingerprint: string; text?: string; trackingLost?: boolean; eventId?: string; card?: string; payload?: unknown; payloadStored?: boolean; recovered?: boolean }
const KEY = 'weevils-outbox-v1'
let rows: LocalReceipt[] = []
try { rows = JSON.parse(localStorage.getItem(KEY) ?? '[]').filter((r: LocalReceipt) => typeof r.messageId === 'string' && typeof r.url === 'string') } catch { /* unavailable storage */ }
const listeners = new Set<() => void>()
/** A send whose transport failed (server restarting, network blip) resumes by itself with the same identity:
 * after 15 s, 30 s, then every minute, for at most two minutes. Then it waits for « try again ». */
const RESUME_MS = [15_000, 30_000, 60_000]
export const RESUME_GIVE_UP_MS = 120_000
const backoff = new Map<string, { since: number; tries: number; next: number }>()
function later(id: string) {
  const b = backoff.get(id), now = Date.now(), tries = b?.tries ?? 0
  backoff.set(id, { since: b?.since ?? now, tries: tries + 1, next: now + RESUME_MS[Math.min(tries, RESUME_MS.length - 1)] })
}
const inflight = new Map<string, Promise<Receipt>>()
const save = () => {
  try { localStorage.setItem(KEY, JSON.stringify(rows)) } catch { /* server acceptance remains durable */ }
  listeners.forEach(fn => fn())
}
function update(receipt: LocalReceipt) {
  const current = rows.find(r => r.messageId === receipt.messageId)
  // A late poll cannot turn a completed operation back into a pending banner.
  if (current?.status === 'delivered' && receipt.status !== 'delivered') return
  // An explicit false (a new attempt) shows the notice again; anything else keeps a dismissal made meanwhile.
  receipt = { ...receipt, dismissed: receipt.dismissed === false ? false : current?.dismissed || receipt.dismissed }
  if (receipt.status === 'delivered') {
    if (receipt.payloadStored) void removePayload(receipt.messageId).catch(() => undefined)
    receipt = { ...receipt, payload: undefined, payloadStored: false, text: undefined }
  }
  rows = [...rows.filter(r => r.messageId !== receipt.messageId), receipt]
  save()
}
/** Hide presentation only: retain payload, tracking and deduplication identity. */
export function forgetReceipt(id: string) {
  const row = rows.find(r => r.messageId === id)
  if (row && (['delivered', 'failed', 'uncertain'].includes(row.status) || row.stuck)) update({ ...row, dismissed: true })
}
// Only an unsupported old server has no durable receipt to retain.
function forgetUntrackedReceipt(id: string) { rows = rows.filter(r => r.messageId !== id); save() }
export const outboxSnapshot = () => rows
let trackers = 0
export function subscribeOutbox(fn: () => void, track = true) { listeners.add(fn); if (track) { trackers++; startTracking() } return () => { listeners.delete(fn); if (track) trackers--; if (!trackers && timer) { clearInterval(timer); timer = undefined } } }
export function awaitDelivery(receipt: Receipt): Promise<Receipt> {
  if (terminal(receipt)) return Promise.resolve(receipt)
  return new Promise(resolve => {
    const stop = subscribeOutbox(() => { const current = rows.find(r => r.messageId === receipt.messageId); if (current && terminal(current)) { stop(); resolve(current) } })
  })
}
const snapshot = outboxSnapshot
export function useOutbox() {
  return useSyncExternalStore(subscribeOutbox, snapshot)
}
const terminal = (r: Receipt) => ['delivered', 'uncertain', 'failed'].includes(r.status)
let timer: ReturnType<typeof setInterval> | undefined
let polling = false
const terminalChecked = new Map<string, number>()
export async function refreshReceipts() {
  if (polling) return
  polling = true
  try {
    for (const row of rows.filter(r => r.status !== 'delivered')) {
      // Reconcile exact receipts after a backend recovery, without ever resubmitting terminal attempts.
      if (terminal(row)) {
        const checked = terminalChecked.get(row.messageId)
        if (checked !== undefined && Date.now() - checked < 60_000) continue
        terminalChecked.set(row.messageId, Date.now())
      }
      try {
        const response = await fetch(`/api/outbox/${encodeURIComponent(row.messageId)}`, { credentials: 'same-origin', headers: localeHeaders(), signal: AbortSignal.timeout(10000) })
        if (response.status === 404 && row.status === 'sending') {
          // The server never took it: resume the same identity (Idempotency-Key keeps it at most once), on a back-off.
          if (inflight.has(row.fingerprint) || row.stuck || navigator.onLine === false) continue
          const b = backoff.get(row.messageId)
          if (b && Date.now() < b.next) continue
          if (b && Date.now() - b.since >= RESUME_GIVE_UP_MS) { update({ ...row, stuck: true, trackingLost: true }); continue }
          later(row.messageId)
          const payload = row.payloadStored ? await loadPayload(row.messageId) : row.payload
          if (payload === undefined) { update({ ...row, trackingLost: true, stuck: true, error: tr(M).payloadMissing }); continue }
          update({ ...row, recovered: true })
          await deliver(row.url, payload, postSubmitter(row.url, payload, row.locale), true)
          continue
        }
        if (!response.ok) throw new Error()
        const receipt = await response.json() as Receipt
        if (receipt.messageId !== row.messageId || !['accepted','delivering','delivered','uncertain','failed'].includes(receipt.status)) throw new Error()
        backoff.delete(row.messageId)
        update({ ...row, ...receipt, recovered: row.recovered || (row.status === 'sending' && !inflight.has(row.fingerprint)), trackingLost: false, stuck: false })
      } catch {
        // A send still in flight is not lost: its own attempts decide. Otherwise say so (« not sent yet »).
        if (!terminal(row) && !inflight.has(row.fingerprint)) update({ ...(rows.find(r => r.messageId === row.messageId) ?? row), trackingLost: true })
      }
    }
  } finally { polling = false }
}
function startTracking() {
  if (timer) return
  void refreshReceipts()
  timer = setInterval(() => void refreshReceipts(), 5000)
}
let capability: Promise<boolean> | null = null
async function supported() {
  capability ??= fetch('/api/outbox/capabilities', { credentials: 'same-origin', headers: localeHeaders(), signal: AbortSignal.timeout(10000) }).then(async r => {
    if (r.status === 404) return false
    if (!r.ok) throw new Error(tr(M).unconfirmed)
    return (await r.json()).enabled === true
  })
  let enabled: boolean
  try { enabled = await capability } catch { capability = null; throw new Error(tr(M).unconfirmed) }
  if (!enabled) capability = null
  return enabled
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
/** The same POST the app makes (src/api.ts call), for a resume without the page that sent it. */
function postSubmitter(url: string, payload: unknown, original?: Lang): Submit {
  return async (messageId, signal, locale) => {
    if (!messageId) throw new Error(tr(M).unconfirmed)
    const res = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { ...localeHeaders(locale ?? original), ...automatedHeaders(), 'content-type': 'application/json', 'Idempotency-Key': messageId }, body: JSON.stringify(payload), signal })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw Object.assign(new Error(data.error ?? tr(M).unconfirmed), { status: res.status })
    return data
  }
}
export type Submit = (messageId?: string, signal?: AbortSignal, locale?: Lang, originalUrl?: string) => Promise<any>
/** Transport retries reuse the persisted identity. Once accepted, only GET may run. */
export async function deliver(url: string, body: unknown, submit: Submit, resuming = false): Promise<any> {
  const submittedLocale = getLang()
  const bytes = new TextEncoder().encode(`${url.split('?')[0]}\n${JSON.stringify(body)}`)
  const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), x => x.toString(16).padStart(2, '0')).join('')
  const action = /\/foryou\/[^/]+\/act(?:\?|$)/.test(url)
  const previous = rows.find(r => r.fingerprint === fingerprint && r.status !== 'failed' && (action || r.recovered || r.status !== 'delivered'))
  // A known acceptance is not a new request, even after a reload or a lost connection.
  if (previous && ['uncertain', 'failed'].includes(previous.status)) throw new Error(previous.error || tr(M)[previous.status as 'uncertain' | 'failed'])
  if (previous && previous.status !== 'sending') { if (!resuming && previous.recovered) update({ ...previous, recovered: false }); return previous }
  if (inflight.has(fingerprint)) return inflight.get(fingerprint)
  // Sending the same text again (composer or « try again ») is a new chance for the same identity, shown again.
  let base = previous
  if (previous && !resuming) { backoff.delete(previous.messageId); if (previous.stuck || previous.dismissed) base = { ...previous, stuck: false, dismissed: false } }
  const row: LocalReceipt = base ?? { locale: submittedLocale, messageId: action ? `action-${fingerprint}-${rows.filter(r => r.fingerprint === fingerprint && r.status === 'failed').length}` : crypto.randomUUID(), status: 'sending', updatedAt: Date.now(), url, fingerprint, eventId: (body as any)?.eventId, card: (body as any)?.card, ...((body as any)?.text ? { text: (body as any).text } : {}) }
  const prepared = async () => {
  if (!previous) {
    if (Array.isArray((body as any)?.files) && (body as any).files.length) {
      try { await storePayload(row.messageId, body); row.payloadStored = true } catch { throw new Error(tr(M).storageFailed) }
    } else row.payload = body
  }
  update(row)
  try { localStorage.setItem(KEY, JSON.stringify(rows)) } catch { throw new Error(tr(M).storageFailed) }
  let enabled: boolean
  try { enabled = await supported() } catch (error) { update({ ...row, trackingLost: true }); throw error }
  if (!enabled) { forgetUntrackedReceipt(row.messageId); return submit() } // no retries against an older server
  const run = async (): Promise<Receipt> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const known = rows.find(r => r.messageId === row.messageId)
      if (known && known.status !== 'sending') return known
      try {
        const response = await submit(row.messageId, AbortSignal.timeout(30000), row.locale ?? submittedLocale, row.url)
        if (response?.messageId !== row.messageId || !['accepted','delivering','delivered','uncertain','failed'].includes(response.status)) throw new TypeError(tr(M).unconfirmed)
        const receipt = response as Receipt
        backoff.delete(row.messageId)
        update({ ...row, ...receipt, trackingLost: false, stuck: false })
        return receipt
      } catch (error) {
        const current = rows.find(r => r.messageId === row.messageId)
        if (current && current.status !== 'sending') return current
        const status = (error as { status?: number }).status
        // Definitive refusals are not network retries. Keep their recovery text visible.
        if (status && ![502,503,504].includes(status)) {
          // A server error (500) never took it: « not sent yet » with « try again », resumed on the same back-off.
          if (status >= 500) later(row.messageId)
          update({ ...row, status: status >= 500 ? 'sending' : 'failed', error: error instanceof Error ? error.message : '', updatedAt: Date.now(), ...(status >= 500 ? { trackingLost: true } : {}) })
          throw error
        }
        if (attempt < 2) await pause(attempt ? 2000 : 600)
      }
    }
    later(row.messageId)
    update({ ...(rows.find(r => r.messageId === row.messageId) ?? row), trackingLost: true })
    throw new Error(tr(M).unconfirmed)
  }
  return run()
  }
  const job = prepared().finally(() => inflight.delete(fingerprint))
  inflight.set(fingerprint, job)
  return job
}

/** « Try again » on a notice. A send the server never took keeps its identity; a proved refusal (failed) gets a new
 * one, as deliver already does. Never for « uncertain »: it may have reached the agent. */
export async function retryReceipt(id: string): Promise<Receipt | undefined> {
  const row = rows.find(r => r.messageId === id)
  if (!row || (row.status !== 'sending' && row.status !== 'failed')) return
  const payload = row.payloadStored ? await loadPayload(id) : row.payload
  if (payload === undefined) { update({ ...row, stuck: true, error: tr(M).payloadMissing }); throw new Error(tr(M).payloadMissing) }
  if (row.status === 'sending') {
    backoff.delete(id)
    update({ ...row, stuck: false, dismissed: false, error: undefined, updatedAt: Date.now() })
    return deliver(row.url, payload, postSubmitter(row.url, payload, row.locale), true)
  }
  try { return await deliver(row.url, payload, postSubmitter(row.url, payload, row.locale)) }
  finally {
    // The new attempt has its own notice: the old refusal steps aside.
    if (rows.some(r => r.fingerprint === row.fingerprint && r.messageId !== id)) forgetReceipt(id)
  }
}

if (typeof window !== 'undefined') {
  // Back online or back on screen: a pending resume runs now (the two-minute limit still counts from the first failure).
  const resumeNow = () => { for (const b of backoff.values()) b.next = 0 }
  window.addEventListener('online', () => { resumeNow(); terminalChecked.clear(); void refreshReceipts() })
  window.addEventListener('storage', event => {
    if (event.key !== KEY || !event.newValue) return
    try {
      for (const incoming of JSON.parse(event.newValue) as LocalReceipt[]) {
        if (typeof incoming.messageId !== 'string' || typeof incoming.url !== 'string') continue
        const current = rows.find(r => r.messageId === incoming.messageId)
        if (JSON.stringify(current) === JSON.stringify(incoming)) continue
        if (current && current.updatedAt > incoming.updatedAt && incoming.status !== 'delivered') continue
        update(incoming)
      }
    } catch { /* A malformed storage event is not delivery evidence. */ }
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && trackers) { resumeNow(); terminalChecked.clear(); void refreshReceipts() }
  })
}
