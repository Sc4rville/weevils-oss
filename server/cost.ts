// The cost optimiser: a built-in automation of the auto page (server/optimizers.ts, `builtin: 'cost'`), every 30 min,
// that lowers what the agents spend without lowering what they deliver. It runs inside weevilsd, without any model:
// measuring and deciding cost nothing.
//
// What it measures, from the transcripts (~/.claude/projects, read incrementally) and the ledger of weevilsd's own calls
// (server/cost-ledger.ts): tokens per session, per subagent, per auto task, per internal caller, per hour and per day.
//
// What it does alone, only when it is safe:
// - /compact on a session at rest (its turn over, nothing in the background, nothing queued, quiet for IDLE_MS but
//   active in the last ACTIVE_MS: it is likely to be resumed) whose context passed COMPACT_AT tokens. weevboss too.
//   Every turn re-reads the whole context: compacting a 400 k session divides its next turns by ten.
// - stops the background loops Claude Code left behind (a Bash tool call that only waits — while/until + sleep, no
//   child but sleep, nothing launched to outlive it — whose claude process is gone): nobody can read them any more.
// - weevilsd's own calls: an identical request is answered from the cache (fast.ts), and small generations never run
//   on Opus or Fable (fast.ts smartModel).
// What it proposes, never applies (a « for you » card with a button): a lighter model for a session whose task is
// simple, stopping a session that goes round in circles, merging two sessions that do the same thing.
// What it never does: touch a session that is working, waiting for the user or running something in the background
// (a delivery in progress), or call Codex.
//
// Each run that gained something posts one line in « for you », with the week's trend as bars.

import fs from 'node:fs'
import path from 'node:path'
import type { Optimizer, Snapshot } from '../shared/api.ts'
import type { ForYouGauge } from '../shared/foryou.ts'
import { CLAUDE_DIR, DATA_DIR, MACHINE } from './config.ts'
import type { Ledger } from './cost-ledger.ts'
import type { NewItem } from './foryou.ts'
import { tr } from './i18n.ts'
import C from './i18n/cost.ts'

export const RUN_EVERY_MS = 30 * 60_000
/** A session's context past this is compacted when it rests. */
export const COMPACT_AT = 150_000
/** At rest for this long (its turn over)… */
export const IDLE_MS = 20 * 60_000
/** …but active within this window: likely to be resumed (an abandoned session costs nothing, compacting it would). */
export const ACTIVE_MS = 6 * 3600_000
/** Never compacted twice within this window unless it worked again in between. */
export const COMPACT_AGAIN_MS = 3 * 3600_000
/** At most this many compactions per run (each one is a turn of its own). */
export const MAX_COMPACT = 3
/** A background loop this young may still be read by a claude process that is restarting: left alone. */
export const ORPHAN_MIN_AGE_MS = 10 * 60_000
/** A proposal comes back no sooner than this. */
export const PROPOSE_AGAIN_MS = 12 * 3600_000
/** The recent turns read to judge a session (simple task, circles). */
const RECENT = 40
const DAY_MS = 86400_000
const KEEP_DAYS = 8

// ---------------------------------------------------------------- reading the transcripts

export interface Turn {
  at: number
  out: number
  ctx: number
  tools: string[]
  /** Bash commands of the turn, normalised (numbers and quotes blurred) to notice repeats. */
  cmds: string[]
}

/** One transcript (a session or one of its subagents), read incrementally. */
export interface FileAgg {
  offset: number
  sid: string
  /** Subagent id (agent-…), when the file is a subagent's. */
  agent?: string
  seen: Set<string>
  /** day key → tokens, weight, turns, sum of contexts (for the average). */
  days: Record<string, { tokens: number; weight: number; turns: number; ctx: number }>
  /** hour start (ms) → tokens, the last 48 h. */
  hours: Record<number, number>
  lastCtx: number
  lastAt: number
  model: string
  cwd: string
  compacts: number
  recent: Turn[]
}

const modelFactor = (m: string) => (/haiku/i.test(m) ? 1 / 3 : /opus|fable/i.test(m) ? 5 / 3 : 1)
export const dayKey = (at: number) => {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
/** A Bash command reduced to its shape: the same poll with another number reads the same. */
export const shape = (cmd: string) => cmd.replace(/\s+/g, ' ').replace(/\d+/g, 'N').replace(/(["']).*?\1/g, 'S').trim().slice(0, 120)

/** Reads the lines of a transcript into its aggregate (pure: tests feed it lines). */
export function absorb(a: FileAgg, lines: string[], since: number) {
  for (const line of lines) {
    if (line.includes('"compact_boundary"')) a.compacts++
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue
    let o: any
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    const m = o?.message
    const u = m?.usage
    if (o?.type !== 'assistant' || !u) continue
    const at = Date.parse(o.timestamp ?? '') || 0
    const id = String(m.id ?? o.uuid ?? '')
    const tools: string[] = []
    const cmds: string[] = []
    for (const c of Array.isArray(m.content) ? m.content : [])
      if (c?.type === 'tool_use') {
        tools.push(String(c.name ?? ''))
        if (c.name === 'Bash' && typeof c.input?.command === 'string') cmds.push(shape(c.input.command))
      }
    // A reply is written over several lines with the same usage: counted once, its tools gathered on the same turn.
    const last = a.recent.at(-1)
    if (id && a.seen.has(id)) {
      if (last && last.at === at) {
        last.tools.push(...tools)
        last.cmds.push(...cmds)
      }
      continue
    }
    if (id) a.seen.add(id)
    if (at < since) continue
    const inp = Number(u.input_tokens ?? 0)
    const out = Number(u.output_tokens ?? 0)
    const cw = Number(u.cache_creation_input_tokens ?? 0)
    const cr = Number(u.cache_read_input_tokens ?? 0)
    const ctx = inp + cw + cr
    const model = String(m.model ?? '')
    if (model && !model.startsWith('<')) a.model = model
    if (o.cwd) a.cwd = String(o.cwd)
    const d = (a.days[dayKey(at)] ??= { tokens: 0, weight: 0, turns: 0, ctx: 0 })
    d.tokens += ctx + out
    d.weight += (inp + 5 * out + 1.25 * cw + 0.1 * cr) * modelFactor(model)
    d.turns++
    d.ctx += ctx
    const h = Math.floor(at / 3600_000) * 3600_000
    a.hours[h] = (a.hours[h] ?? 0) + ctx + out
    a.lastCtx = ctx
    a.lastAt = Math.max(a.lastAt, at)
    a.recent.push({ at, out, ctx, tools, cmds })
    if (a.recent.length > RECENT) a.recent.shift()
  }
}

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

/** Every transcript of the last days, read incrementally, in chunks that leave the event loop breathe. */
export class TranscriptScan {
  files = new Map<string, FileAgg>()
  private root: string
  constructor(root = CLAUDE_DIR) {
    this.root = root
  }

  async refresh(now = Date.now()) {
    const since = now - (KEEP_DAYS - 1) * DAY_MS
    const list: string[] = []
    listJsonl(this.root, 3, since, list)
    for (const f of list) await this.read(f, since)
    const oldHour = now - 48 * 3600_000
    for (const [f, a] of this.files) {
      if (a.lastAt && a.lastAt < since) this.files.delete(f)
      for (const h of Object.keys(a.hours)) if (Number(h) < oldHour) delete a.hours[Number(h)]
    }
  }

  private async read(file: string, since: number) {
    let size: number
    try {
      size = fs.statSync(file).size
    } catch {
      return
    }
    let a = this.files.get(file)
    if (!a || size < a.offset) {
      const base = path.basename(file, '.jsonl')
      const sub = path.basename(path.dirname(file)) === 'subagents'
      a = { offset: 0, sid: sub ? path.basename(path.dirname(path.dirname(file))) : base, ...(sub ? { agent: base } : {}), seen: new Set(), days: {}, hours: {}, lastCtx: 0, lastAt: 0, model: '', cwd: '', compacts: 0, recent: [] }
      this.files.set(file, a)
    }
    if (size <= a.offset) return
    const fh = await fs.promises.open(file, 'r')
    try {
      const CHUNK = 4 << 20
      let rest = ''
      while (a.offset < size) {
        const len = Math.min(CHUNK, size - a.offset)
        const buf = Buffer.alloc(len)
        const { bytesRead } = await fh.read(buf, 0, len, a.offset)
        if (!bytesRead) break
        const text = rest + buf.subarray(0, bytesRead).toString('utf8')
        const end = text.lastIndexOf('\n')
        if (end < 0) {
          // A single line longer than a chunk (a big tool result): read on.
          rest = text
          a.offset += bytesRead
          continue
        }
        absorb(a, text.slice(0, end).split('\n'), since)
        rest = text.slice(end + 1)
        a.offset += bytesRead
        await new Promise((r) => setImmediate(r))
      }
      // The unfinished last line is read again next time.
      a.offset -= Buffer.byteLength(rest)
    } finally {
      await fh.close()
    }
  }

  /** The session's own transcript (not a subagent's). */
  main(sid: string): FileAgg | undefined {
    for (const a of this.files.values()) if (a.sid === sid && !a.agent) return a
    return undefined
  }
  subagents(sid: string): FileAgg[] {
    return [...this.files.values()].filter((a) => a.sid === sid && !!a.agent)
  }
  /** Tokens per day, every transcript. */
  daily(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const a of this.files.values()) for (const [d, v] of Object.entries(a.days)) out[d] = (out[d] ?? 0) + v.tokens
    return out
  }
  /** Tokens in [from, to). */
  between(from: number, to: number): number {
    let n = 0
    for (const a of this.files.values()) for (const [h, v] of Object.entries(a.hours)) if (Number(h) >= from && Number(h) < to) n += v
    return n
  }
}

// ---------------------------------------------------------------- judging sessions (pure)

/** A turn changes files: Edit, Write, NotebookEdit. */
const WRITES = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])
const POLL = /\bsleep\b|\buntil\b|ScheduleWakeup|Monitor/

/** The task looks simple: no file written, short answers, mostly reads — on a heavy model. */
export function simpleTask(a: Pick<FileAgg, 'model' | 'recent'>): boolean {
  if (!/opus|fable/i.test(a.model)) return false
  const r = a.recent.slice(-30)
  if (r.length < 15) return false
  if (r.some((t) => t.tools.some((x) => WRITES.has(x) || x === 'Agent' || x === 'Task'))) return false
  const outs = r.map((t) => t.out).sort((x, y) => x - y)
  return outs[Math.floor(outs.length / 2)] < 400
}

/** Going round in circles: in the last hour, the same command shape again and again (or poll after poll), nothing written. */
export function circles(a: Pick<FileAgg, 'recent'>, now: number): { times: number } | null {
  const r = a.recent.filter((t) => t.at > now - 3600_000)
  if (r.length < 12) return null
  if (r.some((t) => t.tools.some((x) => WRITES.has(x)))) return null
  const counts = new Map<string, number>()
  let polls = 0
  for (const t of r) {
    for (const c of t.cmds) counts.set(c, (counts.get(c) ?? 0) + 1)
    if (t.cmds.some((c) => POLL.test(c)) || t.tools.some((x) => POLL.test(x))) polls++
  }
  const top = Math.max(0, ...counts.values())
  if (top >= 8) return { times: top }
  if (polls >= 12) return { times: polls }
  return null
}

const words = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3))
/** Two titles that say the same thing (word overlap). */
export function sameTask(a: string, b: string): boolean {
  const x = words(a)
  const y = words(b)
  if (x.size < 2 || y.size < 2) return false
  let common = 0
  for (const w of x) if (y.has(w)) common++
  return common / (x.size + y.size - common) >= 0.6
}

/**
 * A Claude Code Bash call left behind that only waits: its command line is Claude's shell snapshot running a
 * while/until loop around sleep. Anything that launches work meant to outlive it (nohup, setsid, disown, a job sent to
 * the background with &) is never one: a render watcher started that way must keep running.
 */
export function isLoopCommand(cmdline: string): boolean {
  if (!cmdline.includes('/shell-snapshots/')) return false
  const at = cmdline.indexOf("eval '")
  if (at < 0) return false
  const body = cmdline.slice(at + 6, cmdline.lastIndexOf("'") > at + 6 ? cmdline.lastIndexOf("'") : undefined)
  if (/\b(nohup|setsid|disown|screen|tmux|zellij)\b/.test(body) || /[^&>|]&(?![&>])/.test(body)) return false
  return /\b(while|until)\b/.test(body) && /\bsleep\b/.test(body)
}

export const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)} M` : n >= 1e3 ? `${Math.round(n / 1e3)} k` : String(Math.round(n)))

// ---------------------------------------------------------------- processes

export interface Proc {
  pid: number
  ppid: number
  comm: string
  cmdline: string
  startedAt: number
}

/** This user's processes (Linux /proc); empty elsewhere. */
export function listProcs(): Proc[] {
  const out: Proc[] = []
  let boot = 0
  try {
    boot = Date.now() - Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]) * 1000
  } catch {
    return out
  }
  const tick = 100
  const uid = process.getuid?.()
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      if (uid !== undefined && fs.statSync(`/proc/${name}`).uid !== uid) continue
      const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8')
      const close = stat.lastIndexOf(')')
      const comm = stat.slice(stat.indexOf('(') + 1, close)
      const f = stat.slice(close + 2).split(' ')
      const cmdline = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8').replace(/\0/g, ' ').trim()
      out.push({ pid: Number(name), ppid: Number(f[1]), comm, cmdline, startedAt: boot + (Number(f[19]) / tick) * 1000 })
    } catch {
      /* gone */
    }
  }
  return out
}

/** The loops to stop: Claude's Bash calls that only wait, whose claude process is gone, old enough, with no child but
 *  sleep (a loop that runs real work between its sleeps is left alone). */
export function orphanLoops(procs: Proc[], now: number): Proc[] {
  const by = new Map(procs.map((p) => [p.pid, p]))
  const claudeAbove = (p: Proc) => {
    for (let q = by.get(p.ppid), n = 0; q && n < 64; q = by.get(q.ppid), n++) if (q.comm === 'claude' || /(^|\/)claude(\s|$)/.test(q.cmdline)) return true
    return false
  }
  const onlySleeps = (p: Proc) => procs.every((c) => c.ppid !== p.pid || c.comm === 'sleep')
  return procs.filter((p) => isLoopCommand(p.cmdline) && now - p.startedAt >= ORPHAN_MIN_AGE_MS && !claudeAbove(p) && onlySleeps(p))
}

// ---------------------------------------------------------------- the optimiser

export interface CostHost {
  snapshot(): Snapshot
  /** The transcript file of a session (w.store). */
  fileOf(id: string): string | undefined
  /** weevboss's conversation id, and whether it is working. */
  bossId(): string | null
  command(id: string, cmd: string): Promise<unknown>
  commandMain(cmd: string): Promise<unknown>
  /** Auto tasks (their runs carry their session ids). */
  autoTasks(): Optimizer[]
  /** The ledger of weevilsd's own calls. */
  ledger(): Ledger
  /** Posts an item in « for you » (null: no stream on this machine). */
  post(item: NewItem): unknown
  /** A proposal's button (server/foryou.ts deps.op): interrupt a session, switch its model. */
  key(id: string, key: string): Promise<unknown>
  kill?(pid: number): void
  procs?(): Proc[]
}

interface State {
  compacted: Record<string, number>
  proposed: Record<string, number>
  /** Cache hits already reported. */
  hits: number
  /** Per run: what it did (the auto page shows the note, the stream the line). */
  lastRunAt: number
  auditAt?: number
}

export interface RunResult {
  ok: boolean
  note: string
  report: string
}

export class CostOptimizer {
  private host: CostHost
  private file: string
  private s: State
  readonly scan: TranscriptScan
  private running: Promise<RunResult> | null = null

  constructor(host: CostHost, opts: { file?: string; root?: string } = {}) {
    this.host = host
    this.file = opts.file ?? path.join(DATA_DIR, 'cost.json')
    this.scan = new TranscriptScan(opts.root)
    this.s = (() => {
      try {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
        return { compacted: raw.compacted ?? {}, proposed: raw.proposed ?? {}, hits: Number(raw.hits) || 0, lastRunAt: Number(raw.lastRunAt) || 0, auditAt: raw.auditAt }
      } catch {
        return { compacted: {}, proposed: {}, hits: 0, lastRunAt: 0 }
      }
    })()
  }

  private save() {
    const now = Date.now()
    for (const m of [this.s.compacted, this.s.proposed]) for (const [k, at] of Object.entries(m)) if (now - at > 3 * DAY_MS) delete m[k]
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.s), { mode: 0o600 })
      fs.renameSync(`${this.file}.tmp`, this.file)
    } catch (e) {
      console.error(`[coût] état non écrit : ${(e as Error).message}`)
    }
  }

  /** One run of the automation (never two at once). */
  run(now = Date.now()): Promise<RunResult> {
    if (!this.running) this.running = this.once(now).finally(() => (this.running = null))
    return this.running
  }

  private titleOf(snap: Snapshot, sid: string): string {
    if (sid === this.host.bossId()) return 'weevboss'
    const s = snap.sessions.find((x) => x.id === sid)
    if (s) return s.title
    const auto = this.host.autoTasks().find((o) => o.sessionId === sid || o.runs?.some((r) => r.sessionId === sid))
    return auto ? auto.title : sid.slice(0, 8)
  }

  private async once(now: number): Promise<RunResult> {
    const t = tr(C)
    await this.scan.refresh(now)
    const snap = this.host.snapshot()
    const done: string[] = []
    const report: string[] = []

    // 1. Compact the big sessions at rest.
    const compacted: string[] = []
    const candidates: { id: string; title: string; ctx: number; boss: boolean }[] = []
    // An auto task's session is over when its run is: compacting it would only cost a turn.
    const autoSessions = new Set(this.host.autoTasks().flatMap((o) => [o.sessionId, ...(o.runs ?? []).map((r) => r.sessionId)]).filter(Boolean))
    for (const s of snap.sessions) {
      if (autoSessions.has(s.id)) continue
      if (s.machineId !== MACHINE.id || s.tool !== 'claude' || !s.live || !s.controllable || !s.hasScreen) continue
      if (s.status !== 'idle' && s.status !== 'done') continue
      if (s.background > 0 || s.queued > 0 || s.turnWorking) continue
      const quiet = now - s.lastActivityAt
      if (quiet < IDLE_MS || quiet > ACTIVE_MS) continue
      const a = this.scan.main(s.id)
      if (!a || a.lastCtx < COMPACT_AT) continue
      const before = this.s.compacted[s.id] ?? 0
      if (before > s.lastActivityAt - 60_000 || now - before < COMPACT_AGAIN_MS) continue
      candidates.push({ id: s.id, title: s.title, ctx: a.lastCtx, boss: false })
    }
    const boss = this.host.bossId()
    if (boss && !snap.mainWorking) {
      const a = this.scan.main(boss)
      const quiet = a ? now - a.lastAt : 0
      const before = this.s.compacted[boss] ?? 0
      if (a && a.lastCtx >= COMPACT_AT && quiet >= IDLE_MS && quiet <= ACTIVE_MS && before < a.lastAt - 60_000 && now - before >= COMPACT_AGAIN_MS)
        candidates.push({ id: boss, title: 'weevboss', ctx: a.lastCtx, boss: true })
    }
    for (const c of candidates.sort((x, y) => y.ctx - x.ctx).slice(0, MAX_COMPACT)) {
      try {
        await (c.boss ? this.host.commandMain('/compact') : this.host.command(c.id, '/compact'))
        this.s.compacted[c.id] = now
        compacted.push(c.title)
        report.push(t.reportCompacted(c.title, fmtTokens(c.ctx)))
      } catch (e) {
        report.push(t.reportFailed(c.title, (e as Error).message))
      }
    }
    if (compacted.length) done.push(t.compacted(compacted.length))

    // 2. Stop the loops left behind.
    let killed = 0
    try {
      const orphans = orphanLoops((this.host.procs ?? listProcs)(), now)
      for (const p of orphans) {
        try {
          ;(this.host.kill ?? ((pid: number) => process.kill(pid, 'SIGTERM')))(p.pid)
          killed++
          report.push(t.reportKilled(p.pid, p.cmdline.slice(p.cmdline.indexOf('eval') + 5, p.cmdline.indexOf('eval') + 85)))
        } catch {
          /* already gone */
        }
      }
    } catch {
      /* no /proc */
    }
    if (killed) done.push(t.killed(killed))

    // 3. weevilsd's own calls answered from the cache since the last report.
    const ledger = this.host.ledger()
    const today = ledger[dayKey(now)] ?? {}
    const hits = Object.values(today).reduce((n, e) => n + e.cached, 0)
    const newHits = Math.max(0, hits - this.s.hits)
    const perCall = (() => {
      const all = Object.values(today)
      const calls = all.reduce((n, e) => n + e.calls, 0)
      return calls ? all.reduce((n, e) => n + e.tokens, 0) / calls : 0
    })()
    this.s.hits = hits
    if (newHits) done.push(t.cached(newHits, fmtTokens(newHits * perCall)))

    // 4. Proposals.
    const proposed = this.propose(snap, now)
    report.push(...proposed)

    // The trend: the last hour against the one before.
    const hour = Math.floor(now / 3600_000) * 3600_000
    const lastHour = this.scan.between(now - 3600_000, now + 1) || this.scan.between(hour, hour + 3600_000)
    const prevHour = this.scan.between(now - 2 * 3600_000, now - 3600_000)
    const drop = prevHour > 0 && lastHour < prevHour ? Math.round((1 - lastHour / prevHour) * 100) : 0
    report.unshift(t.reportHours(fmtTokens(lastHour), fmtTokens(prevHour)))

    this.s.lastRunAt = now
    this.save()
    if (done.length) {
      const line = t.gain(done, drop)
      this.host.post({ id: `cost:gain:${now}`, kind: 'stat', tone: 'result', who: 'weevils', title: t.title, text: line, gauges: this.week(now), open: { page: 'usage' } })
      return { ok: true, note: line, report: report.join('\n') }
    }
    return { ok: true, note: proposed.length ? t.proposedNote(proposed.length) : t.nothing(fmtTokens(lastHour)), report: report.join('\n') }
  }

  /** The week as bars: one per day, today last. */
  week(now = Date.now()): ForYouGauge[] {
    const t = tr(C)
    const daily = this.scan.daily()
    const days = Array.from({ length: 7 }, (_, i) => dayKey(now - (6 - i) * DAY_MS))
    const max = Math.max(1, ...days.map((d) => daily[d] ?? 0))
    return days.map((d, i) => ({ label: i === 6 ? t.today : t.weekday(new Date(`${d}T12:00:00`).getDay()), value: daily[d] ?? 0, max, shown: fmtTokens(daily[d] ?? 0), hot: (daily[d] ?? 0) >= max * 0.9 && i === 6 }))
  }

  /** Proposals as « for you » cards with one button each, never twice within PROPOSE_AGAIN_MS. Returns report lines. */
  private propose(snap: Snapshot, now: number): string[] {
    const t = tr(C)
    const out: string[] = []
    const fresh = (key: string) => now - (this.s.proposed[key] ?? 0) > PROPOSE_AGAIN_MS
    const mark = (key: string) => (this.s.proposed[key] = now)
    const live = snap.sessions.filter((s) => s.machineId === MACHINE.id && s.tool === 'claude' && s.live && s.controllable && now - s.lastActivityAt < 2 * 3600_000)
    for (const s of live) {
      const a = this.scan.main(s.id)
      if (!a) continue
      const loop = circles(a, now)
      if (loop && fresh(`stop:${s.id}`)) {
        mark(`stop:${s.id}`)
        this.host.post({ id: `cost:stop:${s.id}`, kind: 'improve', tone: 'question', who: 'weevils', projectId: s.projectId, title: t.title, text: t.circles(s.title, loop.times), actions: [{ label: t.stopIt, brief: t.stopBrief(s.title, s.id), op: `stop:${s.id}` }] })
        out.push(t.circles(s.title, loop.times))
        continue
      }
      if (simpleTask(a) && fresh(`model:${s.id}`)) {
        mark(`model:${s.id}`)
        const model = /fable/i.test(a.model) ? 'Fable' : 'Opus'
        this.host.post({ id: `cost:model:${s.id}`, kind: 'improve', tone: 'question', who: 'weevils', projectId: s.projectId, title: t.title, text: t.simple(s.title, model), actions: [{ label: t.toSonnet, brief: t.sonnetBrief(s.title, s.id), op: `model:${s.id}:sonnet` }] })
        out.push(t.simple(s.title, model))
      }
    }
    for (let i = 0; i < live.length; i++)
      for (let j = i + 1; j < live.length; j++) {
        const [x, y] = [live[i], live[j]]
        if (x.projectId !== y.projectId || !sameTask(x.title, y.title)) continue
        const key = `merge:${[x.id, y.id].sort().join(':')}`
        if (!fresh(key)) continue
        mark(key)
        this.host.post({ id: `cost:${key}`, kind: 'improve', tone: 'question', who: 'weevils', projectId: x.projectId, title: t.title, text: t.duplicate(x.title, y.title), actions: [{ label: t.mergeThem, brief: t.mergeBrief(x.title, x.id, y.title, y.id) }] })
        out.push(t.duplicate(x.title, y.title))
      }
    return out
  }

  /** A tapped proposal: « stop:<sid> » interrupts the turn (Esc), « model:<sid>:sonnet » types /model sonnet. */
  async op(op: string): Promise<void> {
    const [kind, sid, arg] = op.split(':')
    const s = this.host.snapshot().sessions.find((x) => x.id === sid)
    if (!s || !s.controllable) throw new Error(tr(C).gone)
    if (kind === 'stop') await this.host.key(sid, 'esc')
    else if (kind === 'model' && (arg === 'sonnet' || arg === 'haiku')) await this.host.command(sid, `/model ${arg}`)
    else throw new Error(tr(C).gone)
  }

  // ---------------------------------------------------------------- the audit

  /** The day's most expensive posts and why, posted in « for you » (and returned as text). */
  async audit(now = Date.now()): Promise<{ text: string; posts: AuditPost[] }> {
    const t = tr(C)
    await this.scan.refresh(now)
    const snap = this.host.snapshot()
    const day = dayKey(now)
    const posts = auditPosts(this.scan, day, (sid) => this.titleOf(snap, sid), (sid) => this.host.autoTasks().some((o) => o.sessionId === sid || o.runs?.some((r) => r.sessionId === sid)), this.host.bossId())
    const internal = Object.entries(this.host.ledger()[day] ?? {}).reduce((n, [, e]) => n + e.tokens, 0)
    const total = posts.reduce((n, p) => n + p.tokens, 0)
    // The four biggest, and the auto tasks past 1 M (they run unattended: nobody watches what they spend).
    const top = [...posts.slice(0, 4), ...posts.slice(4).filter((p) => p.why.some((w) => w.k === 'auto') && p.tokens >= 1e6).slice(0, 2)]
    const lines = top.map((p) => `• ${p.title}: ${fmtTokens(p.tokens)}. ${p.why.map((w) => t.why(w)).join(' ')}`)
    const text = [t.auditLead(fmtTokens(total), Math.round(this.scan.between(now - 3600_000, now + 1) / 1e6)), ...lines, internal ? t.auditInternal(fmtTokens(internal)) : t.auditInternalNone, t.auditPlan].join('\n')
    const max = Math.max(1, ...top.map((p) => p.tokens))
    this.host.post({ id: `cost:audit:${day}`, kind: 'insight', tone: 'neutral', who: 'weevils', title: t.auditTitle, text, gauges: top.map((p) => ({ label: p.title, value: p.tokens, max, shown: fmtTokens(p.tokens), hot: p.tokens >= max * 0.9 })), open: { page: 'usage' } })
    this.s.auditAt = now
    this.save()
    return { text, posts }
  }
}

export type Why =
  | { k: 'subagents'; n: number; tokens: number; turns: number; ctx: number; model: string }
  | { k: 'context'; ctx: number; turns: number; max: number }
  | { k: 'compacts'; n: number }
  | { k: 'auto'; model: string; turns: number }
  | { k: 'heavyModel'; model: string }
  | { k: 'polls'; n: number }

export interface AuditPost {
  sid: string
  title: string
  tokens: number
  why: Why[]
}

const modelName = (m: string) => (/fable/i.test(m) ? 'Fable' : /opus/i.test(m) ? 'Opus' : /sonnet/i.test(m) ? 'Sonnet' : /haiku/i.test(m) ? 'Haiku' : m)

/** Today's posts by session (subagents included), most expensive first, each with its reasons (pure but for the scan). */
export function auditPosts(scan: TranscriptScan, day: string, title: (sid: string) => string, isAuto: (sid: string) => boolean, boss: string | null): AuditPost[] {
  const by = new Map<string, { main?: FileAgg; subs: FileAgg[] }>()
  for (const a of scan.files.values()) {
    if (!a.days[day]) continue
    const e = by.get(a.sid) ?? { subs: [] }
    if (a.agent) e.subs.push(a)
    else e.main = a
    by.set(a.sid, e)
  }
  const out: AuditPost[] = []
  for (const [sid, e] of by) {
    const subTokens = e.subs.reduce((n, a) => n + a.days[day].tokens, 0)
    const m = e.main?.days[day]
    const tokens = (m?.tokens ?? 0) + subTokens
    const why: Why[] = []
    if (e.subs.length && subTokens > tokens * 0.3) {
      const turns = e.subs.reduce((n, a) => n + a.days[day].turns, 0)
      const ctx = turns ? e.subs.reduce((n, a) => n + a.days[day].ctx, 0) / turns : 0
      why.push({ k: 'subagents', n: e.subs.length, tokens: subTokens, turns, ctx, model: modelName(e.subs[0].model) })
    }
    if (m && m.turns) {
      const ctx = m.ctx / m.turns
      if (ctx >= 100_000) why.push({ k: 'context', ctx, turns: m.turns, max: Math.max(...(e.main?.recent.map((r) => r.ctx) ?? [0])) })
      if (e.main!.compacts) why.push({ k: 'compacts', n: e.main!.compacts })
      if (isAuto(sid)) why.push({ k: 'auto', model: modelName(e.main!.model), turns: m.turns })
      else if (/opus|fable/i.test(e.main!.model) && ctx < 100_000) why.push({ k: 'heavyModel', model: modelName(e.main!.model) })
      const polls = e.main!.recent.filter((r) => r.cmds.some((c) => POLL.test(c))).length
      if (polls >= 5) why.push({ k: 'polls', n: polls })
    }
    out.push({ sid, title: sid === boss ? 'weevboss' : title(sid), tokens, why })
  }
  return out.sort((a, b) => b.tokens - a.tokens)
}
