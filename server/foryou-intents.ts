import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { ForYouOpen } from '../shared/foryou.ts'
import { tr } from './i18n.ts'
import M from './i18n/foryou.ts'
import { OutboxError } from './outbox.ts'

export type IntentStatus = 'requested' | 'dispatching' | 'uncertain' | 'queued' | 'running' | 'completed'
export interface WorkIntent {
  id: string
  brief: string
  /** Titles/descriptions provide context only, never an exact request match. */
  exact?: boolean
  scope?: string
  status: IntentStatus
  open?: ForYouOpen
  source?: { sessionId: string; messageId: string }
  at: number
}
export interface IntentResult { intentId: string; existing: boolean; open?: ForYouOpen }
/** Internal calls made by an accepted intent must not register themselves again. */
export const intentDispatch = new AsyncLocalStorage<boolean>()
const normalize = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim()
export const briefKey = (s: string) => crypto.createHash('sha256').update(normalize(s)).digest('hex')
export const substantive = (s: string) => normalize(s).split(' ').length >= 8
/** Do not turn ordinary conversation, questions about status, or short replies
 * into work reservations. Unrecognized wording is never silently swallowed. */
export const isWorkRequest = (s: string) => {
  // i18n-ignore: input recognition, not display copy
  return /^(?:please\s+|merci de\s+)?(?:build|implement|create|prepare|fix|add|remove|publish|deploy|test|review|write|design|refactor|make|construis|implémente|crée|prépare|corrige|ajoute|supprime|publie|déploie|teste|vérifie|écris|refais)\b/iu.test(s.trim())
}

/** Durable reservation before dispatch, shared by direct requests and feed cards.
 * No project-name/fuzzy matching: an explicit known source ID or exact brief is
 * required. Paraphrases carry the source intent ID supplied to the curator. */
export class WorkIntents {
  private entries = new Map<string, WorkIntent>()
  private flights = new Map<string, Promise<IntentResult>>()
  private file: string
  private now: () => number
  constructor(file: string, now = Date.now) {
    this.file = file
    this.now = now
    if (fs.existsSync(file)) {
      for (const entry of JSON.parse(fs.readFileSync(file, 'utf8')) as WorkIntent[]) {
        if (entry.status === 'dispatching') entry.status = 'uncertain'
        this.entries.set(entry.id, entry)
      }
      this.save()
    }
  }
  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const temp = this.file + '.next'
    const fd = fs.openSync(temp, 'w', 0o600)
    try { fs.writeFileSync(fd, JSON.stringify([...this.entries.values()])); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    fs.renameSync(temp, this.file)
    const dir = fs.openSync(path.dirname(this.file), 'r')
    try { fs.fsyncSync(dir) } finally { fs.closeSync(dir) }
  }
  get(id?: string) { return id ? this.entries.get(id) : undefined }
  list() { return [...this.entries.values()].sort((a, b) => b.at - a.at).slice(0, 100) }
  private matches(brief: string, scope?: string) {
    if (!substantive(brief)) return []
    const key = briefKey(brief)
    return [...this.entries.values()].filter(e => e.exact !== false && this.keyOf(e) === key && (!scope || !e.scope || e.scope === scope))
  }
  /** Hashing every stored brief on each lookup made snapshots O(actions x intents)
   * sha256+NFKC passes and pinned the event loop; cache the key per entry. */
  private keys = new WeakMap<WorkIntent, { brief: string; key: string }>()
  private keyOf(e: WorkIntent) {
    const hit = this.keys.get(e)
    if (hit && hit.brief === e.brief) return hit.key
    const key = briefKey(e.brief)
    this.keys.set(e, { brief: e.brief, key })
    return key
  }
  ambiguous(brief: string, scope?: string) {
    const matches = this.matches(brief, scope)
    return matches.length > 1 && new Set(matches.map(e => JSON.stringify(e.open))).size > 1 && !matches.some(e => this.flights.has(e.id))
  }
  find(brief: string, scope?: string, sourceIntentId?: string) {
    if (sourceIntentId) return this.get(sourceIntentId)
    const matches = this.matches(brief, scope)
    return matches.find(e => this.flights.has(e.id)) ?? (this.ambiguous(brief, scope) ? undefined : matches[0])
  }
  observe(entry: Omit<WorkIntent, 'at'> & { at?: number }) {
    const old = this.entries.get(entry.id)
    // A later scan must not regress a durable dispatch reservation or replace its source.
    if (old && !entry.id.startsWith('auto:')) return old
    const next = { ...entry, at: entry.at ?? old?.at ?? this.now() }
    if (JSON.stringify(old) !== JSON.stringify(next)) { this.entries.set(next.id, next); this.save() }
    return next
  }
  async dispatch(brief: string, scope: string | undefined, fallbackId: string, run: () => Promise<{ id: string }>, sourceIntentId?: string): Promise<IntentResult> {
    if (!sourceIntentId && this.ambiguous(brief, scope)) throw new Error(tr(M).intentAmbiguous)
    const known = this.find(brief, scope, sourceIntentId)
    const id = known?.id ?? (substantive(brief) ? `brief:${briefKey((scope ?? '') + '\n' + brief)}` : fallbackId)
    const flight = this.flights.get(id)
    if (flight) return flight.then(result => ({ ...result, existing: true }))
    const old = known ?? this.get(id)
    if (old) return { intentId: id, existing: true, open: old.open }
    const entry: WorkIntent = { id, brief, scope, status: 'dispatching', at: this.now() }
    this.entries.set(id, entry)
    // Refuse dispatch if durable reservation fails.
    try { this.save() } catch (e) { this.entries.delete(id); throw e }
    const work = Promise.resolve().then(() => intentDispatch.run(true, run)).then(result => {
      entry.status = 'requested'
      entry.open = { page: 'session', id: result.id }
      this.save()
      return { intentId: id, existing: false, open: entry.open }
    }, error => {
      // An explicit pre-dispatch refusal is retryable; a lost acknowledgement is not.
      if (error instanceof OutboxError && error.status < 500) this.entries.delete(id)
      else entry.status = 'uncertain'
      this.save()
      throw error
    })
    this.flights.set(id, work)
    try { return await work } finally { this.flights.delete(id) }
  }
}
