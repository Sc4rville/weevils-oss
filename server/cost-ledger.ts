// What weevilsd's own model calls cost (claude -p from server/fast.ts: the « for you » curator, titles, automation
// proposals, voice summaries…). Those calls run with --no-session-persistence, so no transcript
// ever shows them: each answer's usage is counted here, per caller and per day, for the cost optimiser (server/cost.ts).
//
// And the cheapest call is the one never made: an identical request (same model, same prompt, same schema) asked again
// within CACHE_MS gets the answer already given, without a call — nothing changed, the answer would not either.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** One caller's day: calls made, calls answered from the cache, tokens (input + cache + output), weight (≈ relative cost). */
export interface LedgerEntry {
  calls: number
  cached: number
  tokens: number
  weight: number
  model: string
}
/** day (YYYY-MM-DD) → caller → entry. */
export type Ledger = Record<string, Record<string, LedgerEntry>>

export const CACHE_MS = 15 * 60_000
const CACHE_MAX = 300
const KEEP_DAYS = 14

const dayKey = (at: number) => new Date(at).toISOString().slice(0, 10)
const modelFactor = (m: string) => (/haiku/i.test(m) ? 1 / 3 : /opus|fable/i.test(m) ? 5 / 3 : 1)

/** Which file of the server asked (the first stack frame outside fast.ts and this file): « foryou-curator », « titles »… */
export function callerOf(stack = new Error().stack ?? ''): string {
  for (const line of stack.split('\n').slice(1)) {
    const m = /([\w.-]+)\.ts:\d+/.exec(line)
    if (!m) continue
    const name = m[1]
    if (name === 'fast' || name === 'cost-ledger') continue
    return name
  }
  return 'other'
}

export class CostLedger {
  private file: string | null
  private data: Ledger = {}
  private cache = new Map<string, { at: number; text: string }>()
  private dirty = false
  private timer: NodeJS.Timeout | null = null

  constructor(file: string | null) {
    this.file = file
    if (file)
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (raw && typeof raw === 'object') this.data = raw as Ledger
      } catch {
        /* first start */
      }
  }

  /** Counts one answered call (usage as claude -p --output-format json reports it). */
  record(caller: string, model: string, usage: any, now = Date.now()) {
    const inp = Number(usage?.input_tokens ?? 0)
    const out = Number(usage?.output_tokens ?? 0)
    const cw = Number(usage?.cache_creation_input_tokens ?? 0)
    const cr = Number(usage?.cache_read_input_tokens ?? 0)
    const e = this.entry(caller, model, now)
    e.calls++
    e.tokens += inp + out + cw + cr
    e.weight += Math.round((inp + 5 * out + 1.25 * cw + 0.1 * cr) * modelFactor(model))
    this.touch()
  }

  /** A call answered from the cache. */
  hit(caller: string, model: string, now = Date.now()) {
    this.entry(caller, model, now).cached++
    this.touch()
  }

  get(key: string, now = Date.now()): string | undefined {
    const c = this.cache.get(key)
    if (!c) return undefined
    if (now - c.at > CACHE_MS) {
      this.cache.delete(key)
      return undefined
    }
    return c.text
  }

  put(key: string, text: string, now = Date.now()) {
    if (!text.trim()) return
    this.cache.delete(key)
    this.cache.set(key, { at: now, text })
    while (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!)
  }

  static key(model: string, prompt: string, schema?: object): string {
    return crypto.createHash('sha256').update(model).update('\0').update(schema ? JSON.stringify(schema) : '').update('\0').update(prompt).digest('hex')
  }

  /** day → caller → entry, the last `days` days (today included). */
  days(days = 7, now = Date.now()): Ledger {
    const out: Ledger = {}
    for (let i = 0; i < days; i++) {
      const k = dayKey(now - i * 86400_000)
      if (this.data[k]) out[k] = this.data[k]
    }
    return out
  }

  private entry(caller: string, model: string, now: number): LedgerEntry {
    const d = (this.data[dayKey(now)] ??= {})
    const k = `${caller}|${model}`
    return (d[k] ??= { calls: 0, cached: 0, tokens: 0, weight: 0, model })
  }

  private touch() {
    this.dirty = true
    if (!this.file || this.timer) return
    this.timer = setTimeout(() => this.flush(), 30_000)
    this.timer.unref?.()
  }

  flush() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.file || !this.dirty) return
    this.dirty = false
    const keep = new Set(Array.from({ length: KEEP_DAYS }, (_, i) => dayKey(Date.now() - i * 86400_000)))
    for (const k of Object.keys(this.data)) if (!keep.has(k)) delete this.data[k]
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 })
      fs.renameSync(tmp, this.file)
    } catch (e) {
      console.error(`[coût] registre non écrit : ${(e as Error).message}`)
    }
  }
}
