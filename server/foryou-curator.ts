// The curator of the « for you » stream (docs/foryou.md §3.5): everything in the stream that is written or counted
// rather than recorded. One loop, one spender.
//
// A timer (start(), never a request) calls tick() every few minutes:
// - always, no model: the milestones (turns delivered today crossing 10 / 25 / 50 / 100, three projects or more moving
//   the same day, the first auto task done, a streak of days with delivered turns), each emitted once;
// - while the app looks at the stream (a GET /api/foryou in the last 30 min), no model: « where the day stands », one
//   item per day replaced in place at most every 4 h (Claude's usage windows, turns per project, the auto queue);
// - while the app looks, Claude is logged in, no usage window of Claude is at 85 % or more (the last figures the
//   stream already has: never asked here), no back-off is running and fewer than DAILY_CAP calls were made today: at
//   most ONE model call, the first that is due among
//     1. the digest (smart): weevboss's recap, at most one per 5 min and only when something happened since the last;
//     2. the mail lines (haiku): one short « did this » line per mail still raw and unseen, up to 6 in one call;
//     3. improve (smart): one way weevils could serve this user better, at most one per 20 min, from goals, results and usage;
//     4. the insight (smart): one « did you know » on a repo active today, at most one per 10 min, one per repo and day.
// A call that fails (the model, or an answer that is not JSON) backs every producer off 1 h, doubling to 12 h, kept
// across restarts with the day's counter (DATA_DIR/foryou-curator.json). An answer that parses but is empty, too
// thin or says again what an earlier item said is dropped and its producer waits for its next turn.
//
// « More » under an insight (ForYouCurator.more) is the one call a tap starts: it counts in the same daily cap and
// answers nothing when the cap is reached, Claude is logged out or a usage window is nearly full.
//
// Session results are NOT summarised: the app shows « project · title » above the closing words, which already read as
// the summary (cleaned by the store: no raw media path, no signature); a model line would only repeat the title. Mail
// lines are: a mail's first line is often a greeting's neighbour, and the whole mail stays one tap away (body).
//
// Every generated item carries the language it was written in (hidden while the app reads another one).

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Session, Snapshot } from '../shared/api.ts'
import { detectLang } from '../shared/detect-lang.ts'
import type { ForYouGauge, ForYouItem } from '../shared/foryou.ts'
import type { UsageInfo } from '../shared/infra.ts'
import { DATA_DIR } from './config.ts'
import { haiku, parseJson, relay, smart } from './fast.ts'
import { USAGE_ALERT, lastWords, type ForYou, type ForYouCurator } from './foryou.ts'
import { lang, tr, user, withLang, type Lang } from './i18n.ts'
import CM from './i18n/core.ts'
import P from './i18n/foryou-curator.ts'
import M from './i18n/foryou.ts'
import { redact } from './memory.ts'
import { isRepeat } from './optimizers.ts'
import { claudeLogged } from './setup.ts'

// ---------------------------------------------------------------- budget and cadence

export const TICK_MS = 60_000
/** Model calls a day, « more » included. */
export const DAILY_CAP = 60
export const BACKOFF_MS = 3600_000
export const BACKOFF_MAX_MS = 12 * 3600_000
export const DIGEST_EVERY_MS = 5 * 60_000
/** A first digest (or one after a long silence) looks this far back at most. */
export const DIGEST_SPAN_MS = 12 * 3600_000
export const IMPROVE_EVERY_MS = 20 * 60_000
export const INSIGHT_EVERY_MS = 10 * 60_000
export const STAT_EVERY_MS = 4 * 3600_000
/** Mails are batched: a call at most this often. */
export const MAIL_EVERY_MS = 10 * 60_000
export const MAIL_BATCH = 6
/** The short lines (haiku, cheap) keep going past the 85 % gate, up to this share of a window, this many calls a day:
 *  a robotic report in the stream is worse than a few haiku calls. */
export const LINES_CEIL = 98
export const LINES_CAP = 16
/** Calls a day through Codex while Claude's usage is nearly full (its own subscription, which stays almost unused). */
export const RELAY_CAP = 120
export const TURN_STEPS = [10, 25, 50, 100]
export const STREAK_STEPS = [3, 7, 14, 30, 60, 100]
export const PROJECTS_STEP = 3
/** improve: an agent's question is said to have waited past this. */
export const WAITED_MS = 30 * 60_000

export const DIGEST_MAX = 600
export const THOUGHT_MAX = 240
export const IMPROVE_MAX = 400
export const INSIGHT_MAX = 220
export const MORE_MAX = 900
export const MAIL_LINE = 220

// ---------------------------------------------------------------- pure helpers (tested)

const pad = (n: number) => String(n).padStart(2, '0')
/** Local day, sortable: 2026-11-10. */
export const dayKey = (at: number) => {
  const d = new Date(at)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const dayBefore = (key: string) => {
  const [y, m, d] = key.split('-').map(Number)
  return dayKey(new Date(y, m - 1, d - 1, 12).getTime())
}
/** ISO week of a local date: 2026-W46. */
export function isoWeek(at: number): string {
  const d = new Date(at)
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7))
  const week = Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7)
  return `${t.getUTCFullYear()}-W${pad(week)}`
}

/** Model words as the stream shows them: one paragraph, no emoji, no quotes wrapped around the whole. */
const plain = (s: unknown) =>
  (typeof s === 'string' ? s : '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["“«]\s*([^"“”«»]*?)\s*["”»]$/, '$1')
    .trim()

/** Text held under max: whole when it fits, else cut after its last full sentence, else '' (strict) or clipped. */
export function fit(s: string, max: number, strict = false): string {
  if (s.length <= max) return s
  const head = s.slice(0, max)
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '), head.lastIndexOf('… '))
  if (end >= max * 0.4) return head.slice(0, end + 1)
  return strict ? '' : `${head.slice(0, max - 1).trimEnd()}…`
}

const repeats = (text: string, known: string[]) => isRepeat(text, known.map((title) => ({ title })))

export interface Digest {
  text: string
  thought?: string
  actions?: { label: string; brief: string }[]
}

const buttons = (raw: unknown, max: number): { label: string; brief: string }[] =>
  (Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [])
    .map((a) => ({ label: plain((a as { label?: unknown })?.label).slice(0, 48).trim(), brief: typeof (a as { brief?: unknown })?.brief === 'string' ? (a as { brief: string }).brief.trim().slice(0, 2000) : '' }))
    .filter((a) => a.label.length >= 2 && a.brief.length >= 10)
    .slice(0, max)

/** weevboss's recap as the model wrote it, checked: real words, not said before, a thought only when it adds something, two actions at most. */
export function parseDigest(raw: unknown, known: string[] = []): Digest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const text = fit(plain(r.text), DIGEST_MAX)
  if (text.length < 20 || repeats(text, known)) return null
  const thought = fit(plain(r.thought), THOUGHT_MAX, true)
  const actions = buttons(r.actions, 2)
  return { text, ...(thought.length >= 12 && !repeats(thought, [text, ...known]) ? { thought } : {}), ...(actions.length ? { actions } : {}) }
}

export interface Improve {
  title?: string
  text: string
  action: { label: string; brief: string }
}

/** One way to serve the user better: words, one button with its brief, never an idea already given. */
export function parseImprove(raw: unknown, known: string[] = []): Improve | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const text = fit(plain(r.text), IMPROVE_MAX)
  const title = plain(r.title).slice(0, 60).trim()
  const [action] = buttons(r.action ?? r.actions, 1)
  if (text.length < 20 || !action) return null
  if (repeats(text, known) || (title && repeats(title, known))) return null
  return { ...(title.length >= 3 ? { title } : {}), text, action }
}

/** A « did you know »: one or two full sentences within 220 characters, not said before. */
export function parseInsight(raw: unknown, known: string[] = []): { text: string; about?: string } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const text = fit(plain(r.text), INSIGHT_MAX, true)
  if (text.length < 20 || repeats(text, known)) return null
  const about = plain(r.about).slice(0, 60).trim()
  return { text, ...(about ? { about } : {}) }
}

/** The mail lines by number (1-based, as asked): short, one line each. */
export function parseLines(raw: unknown, n: number): Map<number, string> {
  const out = new Map<number, string>()
  const list: unknown[] = Array.isArray(raw) ? raw : Array.isArray((raw as { lines?: unknown } | null)?.lines) ? (raw as { lines: unknown[] }).lines : []
  for (const x of list as Record<string, unknown>[]) {
    if (!x || typeof x !== 'object') continue
    const i = Math.round(Number(x.n ?? x.id))
    const line = fit(plain(x.line), MAIL_LINE)
    if (i >= 1 && i <= n && line.length >= 8 && !out.has(i)) out.set(i, line)
  }
  return out
}

// ---------------------------------------------------------------- what is really in a repo

export interface RepoFacts {
  /** Names declared in the manifests (package.json, pyproject.toml, requirements.txt, go.mod, Cargo.toml). */
  deps: string[]
  /** Names at the root (folders end with /), no dot file. */
  files: string[]
  /** Subjects of the last commits. */
  commits: string[]
}

export const MAX_DEPS = 40
export const MAX_FILES = 40
export const MAX_COMMITS = 8
const MANIFEST_BYTES = 96 * 1024

const head = (file: string): string => {
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(MANIFEST_BYTES)
      return buf.subarray(0, fs.readSync(fd, buf, 0, MANIFEST_BYTES, 0)).toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return ''
  }
}

/** Dependency names of a manifest's text (pure): only names, never versions, paths or values. */
export function manifestDeps(name: string, text: string): string[] {
  const out: string[] = []
  const section = (re: RegExp) => [...text.matchAll(re)].map((m) => m[1])
  if (name === 'package.json') {
    try {
      const j = JSON.parse(text) as Record<string, unknown>
      for (const k of ['dependencies', 'devDependencies', 'peerDependencies']) if (j[k] && typeof j[k] === 'object') out.push(...Object.keys(j[k] as object))
    } catch {
      /* cut or broken: nothing */
    }
  } else if (name === 'pyproject.toml') {
    for (const block of section(/dependencies\s*=\s*\[([\s\S]*?)\]/g)) out.push(...[...block.matchAll(/["']\s*([A-Za-z0-9][A-Za-z0-9_.-]*)/g)].map((m) => m[1]))
    for (const block of section(/\[tool\.poetry(?:\.[\w-]+)*\.dependencies\]([\s\S]*?)(?=\n\[|$)/g)) out.push(...[...block.matchAll(/^\s*([A-Za-z0-9][A-Za-z0-9_.-]*)\s*=/gm)].map((m) => m[1]))
  } else if (name === 'requirements.txt') {
    out.push(...[...text.matchAll(/^\s*([A-Za-z0-9][A-Za-z0-9_.-]*)\s*(?:[=<>~!\[;]|$)/gm)].map((m) => m[1]))
  } else if (name === 'go.mod') {
    out.push(...[...text.matchAll(/^\s*(?:require\s+)?([\w.-]+\.[a-z]{2,}\/[^\s]+)\s+v\d/gm)].map((m) => m[1]))
  } else if (name === 'Cargo.toml') {
    for (const block of section(/\[(?:dev-|build-)?dependencies\]([\s\S]*?)(?=\n\[|$)/g)) out.push(...[...block.matchAll(/^\s*([A-Za-z0-9][A-Za-z0-9_-]*)\s*=/gm)].map((m) => m[1]))
  }
  return [...new Set(out.filter((d) => d.length <= 60 && d !== 'python'))]
}

const MANIFESTS = ['package.json', 'pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml']

/** What a repo holds, read cheaply: manifest names, the root listing, the last commit subjects. Never a source file. */
export async function repoFacts(dir: string): Promise<RepoFacts> {
  const deps = [...new Set(MANIFESTS.flatMap((name) => manifestDeps(name, head(path.join(dir, name)))))].slice(0, MAX_DEPS)
  let files: string[] = []
  try {
    files = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name.length <= 60)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort()
      .slice(0, MAX_FILES)
  } catch {
    /* gone */
  }
  const commits = await new Promise<string[]>((resolve) => {
    const c = execFile('git', ['-C', dir, 'log', `-${MAX_COMMITS}`, '--no-merges', '--format=%s'], { timeout: 5000, maxBuffer: 1 << 16, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }, (err, out) =>
      resolve(err ? [] : String(out).split('\n').map((l) => redact(l.trim()).slice(0, 100)).filter(Boolean).slice(0, MAX_COMMITS)),
    )
    c.stdin?.end()
  })
  return { deps, files, commits }
}

// ---------------------------------------------------------------- usage patterns (improve), counted before any model

export interface Patterns {
  /** Sessions with a recorded turn, per project name, most first. */
  projects: [string, number][]
  hours: { morning: number; afternoon: number; evening: number; night: number }
  cuts: number
  /** Why they were cut, in words. */
  cutWhy: string[]
  waited: number
  auto: { done: number; failed: number; unanswered: number }
  /** Setup bricks not connected (voice, dictation, github). */
  unused: ('voice' | 'dictation' | 'github')[]
  /** How many sessions the figures rest on. */
  sessions: number
}

export function usagePatterns(items: ForYouItem[], snap: Snapshot, now: number, eligible: (s: Session) => boolean = () => true): Patterns {
  const name = (id?: string) => snap.projects.find((p) => p.id === id)?.name ?? id ?? '?'
  const per = new Map<string, number>()
  const hours = { morning: 0, afternoon: 0, evening: 0, night: 0 }
  const mine = items.filter((i) => i.kind === 'session')
  for (const i of mine) {
    per.set(name(i.projectId), (per.get(name(i.projectId)) ?? 0) + 1)
    if (i.tone !== 'result') continue
    const h = new Date(i.at).getHours()
    hours[h < 6 ? 'night' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening']++
  }
  const sessions = snap.sessions.filter(eligible)
  const cut = sessions.filter((s) => s.status === 'interrupted')
  const why = new Map<string, number>()
  for (const s of cut) {
    const w = tr(CM).cutWhy(s.interrupted?.reason ?? 'died')
    why.set(w, (why.get(w) ?? 0) + 1)
  }
  const auto = snap.optimizers ?? []
  const setup = snap.setup
  return {
    projects: [...per].sort((a, b) => b[1] - a[1]).slice(0, 6),
    hours,
    cuts: Math.max(cut.length, mine.filter((i) => i.tone === 'alert').length),
    cutWhy: [...why].sort((a, b) => b[1] - a[1]).map(([w, n]) => (n > 1 ? `${w} × ${n}` : w)),
    waited: sessions.filter((s) => s.status === 'needs_user' && now - s.lastActivityAt > WAITED_MS).length,
    auto: { done: auto.filter((o) => o.state === 'done').length, failed: auto.filter((o) => o.state === 'failed').length, unanswered: auto.filter((o) => o.state === 'proposed').length },
    unused: setup ? (['voice', 'dictation', 'github'] as const).filter((b) => setup[b] === false) : [],
    sessions: mine.length,
  }
}

// ---------------------------------------------------------------- the curator

export interface CuratorDeps {
  /** Default DATA_DIR/foryou-curator.json. */
  file?: string
  now?: () => number
  logged?: () => boolean
  /** The last known usage figures (default: the ones the stream holds). Never a request. */
  usage?: () => UsageInfo | null
  /** weevils' memory (main machine), for the digest's thought. */
  memory?: () => { digest(max?: number, chars?: number): string } | null | undefined
  /** Codex call (tests). Default: relay() of fast.ts. */
  relay?: (prompt: string, timeout: number) => Promise<string>
  /** Build identity actually served by this server. */
  deployment?: () => { commit: string; at: number } | null
  /** Folder of a repo on this machine (undefined or a throw: not here). */
  repoDir?: (repo: string) => string | undefined
  facts?: (dir: string) => Promise<RepoFacts>
  /** The machine page's advice lines, when there are some. */
  advice?: () => Promise<string[]>
}

interface State {
  calls: { day: string; n: number }
  /** Haiku calls of the short lines today (their own small allowance, see LINES_CAP). */
  lines?: { day: string; n: number }
  /** Codex calls today (relay). */
  relay?: { day: string; n: number }
  fails: number
  failUntil: number
  digestAt: number
  improveAt: number
  insightAt: number
  mailAt: number
  statAt: number
  /** « repo:day » → when it was looked at, and the item written (none: nothing worth saying, or nothing to read). */
  insights: Record<string, { at: number; repo: string; id?: string }>
  /** Milestones already emitted: id → when. */
  done: Record<string, number>
  /** Turns delivered per day (for the streak). */
  days: Record<string, number>
}

const EMPTY = (): State => ({ calls: { day: '', n: 0 }, fails: 0, failUntil: 0, digestAt: 0, improveAt: 0, insightAt: 0, mailAt: 0, statAt: 0, insights: {}, done: {}, days: {} })

type Job = () => Promise<void>

/** The question cards a model wrote: [{n, ask, title, question, options}], checked and capped. */
export function parseAsks(raw: unknown): Map<number, { ask: boolean; title?: string; question?: string; options?: string[] }> {
  const out = new Map<number, { ask: boolean; title?: string; question?: string; options?: string[] }>()
  if (!Array.isArray(raw)) return out
  const str = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '')
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue
    const o = x as Record<string, unknown>
    const n = Number(o.n)
    const question = str(o.question, 320)
    if (!Number.isInteger(n) || !question) continue
    const options = Array.isArray(o.options) ? o.options.map((v) => str(v, 40)).filter(Boolean).slice(0, 3) : []
    const ask = o.ask !== false
    out.set(n, ask ? { ask, title: str(o.title, 60) || undefined, question, options } : { ask, question })
  }
  return out
}

export class Curator implements ForYouCurator {
  readonly fy: ForYou
  readonly file: string
  private deps: CuratorDeps
  private s: State
  private now: () => number
  /** The one model call of the loop, while it runs. */
  private running: Promise<void> | null = null
  /** The running job really called the model (a job may find nothing to ask). */
  private spent = false
  /** « More » asked twice for the same item: one call. */
  private asking = new Map<string, Promise<string>>()

  constructor(fy: ForYou, deps: CuratorDeps = {}) {
    this.fy = fy
    this.deps = deps
    this.file = deps.file ?? path.join(DATA_DIR, 'foryou-curator.json')
    this.now = deps.now ?? Date.now
    this.s = (() => {
      const e = EMPTY()
      try {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<State>
        const num = (v: unknown) => Number(v) || 0
        const obj = <T>(v: unknown): Record<string, T> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, T>) : {})
        return {
          calls: raw.calls && typeof raw.calls.day === 'string' ? { day: raw.calls.day, n: num(raw.calls.n) } : e.calls,
          fails: num(raw.fails),
          failUntil: num(raw.failUntil),
          digestAt: num(raw.digestAt),
          improveAt: num(raw.improveAt),
          insightAt: num(raw.insightAt),
          mailAt: num(raw.mailAt),
          statAt: num(raw.statAt),
          insights: obj(raw.insights),
          done: obj(raw.done),
          days: obj(raw.days),
        }
      } catch {
        return e
      }
    })()
  }

  /** The loop: a timer of its own, never a request. */
  start() {
    const run = () => void this.tick().catch((e) => console.error(`[foryou] curateur : ${(e as Error).message}`))
    setTimeout(run, 30_000).unref?.()
    setInterval(run, TICK_MS).unref?.()
  }

  private save() {
    const now = this.now()
    for (const [k, v] of Object.entries(this.s.insights)) if (now - v.at > 35 * 86_400_000) delete this.s.insights[k]
    // Day-stamped milestones are forgotten after a while; the firsts (no date in their id) stay for good.
    for (const [k, at] of Object.entries(this.s.done)) if (/\d{4}-\d{2}-\d{2}/.test(k) && now - at > 120 * 86_400_000) delete this.s.done[k]
    const days = Object.keys(this.s.days).sort()
    for (const d of days.slice(0, Math.max(0, days.length - 150))) delete this.s.days[d]
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.s), { mode: 0o600 })
      fs.renameSync(tmp, this.file)
    } catch (e) {
      console.error(`[foryou] curateur, écriture : ${(e as Error).message}`)
    }
  }

  // ---------------------------------------------------------------- budget

  /** How the next call goes: full (Claude has room: sonnet and haiku), relay (Claude nearly full, Codex has room:
   *  everything through Codex), lean (neither: haiku only, up to LINES_CEIL), or nothing. */
  mode(now = this.now()): 'full' | 'relay' | 'lean' | null {
    if (this.can(now)) return 'full'
    const u = this.deps.usage ? this.deps.usage() : this.fy.usageKnown()
    const cx = u?.codex
    const relayDay = this.s.relay?.day === dayKey(now) ? this.s.relay.n : 0
    if (cx?.ok && cx.windows.length && cx.windows.every((w) => w.percent < USAGE_ALERT) && relayDay < RELAY_CAP && now >= this.s.failUntil) return 'relay'
    return this.lean(now) ? 'lean' : null
  }
  /** The mode of the call being made. */
  private via: 'full' | 'relay' | 'lean' = 'full'

  /** A model answer by the current mode: Codex in relay, haiku in lean, else the model asked for. */
  private ask(kind: 'smart' | 'haiku', prompt: string, timeout: number, via = this.via): Promise<string> {
    if (via === 'relay') return (this.deps.relay ?? relay)(prompt, Math.max(timeout, 120_000))
    return via === 'lean' || kind === 'haiku' ? haiku(prompt, Math.min(timeout, 60_000)) : smart(prompt, timeout)
  }

  /** Haiku calls of the short lines made today. */
  lineCalls(now = this.now()): number {
    return this.s.lines?.day === dayKey(now) ? this.s.lines.n : 0
  }

  /** The short lines may be written now even though the bigger calls wait: figures known, no window past LINES_CEIL. */
  lean(now = this.now()): boolean {
    const q = (this.deps.usage ? this.deps.usage() : this.fy.usageKnown())?.claude
    if (!q?.ok || q.windows.some((w) => w.percent >= LINES_CEIL)) return false
    return this.logged() && this.lineCalls(now) < LINES_CAP && now >= this.s.failUntil
  }

  /** Model calls made today. */
  calls(now = this.now()): number {
    return this.s.calls.day === dayKey(now) ? this.s.calls.n : 0
  }

  /** A usage window of Claude is nearly full, by the last figures known. None known yet (a start): held back too — a
   *  call made blind at 90 % of the week is exactly what this gate is for. */
  private hot(): boolean {
    const q = (this.deps.usage ? this.deps.usage() : this.fy.usageKnown())?.claude
    if (!q?.ok) return true
    return q.windows.some((w) => w.percent >= USAGE_ALERT)
  }

  private logged(): boolean {
    return (this.deps.logged ?? claudeLogged)()
  }

  /** A model call may start now: logged in, under the day's cap, no window nearly full (and, for the loop, no back-off). */
  can(now = this.now(), loop = true): boolean {
    return this.logged() && this.calls(now) < DAILY_CAP && !(loop && now < this.s.failUntil) && !this.hot()
  }

  /** Counted when the call starts, kept at once: a crash or a restart never gives the call back. Each mode has its count. */
  private spend(now: number, via = this.via) {
    const d = dayKey(now)
    if (via === 'relay') this.s.relay = { day: d, n: (this.s.relay?.day === d ? this.s.relay.n : 0) + 1 }
    else if (via === 'lean') this.s.lines = { day: d, n: this.lineCalls(now) + 1 }
    else this.s.calls = { day: d, n: this.calls(now) + 1 }
    this.spent = true
    this.save()
  }

  /** Reserve against current usage after any asynchronous preparation. */
  private reserve(): boolean {
    const mode = this.mode(this.now())
    if (!mode) return false
    this.via = mode
    this.spend(this.now(), mode)
    return true
  }

  // ---------------------------------------------------------------- the loop

  /**
   * One pass: milestones, then (app looking) the day's bars, then (budget allowing) at most one model call. Resolves
   * when that call, if any, is over.
   */
  tick(now = this.now()): Promise<void> {
    try {
      this.milestones(now)
      if (!this.fy.wanted(now)) return Promise.resolve()
      this.stat(now)
    } catch (e) {
      console.error(`[foryou] curateur : ${(e as Error).message}`)
    }
    if (this.running) return this.running
    if (!this.fy.wanted(now)) return Promise.resolve()
    const m = this.mode(now)
    if (!m) return Promise.resolve()
    this.via = m
    // A question waiting for its clear wording first, then the lines said in passing, then the rest.
    const job =
      m === 'full'
        ? (this.askJob(now) ?? this.digestJob(now) ?? this.mailJob(now) ?? this.improveJob(now) ?? this.insightJob(now))
        : (this.askJob(now) ?? this.mailJob(now) ?? this.digestJob(now) ?? this.insightJob(now) ?? this.improveJob(now))
    if (!job) return Promise.resolve()
    this.running = (async () => {
      this.spent = false
      try {
        await job()
        // Only an answer from the model says it is back.
        if (this.spent) {
          this.s.fails = 0
          this.s.failUntil = 0
        }
      } catch (e) {
        this.s.fails++
        const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_MS * 2 ** (this.s.fails - 1))
        this.s.failUntil = now + wait
        console.error(`[foryou] curateur : ${(e as Error).message} · nouvel essai dans ${Math.round(wait / 60_000)} min`)
      } finally {
        this.save()
      }
    })().finally(() => (this.running = null))
    return this.running
  }

  private json(text: string): unknown {
    const raw = parseJson<unknown>(text)
    // i18n-ignore : raison de l'échec, seulement dans le journal
    if (raw === null) throw new Error('no JSON')
    return raw
  }

  // ---------------------------------------------------------------- milestones (no model)

  private milestones(now: number) {
    const t = tr(P)
    const l = lang()
    const d = dayKey(now)
    const { n, by } = this.fy.deliveredToday(now)
    let dirty = false
    if (n > 0 && this.s.days[d] !== n) {
      this.s.days[d] = n
      dirty = true
    }
    /** Emits the highest step reached and never a lower one after it. */
    const cross = (steps: number[], value: number, id: (step: number) => string, text: (step: number) => string) => {
      const reached = steps.filter((x) => value >= x)
      const top = reached[reached.length - 1]
      if (top === undefined || this.s.done[id(top)]) return
      for (const x of reached) this.s.done[id(x)] = now
      dirty = true
      this.fy.add({ id: id(top), kind: 'milestone', text: text(top), lang: l })
    }
    cross(TURN_STEPS, n, (x) => `ms:turns:${d}:${x}`, (x) => t.msTurns(x))
    const active = Object.values(by).filter((x) => x > 0).length
    if (active >= PROJECTS_STEP && !this.s.done[`ms:projects:${d}`]) {
      this.s.done[`ms:projects:${d}`] = now
      dirty = true
      this.fy.add({ id: `ms:projects:${d}`, kind: 'milestone', text: t.msProjects(active), lang: l })
    }
    if (!this.s.done['ms:auto-first'] && (this.fy.w.snapshot().optimizers ?? []).some((o) => o.state === 'done')) {
      this.s.done['ms:auto-first'] = now
      dirty = true
      this.fy.add({ id: 'ms:auto-first', kind: 'milestone', text: t.msAutoFirst, lang: l, open: { page: 'auto' } })
    }
    let streak = 0
    let first = d
    for (let k = d; (this.s.days[k] ?? 0) > 0; k = dayBefore(k)) {
      streak++
      first = k
    }
    // One streak, counted from its first day: each length is said once.
    cross(STREAK_STEPS, streak, (x) => `ms:streak:${first}:${x}`, (x) => t.msStreak(x))
    if (dirty) this.save()
  }

  // ---------------------------------------------------------------- where the day stands (no model)

  private stat(now: number) {
    if (now - this.s.statAt < STAT_EVERY_MS) return
    const t = tr(P)
    const tm = tr(M)
    const snap = this.fy.w.snapshot()
    const gauges: ForYouGauge[] = []
    const q = (this.deps.usage ? this.deps.usage() : this.fy.usageKnown())?.claude
    for (const w of q?.ok ? q.windows : []) {
      const window = w.kind === 'session' ? tm.window_session : w.kind === 'week' ? tm.window_week : tm.window_model(w.label ?? '').trim()
      const percent = Math.max(0, Math.min(100, Math.round(w.percent)))
      gauges.push({ label: t.statUsage(window), value: percent, max: 100, shown: t.percent(percent), ...(w.percent >= USAGE_ALERT ? { hot: true } : {}) })
    }
    const usage = gauges.length > 0
    const { n, by } = this.fy.deliveredToday(now)
    for (const [id, turns] of Object.entries(by).filter(([, x]) => x > 0).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 4)) {
      gauges.push({ label: snap.projects.find((p) => p.id === id)?.name ?? id, value: turns, max: n, shown: t.statTurns(turns, n), projectId: id })
    }
    const auto = snap.optimizers ?? []
    const running = auto.filter((o) => o.state === 'running').length
    const queued = auto.filter((o) => o.state === 'queued').length
    if (running + queued > 0) gauges.push({ label: t.statAuto, value: running, max: running + queued, shown: t.statAutoShown(running, queued) })
    if (!gauges.length) return
    this.s.statAt = now
    this.fy.add({ id: `stat:${dayKey(now)}`, kind: 'stat', text: t.statText(n), gauges, lang: lang(), ...(usage ? { open: { page: 'usage' as const } } : {}) })
    this.save()
  }

  // ---------------------------------------------------------------- the digest (weevboss's voice)

  private digestJob(now: number): Job | null {
    if (now - this.s.digestAt < DIGEST_EVERY_MS) return null
    const since = Math.max(this.s.digestAt, now - DIGEST_SPAN_MS)
    const snap = this.fy.w.snapshot()
    const project = (id?: string) => snap.projects.find((p) => p.id === id)?.name ?? id ?? '?'
    const mine = snap.sessions.filter((s) => this.fy.eligible(s))
    const results = this.fy.recent(['session'], 80).filter((i) => i.tone === 'result' && i.at > since)
    const waiting = mine.filter((s) => s.status === 'needs_user' || s.status === 'interrupted')
    const boss = this.fy.recent(['boss'], 30)
    const posts = boss.filter((i) => i.at > since && i.who === 'weevboss' && !i.id.startsWith('d:'))
    const mails = this.fy.recent(['mail'], 30).filter((i) => i.at > since)
    const ended = (snap.optimizers ?? []).filter((o) => (o.state === 'done' || o.state === 'failed') && (o.endedAt ?? 0) > since)
    const fresh = waiting.filter((s) => Math.max(s.lastActivityAt, s.interrupted?.at ?? 0) > since)
    // Nothing happened: nothing to say, and no call.
    if (!results.length && !fresh.length && !posts.length && !mails.length && !ended.length) return null
    const t = tr(P)
    const l = lang()
    const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)
    const earlier = boss.filter((i) => i.id.startsWith('d:')).slice(0, 3).map((i) => i.text)
    const prompt = t.digest({
      user: user(),
      memory: this.deps.memory?.()?.digest(10, 1200) ?? '',
      done: results.slice(0, 12).map((i) => t.line(project(i.projectId), i.title ?? '', short(i.text.replace(/\s+/g, ' '), 220))).join('\n'),
      waiting: waiting.slice(0, 6).map((s) => t.line(project(s.projectId), s.title.replace(/^\s*\[from:[a-z0-9_-]+\]\s*/i, ''), s.status === 'needs_user' ? short((s.attention ?? '').replace(/\s+/g, ' '), 160) : tr(CM).cutWhy(s.interrupted?.reason ?? 'died'))).join('\n'),
      counts: t.counts({
        delivered: results.length,
        started: mine.filter((s) => (s.openedAt ?? 0) > since).length,
        asking: waiting.filter((s) => s.status === 'needs_user').length,
        cut: waiting.filter((s) => s.status === 'interrupted').length,
        mails: mails.length,
        autoDone: ended.filter((o) => o.state === 'done').length,
        autoFailed: ended.filter((o) => o.state === 'failed').length,
        posts: posts.length,
      }),
      earlier: earlier.map((x) => `- ${short(x.replace(/\s+/g, ' '), 300)}`).join('\n'),
    })
    return async () => {
      if (!this.reserve()) return
      const d = parseDigest(this.json(await this.ask('smart', prompt, 120_000)), earlier)
      // Answered, kept or not: the next one after DIGEST_EVERY_MS.
      this.s.digestAt = now
      if (!d) return void console.log('[foryou] curateur : point de weevboss écarté (vide ou déjà dit)')
      this.fy.add({ id: `d:${now.toString(36)}`, kind: 'boss', who: 'weevboss', text: d.thought ? `${d.text}\n\n${d.thought}` : d.text, actions: d.actions, lang: l })
    }
  }

  // ---------------------------------------------------------------- question cards

  /** A session waiting on the user: its last message read by a light model into a clear question with its options. */
  private askJob(_now: number): Job | null {
    const qs = this.fy.rawAsks(4)
    if (!qs.length) return null
    const t = tr(P)
    const l = lang()
    return async () => {
      const said = await Promise.all(qs.map((q) => this.fy.w.detailAny(q.sessionId).then((d) => (d && lastWords(d.messages)) ?? '').catch(() => '')))
      const items = qs.map((q, i) => t.askItem(i + 1, q.project, q.title, (said[i] || q.attention).slice(-2500)))
      if (!this.reserve()) return
      let got: Map<number, { ask: boolean; title?: string; question?: string; options?: string[] }>
      try {
        got = parseAsks(this.json(await this.ask('haiku', t.asks(items.join('\n\n'), this.fy.w.snapshot().config?.userName || ''), 60_000)))
      } catch (e) {
        for (const q of qs) this.fy.askRead(q.id, null, q.attention)
        throw e
      }
      qs.forEach((q, i) => this.fy.askRead(q.id, got.get(i + 1) ?? null, q.attention))
      void l
    }
  }

  // ---------------------------------------------------------------- mail lines

  private mailJob(now: number): Job | null {
    if (now - this.s.mailAt < MAIL_EVERY_MS) return null
    const mails = this.fy.rawMails(MAIL_BATCH)
    // Sessions' closing words too: the stream says « did this » in a line, never the whole report.
    const results = this.fy.rawResults(Math.max(0, MAIL_BATCH - mails.length))
    if (!mails.length && !results.length) return null
    const t = tr(P)
    const l = lang()
    const snap = this.fy.w.snapshot()
    const name = (id: string) => snap.config?.authors?.find((a) => a.id === id)?.name ?? id
    const items = [
      ...mails.map((m, i) => t.mailItem(i + 1, name(m.who), m.subject, m.text.slice(0, 1500))),
      ...results.map((r, i) => t.resultItem(mails.length + i + 1, r.project, r.asked, Math.round((now - r.askedAt) / 60_000), r.text.slice(0, 1500))),
    ]
    const prompt = t.mailLines(items.join('\n\n'), this.fy.w.snapshot().config?.userName || '', this.deps.memory?.()?.digest(8, 700) ?? '')
    return async () => {
      if (!this.reserve()) return
      this.s.mailAt = now
      let lines: Map<number, string>
      try {
        lines = parseLines(this.json(await this.ask('haiku', prompt, 60_000)), mails.length + results.length)
      } catch (e) {
        // These keep their first line: the same batch is never sent twice.
        for (const m of mails) this.fy.mailLine(m.id, null)
        for (const r of results) this.fy.resultLine(r.id, null)
        throw e
      }
      mails.forEach((m, i) => this.fy.mailLine(m.id, lines.get(i + 1) ?? null, detectLang(lines.get(i + 1) ?? '') ?? l))
      results.forEach((r, i) => {
        const line = lines.get(mails.length + i + 1) ?? null
        this.fy.resultLine(r.id, line, detectLang(line ?? '') ?? l)
      })
    }
  }

  // ---------------------------------------------------------------- improve

  private improveJob(now: number): Job | null {
    if (now - this.s.improveAt < IMPROVE_EVERY_MS) return null
    const snap = this.fy.w.snapshot()
    const p = usagePatterns(this.fy.recent(['session'], 200), snap, now, (s) => this.fy.eligible(s))
    // Too little to draw anything from: no call.
    if (p.sessions < 3 && !p.unused.length && !p.cuts && !p.waited) return null
    const t = tr(P)
    const l = lang()
    const lines = [
      this.deps.memory?.()?.digest(10, 1600) ?? '',
      ...this.fy.recent(['session', 'media'], 12).map((i) => [i.projectId, i.title, i.text].filter(Boolean).join(' · ').slice(0, 350)),
      p.projects.length ? t.patProjects(p.projects.map(([n, c]) => `${n} ${c}`).join(', ')) : '',
      p.sessions ? t.patHours(p.hours) : '',
      t.patCuts(p.cuts, p.cutWhy.join(', ')),
      t.patWaited(p.waited),
      t.patAuto(p.auto),
      p.unused.length ? t.patUnused(p.unused.map((b) => t[`brick_${b}`]).join(', ')) : '',
    ].filter(Boolean)
    const known = this.fy.recent(['improve'], 30)
    const earlier = known.map((i) => `- ${i.title ? `${i.title} : ` : ''}${i.text.replace(/\s+/g, ' ').slice(0, 200)}`).join('\n')
    const who = user()
    return async () => {
      const advice = ((await this.deps.advice?.().catch(() => [])) ?? []).filter((a) => typeof a === 'string' && a.trim()).slice(0, 5)
      if (advice.length) lines.push(t.patAdvice(advice.map((a) => `- ${a.replace(/\s+/g, ' ').slice(0, 240)}`).join('\n')))
      if (!this.reserve()) return
      const got = parseImprove(this.json(await this.ask('smart', t.improve({ user: who, patterns: lines.join('\n'), earlier }), 120_000)), known.flatMap((i) => [i.text, ...(i.title ? [i.title] : [])]))
      this.s.improveAt = now
      if (!got) return void console.log('[foryou] curateur : idée écartée (vide ou déjà dite)')
      this.fy.add({ kind: 'improve', tone: 'magic', title: got.title, text: got.text, actions: [got.action], lang: l })
    }
  }

  // ---------------------------------------------------------------- insight

  private factsText(t: (typeof P)['en'], f: RepoFacts, last?: ForYouItem): string {
    return [
      f.deps.length ? t.factsDeps(f.deps.join(', ')) : '',
      f.files.length ? t.factsFiles(f.files.join(', ')) : '',
      f.commits.length ? t.factsCommits(f.commits.map((c) => `- ${c}`).join('\n')) : '',
      last ? t.factsLast(last.title ?? '', last.text.replace(/\s+/g, ' ').slice(0, 220)) : '',
    ]
      .filter(Boolean)
      .join('\n')
  }

  private async facts(repo: string): Promise<RepoFacts | null> {
    let dir: string | undefined
    try {
      dir = this.deps.repoDir?.(repo)
    } catch {
      /* not on this machine */
    }
    if (!dir) return null
    const f = await (this.deps.facts ?? repoFacts)(dir).catch(() => null)
    return f && (f.deps.length || f.commits.length) ? f : null
  }

  private insightJob(now: number): Job | null {
    if (now - this.s.insightAt < INSIGHT_EVERY_MS) return null
    const today = dayKey(now)
    const day = dayKey(now)
    const snap = this.fy.w.snapshot()
    const s = snap.sessions
      .filter((x) => x.repo && dayKey(x.lastActivityAt) === today && this.fy.eligible(x))
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .find((x) => !this.s.insights[`${x.repo}:${day}`])
    if (!s?.repo) return null
    const repo = s.repo
    const key = `${repo}:${day}`
    const t = tr(P)
    const l = lang()
    const known = this.fy.recent(['insight'], 30).map((i) => i.text)
    const last = this.fy.recent(['session'], 80).find((i) => i.tone === 'result' && i.projectId === s.projectId)
    return async () => {
      const f = await this.facts(repo)
      // Looked at for this day either way: a repo with nothing to read is not read again at every tick.
      this.s.insights[key] = { at: now, repo }
      if (!f) return
      if (!this.reserve()) return
      const got = parseInsight(this.json(await this.ask('smart', t.insight({ repo, facts: this.factsText(t, f, last), earlier: known.slice(0, 12).map((x) => `- ${x}`).join('\n') }), 120_000)), known)
      this.s.insightAt = now
      if (!got) return void console.log(`[foryou] curateur : rien de sûr à dire sur ${repo}`)
      const item = this.fy.add({ id: `i:${repo}:${day}`, kind: 'insight', projectId: s.projectId, text: got.text, more: true, lang: l })
      if (item) this.s.insights[key].id = item.id
    }
  }

  /**
   * « More » under an insight: a longer answer, in the language of the item. '' when it cannot be asked now (cap,
   * login, usage) or the model fails: the store then says there is nothing more for now, and a later tap asks again.
   */
  more(item: ForYouItem): Promise<string> {
    const flying = this.asking.get(item.id)
    if (flying) return flying
    const now = this.now()
    // A tap: any mode with room will do (a back-off of the loop does not hold it).
    const m = this.can(now, false) ? 'full' : this.mode(now)
    if (item.kind !== 'insight' || !m) return Promise.resolve('')
    const l: Lang = detectLang(item.text) ?? lang()
    const t = withLang(l, () => tr(P))
    const repo = Object.values(this.s.insights).find((x) => x.id === item.id)?.repo ?? item.projectId ?? ''
    const p = (async () => {
      const f = repo ? await this.facts(repo) : null
      // Asked again while the facts were read: the cap may have been reached meanwhile.
      const current = this.can(this.now(), false) ? 'full' : this.mode(this.now())
      if (!current) return ''
      this.spend(this.now(), current)
      try {
        return fit(plain(await this.ask('smart', t.more({ repo: repo || '?', text: item.text, facts: f ? this.factsText(t, f) : '' }), 120_000, current)), MORE_MAX)
      } catch (e) {
        console.error(`[foryou] curateur, « plus » : ${(e as Error).message}`)
        return ''
      }
    })().finally(() => this.asking.delete(item.id))
    this.asking.set(item.id, p)
    return p
  }
}
