// Sleep mode: one tap before bed. The user is asleep, the agents keep working (the app shows them as glowing ghosts),
// nothing is blocked. While asleep, push notifications only go out for real blockers (a session that needs an answer
// or a permission, a session cut off): results wait for the morning. Automations with the « when I sleep » trigger
// start when it turns on (server/optimizers.ts) and may stop on wake. On wake, a recap card in For you tells what
// really happened overnight, line by line, each one read from a run or a session state, never written by a model.
//
// Stored in DATA_DIR/sleep.json (survives a restart), read by GET /api/sleep and the snapshot, set by POST /api/sleep.

import fs from 'node:fs'
import path from 'node:path'
import type { AutoRun, Optimizer, Session, SleepState } from '../shared/api.ts'
import type { ForYouRecap, ForYouRecapLine } from '../shared/foryou.ts'
import { notificationText } from '../shared/notification-policy.ts'
import { tr } from './i18n.ts'
import SM from './i18n/sleep.ts'
import type { PushPayload } from './push.ts'

/** A recap card shows this many lines; the others are counted. */
export const RECAP_LINES = 8
/** A nap this short with nothing to tell leaves no card. */
export const RECAP_MIN_MS = 20 * 60_000

/**
 * Whether a wake deserves a morning card. A real night always does (even a quiet one says so). A nap shorter than
 * RECAP_MIN_MS only does when something reached an outcome during it (a result, a failure, a stop, a question):
 * work merely still going, or a turn that ended without a result, is not news after a few minutes.
 */
export function recapWorth(recap: { from: number; to: number; lines: { state: string }[] }): boolean {
  if (recap.to - recap.from >= RECAP_MIN_MS) return true
  return recap.lines.some((l) => l.state !== 'working' && l.state !== 'ended')
}

type Change = (on: boolean, night: { from: number; to: number } | null, now: number) => void

export class Sleep {
  readonly file: string
  private s: SleepState
  private listeners: Change[] = []

  constructor(file: string) {
    this.file = file
    this.s = (() => {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<SleepState>
        const on = raw.on === true && typeof raw.since === 'number'
        const last = raw.last && typeof raw.last.from === 'number' && typeof raw.last.to === 'number' ? { from: raw.last.from, to: raw.last.to } : undefined
        return { on, since: on ? (raw.since as number) : null, ...(last ? { last } : {}) }
      } catch {
        return { on: false, since: null }
      }
    })()
  }

  get on(): boolean {
    return this.s.on
  }

  get since(): number | null {
    return this.s.since
  }

  state(): SleepState {
    return { ...this.s, ...(this.s.last ? { last: { ...this.s.last } } : {}) }
  }

  onChange(fn: Change) {
    this.listeners.push(fn)
  }

  /** Turns sleep on or off. Nothing changes (and nobody is told) when it already is. */
  set(on: boolean, now = Date.now()): SleepState {
    if (on === this.s.on) return this.state()
    let night: { from: number; to: number } | null = null
    if (on) this.s = { ...this.s, on: true, since: now }
    else {
      night = { from: this.s.since ?? now, to: now }
      this.s = { on: false, since: null, last: night }
    }
    this.save()
    for (const fn of this.listeners) {
      try {
        fn(on, night, now)
      } catch (e) {
        console.error(`[sleep] ${on ? 'coucher' : 'réveil'} : ${(e as Error).message}`)
      }
    }
    console.log(`[sleep] ${on ? 'mode sommeil' : `réveil après ${Math.round((night!.to - night!.from) / 60_000)} min`}`)
    return this.state()
  }

  private save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.s), { mode: 0o600 })
      fs.renameSync(`${this.file}.tmp`, this.file)
    } catch (e) {
      console.error(`[sleep] écriture : ${(e as Error).message}`)
    }
  }
}

/** Asleep, only a real blocker wakes the phone: a question (an answer or a permission), a warning (a session cut off,
 *  no relay ready) and the explicit test. Results and milestones wait for the morning recap. */
export function sleepAllowsPush(asleep: boolean, category: PushPayload['category']): boolean {
  return !asleep || category === 'question' || category === 'warning' || category === 'test'
}

/** An automation as the recap reads it. */
export interface RecapAuto {
  id: string
  title: string
  runs: AutoRun[]
  state: Optimizer['state']
  startedAt?: number
  sessionId?: string
  /** Its run was stopped on wake (the note it was given). */
  stoppedNote?: string
  /** The supervisor's decisions (optimizers.ts supervise): relaunched, gave up, asked in For you. */
  supervision?: { at: number; action: 'relaunch' | 'gave-up' | 'asked'; why: string }[]
}

/**
 * What really happened between from and to, from the state alone: each automation run that ended in the night (done
 * or failed, its own note), a run still going on wake, and each session of a project active in the night with its
 * state on wake. A session reads as done only when its last words state a finished outcome (notificationText, the
 * notifications' own rule); otherwise its turn « ended » and its last words are shown as they are. Sessions that ran
 * an automation are the automation's lines, not their own.
 */
export interface RecapCounts { done: number; working: number; waiting: number; failed: number; /** runs the supervisor relaunched (not counted in failed) */ retried: number }
export function nightRecap(x: { from: number; to: number; sessions: Session[]; autos: RecapAuto[]; headline?: (text: string) => string }, max = RECAP_LINES): { recap: ForYouRecap; counts: RecapCounts } {
  const { from, to } = x
  const lines: ForYouRecapLine[] = []
  const owned = new Set<string>()
  let retried = 0
  const cut = (s: string | undefined, n = 160) => {
    const one = (s ?? '').replace(/\s+/g, ' ').trim()
    return one.length > n ? `${one.slice(0, n - 1).trimEnd()}…` : one
  }
  for (const a of x.autos) {
    for (const r of a.runs) if (r.sessionId) owned.add(r.sessionId)
    if (a.sessionId) owned.add(a.sessionId)
    // A run the supervisor relaunched or gave up on reads as failed (a blocked run may have ended « ok »), with why
    // and what was done; a question it sent to For you is a waiting line.
    const sup = (a.supervision ?? []).filter((x) => x.at >= from && x.at <= to)
    let relaunches = 0
    for (const r of a.runs)
      if (r.at >= from && r.at <= to) {
        const d = sup.find((x) => x.at === r.at && x.action !== 'asked')
        const t = tr(SM)
        if (d?.action === 'relaunch') relaunches++
        const detail = d ? (d.action === 'relaunch' ? t.relaunched(relaunches, d.why) : t.gaveUp(d.why)) : r.note
        if (d?.action === 'gave-up') relaunches = 0
        if (d?.action === 'relaunch') retried++
        lines.push({ state: d ? 'failed' : r.ok ? 'done' : a.stoppedNote && r.note === a.stoppedNote ? 'stopped' : 'failed', src: 'auto', title: a.title, ...(detail ? { detail: cut(detail) } : {}), open: { page: 'auto', id: a.id }, at: r.at })
      }
    for (const q of sup) if (q.action === 'asked') lines.push({ state: 'waiting', src: 'auto', title: a.title, detail: cut(tr(SM).asked(q.why)), open: { page: 'auto', id: a.id }, at: q.at })
    if (a.state === 'running' && (a.startedAt ?? 0) <= to) lines.push({ state: 'working', src: 'auto', title: a.title, open: { page: 'auto', id: a.id }, at: to })
  }
  for (const s of x.sessions) {
    if (s.archived || owned.has(s.id) || s.lastActivityAt < from || s.openedAt > to) continue
    const base = { src: 'session' as const, title: s.title, projectId: s.projectId, open: { page: 'session' as const, id: s.id }, at: Math.min(s.lastActivityAt, to) }
    if (s.status === 'working') lines.push({ ...base, state: 'working' })
    else if (s.status === 'needs_user') lines.push({ ...base, state: 'waiting', ...(s.attention || s.lastMessage ? { detail: cut(s.attention || s.lastMessage) } : {}) })
    else if (s.status === 'interrupted') lines.push({ ...base, state: 'stopped' })
    else {
      const outcome = notificationText(s.lastMessage ?? '')
      const said = outcome || cut(x.headline ? x.headline(s.lastMessage ?? '') : s.lastMessage)
      lines.push({ ...base, state: outcome ? 'done' : 'ended', ...(said ? { detail: cut(said) } : {}) })
    }
  }
  // What needs the user first, then the results, then what goes on, then the rest; newest first inside each.
  const rank: Record<ForYouRecapLine['state'], number> = { waiting: 0, stopped: 1, failed: 2, done: 3, working: 4, ended: 5 }
  lines.sort((a, b) => rank[a.state] - rank[b.state] || b.at - a.at)
  const n = (...st: ForYouRecapLine['state'][]) => lines.filter((l) => st.includes(l.state)).length
  return { recap: { from, to, lines: lines.slice(0, max), more: Math.max(0, lines.length - max) }, counts: { done: n('done'), working: n('working'), waiting: n('waiting'), failed: n('failed', 'stopped') - retried, retried } }
}
