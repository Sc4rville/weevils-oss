import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { OutboxReceipt } from '../shared/outbox.ts'
import { tr, type Lang } from './i18n.ts'
import M from './i18n/outbox.ts'

export const deliveryContext = new AsyncLocalStorage<{ messageId: string }>()
export interface OutboxTask { locale?: Lang; url: string; body: Record<string, unknown>; lane: string }
interface Entry extends OutboxReceipt { hash: string; task?: OutboxTask; retryAt?: number; sequence?: number }
export class OutboxError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}
/** Only throw before any transport side effect. Unlike uncertainty, this is safe to dispatch later. */
export class OutboxDeferred extends OutboxError {
  readonly retryAt: number
  constructor(retryAt: number, message: string) { super(429, message); this.retryAt = retryAt }
}
const canonical = (v: any): string => Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => JSON.stringify(k)+':'+canonical(v[k])).join(',')}}` : JSON.stringify(v)
const hashOf = (v: unknown) => crypto.createHash('sha256').update(canonical(v)).digest('hex')
/** At-most-once dispatch. An interrupted delivery is uncertain, never automatically reinjected. */
export class Outbox {
  private dir: string
  private run: (task: OutboxTask) => Promise<OutboxReceipt['result']>
  private entries = new Map<string, Entry>()
  private lanes = new Set<string>()
  private scheduled = false
  private sequence = 0
  private wake?: ReturnType<typeof setTimeout>
  constructor(dir: string, run: (task: OutboxTask) => Promise<OutboxReceipt['result']>) {
    this.dir = dir; this.run = run
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    for (const file of fs.readdirSync(dir).filter(f => /^[a-f0-9]{64}\.json$/.test(f))) {
      const e = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as Entry
      this.sequence = Math.max(this.sequence, e.sequence ?? 0)
      if (e.status === 'delivering') { e.status = 'uncertain'; e.error = tr(M).uncertain; e.updatedAt = Date.now(); this.save(e) }
      this.entries.set(e.messageId, e)
    }
  }
  private save(e: Entry) {
    const file = path.join(this.dir, hashOf(e.messageId)+'.json'), temp = file+'.next'
    const fd = fs.openSync(temp, 'w', 0o600)
    try { fs.writeFileSync(fd, JSON.stringify(e)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    fs.renameSync(temp, file)
    const dir = fs.openSync(this.dir, 'r'); try { fs.fsyncSync(dir) } finally { fs.closeSync(dir) }
  }
  get(id: string): OutboxReceipt | undefined {
    const e = this.entries.get(id)
    if (!e) return
    const { hash: _hash, task: _task, ...receipt } = e
    return receipt
  }
  accept(messageId: string, task: OutboxTask, id?: string): OutboxReceipt {
    if (!/^[a-zA-Z0-9_-]{16,120}$/.test(messageId)) throw new OutboxError(400, tr(M).invalid)
    const identity = new URL(task.url, 'http://local')
    identity.searchParams.delete('lang'); identity.searchParams.sort()
    const hash = hashOf({ url: identity.pathname + identity.search, body: task.body })
    const old = this.entries.get(messageId)
    if (old) {
      if (old.hash !== hash) throw new OutboxError(409, tr(M).conflict)
      return this.get(messageId)!
    }
    const now = Date.now()
    const e: Entry = { messageId, hash, task, sequence: ++this.sequence, status: 'accepted', acceptedAt: now, updatedAt: now, ...(id ? { id } : {}) }
    this.save(e); this.entries.set(messageId, e)
    console.log(`[outbox] ${messageId} accepted`)
    this.start()
    return this.get(messageId)!
  }
  start() {
    if (this.scheduled) return
    this.scheduled = true
    setImmediate(() => { this.scheduled = false; this.pump() })
  }
  private pump() {
    if (this.wake) clearTimeout(this.wake)
    const waiting = new Set<string>()
    let next = Infinity
    for (const e of [...this.entries.values()].sort((a,b) => a.acceptedAt-b.acceptedAt || (a.sequence ?? 0)-(b.sequence ?? 0))) {
      if (e.status !== 'accepted' || !e.task || this.lanes.has(e.task.lane) || waiting.has(e.task.lane)) continue
      if (e.retryAt && e.retryAt > Date.now()) { waiting.add(e.task.lane); next = Math.min(next, e.retryAt); continue }
      const lane = e.task.lane
      this.lanes.add(lane)
      e.status = 'delivering'; e.updatedAt = Date.now()
      try { this.save(e) } catch { e.status = 'uncertain'; e.error = tr(M).uncertain; this.lanes.delete(lane); console.error('[outbox] persistence failed before dispatch'); continue }
      void deliveryContext.run({ messageId: e.messageId }, () => this.run(e.task!)).then(result => {
        e.status = 'delivered'; e.result = result; if (result?.id) e.id = result.id
        delete e.task; delete e.retryAt; delete e.error
      }, error => {
        if (error instanceof OutboxDeferred) {
          e.status = 'accepted'; e.error = error.message
          e.retryAt = Math.max(Date.now() + 60_000, Number.isFinite(error.retryAt) ? error.retryAt : 0)
          return
        }
        // Only an explicit refusal before dispatch can be called a failure.
        e.status = error instanceof OutboxError && error.status < 500 ? 'failed' : 'uncertain'
        e.error = e.status === 'failed' ? error.message : tr(M).uncertain
      }).finally(() => {
        e.updatedAt = Date.now()
        try { this.save(e) } catch { console.error('[outbox] receipt persistence failed') }
        console.log(`[outbox] ${e.messageId} ${e.status} ${e.updatedAt-e.acceptedAt}ms`)
        this.lanes.delete(lane); this.start()
      })
    }
    if (Number.isFinite(next)) { this.wake = setTimeout(() => this.start(), Math.max(1, next - Date.now())); this.wake.unref?.() }
  }
}
