// How much of the Claude subscription weevils' sessions spend, and when the weekly limit comes at this pace.
//
// Method borrowed from ccusage (MIT, github.com/ccusage/ccusage) and Claude-Code-Usage-Monitor (MIT): read every
// assistant answer in the Claude Code transcripts (~/.claude/projects/**/*.jsonl, subagents included), count each
// answer once (message.id + requestId: one answer is written on several lines with the same usage), price it at API
// list prices. The subscription is not billed that way, but its limits track the same compute, so the dollar figure
// is a common unit across models. The link to the real percentage is learned, not assumed: each time the quota answer
// (api/oauth/usage, read by usage.ts) changes, the week's estimated dollars are divided by its percent ($ per 1 %).
// Read-only: nothing here throttles anything.

import fs from 'node:fs'
import path from 'node:path'
import type { QuotaInfo, SpendSummary } from '../shared/infra.ts'
import { CLAUDE_DIR, CODEX_DIR, DATA_DIR } from './config.ts'

const HOUR = 3600_000
const WEEK = 7 * 24 * HOUR
const FIVE_H = 5 * HOUR

/** API list prices, $ per million tokens: [input, output, cache read]. Cache writes: 1.25x input (5 min), 2x (1 h). */
const PRICES: [RegExp, [number, number, number]][] = [
  [/fable-5-2|mythos-5-2/, [8, 40, 0.2]],
  [/fable|mythos/, [10, 50, 1]],
  [/opus-5-5/, [4, 20, 0.2]],
  [/opus-4-[01]|opus-3/, [15, 75, 1.5]],
  [/opus/, [5, 25, 0.5]],
  [/sonnet-5/, [2, 10, 0.1]],
  [/sonnet/, [3, 15, 0.3]],
  [/haiku-5/, [0.1, 0.5, 0.01]],
  [/haiku-4/, [1, 5, 0.1]],
  [/haiku/, [0.8, 4, 0.08]],
]
export function priceOf(model: string): [number, number, number] | null {
  for (const [re, p] of PRICES) if (re.test(model)) return p
  return null
}

/** One answer: when, which session, which model, its tokens and its API-price cost in dollars. */
export interface SpendEntry {
  at: number
  sid: string
  model: string
  tokens: number
  cost: number
  tool: 'claude' | 'codex'
}

export function claudeEntry(o: any): (SpendEntry & { key: string }) | null {
  const u = o?.message?.usage
  if (!u || o.type !== 'assistant') return null
  const model = String(o.message?.model ?? '')
  if (!model || model.startsWith('<')) return null
  const at = Date.parse(o.timestamp ?? '')
  if (!Number.isFinite(at)) return null
  const inp = Number(u.input_tokens ?? 0)
  const out = Number(u.output_tokens ?? 0)
  const cw = Number(u.cache_creation_input_tokens ?? 0)
  const cw1h = Math.min(cw, Number(u.cache_creation?.ephemeral_1h_input_tokens ?? 0))
  const cr = Number(u.cache_read_input_tokens ?? 0)
  const p = priceOf(model) ?? [4, 20, 0.2]
  const fast = u.speed === 'fast' ? 2 : 1
  const cost = (fast * (inp * p[0] + out * p[1] + (cw - cw1h) * p[0] * 1.25 + cw1h * p[0] * 2 + cr * p[2])) / 1e6
  const key = `${o.message?.id ?? o.uuid}:${o.requestId ?? ''}`
  return { key, at, sid: String(o.sessionId ?? ''), model, tokens: inp + out + cw + cr, cost, tool: 'claude' }
}

interface FileCache {
  size: number
  offset: number
  entries: SpendEntry[]
  // codex only
  model?: string
  sid?: string
  last?: number
}
const cache = new Map<string, FileCache>()
const seen = new Set<string>()

function listJsonl(dir: string, depth: number, since: number, out: string[]) {
  let es: fs.Dirent[]
  try {
    es = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of es) {
    const p = path.join(dir, e.name)
    if (e.isFile() && e.name.endsWith('.jsonl')) {
      try {
        if (fs.statSync(p).mtimeMs >= since) out.push(p)
      } catch {
        /* gone */
      }
    } else if (e.isDirectory() && depth > 0) listJsonl(p, depth - 1, since, out)
  }
}

function readTail(file: string, c: FileCache, size: number): string[] {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(size - c.offset)
    fs.readSync(fd, buf, 0, buf.length, c.offset)
    const end = buf.lastIndexOf(10)
    if (end < 0) return []
    c.offset += end + 1
    return buf.subarray(0, end).toString('utf8').split('\n')
  } finally {
    fs.closeSync(fd)
  }
}

function scanClaude(file: string, since: number) {
  let size: number
  try {
    size = fs.statSync(file).size
  } catch {
    return
  }
  let c = cache.get(file)
  if (!c || size < c.offset) cache.set(file, (c = { size: 0, offset: 0, entries: [] }))
  if (size === c.offset) return
  for (const line of readTail(file, c, size)) {
    if (!line.includes('"usage"')) continue
    let o: any
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    const e = claudeEntry(o)
    if (!e || e.at < since || seen.has(e.key)) continue
    seen.add(e.key)
    const { key: _k, ...rest } = e
    if (!rest.sid) rest.sid = path.basename(file, '.jsonl')
    c.entries.push(rest)
  }
  c.size = size
}

/** Codex: token counts only (its own quota, not Claude's). Cost left at 0. */
function scanCodex(file: string, since: number) {
  let size: number
  try {
    size = fs.statSync(file).size
  } catch {
    return
  }
  let c = cache.get(file)
  if (!c || size < c.offset) cache.set(file, (c = { size: 0, offset: 0, entries: [] }))
  if (size === c.offset) return
  for (const line of readTail(file, c, size)) {
    if (!line.includes('"token_count"') && !line.includes('"session_meta"') && !line.includes('"turn_context"')) continue
    let o: any
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if (o.type === 'session_meta') c.sid = o.payload?.id ?? c.sid
    if (o.payload?.model) c.model = o.payload.model
    const total = o?.payload?.info?.total_token_usage?.total_tokens
    if (typeof total !== 'number') continue
    const prev = c.last ?? 0
    c.last = total
    const at = Date.parse(o.timestamp ?? '')
    const d = total >= prev ? total - prev : total
    if (!d || !Number.isFinite(at) || at < since) continue
    c.entries.push({ at, sid: c.sid ?? path.basename(file, '.jsonl').slice(-36), model: c.model ?? 'codex', tokens: d, cost: 0, tool: 'codex' })
  }
  c.size = size
}

let lastScan = 0
/** Every answer of the last 8 days, all sessions. Incremental: only the new end of each file is read. */
export function entries(now = Date.now(), dirs = { claude: CLAUDE_DIR, codex: CODEX_DIR }): SpendEntry[] {
  const since = now - WEEK - 12 * HOUR
  if (now - lastScan > 5000) {
    lastScan = now
    const cl: string[] = []
    listJsonl(dirs.claude, 6, since, cl)
    for (const f of cl) scanClaude(f, since)
    const cx: string[] = []
    listJsonl(dirs.codex, 4, since, cx)
    for (const f of cx) scanCodex(f, since)
  }
  const out: SpendEntry[] = []
  for (const c of cache.values()) for (const e of c.entries) if (e.at >= since) out.push(e)
  return out
}
/** Test hook. */
export function resetSpend() {
  cache.clear()
  seen.clear()
  lastScan = 0
}

// ---------------------------------------------------------------- summary

const sum = (es: SpendEntry[], from: number, to: number) => {
  let cost = 0
  let tokens = 0
  for (const e of es) if (e.at >= from && e.at < to) (cost += e.cost), (tokens += e.tokens)
  return { cost, tokens }
}

/** An earlier reading of the same week (from the calibration log): with it, $ per point is the marginal rate since
 *  then, which follows a change of model mix better than the week's average. */
export interface Anchor {
  quotaAt: number
  weekPct: number
}

export function summarize(es: SpendEntry[], q: QuotaInfo | undefined, now = Date.now(), anchor?: Anchor): SpendSummary {
  const claude = es.filter((e) => e.tool === 'claude')
  const codex = es.filter((e) => e.tool === 'codex')
  const wq = q?.ok ? q.windows.find((w) => w.kind === 'week') : undefined
  const sq = q?.ok ? q.windows.find((w) => w.kind === 'session') : undefined
  const weekEnd = wq?.resetsAt && wq.resetsAt > now - HOUR ? wq.resetsAt : now
  const weekStart = weekEnd - WEEK
  const w = sum(claude, weekStart, now + 1)
  const models = new Map<string, { model: string; cost: number; tokens: number }>()
  const sessions = new Map<string, { sid: string; cost: number; tokens: number }>()
  for (const e of claude) {
    if (e.at < weekStart) continue
    const m = models.get(e.model) ?? { model: e.model, cost: 0, tokens: 0 }
    m.cost += e.cost
    m.tokens += e.tokens
    models.set(e.model, m)
    const s = sessions.get(e.sid) ?? { sid: e.sid, cost: 0, tokens: 0 }
    s.cost += e.cost
    s.tokens += e.tokens
    sessions.set(e.sid, s)
  }
  const out: SpendSummary = {
    at: now,
    ...(q?.ok ? { quotaAt: q.at } : {}),
    week: {
      start: weekStart,
      end: weekEnd,
      ...w,
      ...(wq ? { percent: wq.percent } : {}),
      byModel: [...models.values()].sort((a, b) => b.cost - a.cost),
      bySession: [...sessions.values()].sort((a, b) => b.cost - a.cost).slice(0, 30),
    },
    burn: { hour: sum(claude, now - HOUR, now + 1).cost, fiveHours: sum(claude, now - FIVE_H, now + 1).cost / 5 },
    perPercent: null,
    codexTokens: { week: sum(codex, weekStart, now + 1).tokens, hour: sum(codex, now - HOUR, now + 1).tokens },
  }
  if (sq?.resetsAt) {
    const start = sq.resetsAt - FIVE_H
    out.session = { start, end: sq.resetsAt, ...sum(claude, start, now + 1), percent: sq.percent }
  }
  if (wq && q) {
    // Spend up to the quota reading, over its percent. Under 3 % the integer rounding dominates.
    const upTo = sum(claude, weekStart, q.at).cost
    if (wq.percent >= 3 && upTo > 0) out.perPercent = upTo / wq.percent
    // Marginal: only once the percent has moved enough (5 points) for the integer rounding to matter little.
    if (anchor && anchor.quotaAt >= weekStart && anchor.quotaAt < q.at && wq.percent - anchor.weekPct >= 5) {
      const d = sum(claude, anchor.quotaAt, q.at).cost
      if (d > 0) out.perPercent = d / (wq.percent - anchor.weekPct)
    }
    if (out.perPercent) {
      const k = out.perPercent
      out.weekPercentNow = wq.percent + sum(claude, q.at, now + 1).cost / k
      out.pctPerHour = { hour: out.burn.hour / k, fiveHours: out.burn.fiveHours / k }
      const pace = out.pctPerHour.fiveHours
      const left = Math.max(0, 100 - out.weekPercentNow)
      const at = pace > 0 ? now + (left / pace) * HOUR : Infinity
      out.limitAt = at < weekEnd ? at : null
    }
  }
  return out
}

// ---------------------------------------------------------------- calibration log

/** The oldest logged reading of the week that ends at `weekEnd` (null: none yet). */
export function anchorFor(weekEnd: number): Anchor | null {
  try {
    for (const l of fs.readFileSync(CAL_FILE(), 'utf8').split('\n')) {
      if (!l) continue
      const r = JSON.parse(l)
      if (typeof r.weekPct === 'number' && r.weekPct >= 3 && Math.abs(r.weekResets - weekEnd) < HOUR) return { quotaAt: r.quotaAt, weekPct: r.weekPct }
    }
  } catch {
    /* no log yet */
  }
  return null
}

const CAL_FILE = () => process.env.WEEVILS_SPEND_LOG ?? path.join(DATA_DIR, 'spend-calibration.jsonl')
let lastLogged = 0
/** One line per new quota reading: real percents next to the estimate, for the error margin (scripts/spend-report.ts). */
export function logCalibration(s: SpendSummary, es: SpendEntry[], q: QuotaInfo | undefined) {
  if (!q?.ok || !s.quotaAt || s.quotaAt === lastLogged) return
  try {
    const f = CAL_FILE()
    if (!lastLogged && fs.existsSync(f)) {
      const tail = fs.readFileSync(f, 'utf8').trimEnd().split('\n').pop()
      lastLogged = tail ? (JSON.parse(tail).quotaAt ?? 0) : 0
      if (s.quotaAt === lastLogged) return
    }
    lastLogged = s.quotaAt
    const claude = es.filter((e) => e.tool === 'claude')
    const line = {
      quotaAt: s.quotaAt,
      weekPct: s.week.percent ?? null,
      weekResets: s.week.end,
      weekCost: Math.round(sum(claude, s.week.start, s.quotaAt).cost * 100) / 100,
      sessionPct: s.session?.percent ?? null,
      sessionResets: s.session?.end ?? null,
      sessionCost: s.session ? Math.round(sum(claude, s.session.start, s.quotaAt).cost * 100) / 100 : null,
      models: Object.fromEntries(q.windows.filter((w) => w.kind === 'model').map((w) => [w.label ?? '?', w.percent])),
    }
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.appendFileSync(f, JSON.stringify(line) + '\n')
  } catch {
    /* read-only disk */
  }
}
