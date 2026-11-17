// When an « auto » task may start (server/optimizers.ts): not before a given moment, inside a daily window (« the
// nights, 01:00–06:00 »), every N hours or days. Times are read in the user's own time zone (the phone sends it with
// each exchange), not the server's: a VPS often runs in UTC. Pure, tested in auto-time.test.ts.

import { timespan } from './schedule.ts'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** A daily window, in minutes after local midnight; from > to wraps past midnight (22:00–06:00). */
export interface Window {
  from: number
  to: number
}

/** Shortest window, longest period, furthest start: anything outside is the model's mistake, dropped. */
export const MIN_WINDOW_MIN = 30
export const MIN_EVERY_MS = HOUR
export const MAX_EVERY_MS = 90 * DAY
export const MAX_AHEAD_MS = 60 * DAY

/** The server's own zone, when the phone sent none. */
export const serverTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

/** A zone Intl knows, else null. */
export function validTz(tz: unknown): string | null {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return null
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return tz
  } catch {
    return null
  }
}

const fmts = new Map<string, Intl.DateTimeFormat>()
/** Local calendar parts of a moment in a zone. */
export function parts(ts: number, tz: string): { y: number; mo: number; d: number; h: number; mi: number; wd: number } {
  let f = fmts.get(tz)
  if (!f) fmts.set(tz, (f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' })))
  const p = Object.fromEntries(f.formatToParts(ts).map((x) => [x.type, x.value]))
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday)
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute), wd }
}

/** Minutes after local midnight. */
export const minuteOfDay = (ts: number, tz: string) => {
  const p = parts(ts, tz)
  return p.h * 60 + p.mi
}

/** Offset of the zone at that moment (local − UTC), in ms. */
function offset(ts: number, tz: string): number {
  const p = parts(ts, tz)
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - Math.floor(ts / MIN) * MIN
}

/** « 2026-11-11 01:00 » (or with a T) read as local time in the zone; null when unreadable. */
export function parseLocal(s: unknown, tz: string): number | null {
  const m = typeof s === 'string' ? /^\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/.exec(s) : null
  if (!m) return null
  const [y, mo, d, h, mi] = m.slice(1).map(Number)
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null
  const guess = Date.UTC(y, mo - 1, d, h, mi)
  const first = guess - offset(guess, tz)
  // Across a change of hour the offset at the result can differ from the one at the guess: one more step settles it.
  return guess - offset(first, tz)
}

const pad = (n: number) => String(n).padStart(2, '0')
/** « 2026-11-11 01:00 » in the zone (what the model reads and writes). */
export function fmtLocal(ts: number, tz: string): string {
  const p = parts(ts, tz)
  return `${p.y}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}`
}
/** 90 → « 01:30 ». */
export const hhmm = (min: number) => `${pad(Math.floor(min / 60) % 24)}:${pad(min % 60)}`

/** « 01:00-06:00 » (also « 1h-6h », « 01:00–06:00 ») → a window; null when unreadable or too short. */
export function parseWindow(s: unknown): Window | null {
  const m = typeof s === 'string' ? /^\s*(\d{1,2})(?:[:h](\d{2})?)?\s*[-–—à]+\s*(\d{1,2})(?:[:h](\d{2})?)?\s*$/i.exec(s) : null
  if (!m) return null
  const [h1, m1 = '0', h2, m2 = '0'] = [m[1], m[2], m[3], m[4]]
  const from = Number(h1) * 60 + Number(m1)
  const to = (Number(h2) * 60 + Number(m2)) % 1440
  if (Number(h1) > 24 || Number(h2) > 24 || Number(m1) > 59 || Number(m2) > 59) return null
  const f = from % 1440
  const len = (to - f + 1440) % 1440
  if (len < MIN_WINDOW_MIN) return null
  return { from: f, to }
}

export const windowText = (w: Window) => `${hhmm(w.from)}-${hhmm(w.to)}`

/** Inside the window at that moment. */
export function inWindow(ts: number, w: Window, tz: string): boolean {
  const m = minuteOfDay(ts, tz)
  return w.from < w.to ? m >= w.from && m < w.to : m >= w.from || m < w.to
}

/** « 1d », « 7d », « 12h », « daily », « weekly », « 1 semaine » → ms (1 h … 90 days); null: once, or unreadable. */
export function parseEvery(s: unknown): number | null {
  if (typeof s === 'number') return s >= MIN_EVERY_MS && s <= MAX_EVERY_MS ? s : null
  if (typeof s !== 'string') return null
  const k = s.trim().toLowerCase()
  const named: Record<string, number> = { hourly: HOUR, daily: DAY, nightly: DAY, weekly: 7 * DAY, monthly: 30 * DAY, quotidien: DAY, hebdo: 7 * DAY, hebdomadaire: 7 * DAY, mensuel: 30 * DAY }
  const ms = named[k] ?? timespan(k)
  return ms && ms >= MIN_EVERY_MS && ms <= MAX_EVERY_MS ? Math.round(ms) : null
}

/**
 * The first moment at or after `now` when a task may start: not before `notBefore`, and inside its window (the
 * start of the next one when outside). Minute precision.
 */
export function nextStart(o: { notBefore?: number; window?: Window }, now: number, tz: string): number {
  const base = Math.max(now, o.notBefore ?? 0)
  if (!o.window || inWindow(base, o.window, tz)) return base
  const m = minuteOfDay(base, tz)
  const wait = (o.window.from - m + 1440) % 1440
  const t = Math.floor(base / MIN) * MIN + wait * MIN
  // A change of hour may shift it by one: check and nudge.
  for (const d of [0, HOUR, -HOUR]) if (inWindow(t + d, o.window, tz)) return t + d
  return t
}

/** The next occurrence of a recurring task: one period after the last one was due (as many as it takes to pass now). */
export function nextRun(from: number, every: number, now: number): number {
  let t = from + every
  if (t <= now) t += Math.ceil((now - t + 1) / every) * every
  return t
}
