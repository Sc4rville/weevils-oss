import { sourceAccessIssue } from './source-access'
// The « auto » drawer's content: one flat list of automations (everything that runs without asking), the words that
// say when each one fires, and the colours of its bands. Pure: built from the snapshot, tested in auto-model.test.ts.
import type { AutoRun, H24Activity, Optimizer, Snapshot, SourceAccess, WorkstreamIdentity } from '../../shared/api.ts'
import { failedLine } from '../../shared/failed-line.ts'
import { locale, type Lang } from '../../shared/i18n.ts'
import { getLang, tr } from '../i18n'
import F from '../i18n/format'
import M from '../i18n/h24'
import S from '../i18n/sleep'

/** What an automation is doing. waiting: held by the machine (agents at work, load, memory); queued: behind another
 *  one; scheduled: held by its own time; proposed: not accepted yet (proposal bands and page only). */
export type AutoState = 'running' | 'waiting' | 'queued' | 'scheduled' | 'paused' | 'done' | 'failed' | 'proposed'
export type AutoSrc = 'optimizer' | 'timer' | 'job'
/** every: recurring; window: once, inside a daily window; time: once, at a time; idle: as soon as nothing else runs;
 *  manual: a job someone started. */
export type TriggerKind = 'every' | 'window' | 'time' | 'idle' | 'manual' | 'sleep'

export interface Trigger {
  kind: TriggerKind
  every?: number
  /** Minutes after local midnight. */
  window?: { from: number; to: number }
  /** The next (or only) time it fires. */
  at?: number
  /** sleep: stopped when the user wakes up. */
  stopOnWake?: boolean
}

export interface Span {
  from: number
  to: number
}

export interface AutoItem {
  sourceAccess?: SourceAccess
  workstream?: WorkstreamIdentity
  id: string
  src: AutoSrc
  title: string
  /** Its family in the drawer (Optimizer.group). */
  group?: string
  state: AutoState
  /** waiting / queued: what holds it (busy, load, ram, queue, later, time, paused). */
  waiting?: Optimizer['waiting']
  /** queued: its place in the line (2 = next after the running one). */
  place?: number
  nextAt: number | null
  nextReason?: 'retry'
  startedAt: number | null
  endedAt: number | null
  since: number | null
  acceptedAt?: number
  est?: number
  sessionId?: string
  /** A timer: paused or resumed with one tap. */
  toggle?: boolean
  note?: string
  trigger: Trigger
  projectId: string | null
  repo: string | null
  /** What it is for: the optimizer's reason, the timer's Description=. */
  why: string
  runCount: number
  /** Newest first. */
  runs: AutoRun[]
  lastRun?: AutoRun
  tokens?: number
  /** The span the fill covers now (null: nothing fills, it waits for the machine or for nothing else to run). */
  progress: (now: number) => Span | null
}

const DAY = 86_400_000
const WEEK = 7 * DAY
/** A finished job stays in the finished fold this long. */
const JOB_KEEP_MS = 3 * 3600_000
/** A run with no estimate and no history: the fill heads for this. */
const DEFAULT_RUN_MS = 15 * 60_000

// A finished job's last line that says it failed: shared with the server, which nests an agent's jobs under its session.
export { failedLine }

const median = (xs: number[]): number | null => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** How long a run usually lasts: the median of the recorded ones, else the estimate (null: nothing known). */
export function typicalMs(x: Pick<AutoItem, 'runs' | 'est'>): number | null {
  return median(x.runs.map((r) => r.at - r.startedAt).filter((d) => d > 0)) ?? (x.est ? x.est * 60_000 : null)
}

/** The span the fill covers: a run heading for its usual length; a wait from the last run (or the acceptance) to the
 *  next trigger; a paused one keeps the span it had. Null when nothing fills. */
export function progressOf(x: Omit<AutoItem, 'progress'>, _now: number): Span | null {
  if (x.state === 'running' && x.startedAt) return { from: x.startedAt, to: x.startedAt + (typicalMs(x) ?? DEFAULT_RUN_MS) }
  const every = x.trigger.every
  const to = x.state === 'scheduled' ? x.nextAt : null
  if (!to) return null
  let from = x.lastRun?.at ?? x.acceptedAt ?? x.since ?? to - (every ?? 3600_000)
  if (every && to - from > every) from = to - every
  if (from >= to) from = to - (every ?? 3600_000)
  return { from, to }
}

const withProgress = (x: Omit<AutoItem, 'progress'>): AutoItem => {
  const item = x as AutoItem
  item.progress = (now) => progressOf(x, now)
  return item
}

const newestFirst = (runs: AutoRun[] | undefined) => [...(runs ?? [])].map((r) => ({ ...r, startedAt: r.startedAt ?? r.at })).sort((a, b) => b.at - a.at)

/** An explicit date is distinct from a retry, a recurring cadence or an eligibility window. */
export function optimizerTrigger(o: Pick<Optimizer, 'every' | 'window' | 'notBefore' | 'startAt' | 'onSleep' | 'stopOnWake'>): Trigger {
  // « When I sleep » keeps its times as the fallback (it runs at them on a night sleep mode never came).
  if (o.onSleep) return { kind: 'sleep', stopOnWake: !!o.stopOnWake, ...(o.every ? { every: o.every } : {}), ...(o.window ? { window: o.window } : {}) }
  // Recurring notBefore is also written by finish(); without provenance it is only eligibility.
  const at = o.window || o.every ? undefined : o.notBefore
  if (o.every) return { kind: 'every', every: o.every, window: o.window, at }
  if (o.window) return { kind: 'window', window: o.window, at }
  if (o.notBefore) return { kind: 'time', at }
  return { kind: 'idle' }
}

/** Only an upcoming, explicitly dated one-off may expose a next execution. */
export function fromOptimizer(o: Optimizer, projectId: string | null = null, now = Date.now()): AutoItem | null {
  if (o.state === 'refused') return null
  const accessBlocked = !!sourceAccessIssue(o)
  const paused = o.paused || o.waiting === 'paused'
  const fixedAt = !accessBlocked && o.waiting !== 'later' && !o.every && !o.window && o.notBefore && o.notBefore > now && (!o.startAt || o.startAt === o.notBefore) && (!o.retryAt || o.retryAt <= now) ? o.notBefore : null
  // Held by its own time (waiting « time », or a built-in, which the queue never marks): startAt is the moment the
  // server's runner itself waits for (timeAt()), so it is its next run, recurring or not. Never a retry delay.
  // Held for a retry (a usage limit, Claude logged out) that ends before its own time: its own time still says when.
  const ownTime = !accessBlocked && !paused && o.startAt && o.startAt > now && (o.waiting === 'time' || o.waiting === 'later' || (!o.waiting && !!o.builtin)) && (!o.retryAt || o.retryAt < o.startAt) ? o.startAt : null
  const nextAt = fixedAt ?? ownTime
  const state: AutoState =
    o.state === 'queued'
      ? paused
        ? 'paused'
        : nextAt || o.waiting === 'sleep'
          ? 'scheduled'
          : o.waiting === 'queue' || !o.waiting
            ? 'queued'
            : 'waiting'
      : o.state
  const runs = newestFirst(o.runs)
  return withProgress({
    id: o.id,
    sourceAccess: o.sourceAccess,
    workstream: o.workstream,
    src: 'optimizer',
    title: o.title,
    group: o.group,
    state,
    waiting: o.waiting,
    startedAt: o.startedAt ?? null,
    endedAt: o.endedAt ?? null,
    since: o.createdAt,
    acceptedAt: o.acceptedAt,
    est: o.est,
    sessionId: o.sessionId,
    note: o.lastEvent,
    // Weak provenance is not a future execution: neither retryAt nor an orphan startAt establishes one.
    nextAt: o.state === 'queued' && !paused ? nextAt : null,
    nextReason: !ownTime && (o.waiting === 'later' || (o.retryAt && o.retryAt > now)) ? 'retry' : undefined,
    trigger: optimizerTrigger(o),
    projectId,
    repo: o.repo,
    why: o.why,
    runCount: o.runCount ?? runs.length,
    runs,
    lastRun: runs[0],
    tokens: o.tokens,
  })
}

export function fromActivity(a: H24Activity, projectId: string | null = a.projectId): AutoItem {
  const failed = a.kind === 'job' ? failedLine(a.lastEvent) : a.lastOk === false
  const state: AutoState = a.runState === 'running' ? 'running' : a.runState === 'paused' ? 'paused' : a.kind === 'timer' ? 'scheduled' : failed ? 'failed' : 'done'
  // A job's one run is its log, from its start to its last line: while it runs, that run is the live one, not a last.
  const lastAt = a.kind === 'job' ? (a.runState !== 'running' ? (a.lastRunAt ?? a.runStartedAt) : undefined) : a.lastRunAt
  const lastRun: AutoRun | undefined = lastAt ? { at: lastAt, startedAt: lastAt - (a.lastDurMs ?? 0), ok: !failed } : undefined
  const nextAt = a.kind === 'timer' && a.runState !== 'paused' ? (a.nextRunAt ?? null) : null
  return withProgress({
    id: a.id,
    src: a.kind,
    title: a.title,
    state,
    nextAt,
    startedAt: a.runState === 'running' ? a.runStartedAt : null,
    endedAt: a.kind === 'job' && a.runState !== 'running' ? (lastAt ?? null) : null,
    since: a.since ?? null,
    toggle: a.canToggle,
    note: a.lastEvent,
    trigger: a.kind === 'job' ? { kind: 'manual' } : a.everyMs ? { kind: 'every', every: a.everyMs, at: a.nextRunAt ?? undefined } : { kind: 'time', at: a.nextRunAt ?? undefined },
    projectId,
    repo: null,
    why: a.description ?? '',
    runCount: a.runCount ?? (lastRun ? 1 : 0),
    runs: lastRun && lastRun.at > lastRun.startedAt ? [lastRun] : [],
    lastRun,
  })
}

export const isFinished = (x: Pick<AutoItem, 'state'>) => x.state === 'done' || x.state === 'failed'

/** The drawer's order: running, then the soonest trigger, then held by the machine, then paused; finished last (newest
 *  first). */
export function autoRank(x: AutoItem): number {
  if (x.state === 'running') return 0
  if (x.state === 'scheduled') return 1
  if (x.state === 'waiting' || x.state === 'queued') return 2
  if (x.state === 'paused') return 3
  return 4
}
const byOrder = (a: AutoItem, b: AutoItem) =>
  autoRank(a) - autoRank(b) || (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity) || (a.place ?? 0) - (b.place ?? 0) || (b.endedAt ?? 0) - (a.endedAt ?? 0) || a.title.localeCompare(b.title)

/** The automation a session runs for (an optimizer's run in progress): its id, else null. Its row shows AutoMark, not the
 *  star; the run over, the session is the user's again. */
export const autoOfSession = (snap: Pick<Snapshot, 'optimizers'>, sessionId: string): string | null => (snap.optimizers ?? []).find((o) => o.state === 'running' && o.sessionId === sessionId)?.id ?? null

export const projectOfRepo = (projects: Snapshot['projects'], repo: string | null) => (repo ? (projects.find((p) => p.repos.includes(repo))?.id ?? null) : null)

/** Everything that runs without asking, flat: accepted tasks, timers, running jobs; finished ones (one-off tasks, jobs
 *  ended under 3 h) last. Proposals are not in it. */
/**
 * A real automation: a timer, or a job that recurs or has a trigger. A one-off background command
 * an agent started (its log in ~/logs: tests, mocks, builds) is that agent's work, never an automation: not shown here.
 */
export const isAutomation = (a: Pick<H24Activity, 'kind' | 'everyMs' | 'nextRunAt'>) => a.kind === 'timer' || !!a.everyMs || !!a.nextRunAt

export function autoList(snap: Pick<Snapshot, 'projects' | 'h24' | 'optimizers' | 'now'>): AutoItem[] {
  const known = new Set(snap.projects.map((p) => p.id))
  const opts = snap.optimizers ?? []
  // A task held by its time or by a retry delay is not in the line: the others go before it.
  const line = opts.filter((o) => o.state === 'queued' && !o.paused && o.waiting !== 'time' && o.waiting !== 'later' && o.waiting !== 'paused')
  const running = opts.some((o) => o.state === 'running')
  const out: AutoItem[] = []
  for (const o of opts) {
    if (o.state === 'proposed') continue
    const x = fromOptimizer(o, projectOfRepo(snap.projects, o.repo))
    if (!x) continue
    if (line.includes(o)) x.place = line.indexOf(o) + 1 + Number(running)
    out.push(x)
  }
  for (const a of snap.h24) {
    if (!isAutomation(a)) continue
    const pid = a.projectId && known.has(a.projectId) ? a.projectId : a.group && known.has(a.group) ? a.group : null
    const x = fromActivity(a, pid)
    if (x.src === 'job' && isFinished(x) && snap.now - (x.endedAt ?? 0) > JOB_KEEP_MS) continue
    out.push(x)
  }
  return out.sort(byOrder)
}

// ---------------------------------------------------------------- words

/** Compact duration for bold numbers: 14m, 2h, 1h30, 3j (3d); coarse: whole hours (« 6h ago », not « 6h01 »). */
export function short(ms: number, coarse = false): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const r = m % 60
  if (h < 24) return r && h < 10 && !coarse ? `${h}h${String(r).padStart(2, '0')}` : `${h}h`
  return tr(F).days(Math.round(h / 24))
}

/** « 01:00 » today, « mer. 08:00 » on another day within the week, else the date. */
export function at(ts: number, now: number, lang: Lang = getLang()): string {
  const loc = locale(lang)
  const time = new Intl.DateTimeFormat(loc, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ts)
  if (new Date(ts).toDateString() === new Date(now).toDateString()) return time
  if (ts - now < 6 * DAY) return `${new Intl.DateTimeFormat(loc, { weekday: 'short' }).format(ts)} ${time}`
  return `${new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'short' }).format(ts)} ${time}`
}

/** Retry eligibility is not a user-selected schedule. */
export function nextTimeText(x: Pick<AutoItem, 'nextAt' | 'nextReason'>, now: number, summary = false): string {
  if (!x.nextAt) return ''
  const time = at(x.nextAt, now)
  return x.nextReason === 'retry' ? tr(M).retryAfter(time) : summary ? tr(M).nextAt(time) : time
}

export const hm = (min: number) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
/** A night window (it starts in the evening or deep in the night, ends in the morning). */
export const isNight = (w: { from: number; to: number }) => (w.from >= 20 * 60 || w.from < 5 * 60) && w.to <= 9 * 60
const clock = (ts: number, lang: Lang) => new Intl.DateTimeFormat(locale(lang), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ts)

/** When it fires, in one short phrase: « toutes les 6h », « chaque jour 07:00–08:00 », « chaque lundi, la nuit »,
 *  « quand rien ne tourne », « lancé à la main ». */
export function triggerText(tg: Trigger, now: number, lang: Lang = getLang()): string {
  const t = M[lang]
  const w = tg.window
  const range = w ? `${hm(w.from)}–${hm(w.to)}` : ''
  const night = !!w && isNight(w)
  switch (tg.kind) {
    case 'idle':
      return t.whenIdle
    case 'manual':
      return t.manual
    case 'sleep': {
      const head = tg.stopOnWake ? S[lang].triggerSleepStop : S[lang].triggerSleep
      const rest = tg.every || tg.window ? triggerText({ kind: tg.every ? 'every' : 'window', every: tg.every, window: tg.window }, now, lang) : ''
      return rest ? S[lang].triggerSleepFallback(head, rest) : head
    }
    case 'time':
      return tg.at ? t.atTime(at(tg.at, now, lang)) : t.whenIdle
    case 'window':
      return night ? t.night(range) : t.between(range)
    case 'every': {
      const every = tg.every ?? DAY
      if (every === DAY) return w ? (night ? t.nightly(range) : t.daily(range)) : t.daily(tg.at ? clock(tg.at, lang) : '')
      const head =
        every === WEEK
          ? tg.at ? t.weekly(new Intl.DateTimeFormat(locale(lang), { weekday: 'long' }).format(tg.at)) : t.everyDays(7)
          : every % DAY === 0
            ? t.everyDays(every / DAY)
            : t.every(spanIn(every, lang))
      if (w) return night ? `${head}, ${t.night('')}` : `${head} ${range}`
      return every === WEEK && tg.at ? `${head} ${clock(tg.at, lang)}` : head
    }
  }
}

/** A run's moment, in full: « lundi 9 novembre 03:00 ». */
export function longAt(ts: number, lang: Lang = getLang()): string {
  return new Intl.DateTimeFormat(locale(lang), { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ts)
}

/** A period under a day: « 6 h », « 1 h 30 », « 45 min » (fr); « 6h », « 1h30 », « 45 min » (en). */
function spanIn(ms: number, lang: Lang): string {
  const m = Math.max(1, Math.round(ms / 60_000))
  if (m < 60) return F[lang].minutes(m)
  const h = Math.floor(m / 60)
  const r = m % 60
  const sep = lang === 'fr' ? ' ' : ''
  return r ? `${h}${sep}h${sep}${String(r).padStart(2, '0')}` : `${h}${sep}h`
}

// ---------------------------------------------------------------- colours

/** The drawer's own colour (--h24, amber), as the nearest palette slot. */
export const DRAWER_SLOT = 'p3'
const SLOTS = 16
const slotHue = (slot: string) => Number(slot.replace(/^p/, '')) || 0
/** Steps between two palette slots around the wheel (16 hues, 22.5° apart). */
export function hueGap(a: string, b: string): number {
  const d = Math.abs(slotHue(a) - slotHue(b)) % SLOTS
  return Math.min(d, SLOTS - d)
}
/** Against the band above (or the drawer's head for the first one): at least 3 steps. */
export const BAND_GAP = 3
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)

/** The slot each band last had, for the page it opens (AutoPage reads it). */
const lastSlots = new Map<string, string>()
export const slotOf = (id: string) => lastSlots.get(id) ?? 'p9'

/** No band anywhere in the drawer within this many steps of its amber: it would read as the drawer itself. */
const HEAD_GAP = 2

/**
 * A colour per band of the drawer, in display order (proposals, then automations): a stable slot drawn from the id,
 * never within 3 steps of the band above (the amber head for the first one), never next to the amber. A band keeps
 * its slot while it stays and its neighbour above allows it; one that must change takes the first slot after its own
 * that also suits the band below as it is, so one band leaving never repaints the whole list.
 */
export function bandColors(ids: string[], kept: ReadonlyMap<string, string>, head = DRAWER_SLOT): Map<string, string> {
  const out = new Map<string, string>()
  let above = head
  const fits = (p: string, up: string) => hueGap(p, up) >= BAND_GAP && hueGap(p, head) >= HEAD_GAP
  ids.forEach((id, i) => {
    const mine = kept.get(id)
    let slot = mine && fits(mine, above) ? mine : null
    if (!slot) {
      const below = ids[i + 1] !== undefined ? kept.get(ids[i + 1]) : undefined
      const start = hash(id) % SLOTS
      const order = Array.from({ length: SLOTS }, (_, k) => `p${(start + k) % SLOTS}`)
      slot = order.find((p) => fits(p, above) && (!below || hueGap(p, below) >= BAND_GAP)) ?? order.find((p) => fits(p, above)) ?? order.find((p) => hueGap(p, above) >= BAND_GAP)!
    }
    out.set(id, slot)
    lastSlots.set(id, slot)
    above = slot
  })
  return out
}

/** Slots for side-by-side cards (« pour toi »'s proposals): far from the amber and the band below, 2 steps apart. */
export const PROP_PALETTE = ['p9', 'p13', 'p0', 'p6', 'p8', 'p11']
const SIDE_GAP = 2

/**
 * Colours for cards side by side under the drawer's amber (and above `below`, when there is one): each one at least
 * 3 steps from both, 2 from its neighbours, kept while it stays. Used by « pour toi » (foryou-store) since the drawer's
 * own proposals became bands (bandColors).
 */
export function propColors(ids: string[], kept: ReadonlyMap<string, string>, below: string | null): Map<string, string> {
  const bands = below ? [DRAWER_SLOT, below] : [DRAWER_SLOT]
  const ok = (p: string) => bands.every((x) => hueGap(p, x) >= BAND_GAP)
  const apart = (p: string, used: Iterable<string>) => [...used].every((u) => hueGap(p, u) >= SIDE_GAP)
  const out = new Map<string, string>()
  for (const id of ids) {
    const p = kept.get(id)
    if (p && ok(p) && apart(p, out.values())) out.set(id, p)
  }
  for (const id of ids) {
    if (out.has(id)) continue
    const used = [...out.values()]
    const free = PROP_PALETTE.filter((p) => !used.includes(p))
    out.set(id, free.find((p) => ok(p) && apart(p, used)) ?? free.find(ok) ?? free[0] ?? PROP_PALETTE[0])
  }
  return out
}

// ---------------------------------------------------------------- the drawer's rows and families

/**
 * The one word on the right of a row: something only this automation can say (running for 14m, in 2h, Sat 08:00,
 * failed 3h ago, memory low…), never a generic state repeated on every row.
 */
export function rowStatus(x: AutoItem, now: number, condition: (x: AutoItem) => string, lang: Lang = getLang()): string {
  const t = M[lang]
  if (x.state === 'running') return x.startedAt ? t.runningFor(short(now - x.startedAt)) : t.state_running
  if (x.state === 'paused') return t.paused
  if (x.state === 'failed' || (x.lastRun && !x.lastRun.ok && x.state !== 'done')) {
    const at = x.state === 'failed' ? (x.endedAt ?? x.lastRun?.at) : x.lastRun?.at
    return at ? t.failedAgo(short(now - at, true)) : t.state_failed
  }
  if (x.state === 'done') return x.endedAt ? t.endedAgo(short(now - x.endedAt, true)) : t.state_done
  if (x.nextAt && x.nextReason !== 'retry') return x.nextAt - now < 18 * 3600_000 ? t.inTime(short(x.nextAt - now, x.nextAt - now >= 3600_000)) : at(x.nextAt, now, lang)
  if (x.state === 'scheduled' && x.waiting === 'sleep') return t.wait_sleep
  if (x.state === 'queued' && x.place) return t.placeN(x.place)
  return condition(x)
}

export interface AutoGroup {
  name: string
  items: AutoItem[]
}

/** Families in the drawer, by name (the unnamed ones last, as « other »); null when none is named: a flat list. */
export function autoGroups(items: AutoItem[], other: string): AutoGroup[] | null {
  if (!items.some((x) => x.group)) return null
  const by = new Map<string, AutoItem[]>()
  for (const x of items) {
    const k = x.group ?? ''
    by.set(k, [...(by.get(k) ?? []), x])
  }
  return [...by.entries()]
    .sort(([a], [b]) => (!a ? 1 : !b ? -1 : a.localeCompare(b)))
    .map(([k, v]) => ({ name: k || other, items: v }))
}
