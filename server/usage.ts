// Ce qu'il reste d'abonnement, à la source : les mêmes chiffres que /usage dans Claude Code
// (GET api.anthropic.com/api/oauth/usage, jeton OAuth de ~/.claude/.credentials.json) et que /status dans Codex
// (GET chatgpt.com/backend-api/wham/usage, jeton de ~/.codex/auth.json ; repli : les rate_limits du dernier rollout).
// Les jetons sont lus, jamais rafraîchis ici : Claude Code et Codex s'en chargent (un refresh concurrent les déconnecterait).
// Plus la consommation du jour par session, lue dans les transcripts (la part de chacun, pas le quota).

import fs from 'node:fs'
import path from 'node:path'
import type { QuotaInfo, QuotaWindow, TokenRate, UsageModel, UsageRow } from '../shared/infra.ts'
import { CLAUDE_DIR, CODEX_DIR, DATA_DIR, HOME, MACHINE, ORCH_DIR, PROJECT_ROOTS } from './config.ts'
import { claudeOauth, forgetClaudeOauth } from './claude-credentials.ts'
import { tr } from './i18n.ts'
import M from './i18n/infra.ts'

const CODEX_HOME = process.env.CODEX_HOME ?? path.join(HOME, '.codex')

const readJson = (f: string): any => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch {
    return null
  }
}
const time = (v: unknown): number | null => {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : null
  }
  return null
}

// ---------------------------------------------------------------- Claude

function claudePlan(o: any): string | undefined {
  const tier = String(o?.rateLimitTier ?? '')
  const x = /(\d+)x$/.exec(tier)?.[1]
  const sub = String(o?.subscriptionType ?? '')
  return sub ? `${sub[0].toUpperCase()}${sub.slice(1)}${x ? ` ${x}x` : ''}` : undefined
}

/** La réponse de /api/oauth/usage, réduite aux fenêtres qu'affiche /usage. */
export function claudeWindows(d: any): QuotaWindow[] {
  const out: QuotaWindow[] = []
  const add = (w: QuotaWindow) => {
    if (!out.some((x) => x.kind === w.kind && x.label === w.label)) out.push(w)
  }
  if (d?.five_hour) add({ kind: 'session', percent: Math.round(Number(d.five_hour.utilization ?? 0)), resetsAt: time(d.five_hour.resets_at) })
  for (const l of Array.isArray(d?.limits) ? d.limits : []) {
    const kind = String(l?.kind ?? '')
    const pct = Math.round(Number(l?.percent ?? 0))
    const resetsAt = time(l?.resets_at)
    if (/five|session|hour/.test(kind) || l?.group === 'session') add({ kind: 'session', percent: pct, resetsAt })
    else if (kind === 'weekly_all') add({ kind: 'week', percent: pct, resetsAt })
    else if (kind === 'weekly_scoped') add({ kind: 'model', label: String(l?.scope?.model?.display_name ?? l?.scope?.model?.id ?? '') || undefined, percent: pct, resetsAt })
  }
  if (d?.seven_day) add({ kind: 'week', percent: Math.round(Number(d.seven_day.utilization ?? 0)), resetsAt: time(d.seven_day.resets_at) })
  for (const [k, label] of [['seven_day_opus', 'Opus'], ['seven_day_sonnet', 'Sonnet']] as const)
    if (d?.[k] && !out.some((w) => w.kind === 'model')) add({ kind: 'model', label, percent: Math.round(Number(d[k].utilization ?? 0)), resetsAt: time(d[k].resets_at) })
  const order = { session: 0, week: 1, model: 2 }
  return out.sort((a, b) => order[a.kind] - order[b.kind])
}

/** Claude refuses /api/oauth/usage with 429 as soon as it is asked too often: one call shared by every view and device,
 *  at most every 5 min, an exponential back-off after a failure (Retry-After honoured), and the last valid answer kept
 *  on disk so the page always shows figures, with their age (`at`), even right after a restart or during a 429. */
export const QUOTA_MIN_MS = 5 * 60_000
const QUOTA_MAX_BACKOFF_MS = 60 * 60_000
const QUOTA_FILE = () => process.env.WEEVILS_QUOTA_CACHE ?? path.join(DATA_DIR, 'quota-cache.json')

class RetryAfter extends Error {
  ms: number
  constructor(message: string, ms: number) {
    super(message)
    this.ms = ms
  }
}
const httpError = (res: Response) => {
  const v = res.headers.get('retry-after')
  const n = Number(v)
  const ms = !v ? 0 : Number.isFinite(n) ? n * 1000 : Math.max(0, (Date.parse(v) || 0) - Date.now())
  return ms > 0 ? new RetryAfter(`HTTP ${res.status}`, ms) : new Error(`HTTP ${res.status}`)
}

/** Wait before the next try after `fails` failures in a row: 5, 10, 20, 40 min, at most 1 h, never under Retry-After. */
export function quotaBackoff(fails: number, retryAfterMs = 0): number {
  return Math.max(Math.min(retryAfterMs, QUOTA_MAX_BACKOFF_MS), Math.min(QUOTA_MAX_BACKOFF_MS, QUOTA_MIN_MS * 2 ** Math.max(0, fails - 1)))
}

type Provider = 'claude' | 'codex'
interface Slot {
  /** The last valid answer (persisted). */
  good: QuotaInfo | null
  /** The last failure, when it came after `good`. */
  error?: string
  nextAt: number
  failures: number
  inflight: Promise<void> | null
}
const slots = new Map<Provider, Slot>()
function slot(p: Provider): Slot {
  let s = slots.get(p)
  if (!s) {
    // usage-claude.json: the Claude-only file of the previous version (0d83cd6), read once if nothing newer.
    const saved = readJson(QUOTA_FILE())?.[p] ?? (p === 'claude' ? { ok: true, ...readJson(path.join(DATA_DIR, 'usage-claude.json')) } : null)
    const good = saved?.ok && Array.isArray(saved.windows) && typeof saved.at === 'number' ? (saved as QuotaInfo) : null
    // After a restart, wait out the rest of the 5 min of the saved answer instead of asking again at once.
    s = { good, nextAt: good ? good.at + QUOTA_MIN_MS : 0, failures: 0, inflight: null }
    slots.set(p, s)
  }
  return s
}
function persist() {
  const out: Record<string, QuotaInfo> = {}
  for (const [p, s] of slots) if (s.good) out[p] = s.good
  try {
    fs.mkdirSync(path.dirname(QUOTA_FILE()), { recursive: true })
    const tmp = `${QUOTA_FILE()}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(out))
    fs.renameSync(tmp, QUOTA_FILE())
  } catch {
    /* read-only disk: the memory copy still serves */
  }
}
/** Test hook: forget the memory copy (the disk one is read again). */
export function resetQuotaSlots() {
  slots.clear()
}

async function shared(p: Provider, get: () => Promise<QuotaInfo>, fallback: (error: string) => QuotaInfo): Promise<QuotaInfo> {
  const s = slot(p)
  const now = Date.now()
  if (now >= s.nextAt && !s.inflight) {
    s.inflight = (async () => {
      try {
        const next = await get()
        // An answer that parses to no window at all (a changed shape, a hiccup) never erases the last good figures.
        if (!next.windows.length && s.good?.windows.length) throw new Error(tr(M).emptyAnswer)
        s.good = next
        s.error = undefined
        s.failures = 0
        s.nextAt = Date.now() + QUOTA_MIN_MS
        persist()
      } catch (e) {
        s.failures++
        s.error = (e as Error).message
        const wait = quotaBackoff(s.failures, e instanceof RetryAfter ? e.ms : 0)
        s.nextAt = Date.now() + wait
        console.error(`[usage] ${p}: ${s.error} · next try in ${Math.round(wait / 60_000)} min`)
      } finally {
        s.inflight = null
      }
    })()
  }
  // Only the very first call (nothing known yet) waits for the answer; the others get the last figures at once.
  if (s.inflight && !s.good) await s.inflight
  // Stale: the last read failed, or the figures are older than one period (the UI then shows their age).
  if (s.good) return s.error || Date.now() - s.good.at > QUOTA_MIN_MS + 60_000 ? { ...s.good, stale: true, ...(s.error ? { error: s.error } : {}) } : s.good
  return fallback(s.error ?? tr(M).unavailable)
}

export async function claudeQuota(): Promise<QuotaInfo> {
  // Simulation (tests of the Codex relay on a throwaway server): a file shaped like the API's answer.
  const fake = process.env.WEEVILS_FAKE_CLAUDE_USAGE
  if (fake) {
    const d = readJson(fake)
    const now = Date.now()
    return d ? { ok: true, plan: 'fake', windows: claudeWindows(d), source: fake, at: now } : { ok: false, windows: [], source: fake, at: now, error: tr(M).noToken }
  }
  const source = 'api.anthropic.com/api/oauth/usage'
  return shared(
    'claude',
    async () => {
      // The credentials file, or on a Mac the Keychain (asked a few times an hour at most, see claude-credentials.ts).
      const o = await claudeOauth()
      if (!o?.accessToken) throw new Error(tr(M).noToken)
      const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
        headers: { authorization: `Bearer ${o.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'user-agent': 'weevils' },
        signal: AbortSignal.timeout(8000),
      })
      if (res.status === 401) {
        forgetClaudeOauth()
        throw new Error(tr(M).expired)
      }
      if (!res.ok) throw httpError(res)
      return { ok: true, plan: claudePlan(o), windows: claudeWindows(await res.json()), source, at: Date.now() }
    },
    (error) => ({ ok: false, windows: [], source, at: Date.now(), error }),
  )
}

// ---------------------------------------------------------------- Codex

const codexKind = (seconds: number): QuotaWindow['kind'] => (seconds <= 6 * 3600 ? 'session' : 'week')

export function codexWindows(rl: any): QuotaWindow[] {
  const out: QuotaWindow[] = []
  for (const w of [rl?.primary_window, rl?.secondary_window]) {
    if (!w) continue
    out.push({ kind: codexKind(Number(w.limit_window_seconds ?? 0)), percent: Math.round(Number(w.used_percent ?? 0)), resetsAt: time(w.reset_at) ?? (w.reset_after_seconds != null ? Date.now() + Number(w.reset_after_seconds) * 1000 : null) })
  }
  return out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'session' ? -1 : 1))
}

/** Repli : les rate_limits que Codex écrit dans ses rollouts (en-têtes de la dernière réponse). */
function codexFromRollout(): { windows: QuotaWindow[]; plan?: string; at: number } | null {
  let best: { f: string; m: number } | null = null
  const walk = (dir: string, depth: number) => {
    let es: fs.Dirent[]
    try {
      es = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    // Les dossiers sont datés (AAAA/MM/JJ) : seul le plus récent de chaque niveau compte.
    const dirs = es.filter((e) => e.isDirectory()).map((e) => e.name).sort().slice(-2)
    for (const e of es) if (e.isFile() && e.name.endsWith('.jsonl')) {
      const m = fs.statSync(path.join(dir, e.name)).mtimeMs
      if (!best || m > best.m) best = { f: path.join(dir, e.name), m }
    }
    if (depth < 3) for (const d of dirs) walk(path.join(dir, d), depth + 1)
  }
  walk(CODEX_DIR, 0)
  if (!best) return null
  const { f } = best as { f: string; m: number }
  const lines = fs.readFileSync(f, 'utf8').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"rate_limits"')) continue
    try {
      const event = JSON.parse(lines[i])
      const rl = event?.payload?.rate_limits
      if (!rl) continue
      const windows = [rl.primary, rl.secondary]
        .filter(Boolean)
        .map((w: any) => ({ kind: codexKind(Number(w.window_minutes ?? 0) * 60), percent: Math.round(Number(w.used_percent ?? 0)), resetsAt: time(w.resets_at) }) as QuotaWindow)
      return { windows, plan: rl.plan_type ?? undefined, at: time(event.timestamp) ?? 0 }
    } catch {
      /* ligne coupée */
    }
  }
  return null
}

export async function codexQuota(): Promise<QuotaInfo> {
  const q = await shared(
    'codex',
    async () => {
      const t = readJson(path.join(CODEX_HOME, 'auth.json'))?.tokens
      if (!t?.access_token) throw new Error(tr(M).noToken)
      const res = await fetch('https://chatgpt.com/backend-api/wham/usage', {
        headers: { authorization: `Bearer ${t.access_token}`, 'chatgpt-account-id': String(t.account_id ?? ''), 'user-agent': 'weevils', originator: 'codex_cli_rs' },
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) throw httpError(res)
      const d = (await res.json()) as any
      return { ok: true, plan: d?.plan_type, windows: codexWindows(d?.rate_limit), source: 'chatgpt.com/backend-api/wham/usage', at: Date.now() }
    },
    (error) => ({ ok: false, windows: [], source: 'codex', at: Date.now(), error }),
  )
  // While the API fails, the rate_limits Codex writes in its rollouts may be newer than the last valid answer.
  if (q.ok && !q.error) return q
  const r = codexFromRollout()
  return r && (!q.ok || r.at > q.at) ? { ok: true, plan: r.plan ?? q.plan, windows: r.windows, source: 'codex rollout rate_limits', at: r.at, ...(Date.now() - r.at > QUOTA_MIN_MS + 60_000 ? { stale: true } : {}) } : q
}

export async function quotas() {
  const [claude, codex] = await Promise.all([claudeQuota(), codexQuota()])
  return { claude, codex }
}

// ---------------------------------------------------------------- consommation du jour

interface Agg {
  tool: 'claude' | 'codex'
  cwd: string
  weight: number
  tokens: number
  last: number
}
interface FileState {
  cumulative?: { tokens: number; weight: number }
  hasUsage?: boolean
  offset: number
  seen: Set<string>
  agg: Map<string, Agg>
  /** Par modèle : clé « outil:modèle ». */
  models: Map<string, UsageModel>
  /** Les réponses des dernières minutes : [heure, tokens], pour le débit en direct. */
  recent: [number, number][]
  sid?: string
  cwd?: string
  model?: string
}

const RATE_SPAN = 10 * 60_000
const RATE_STEP = 15_000

let dayStart = 0
let files = new Map<string, FileState>()

const modelFactor = (m: string) => (/haiku/i.test(m) ? 1 / 3 : /opus|fable/i.test(m) ? 5 / 3 : 1)

/** Ce qu'une ligne de transcript a consommé : jetons, poids (≈ coût relatif), modèle, et l'id du message (claude : une
 *  réponse est écrite sur plusieurs lignes avec le même usage, à ne compter qu'une fois). null : pas une ligne d'usage. */
export interface LineUsage {
  cumulative?: boolean
  id?: string
  at: number
  tokens: number
  weight: number
  model?: string
  sid?: string
  cwd?: string
}
export function usageOfLine(o: any, tool: 'claude' | 'codex'): LineUsage | null {
  const at = time(o?.timestamp) ?? 0
  if (tool === 'claude') {
    const u = o?.message?.usage
    if (!u || o.type !== 'assistant') return null
    const inp = Number(u.input_tokens ?? 0)
    const out = Number(u.output_tokens ?? 0)
    const cw = Number(u.cache_creation_input_tokens ?? 0)
    const cr = Number(u.cache_read_input_tokens ?? 0)
    const model = String(o.message?.model ?? '')
    return {
      id: o.message?.id ?? o.uuid,
      at,
      tokens: inp + out + cw + cr,
      weight: (inp + 5 * out + 1.25 * cw + 0.1 * cr) * modelFactor(model),
      model,
      ...(o.sessionId ? { sid: String(o.sessionId) } : {}),
      cwd: String(o.cwd ?? ''),
    }
  }
  const cumulative = o?.payload?.info?.total_token_usage
  const u = cumulative ?? o?.payload?.info?.last_token_usage
  if (!u) return null
  const inp = Number(u.input_tokens ?? 0)
  const cached = Number(u.cached_input_tokens ?? 0)
  const out = Number(u.output_tokens ?? 0)
  return { at, cumulative: !!cumulative, tokens: Number(u.total_tokens ?? inp + out), weight: inp - cached + 0.1 * cached + 5 * out }
}

/** Cumulative Codex snapshots are watermarks, not additional calls. */
function increment(u: LineUsage, state: { cumulative?: { tokens: number; weight: number } }): LineUsage {
  if (!u.cumulative) return u
  const prev = state.cumulative
  state.cumulative = { tokens: u.tokens, weight: u.weight }
  if (!prev || u.tokens < prev.tokens) return u // a resumed counter can start a new epoch
  return { ...u, tokens: u.tokens - prev.tokens, weight: Math.max(0, u.weight - prev.weight) }
}

function scan(file: string, tool: 'claude' | 'codex') {
  let st: fs.Stats
  try {
    st = fs.statSync(file)
  } catch {
    return
  }
  if (st.mtimeMs < dayStart) return
  const previous = files.get(file)
  const s: FileState = previous && previous.offset <= st.size ? previous : { offset: 0, seen: new Set(), agg: new Map(), models: new Map(), recent: [] }
  files.set(file, s)
  if (st.size <= s.offset) return
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.alloc(st.size - s.offset)
  fs.readSync(fd, buf, 0, buf.length, s.offset)
  fs.closeSync(fd)
  const text = buf.toString('utf8')
  const end = text.lastIndexOf('\n')
  if (end < 0) return
  s.offset += Buffer.byteLength(text.slice(0, end + 1))
  for (const line of text.slice(0, end).split('\n')) {
    if (tool === 'codex' && (line.includes('"session_meta"') || line.includes('"turn_context"'))) {
      try {
        const o = JSON.parse(line)
        const p = o.payload
        if (o.type === 'session_meta') {
          s.sid = p?.id ?? s.sid
          s.cwd = p?.cwd ?? s.cwd
        }
        s.model = p?.model ?? s.model
      } catch {
        /* ignorée */
      }
      continue
    }
    if (tool === 'claude' ? !line.includes('"usage"') : !line.includes('"token_count"')) continue
    let o: any
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    const raw = usageOfLine(o, tool)
    if (!raw) continue
    s.hasUsage = true
    const u = increment(raw, s)
    if (u.at < dayStart) continue
    if (u.id !== undefined) {
      if (s.seen.has(u.id)) continue
      s.seen.add(u.id)
    }
    const { at, tokens, weight } = u
    const sid = tool === 'claude' ? (u.sid ?? path.basename(file, '.jsonl')) : (s.sid ?? path.basename(file, '.jsonl').slice(-36))
    const cwd = tool === 'claude' ? (u.cwd ?? '') : (s.cwd ?? '')
    const model = tool === 'claude' ? (u.model ?? '') : (s.model ?? '')
    const a = s.agg.get(sid) ?? { tool, cwd, weight: 0, tokens: 0, last: 0 }
    a.weight += weight
    a.tokens += tokens
    a.last = Math.max(a.last, at)
    if (cwd) a.cwd = cwd
    s.agg.set(sid, a)
    if (at > Date.now() - RATE_SPAN) s.recent.push([at, tokens])
    if (model && !model.startsWith('<')) {
      const k = `${tool}:${model}`
      const m = s.models.get(k) ?? { tool, model, machine: MACHINE.id, weight: 0, tokens: 0 }
      m.weight += weight
      m.tokens += tokens
      s.models.set(k, m)
    }
  }
}

/** Jetons d'une session entière (tous les jours), lus dans son transcript : une tâche auto, un passage. Incrémental
 *  (relit seulement la fin depuis le dernier appel) ; 0 sans fichier lisible. */
const totals = new Map<string, { offset: number; seen: Set<string>; tokens: number; cumulative?: { tokens: number; weight: number } }>()
export function sessionTokens(file: string, tool: 'claude' | 'codex' = 'claude'): number {
  let size: number
  try {
    size = fs.statSync(file).size
  } catch {
    return 0
  }
  let s = totals.get(file)
  if (!s || size < s.offset) totals.set(file, (s = { offset: 0, seen: new Set(), tokens: 0 }))
  if (size > s.offset) {
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(size - s.offset)
    fs.readSync(fd, buf, 0, buf.length, s.offset)
    fs.closeSync(fd)
    const text = buf.toString('utf8')
    const end = text.lastIndexOf('\n')
    if (end >= 0) {
      s.offset += Buffer.byteLength(text.slice(0, end + 1))
      for (const line of text.slice(0, end).split('\n')) {
        if (tool === 'claude' ? !line.includes('"usage"') : !line.includes('"token_count"')) continue
        let o: any
        try {
          o = JSON.parse(line)
        } catch {
          continue
        }
        const raw = usageOfLine(o, tool)
        if (!raw) continue
        const u = increment(raw, s)
        if (u.id !== undefined) {
          if (s.seen.has(u.id)) continue
          s.seen.add(u.id)
        }
        s.tokens += u.tokens
      }
    }
  }
  if (totals.size > 64) for (const k of [...totals.keys()].slice(0, totals.size - 64)) if (k !== file) totals.delete(k)
  return s.tokens
}

function listJsonl(dir: string, depth: number, out: string[]) {
  let es: fs.Dirent[]
  try {
    es = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of es) {
    const p = path.join(dir, e.name)
    if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p)
    else if (e.isDirectory() && depth > 0) {
      // Appending a rollout does not update its parent year/month directory mtime.
      // Visit parents; scan() filters files by their own mtime.
      try {
        listJsonl(p, depth - 1, out)
      } catch {
        /* disparu */
      }
    }
  }
}

/** Repo d'un dossier de travail : le premier dossier sous une racine de projets. */
const repoOf = (cwd: string) => {
  if (cwd === ORCH_DIR || cwd.startsWith(ORCH_DIR + path.sep)) return 'weevboss'
  for (const root of PROJECT_ROOTS) if (cwd.startsWith(root + path.sep)) return cwd.slice(root.length + 1).split(path.sep)[0]
  return path.basename(cwd) || '?'
}

let lastRefresh = 0
/** Relit la fin des transcripts du jour (incrémental), au plus une fois toutes les 2 s. */
function refresh() {
  const now = Date.now()
  if (now - lastRefresh < 2000) return
  lastRefresh = now
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  if (d.getTime() !== dayStart) {
    dayStart = d.getTime()
    files = new Map()
  }
  const claude: string[] = []
  listJsonl(CLAUDE_DIR, 6, claude) // subagents/workflows/wf_*/agent-*.jsonl sit 5 levels down
  for (const f of claude) scan(f, 'claude')
  const codex: string[] = []
  listJsonl(CODEX_DIR, 3, codex)
  for (const f of codex) scan(f, 'codex')
  for (const s of files.values()) if (s.recent.length && s.recent[0][0] < now - RATE_SPAN) s.recent = s.recent.filter(([at]) => at >= now - RATE_SPAN)
}

/** Le débit en direct, toutes sessions de cette machine : tokens par tranche de 15 s sur les 10 dernières minutes. */
export function rate(): TokenRate {
  refresh()
  const end = Math.floor(Date.now() / RATE_STEP) * RATE_STEP + RATE_STEP
  const buckets = new Array<number>(RATE_SPAN / RATE_STEP).fill(0)
  for (const s of files.values())
    for (const [at, tokens] of s.recent) {
      const i = buckets.length - 1 - Math.floor((end - 1 - at) / RATE_STEP)
      if (i >= 0 && i < buckets.length) buckets[i] += tokens
    }
  return { step: RATE_STEP, end, buckets, available: [...files.values()].some((s) => s.hasUsage) }
}

export function today(lookup: (id: string) => { title: string; projectId: string } | undefined): { rows: UsageRow[]; models: UsageModel[] } {
  lastRefresh = 0
  refresh()
  const by = new Map<string, Agg>()
  for (const s of files.values())
    for (const [sid, a] of s.agg) {
      const cur = by.get(sid)
      if (!cur) by.set(sid, { ...a })
      else {
        cur.weight += a.weight
        cur.tokens += a.tokens
        cur.last = Math.max(cur.last, a.last)
      }
    }
  const models = new Map<string, UsageModel>()
  for (const s of files.values())
    for (const [k, m] of s.models) {
      const cur = models.get(k)
      if (!cur) models.set(k, { ...m })
      else {
        cur.weight += m.weight
        cur.tokens += m.tokens
      }
    }
  const rows = [...by]
    .map(([id, a]) => {
      const known = lookup(id)
      const repo = repoOf(a.cwd)
      return { id, title: known?.title ?? repo, projectId: known?.projectId ?? repo, tool: a.tool, machine: MACHINE.id, weight: Math.round(a.weight), tokens: a.tokens, last: a.last }
    })
    .filter((r) => r.weight > 0)
    .sort((a, b) => b.weight - a.weight)
  return { rows, models: [...models.values()].map((m) => ({ ...m, weight: Math.round(m.weight) })).filter((m) => m.weight > 0) }
}
