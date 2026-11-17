// Codex relay while Claude is at its usage limit. Everything here runs without Claude: detection and triggering are
// plain code in weevilsd (no model call), the plans are written by Codex.
//
// Three signals, combined: (a) the limit message Claude Code writes in a transcript, with its reset time; (b) repeated
// API errors or sessions that stop dead mid-work; (c) the subscription quota read live (5-hour and weekly windows, the
// figures of the usage page).
//
// - From PREPARE_AT % of a window, Codex writes a takeover plan for every Claude session at work, read-only and in the
//   background (`codex exec --sandbox read-only --ephemeral`), so the plans are there the second the limit hits. One
//   line tells the user, once per window (« t'es à 90 % de ta semaine, je garde Codex au chaud »).
// - At switchAt % (97 by default: the limit has no grace period), the switch is made before the cut: weevboss answers
//   through Codex, and every working session is told to finish its step and stop. A limit seen after the fact (a
//   transcript message, a quota at 100 %, errors piling up) opens the same episode: the safety net.
// - A session that stopped (or was cut) gets its plan: what is done, what is left, the risks, what Codex intends to do.
//   Nothing is touched before the plan is approved (mode « ask », the default); in mode « auto » the plan is carried
//   out as soon as it is written; « never » turns the relay off. Approved, a Codex session opens in the same folder,
//   linked to the Claude one. « Wait for Claude » resumes the Claude session when the window resets.
// - At the reset time, everything goes back to Claude.
//
// State in DATA_DIR/relay.json.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import type { ProviderHealth } from './provider-health.ts'
import { ReturnRelay } from './return-relay.ts'
import os from 'node:os'
import path from 'node:path'
import type { RelayMode, RelayPlan, RelayView, Session } from '../shared/api.ts'
import type { QuotaInfo } from '../shared/infra.ts'
import { signAs } from './authors.ts'
import { DATA_DIR, MACHINE } from './config.ts'
import { lang, tr } from './i18n.ts'
import R from './i18n/relay.ts'
import type { StopError, Transcript } from './transcripts.ts'

export const PREPARE_AT = 90
export const SWITCH_AT = 97
/** First words of the prompt of a plan run: weevils never lists such a session (they are ephemeral anyway). */
export const PLAN_MARKER = '[weevils-relay-plan]'
const TICK_MS = 5000
const QUOTA_EVERY_MS = 5 * 60_000
const QUOTA_HOT_MS = 90_000
const PROBE_EVERY_MS = 5 * 60_000
const ERRORS_WITHIN_MS = 10 * 60_000
const UNKNOWN_RESET_MS = 3600_000
const KEEP_MS = 3 * 24 * 3600_000
const RETRY_WRITE_MS = 3 * 60_000
const MAX_WRITING = 2
const STATE_FILE = path.join(DATA_DIR, 'relay.json')

// ---------------------------------------------------------------- reset time

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const validTz = (tz?: string): string | undefined => {
  if (!tz) return undefined
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return tz
  } catch {
    return undefined
  }
}
/** The wall clock of `at` in a time zone. */
export function wall(at: number, tz?: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: validTz(tz), hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(at)).map((x) => [x.type, Number(x.value)]))
  return { y: p.year, mo: p.month, d: p.day, h: p.hour, mi: p.minute }
}
/** The instant of a wall clock in a time zone. */
function instant(y: number, mo: number, d: number, h: number, mi: number, tz?: string): number {
  const asUtc = Date.UTC(y, mo - 1, d, h, mi)
  let t = asUtc
  // Two passes settle the offset, even next to a daylight-saving change.
  for (let i = 0; i < 2; i++) {
    const w = wall(t, tz)
    t -= Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) - asUtc
  }
  return t
}

/**
 * The reset time written in a limit message, as an instant after `at`: « resets 6pm (Europe/Paris) », « will reset at
 * 18:30 », « resets Nov 12, 9am », « resets in 2h 15m », or the old « …|1731250000 » (epoch seconds). null: none found.
 */
export function parseReset(text: string, at: number, defaultTz?: string): { until: number; tz?: string } | null {
  const epoch = /\|\s*(\d{10})\b/.exec(text)
  if (epoch) return { until: Number(epoch[1]) * 1000 }
  const rel = /reset\w*\s+in\s+(?:(\d+)\s*h\w*)?\s*(?:(\d+)\s*m\w*)?/i.exec(text)
  if (rel && (rel[1] || rel[2])) return { until: at + (Number(rel[1] ?? 0) * 60 + Number(rel[2] ?? 0)) * 60_000 }
  const m = /reset\w*\s*(?:at|on)?\s*(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s*(?:at\s*)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z_+-]+)*)\))?/i.exec(text)
  if (!m) return null
  const tz = validTz(m[6]) ?? validTz(defaultTz)
  let h = Number(m[3])
  const mi = Number(m[4] ?? 0)
  const ap = m[5]?.toLowerCase()
  if (ap === 'pm' && h < 12) h += 12
  if (ap === 'am' && h === 12) h = 0
  if (h > 23 || mi > 59) return null
  const now = wall(at, tz)
  const month = m[1] ? MONTHS.indexOf(m[1].toLowerCase()) + 1 : 0
  if (month > 0 && m[2]) {
    let until = instant(now.y, month, Number(m[2]), h, mi, tz)
    if (until < at - 24 * 3600_000) until = instant(now.y + 1, month, Number(m[2]), h, mi, tz)
    return { until, tz }
  }
  let until = instant(now.y, now.mo, now.d, h, mi, tz)
  if (until <= at) until = instant(now.y, now.mo, now.d + 1, h, mi, tz)
  return { until, tz }
}

/** « 18 h », « 18 h 30 », or with the day when it is not within the next 20 hours (« jeudi 9 h »). */
export function clockOf(until: number, now: number, tz?: string): string {
  const t = tr(R)
  const w = wall(until, tz)
  const clock = t.clock(w.h, w.mi)
  if (until - now < 20 * 3600_000) return clock
  return t.dayClock(new Date(until).toLocaleDateString(lang() === 'fr' ? 'fr-FR' : 'en-US', { weekday: 'long', timeZone: validTz(tz) }), clock)
}

/** The fullest of the 5-hour and weekly windows still running (a per-model window does not stop everything). */
export function hottest(q: QuotaInfo | null | undefined, now: number): { percent: number; window: 'session' | 'week'; resetsAt: number | null } | null {
  let best: { percent: number; window: 'session' | 'week'; resetsAt: number | null } | null = null
  for (const w of q?.ok ? q.windows : []) {
    if (w.kind !== 'session' && w.kind !== 'week') continue
    if (w.resetsAt && w.resetsAt <= now) continue
    if (!best || w.percent > best.percent) best = { percent: w.percent, window: w.kind, resetsAt: w.resetsAt }
  }
  return best
}

// ---------------------------------------------------------------- state

interface Episode {
  kind: 'near' | 'limit' | 'down'
  since: number
  until: number | null
  source: 'transcript' | 'quota' | 'errors'
  window?: 'session' | 'week'
  percent?: number
  tz?: string
  announced?: boolean
  probedAt?: number
}
interface Plan {
  resolved?: boolean
  sessionId: string
  title: string
  projectId: string
  cwd: string
  /** draft: written ahead, not shown; open: waits for a decision; go: approved; wait: waits for Claude; closed. */
  phase: 'draft' | 'open' | 'go' | 'wait' | 'closed'
  /** The writing of the plan by Codex. */
  gen: 'todo' | 'running' | 'idle' | 'failed'
  text?: string
  /** When the text was written. */
  textAt?: number
  error?: string
  failedAt?: number
  /** The user's adjustments. */
  note?: string
  at: number
  /** The quota window (its reset time) or the episode (its start) the plan belongs to. */
  window?: number
  episode?: number
  /** The session was told to finish its step and stop. */
  asked?: number
  relayTo?: string
  /** Persisted before launch; a lost acknowledgement must never automatically launch another worker. */
  dispatchedAt?: number
  auto?: boolean
  said?: boolean
}
interface Boss {
  /** The tmux pane of weevboss on Codex, then its transcript once linked. */
  pane?: string
  sessionId?: string
  since: number
}
interface State {
  mode: RelayMode
  switchAt: number
  /** The time zone of the user's device (sent by the app): the hour of « until 6 pm ». */
  tz?: string
  episode?: Episode
  lastEnd?: number
  plans: Plan[]
  /**
   * The quota window being prepared for: which one, until when, and its key (the plans written ahead carry it). The
   * API's reset time moves by a few milliseconds from one read to the next: it is read once, never compared again.
   */
  prep?: { window: 'session' | 'week'; until: number; key: number; warned?: boolean }
  /** The window whose switch was already announced (one notice per window, even if the episode ends and reopens). */
  switched?: { window: 'session' | 'week' | 'none'; until: number }
  preparations?: Partial<Record<'session' | 'week', NonNullable<State['prep']>>>
  switches?: Partial<Record<'session' | 'week' | 'none', NonNullable<State['switched']>>>
  boss?: Boss
  /** The stop error of weevboss on Claude already handed to Codex. */
  bossCutAt?: number
  /** Claude is back and weevboss has not been told yet what Codex said in its place: since when Codex answered. */
  bossBack?: number
}

/** What the relay needs from weevilsd (server/core.ts), narrow enough to fake in tests. */
export interface RelayHost {
  sessions(now?: number): Session[]
  transcript(id: string): Transcript | undefined
  send(id: string, text: string, from?: string): Promise<unknown>
  resume(id: string): Promise<unknown>
  /** The cut of this session is dealt with: it is no longer « interrupted ». */
  settle(id: string): void
  /** Opens a Codex session in a folder; returns its id (the pane's name until its transcript is known). */
  openCodex(cwd: string, title: string, text: string): Promise<string>
  openClaude?(cwd: string, title: string, text: string, id: string): Promise<string>
  autoReturn?(id: string, text: string, targetId: string, tool?: 'claude' | 'codex'): Promise<string>
  resumeCodex?(id: string, text: string, requestId: string): Promise<string>
  codexBossStop?(): StopError | undefined
  codexBossSession?(): Session | undefined
  mainBusy?(): boolean
  returnMain?(text: string, requestId: string): Promise<string>
  resolve(id: string): string
  /** weevboss on Claude: the error that stopped its turn, if any. */
  bossStop(): StopError | undefined
  /** weevboss' unanswered message goes to Codex. */
  bossRelayCut(): Promise<unknown>
  /** A background task of the auto band: its session, restarted on Codex inside its barriers. */
  autoOwns?(sessionId: string): boolean
  autoRun?(sessionId: string, text: string): Promise<string>
  autoTick?(): void
  notify(title: string, body: string, url: string, tag: string): void
  say(text: string): void
  bump(): void
}

export interface RelayDeps {
  health?: ProviderHealth
  /** Claude's quota, as the usage page reads it. */
  quota: () => Promise<QuotaInfo>
  codexReady: () => boolean
  /** Codex writes a plan, read-only, in this folder. */
  write: (cwd: string, prompt: string) => Promise<string>
  /** git status and diff stat of a folder, as text. */
  git: (cwd: string) => Promise<string>
  /** Does Claude answer at all? (only to tell an outage from two sessions that died for another reason). */
  probe: () => Promise<boolean>
  /** The clock (tests). */
  now?: () => number
}

const run = (cmd: string, args: string[], cwd: string, timeout: number): Promise<string> =>
  new Promise((resolve) => {
    const c = execFile(cmd, args, { cwd, timeout, maxBuffer: 4 << 20 }, (_err, stdout) => resolve(String(stdout ?? '')))
    c.stdin?.end()
  })

export const defaultDeps = (quota: () => Promise<QuotaInfo>, codexReady: () => boolean): RelayDeps => ({
  quota,
  codexReady,
  write: (cwd, prompt) =>
    new Promise((resolve, reject) => {
      const out = path.join(os.tmpdir(), `wv-plan-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`)
      const c = execFile('codex', ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '-C', cwd, '-o', out, prompt], { cwd, timeout: 10 * 60_000, maxBuffer: 16 << 20 }, (err, _stdout, stderr) => {
        let text = ''
        try {
          text = fs.readFileSync(out, 'utf8').trim()
          fs.rmSync(out, { force: true })
        } catch {
          /* nothing written */
        }
        if (text) resolve(text)
        else reject(new Error(String(stderr || err?.message || 'codex exec').trim().split('\n').slice(-3).join(' ').slice(0, 300)))
      })
      c.stdin?.end()
    }),
  git: async (cwd) => {
    const status = (await run('git', ['status', '--short', '--branch'], cwd, 8000)).split('\n').slice(0, 40).join('\n').trim()
    const stat = (await run('git', ['diff', '--stat', 'HEAD'], cwd, 8000)).split('\n').slice(-25).join('\n').trim()
    const log = (await run('git', ['log', '--oneline', '-5'], cwd, 8000)).trim()
    return [status && `git status:\n${status}`, stat && `git diff --stat HEAD:\n${stat}`, log && `git log:\n${log}`].filter(Boolean).join('\n\n')
  },
  probe: () =>
    new Promise((resolve) => {
      const c = execFile('claude', ['-p', '--model', 'haiku', '--tools', '', '--no-session-persistence', 'ok'], { timeout: 45_000, cwd: os.tmpdir() }, (err, stdout) => resolve(!err && !!String(stdout).trim()))
      c.stdin?.end()
    }),
})

const clip = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat
}
/** WEEVILS_RELAY_AT: the switch threshold before any choice made in the app. */
const envSwitch = () => {
  const n = Number(process.env.WEEVILS_RELAY_AT)
  return n >= 50 && n <= 100 ? Math.round(n) : SWITCH_AT
}
const isMode = (m: unknown): m is RelayMode => m === 'auto' || m === 'ask' || m === 'never'
/** A session's turn or background is at work. */
const atWork = (s: Session) => s.status === 'working'
const STOPPED = new Set(['quota', 'api', 'died'])

export class Relay {
  private returns?: ReturnRelay
  private s: State = { mode: 'ask', switchAt: envSwitch(), plans: [] }
  private q: QuotaInfo | null = null
  private quotaAt = 0
  private ticking = false
  private writing = new Set<string>()
  private launching = new Set<string>()
  private probing = false
  private probeOkAt = 0

  private host: RelayHost
  private deps: RelayDeps
  private file: string

  constructor(host: RelayHost, deps: RelayDeps, file = STATE_FILE) {
    this.host = host
    this.deps = deps
    this.file = file
    if (host.openClaude && deps.health) this.returns = new ReturnRelay(path.join(path.dirname(file), 'provider-handoffs.json'), {
      ...host, openClaude: host.openClaude,
      sessions: () => [...host.sessions(), ...[host.codexBossSession?.()].filter((s): s is Session => !!s)],
      isMain: id => host.codexBossSession?.()?.id === id,
    })
    try {
      const p = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<State>
      this.s = { ...this.s, ...p, mode: isMode(p.mode) ? p.mode : 'ask', plans: (p.plans ?? []).map((x) => (x.gen === 'running' ? { ...x, gen: 'todo' as const } : x)) }
      // State written before « one line per window »: the window already announced stays announced, its plans stay its plans.
      const old = (p as { warned?: number }).warned
      if (typeof old === 'number' && !this.s.prep) {
        this.s.prep = { window: old - Date.now() > 6 * 3600_000 ? 'week' : 'session', until: old, key: old, warned: true }
        for (const x of this.s.plans) if (x.phase === 'draft' && x.window) x.window = old
      }
      delete (this.s as { warned?: number }).warned
      this.s.preparations ??= {}
      if (this.s.prep) this.s.preparations[this.s.prep.window] ??= this.s.prep
      this.s.switches ??= {}
      if (this.s.switched) this.s.switches[this.s.switched.window] ??= this.s.switched
    } catch {
      /* first start */
    }
  }

  private now() {
    return this.deps.now?.() ?? Date.now()
  }

  start() {
    setInterval(() => void this.tick(), TICK_MS).unref?.()
  }

  private save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
      const tmp = this.file + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(this.s, null, 1), { mode: 0o600 })
      const fd = fs.openSync(tmp, 'r'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      fs.renameSync(tmp, this.file)
      const dir = fs.openSync(path.dirname(this.file), 'r'); try { fs.fsyncSync(dir) } finally { fs.closeSync(dir) }
      return true
    } catch {
      return false
    }
  }
  private changed() {
    this.save()
    this.host.bump()
  }

  // ---------------------------------------------------------------- what the others ask

  get mode() {
    return this.s.mode
  }
  /** Codex may take over on this machine at all. */
  can() {
    return this.s.mode !== 'never' && this.deps.codexReady() && (this.deps.health?.canUse('codex') ?? true)
  }
  /** Preserve preferences; choose a temporary available route only under durable automatic authorization. */
  executionTool(preferred: 'claude' | 'codex'): 'claude' | 'codex' | null {
    if (!this.deps.health) return preferred
    const usable = (tool: 'claude' | 'codex') => this.deps.health!.canUse(tool) && (tool !== 'claude' || !this.s.episode || this.s.episode.kind === 'near')
    const wanted = preferred === 'claude' && this.s.episode && this.s.mode === 'auto' ? 'codex' : preferred
    if (usable(wanted)) return wanted
    const other = wanted === 'claude' ? 'codex' : 'claude'
    return this.s.mode === 'auto' && usable(other) ? other : null
  }
  providerReady(tool: 'claude' | 'codex') { return this.deps.health?.canUse(tool) ?? true }
  retryAt() { return this.deps.health?.retryAt(this.now()) ?? this.now() + 60_000 }
  deliveryTarget(id: string) {
    let target = id
    const seen = new Set<string>()
    while (!seen.has(target)) {
      seen.add(target)
      const next = this.returns?.target(target) ?? this.relayedBy(target)
      if (!next) break
      target = next
    }
    return target
  }
  requestReturn(s: Session, requested = false) {
    const block = this.deps.health?.block('codex')
    if (this.s.mode !== 'auto' || !block) return
    // A newly observed account limit must not revive every old interrupted task in the history.
    if (!requested && (!s.interrupted || s.interrupted.at < block.since - ERRORS_WITHIN_MS)) return
    this.returns?.request(s, this.now())
  }
  /** Claude is unavailable, or about to be: the episode. */
  episode(): Episode | undefined {
    return this.s.episode
  }
  /** weevboss answers through Codex. */
  bossOn() {
    return !!this.s.episode && this.can()
  }
  get boss(): Boss | undefined {
    return this.s.boss
  }
  setBoss(b: Boss | undefined) {
    this.s.boss = b
    this.save()
  }
  /** Claude is back: since when Codex answered in weevboss' place (told once, then forgotten). */
  takeBossBack(): number | undefined {
    const since = this.s.bossBack
    if (since === undefined) return undefined
    delete this.s.bossBack
    this.save()
    return since
  }
  peekBossBack() { return this.s.bossBack }
  /** A background task waits (no start on Claude) until this time; 0: no wait. */
  holdUntil(now = this.now()): number {
    const e = this.s.episode
    return e ? (e.until ?? now + UNKNOWN_RESET_MS) : 0
  }
  /** New background tasks start on Codex. */
  autoOnCodex() {
    return !!this.s.episode && this.s.mode === 'auto' && this.can()
  }
  /** This session is being handed over (told to stop, or its plan is on the table): not « done », not « failed ». */
  holds(sessionId: string | undefined): boolean {
    if (sessionId && this.returns?.holds(sessionId)) return true
    const p = sessionId ? this.planOf(sessionId) : undefined
    if (!p) return false
    if (p.phase === 'draft') return !!this.s.episode && !!p.asked && p.episode === this.s.episode.since
    return p.phase === 'open' || p.phase === 'wait' || (p.phase === 'go' && !p.relayTo)
  }
  /** The relay speaks for this cut (one notice for the episode, not one per session). */
  covers(s: Session): boolean {
    if (s.tool !== 'claude' || !s.interrupted || !this.can()) return false
    if (s.interrupted.reason === 'quota') return true
    const e = this.s.episode
    return !!e && STOPPED.has(s.interrupted.reason) && s.interrupted.at >= e.since - ERRORS_WITHIN_MS
  }
  planOf(sessionId: string) {
    return this.s.plans.find((p) => p.sessionId === sessionId)
  }
  /** The Codex session that took over this Claude session. */
  relayedBy(sessionId: string): string | undefined {
    const to = this.planOf(sessionId)?.relayTo
    return to ? this.host.resolve(to) : undefined
  }
  /** The Claude session this Codex session (its id, or its pane's name) took over. */
  relayOf(...ids: (string | undefined)[]): string | undefined {
    return this.s.plans.find((p) => p.relayTo && (ids.includes(p.relayTo) || ids.includes(this.host.resolve(p.relayTo))))?.sessionId
  }

  view(now = this.now()): RelayView {
    const e = this.s.episode
    const plans: RelayPlan[] = this.s.plans
      .filter((p) => p.phase === 'open' || p.phase === 'wait' || (p.phase === 'go' && now - p.at < 12 * 3600_000))
      .sort((a, b) => a.at - b.at)
      .map((p) => ({
        sessionId: p.sessionId,
        title: p.title,
        projectId: p.projectId,
        state: p.dispatchedAt && !p.relayTo ? 'waiting' : p.phase === 'go' ? 'running' : p.phase === 'wait' ? 'waiting' : p.text ? 'ready' : p.gen === 'failed' ? 'failed' : 'preparing',
        text: p.text,
        ...(p.text && (p.gen === 'todo' || p.gen === 'running') ? { refreshing: true } : {}),
        ...(p.dispatchedAt && !p.relayTo ? { error: tr(R).handoffUncertain } : p.error ? { error: p.error } : {}),
        at: p.at,
        ...(p.resolved ? { resolved: true } : {}),
        ...(p.auto ? { auto: true } : {}),
        ...(p.relayTo ? { relayTo: this.host.resolve(p.relayTo) } : {}),
      }))
    return {
      mode: this.s.mode,
      codex: this.deps.codexReady() && (this.deps.health?.canUse('codex') ?? true),
      ...(this.deps.health ? { providers: this.deps.health.view(), handoffs: this.returns?.view() ?? [] } : {}),
      switchAt: this.s.switchAt,
      ...(e ? { limit: { kind: e.kind, since: e.since, until: e.until, percent: e.percent, window: e.window } } : {}),
      ...(this.bossOn() ? { boss: true } : {}),
      plans,
    }
  }

  // ---------------------------------------------------------------- settings and decisions

  set(o: { mode?: unknown; switchAt?: unknown; tz?: unknown }) {
    if (isMode(o.mode)) {
      if (o.mode === 'auto' && this.s.mode !== 'auto') {
        // A durable authorization also releases plans previously left waiting for Claude.
        // Already launched plans keep their relayTo and can never be launched a second time.
        for (const p of this.s.plans) if (p.phase === 'wait') p.phase = 'open'
      }
      this.s.mode = o.mode
    }
    const at = Number(o.switchAt)
    if (o.switchAt !== undefined && at >= 50 && at <= 100) this.s.switchAt = Math.round(at)
    if (typeof o.tz === 'string' && validTz(o.tz)) this.s.tz = o.tz
    this.changed()
    void this.tick()
  }

  /** go: approved (all: every plan on the table); adjust: the plan is rewritten with the user's note; wait: Claude will do it. */
  async decide(id: string, action: string, text?: string): Promise<{ ok: true }> {
    const t = tr(R)
    const list = id === 'all' ? this.s.plans.filter((p) => p.phase === 'open' && !p.resolved) : this.s.plans.filter((p) => p.sessionId === id && (p.phase === 'open' || p.phase === 'wait'))
    if (!list.length) throw new Error(t.noPlan)
    if (action !== 'wait' && !this.deps.codexReady()) throw new Error(t.noCodex)
    for (const p of list) {
      if (action === 'go') p.phase = 'go'
      else if (action === 'adjust') {
        if (!text?.trim()) continue
        p.note = [p.note, text.trim()].filter(Boolean).join(' / ')
        p.phase = 'open'
        p.gen = this.writing.has(p.sessionId) ? p.gen : 'todo'
        delete p.error
      } else if (action === 'wait') {
        // Claude already back: resumed now.
        if (this.s.episode) p.phase = 'wait'
        else await this.backToClaude(p)
      }
      p.resolved = true
      this.changed()
    }
    void this.tick()
    return { ok: true }
  }

  /** A plan asked by hand for a Claude session that stopped (its page), whatever the mode. */
  request(sessionId: string): { ok: true } {
    if (!this.deps.codexReady()) throw new Error(tr(R).noCodex)
    const s = this.host.sessions().find((x) => x.id === sessionId)
    if (!s || s.tool !== 'claude') throw new Error(tr(R).noPlan)
    const p = this.ensure(s, this.now())
    if (p.phase === 'draft' || p.phase === 'closed') this.open(p, s, this.now())
    this.changed()
    void this.tick()
    return { ok: true }
  }

  // ---------------------------------------------------------------- the loop

  async tick(now = this.now()) {
    if (this.ticking) return
    this.ticking = true
    try {
      if (this.deps.health) {
        await this.deps.health.refresh(now)
        const all = [...this.host.sessions(now), ...[this.host.codexBossSession?.()].filter((s): s is Session => !!s)].filter(s => s.machineId === MACHINE.id)
        for (const s of all) if (s.interrupted?.reason === 'quota') this.deps.health.stop(s.tool, s.interrupted.at, parseReset(s.interrupted.detail ?? '', s.interrupted.at)?.until ?? null)
        const boss = this.host.codexBossStop?.()
        if (boss?.reason === 'quota') this.deps.health.stop('codex', boss.at, parseReset(boss.text, boss.at)?.until ?? null)
        if (this.s.mode === 'auto') {
          for (const s of all) if (s.tool === 'codex' && s.interrupted?.reason === 'quota') this.requestReturn(s)
          const target = this.executionTool('codex')
          await this.returns?.tick(target === 'claude', target === 'codex')
        }
      }
      await this.readQuota(now)
      const sessions = this.host.sessions(now).filter((s) => s.machineId === MACHINE.id && s.tool === 'claude')
      await this.detect(now, sessions)
      this.s.plans = this.s.plans.filter((p) => now - p.at < KEEP_MS)
      for (const p of this.s.plans) if (p.relayTo) p.relayTo = this.host.resolve(p.relayTo)
      if (this.can()) {
        if (this.s.episode) {
          this.handOver(now, sessions)
          this.collect(now, sessions)
          this.bossCut()
        } else this.prepare(now, sessions)
        this.write(now)
        this.carryOut()
        this.announce(now)
      }
    } catch (e) {
      console.error(`[relais] ${(e as Error).message}`)
    } finally {
      this.ticking = false
    }
  }

  private async readQuota(now: number, force = false) {
    if (this.s.mode === 'never') return
    const hot = hottest(this.q, now)
    const every = hot && hot.percent >= 80 ? QUOTA_HOT_MS : QUOTA_EVERY_MS
    if (!force && now - this.quotaAt < every) return
    this.quotaAt = now
    try {
      const q = await this.deps.quota()
      // A failed read keeps the last figures for a while (the API of the quota may be down with the rest).
      // Stale figures (kept by usage.ts after a 429) count only while they are under 30 min old.
      if (q.ok && (!q.stale || now - q.at <= 30 * 60_000)) this.q = q
      else if (this.q && now - this.q.at > 30 * 60_000) this.q = null
    } catch {
      /* next time */
    }
  }

  /** The stops Claude sessions show right now: reason, when, the tool's message. weevboss' own included. */
  private stops(sessions: Session[]): { id: string; at: number; reason: string; detail?: string }[] {
    const out = sessions.filter((s) => s.status === 'interrupted' && s.interrupted).map((s) => ({ id: s.id, at: s.interrupted!.at, reason: s.interrupted!.reason as string, detail: s.interrupted!.detail }))
    const boss = this.host.bossStop()
    if (boss) out.push({ id: 'weevboss', at: boss.at, reason: boss.reason, detail: boss.text })
    return out
  }

  private async detect(now: number, sessions: Session[]) {
    if (this.s.mode === 'never') {
      if (this.s.episode) this.end(now)
      return
    }
    const floor = Math.max(this.s.lastEnd ?? 0, now - 6 * 3600_000)
    const stops = this.stops(sessions).filter((c) => c.at > floor)
    let hot = hottest(this.q, now)
    const ep = this.s.episode

    // (a) the limit message in a transcript, with its reset time.
    const said = stops.filter((c) => c.reason === 'quota').sort((a, b) => b.at - a.at)[0]
    if (said && (!ep || ep.kind !== 'limit' || ep.source !== 'transcript')) {
      const r = parseReset(said.detail ?? '', said.at, this.s.tz)
      const until = r?.until ?? (hot && hot.percent >= PREPARE_AT ? hot.resetsAt : null) ?? ep?.until ?? null
      if (until === null || until > now) this.begin({ kind: 'limit', since: ep?.since ?? said.at, until, source: 'transcript', window: ep?.window ?? hot?.window, percent: ep?.percent, tz: r?.tz, announced: ep?.announced && ep.kind !== 'near' }, now)
    }

    // (b) sessions stopping dead or API errors piling up: with a quota nearly full it is the limit; otherwise ask
    // Claude itself before calling it an outage.
    const recent = stops.filter((c) => STOPPED.has(c.reason) && now - c.at < ERRORS_WITHIN_MS)
    if (!this.s.episode && recent.length) {
      if (hot && hot.percent >= PREPARE_AT) {
        await this.readQuota(now, true)
        hot = hottest(this.q, now)
        if (hot && hot.percent >= PREPARE_AT && (recent.length >= 2 || hot.percent >= this.s.switchAt))
          this.begin({ kind: 'limit', since: Math.min(...recent.map((c) => c.at)), until: hot.resetsAt, source: 'errors', window: hot.window, percent: hot.percent }, now)
      } else if (this.providerReady('claude') && new Set(recent.map((c) => c.id)).size >= 2 && now - this.probeOkAt > ERRORS_WITHIN_MS && !this.probing) {
        this.probing = true
        const since = Math.min(...recent.map((c) => c.at))
        void this.deps
          .probe()
          .then((ok) => {
            if (ok) this.probeOkAt = now
            else if (!this.s.episode) {
              this.begin({ kind: 'down', since, until: null, source: 'errors', probedAt: now }, now)
              void this.tick()
            }
          })
          .finally(() => (this.probing = false))
      }
    }

    // (c) the quota read live: the switch is made before the cut.
    if (hot && hot.percent >= this.s.switchAt) {
      const cur = this.s.episode
      const kind = hot.percent >= 100 ? 'limit' : 'near'
      if (!cur) this.begin({ kind, since: now, until: hot.resetsAt, source: 'quota', window: hot.window, percent: hot.percent }, now)
      else if (cur.source !== 'transcript') {
        const next = { ...cur, kind: cur.kind === 'limit' ? 'limit' : kind, percent: hot.percent, window: hot.window, until: hot.resetsAt ?? cur.until } as Episode
        if (JSON.stringify(next) !== JSON.stringify(cur)) {
          this.s.episode = next
          this.changed()
        }
      } else if (cur.percent !== hot.percent) cur.percent = hot.percent
    }

    // The end: the reset time has come (and the quota agrees), or Claude answers again.
    const cur = this.s.episode
    if (!cur) return
    // Opened on the quota alone, and a fresh read is clearly back under the threshold (the window was reset early,
    // or the threshold was raised): no reason left to keep Claude aside.
    const recovered = () => !!this.q?.ok && !this.q.error && this.q.at > cur.since && now - this.q.at < 2 * QUOTA_HOT_MS && this.q.windows.some(w => w.kind !== 'model') && this.q.windows.filter(w => w.kind !== 'model').every(w => Number.isFinite(w.percent) && w.percent < this.s.switchAt)
    if (cur.source === 'quota' && recovered() && (hot?.percent ?? 0) < Math.min(this.s.switchAt, cur.percent ?? 100) - 5) return this.end(now)
    if (cur.until === null && cur.kind !== 'down' && recovered()) return this.end(now)
    if (cur.until !== null && now >= cur.until) {
      await this.readQuota(now, true)
      const h = hottest(this.q, now)
      if (h && h.percent >= this.s.switchAt) {
        cur.until = h.resetsAt
        this.changed()
      } else if (recovered()) this.end(now)
      else { cur.until = null; this.changed() }
    } else if (cur.kind === 'down' && this.providerReady('claude') && now - (cur.probedAt ?? cur.since) > PROBE_EVERY_MS && !this.probing) {
      this.probing = true
      cur.probedAt = now
      void this.deps
        .probe()
        .then((ok) => {
          if (ok && this.s.episode?.kind === 'down') this.end(now)
        })
        .finally(() => (this.probing = false))
    }
  }

  private begin(e: Episode, now: number) {
    const prev = this.s.episode
    this.s.episode = e
    if (!prev) console.log(`[relais] Claude indisponible (${e.kind}, signal : ${e.source}${e.percent ? `, ${e.percent} %` : ''}) · retour prévu ${e.until ? new Date(e.until).toISOString() : 'inconnu'} · mode ${this.s.mode} · codex ${this.deps.codexReady() ? 'prêt' : 'absent'}`)
    else if (prev.kind !== e.kind) console.log(`[relais] ${prev.kind} → ${e.kind} (signal : ${e.source})`)
    // weevboss on Codex from now on; Claude will be told at the end what was said meanwhile.
    if (!prev && this.can()) this.s.bossBack ??= now
    this.changed()
    this.host.autoTick?.()
  }

  private end(now: number) {
    const e = this.s.episode
    if (!e) return
    delete this.s.episode
    this.s.lastEnd = now
    delete this.s.bossCutAt
    console.log(`[relais] Claude de retour (épisode ${e.kind} commencé il y a ${Math.round((now - e.since) / 60_000)} min)`)
    // Plans written ahead for sessions that never stopped are of no use; the ones waiting for Claude go back to it.
    this.s.plans = this.s.plans.filter((p) => p.phase !== 'draft')
    for (const p of this.s.plans) if (p.phase === 'wait') void this.backToClaude(p)
    if (e.announced && this.can()) this.host.say(tr(R).backSaid)
    this.changed()
    this.host.autoTick?.()
  }

  /** The Claude session carries on itself, now that Claude is there. */
  private async backToClaude(p: Plan) {
    p.phase = 'closed'
    const s = this.host.sessions().find((x) => x.id === p.sessionId)
    try {
      // A background task: the auto band restarts it on Claude in its own worktree.
      if (p.auto) return
      if (s?.status === 'interrupted') await this.host.resume(p.sessionId)
      else if (s) await this.host.send(p.sessionId, tr(R).back(p.cwd), 'weevboss')
      console.log(`[relais] ${p.sessionId.slice(0, 8)} reprise sur Claude · « ${p.title} »`)
    } catch (e) {
      console.error(`[relais] reprise de ${p.sessionId.slice(0, 8)} sur Claude : ${(e as Error).message}`)
    }
  }

  private ensure(s: Session, now: number): Plan {
    let p = this.planOf(s.id)
    const stale = p && (p.phase === 'closed' || (p.phase === 'go' && !!p.relayTo))
    if (!p || stale) {
      this.s.plans = this.s.plans.filter((x) => x !== p)
      p = { sessionId: s.id, title: s.title, projectId: s.projectId, cwd: s.cwd, phase: 'draft', gen: 'idle', at: now, ...(this.host.autoOwns?.(s.id) ? { auto: true } : {}) }
      this.s.plans.push(p)
    }
    p.title = s.title
    return p
  }

  /** From PREPARE_AT %: a plan written ahead for every session at work, then one line to the user. */
  private prepare(now: number, sessions: Session[]) {
    const hot = hottest(this.q, now)
    if (!hot || hot.percent < Math.min(PREPARE_AT, this.s.switchAt - 1)) return
    let dirty = false
    const preparations = (this.s.preparations ??= {})
    let prep = preparations[hot.window]
    if (!prep || now >= prep.until) {
      prep = preparations[hot.window] = { window: hot.window, until: hot.resetsAt ?? now + (hot.window === 'week' ? 7 * 24 : 5) * 3600_000, key: now }
      dirty = true
    }
    this.s.prep = prep
    const key = prep.key
    for (const s of sessions.filter(atWork)) {
      const p = this.ensure(s, now)
      if (p.phase !== 'draft' || p.window === key) continue
      // A draft made for another still-running quota window is already ready for this handover.
      const current = Object.values(preparations).some((w) => w?.key === p.window && now < w.until)
      p.window = key
      if (!current) p.gen = 'todo'
      dirty = true
    }
    const drafts = this.s.plans.filter((p) => p.phase === 'draft' && p.window === key)
    // A plan Codex could not write is tried again a few minutes later (Codex may have been busy or offline).
    for (const p of drafts)
      if (p.gen === 'failed' && now - (p.failedAt ?? 0) > RETRY_WRITE_MS) {
        p.gen = 'todo'
        dirty = true
      }
    // One line when the threshold is crossed, none for the points that follow.
    if (!prep.warned && !drafts.some((p) => p.gen === 'todo' || p.gen === 'running')) {
      prep.warned = true
      dirty = true
      const t = tr(R)
      // « Ready » only when Codex really answered: every plan failing means there is no relay to count on.
      const ready = !drafts.length || drafts.some((p) => p.text)
      const line = ready ? t.warn(hot.percent, hot.window) : t.warnNoCodex(hot.percent, hot.window)
      console.log(`[relais] ${line} · ${drafts.filter((p) => p.text).length}/${drafts.length} plan(s) écrit(s) d'avance`)
      this.host.notify(t.warnTitle, line, '/#relay', 'relay-warn')
      this.host.say(`${line[0].toUpperCase()}${line.slice(1)}.`)
    }
    if (dirty) this.changed()
  }

  /** The switch: every session at work is told once to finish its step and stop. */
  private handOver(now: number, sessions: Session[]) {
    const e = this.s.episode!
    if (e.kind === 'down') return
    for (const s of sessions.filter(atWork)) {
      const p = this.ensure(s, now)
      if (p.asked && p.episode === e.since) continue
      if (p.phase !== 'draft') continue
      p.asked = now
      p.episode = e.since
      console.log(`[relais] ${s.id.slice(0, 8)} priée de finir son étape · « ${s.title} »`)
      void this.host.send(s.id, tr(R).stop(this.untilText(now)), 'weevboss').catch((err) => console.error(`[relais] message d'arrêt à ${s.id.slice(0, 8)} : ${(err as Error).message}`))
      this.changed()
    }
  }

  /** Sessions that stopped (told to, cut by the limit, or their background work killed by it): their plan is on the table. */
  private collect(now: number, sessions: Session[]) {
    const e = this.s.episode!
    for (const s of sessions) {
      const p0 = this.planOf(s.id)
      // Back at work on its own (the user wrote to it): its plan no longer stands.
      if (p0?.phase === 'open' && atWork(s) && p0.episode === e.since) {
        p0.phase = 'closed'
        this.changed()
        continue
      }
      if (p0 && p0.episode === e.since && p0.phase !== 'draft') continue
      const cut = s.status === 'interrupted' && !!s.interrupted && STOPPED.has(s.interrupted.reason) && s.interrupted.at >= e.since - ERRORS_WITHIN_MS
      const handed = !!p0?.asked && p0.episode === e.since && !atWork(s) && now - p0.asked > 3000
      // A job it left writing a log (« job:… », core.ts logJobsOf) failing is its own outcome (a red test run), not work the limit killed.
      const bgKilled = e.kind !== 'near' && !atWork(s) && s.status !== 'needs_user' && s.subagents.some((a) => a.status === 'failed' && !a.id.startsWith('job:') && (a.endedAt ?? 0) >= e.since - 2 * 60_000)
      if (!cut && !handed && !bgKilled) continue
      this.open(this.ensure(s, now), s, now)
      this.changed()
    }
  }

  private open(p: Plan, s: Session, now: number) {
    p.phase = 'open'
    delete p.resolved
    p.episode = this.s.episode?.since ?? now
    p.at = now
    p.said = false
    // Written ahead: shown at once, and rewritten if the session went on working since.
    if (!p.text || s.lastActivityAt > (p.textAt ?? 0)) p.gen = this.writing.has(p.sessionId) ? p.gen : 'todo'
    console.log(`[relais] plan de reprise pour ${s.id.slice(0, 8)} · « ${s.title} »${p.text ? ' (écrit d’avance, mis à jour)' : ''}`)
  }

  private why(s: Session | undefined): string {
    const t = tr(R)
    if (s && atWork(s)) return t.why_running
    return t[`why_${this.s.episode?.kind ?? 'limit'}`]
  }

  /** Codex writes the plans, two at a time. */
  private write(now: number) {
    for (const p of this.s.plans) {
      if (this.writing.size >= MAX_WRITING) break
      if (p.gen !== 'todo' || (p.phase !== 'draft' && p.phase !== 'open')) continue
      const tr0 = this.host.transcript(p.sessionId)
      const s = this.host.sessions(now).find((x) => x.id === p.sessionId)
      p.gen = 'running'
      this.writing.add(p.sessionId)
      const t = tr(R)
      const msgs = tr0?.messages ?? []
      const lines = (list: string[]) => (list.length ? list.map((x) => `- ${x}`).join('\n') : t.none)
      const bg = (s?.subagents ?? tr0?.subagents ?? []).filter((a) => a.status !== 'done').slice(-12)
      void (async () => {
        try {
          const prompt = t.plan({
            marker: PLAN_MARKER,
            why: this.why(s),
            cwd: p.cwd,
            file: tr0?.file ?? '?',
            title: p.title,
            ask: clip(tr0?.firstPrompt ?? '', 1500) || t.none,
            last: clip(msgs.filter((m) => m.role === 'user' || m.role === 'orchestrator').slice(-1)[0]?.text ?? '', 1000) || t.none,
            replies: lines(msgs.filter((m) => m.role === 'assistant').slice(-3).map((m) => clip(m.text, 700))),
            steps: lines(msgs.filter((m) => m.role === 'event').slice(-10).map((m) => clip(m.text, 160))),
            background: lines(bg.map((a) => `${a.kind} « ${clip(a.label, 80)} » [${a.status}] ${clip(a.activity, 160)}`)),
            git: (await this.deps.git(p.cwd).catch(() => '')) || t.none,
            auto: !!p.auto,
            previous: p.text,
            note: p.note,
          })
          const text = await this.deps.write(p.cwd, prompt)
          p.text = text.trim()
          // Dated from the start of the reading: what the session did meanwhile is not in the plan.
          p.textAt = now
          p.gen = 'idle'
          if (p.resolved && p.phase === 'open') { delete p.resolved; p.at = Math.max(this.now(), p.at + 1) }
          delete p.error
          console.log(`[relais] plan écrit par Codex pour ${p.sessionId.slice(0, 8)} (${p.text.length} caractères)`)
        } catch (e) {
          if (p.resolved) { delete p.resolved; p.at = Math.max(this.now(), p.at + 1) }
          p.gen = 'failed'
          p.failedAt = now
          p.error = tr(R).planFailed
          console.error(`[relais] plan de ${p.sessionId.slice(0, 8)} : ${(e as Error).message}`)
        } finally {
          this.writing.delete(p.sessionId)
          this.changed()
          void this.tick()
        }
      })()
    }
  }

  /** Approved plans (all of them in mode auto): a Codex session opens in the same folder and does the work. */
  private carryOut() {
    for (const p of this.s.plans) {
      if (this.s.mode === 'auto' && p.phase === 'open' && p.gen === 'idle' && p.text && this.s.episode) p.phase = 'go'
      if (p.phase !== 'go' || p.relayTo || p.dispatchedAt || p.gen === 'todo' || p.gen === 'running' || this.launching.has(p.sessionId)) continue
      p.dispatchedAt = this.now()
      if (!this.save()) { p.error = tr(R).handoffUncertain; continue }
      this.launching.add(p.sessionId)
      const t = tr(R)
      const text = signAs('weevboss', t.go({ why: this.why(undefined), cwd: p.cwd, file: this.host.transcript(p.sessionId)?.file ?? '?', title: p.title, plan: p.text ?? '', note: p.note, auto: !!p.auto }))
      void (async () => {
        try {
          const to = p.auto && this.host.autoRun ? await this.host.autoRun(p.sessionId, text) : await this.host.openCodex(p.cwd, p.title, text)
          p.relayTo = to
          p.at = this.now()
          delete p.error
          this.host.settle(p.sessionId)
          console.log(`[relais] ${p.sessionId.slice(0, 8)} → Codex (${to}) · « ${p.title} »`)
        } catch (e) {
          p.phase = 'open'
          delete p.resolved
          p.at = Math.max(this.now(), p.at + 1)
          p.error = (e as Error).message
          console.error(`[relais] lancement du relais de ${p.sessionId.slice(0, 8)} : ${(e as Error).message}`)
        } finally {
          this.launching.delete(p.sessionId)
          this.changed()
        }
      })()
    }
  }

  /** weevboss on Claude was cut mid-answer: Codex gets the thread and answers the message left hanging. */
  private bossCut() {
    const e = this.s.episode!
    const stop = this.host.bossStop()
    if (!stop || !STOPPED.has(stop.reason) || stop.at < e.since - ERRORS_WITHIN_MS || stop.at <= (this.s.bossCutAt ?? 0)) return
    this.s.bossCutAt = stop.at
    this.save()
    void this.host.bossRelayCut().catch((err) => console.error(`[relais] weevboss sur Codex : ${(err as Error).message}`))
  }

  private untilText(now: number) {
    const e = this.s.episode
    return e?.until ? tr(R).until(clockOf(e.until, now, e.tz ?? this.s.tz)) : ''
  }

  /** One short notification per episode, then one when plans wait for a yes. */
  private announce(now: number) {
    const e = this.s.episode
    const t = tr(R)
    if (e && !e.announced) {
      e.announced = true
      // Already said for this window (the episode closed and reopened around the threshold): not twice.
      const win = e.window ?? 'none'
      const switches = (this.s.switches ??= {})
      const previous = switches[win]
      const same = previous && now < previous.until && e.kind !== 'down'
      this.s.switched = switches[win] = { window: win, until: e.until ?? now + UNKNOWN_RESET_MS }
      if (same) return this.changed()
      const title = e.kind === 'limit' ? t.limitTitle : e.kind === 'near' ? t.nearTitle(e.percent ?? this.s.switchAt, e.window) : t.downTitle
      const body = this.s.mode === 'auto' ? t.takesOver(this.untilText(now)) : t.plansToCome(this.untilText(now))
      this.host.notify(title, body, '/#relay', 'relay') // i18n-ignore : étiquette de notification
      this.host.say(t.said(title, body))
      this.changed()
    }
    if (this.s.mode !== 'ask') return
    const open = this.s.plans.filter((p) => p.phase === 'open' && !p.resolved)
    if (!open.length || open.some((p) => p.gen === 'todo' || p.gen === 'running') || open.every((p) => p.said)) return
    const fresh = open.filter((p) => !p.said && p.text)
    for (const p of open) p.said = true
    if (fresh.length) {
      this.host.notify(t.plansTitle(fresh.length), fresh.map((p) => p.title).join(' · ').slice(0, 180), '/#relay', 'relay-plans')
      this.host.say(t.plansSaid(fresh.map((p) => clip(p.title, 60))))
    }
    this.changed()
  }
}
