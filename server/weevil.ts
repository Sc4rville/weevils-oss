// The weevil's questions: now and then a panel slides up from the bottom of the app with a short question about the
// user's goals, wishes and projects, answered in a short exchange; each answer feeds the memory (server/memory.ts).
// Questions are written by the model from the memory and the real projects: no fixed list, never twice the same.
//
// One question is kept ready (written ahead, in the background), stored with the questions already asked in the memory
// file so a restart costs nothing. Missed (closed without an answer), it comes back up to MAX_MISSES - 1 more times, then a
// new one is written. Only on the main machine (w.memory set) with Claude logged in; a failed model call waits
// BACKOFF_MS (doubling) before the next try, so nothing ever loops on the subscription.

import type http from 'node:http'
import type { MemoryItem, WeevilQuestion, WeevilReply } from '../shared/api.ts'
import { detectLang } from '../shared/detect-lang.ts'
import type { Weevils } from './core.ts'
import { parseJson, smart } from './fast.ts'
import { lang, onLangChange, tr, user, withLang, type Lang } from './i18n.ts'
import W from './i18n/weevil.ts'
import { looksSecret, redact, type Asked, type Memory } from './memory.ts'
import { claudeLogged } from './setup.ts'

// The secret filter lives with the store (server/memory.ts): every write goes through it, by hand or from a weevil.
export { looksSecret, redact }

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL, params: string[]) => Promise<void> | void
type Json = (res: http.ServerResponse, status: number, body: unknown) => void
type ReadBody = (req: http.IncomingMessage) => Promise<any>
type Line = { role: 'weevil' | 'user'; text: string }

/** Flights of one question before it is retired (the first one included). */
export const MAX_MISSES = 3
/** Follow-up questions the weevil may ask in one exchange (« maybe one »). */
export const MAX_FOLLOWUPS = 1
/** A ready question older than this is not flown any more (the moment it was written for has passed). */
export const MAX_AGE_MS = 8 * 3600_000
/** First wait after a failed model call; doubles up to BACKOFF_MAX_MS. */
export const BACKOFF_MS = 30 * 60_000
export const BACKOFF_MAX_MS = 4 * 3600_000
/** Hard cap on a question (the model aims at 70 characters). */
const MAX_QUESTION = 140
const MAX_FACT = 240
/** The answers kept next to a memory (the store's cap on them). */
const MAX_ANSWERS = 1200
/** At most this many memory changes from one answer. */
const MAX_OPS = 4
/** Background check: a question is written ahead only if the app asked for one recently. */
const CHECK_MS = 30 * 60_000
const WANTED_MS = 2 * 24 * 3600_000
const FIRST_DELAY_MS = 60_000

const ANGLES = ['now', 'far', 'taste', 'project', 'week', 'suggest', 'followup'] as const
type Angle = (typeof ANGLES)[number]
/** Early on (little known), broad and light angles only. */
const BROAD: Angle[] = ['now', 'far', 'taste', 'week']

// ---------------------------------------------------------------- pure helpers (tested)

/** Comparable form of a question: lowercase, no accents nor punctuation. */
const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
const words = (s: string) => new Set(norm(s).split(' ').filter((w) => w.length > 2))

/** Same question, or nearly (most of its words shared with one already asked). */
export function isRepeat(text: string, asked: { text: string }[]): boolean {
  const n = norm(text)
  const a = words(text)
  return asked.some((q) => {
    if (norm(q.text) === n) return true
    const b = words(q.text)
    if (!a.size || !b.size) return false
    let both = 0
    for (const w of a) if (b.has(w)) both++
    return both / (a.size + b.size - both) >= 0.7
  })
}

/** The model's question, cleaned: no quotes nor emoji, one line. Null when unusable. */
export function tidyQuestion(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const t = raw
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["«“'\s]+|["»”'\s]+$/g, '')
    .trim()
  if (t.length < 4 || t.length > MAX_QUESTION) return null
  return t
}

/** Which angle the next question takes: turns with `turn`, broad while little is known. */
export function angleFor(turn: number, known: number, hasProjects: boolean): Angle {
  const list = known < 3 ? BROAD : ANGLES.filter((a) => (a === 'project' ? hasProjects : true))
  return list[Math.abs(Math.trunc(turn)) % list.length]
}

/** The turn of the angle rotation: moves with every new question (from the last one's random id, since the asked
 * list is capped and its length stops moving) and with every failed try (so a retry takes another angle). */
export function angleTurn(asked: { id: string }[], fails: number): number {
  const last = asked.at(-1)
  return (last ? parseInt(last.id.slice(0, 8), 16) || 0 : 0) + fails
}

/** Follow-ups the weevil already asked in this exchange (its lines after the question). */
export const followups = (history: Line[]) => Math.max(0, history.filter((l) => l.role === 'weevil').length - 1)

/**
 * Every answer of the exchange, in order, the latest included: what a memory keeps next to the opening question. Each
 * gets an equal share of MAX_ANSWERS, so a long first answer never pushes the latest one out.
 */
export function answers(history: Line[], said: string): string {
  const all = [...history.filter((l) => l.role === 'user').map((l) => l.text), said].map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean)
  const share = Math.floor((MAX_ANSWERS - 3 * (all.length - 1)) / Math.max(1, all.length))
  return all.map((t) => (t.length > share ? `${t.slice(0, share - 1).trimEnd()}…` : t)).join(' · ')
}

/** Sanitized exchange from the client. */
export function readHistory(raw: unknown): Line[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((l) => l && (l.role === 'weevil' || l.role === 'user') && typeof l.text === 'string' && l.text.trim())
    .slice(-8)
    .map((l) => ({ role: l.role, text: String(l.text).trim().slice(0, 600) }))
}

type Op = { op?: unknown; id?: unknown; text?: unknown }

// ---------------------------------------------------------------- the flyers

export class Flyers {
  readonly w: Weevils
  readonly memory: Memory
  private writing: Promise<void> | null = null
  private fails = 0
  private failUntil = 0
  private lastWanted = 0

  /** auto: write a question shortly after start, then check now and then (off in tests). */
  constructor(w: Weevils, memory: Memory, opts: { auto?: boolean } = {}) {
    this.w = w
    this.memory = memory
    if (opts.auto === false) return
    setTimeout(() => void this.prepare(), FIRST_DELAY_MS).unref?.()
    setInterval(() => Date.now() - this.lastWanted < WANTED_MS && void this.prepare(), CHECK_MS).unref?.()
    // Another language: the ready question (in the old one) waits, a new one is written in the new language.
    onLangChange(() => setTimeout(() => void this.prepare(), 5000).unref?.())
  }

  /** On the main machine, with Claude logged in. */
  private can() {
    return !!this.w.memory && claudeLogged()
  }

  /** The question ready to fly: not answered, not retired, not too old, in the current language. */
  ready(now = Date.now()): Asked | null {
    const l = lang()
    const list = this.memory.asked()
    for (let i = list.length - 1; i >= 0; i--) {
      const q = list[i]
      if (q.state === 'answered' || (q.misses ?? 0) >= MAX_MISSES || now - q.at > MAX_AGE_MS) continue
      const ql = detectLang(q.text)
      if (ql && ql !== l) continue
      return q
    }
    return null
  }

  /** Writes a question ahead if none is ready (one at a time, never during a backoff). */
  prepare(): Promise<void> {
    if (this.writing) return this.writing
    if (!this.can() || Date.now() < this.failUntil || this.ready()) return Promise.resolve()
    this.writing = this.write().finally(() => (this.writing = null))
    return this.writing
  }

  /** The prompt for the next question (exported for tests through the instance). */
  questionPrompt(now = new Date()): string {
    const t = tr(W)
    const l = lang()
    const weekday = new Intl.DateTimeFormat(l === 'fr' ? 'fr-FR' : 'en-US', { weekday: 'long' }).format(now)
    const projects = this.projectsText()
    const angle = angleFor(angleTurn(this.memory.asked(), this.fails), this.memory.count, !!projects)
    return t.question(user(), t.moment(weekday, now.getHours()), projects, this.memory.asText(), this.memory.askedText(), t[`angle_${angle}`])
  }

  /** The real projects as prompt lines: name, repos, the latest sessions (title and what they do now). */
  private projectsText(): string {
    const snap = this.w.snapshot()
    const since = Date.now() - 14 * 24 * 3600_000
    return [...snap.projects]
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .slice(0, 12)
      .map((p) => {
        const sessions = snap.sessions
          .filter((s) => s.projectId === p.id && s.lastActivityAt > since && s.title)
          .slice(0, 3)
          .map((s) => (s.now ? `${s.title} (${s.now})` : s.title))
        const repos = p.repos.filter((r) => r !== p.name)
        return `- ${p.name}${repos.length ? ` [${repos.join(', ')}]` : ''}${sessions.length ? ` : ${sessions.join(' · ')}` : ''}`
      })
      .join('\n')
  }

  private async write() {
    let text: string | null = null
    let why = ''
    try {
      text = tidyQuestion(parseJson<{ question?: unknown }>(await smart(this.questionPrompt()))?.question)
      if (text && isRepeat(text, this.memory.asked())) {
        why = `repeat (${text})`
        text = null
      }
    } catch (e) {
      why = (e as Error).message
    }
    if (text) {
      this.memory.ask(text)
      this.fails = 0
      console.log(`[weevil] question prête : ${text}`)
      return
    }
    this.fails++
    const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_MS * 2 ** (this.fails - 1))
    this.failUntil = Date.now() + wait
    console.error(`[weevil] pas de question${why ? ` : ${why}` : ''} · nouvel essai dans ${Math.round(wait / 60_000)} min`)
  }

  /** A question ready to fly (generated ahead of time), or null when none is ready (no model, still writing…). */
  async next(): Promise<WeevilQuestion | null> {
    this.lastWanted = Date.now()
    if (!this.can()) return null
    const q = this.ready()
    if (q) return { id: q.id, text: q.text }
    void this.prepare()
    return null
  }

  /** The weevil flew by without being caught: it will come back later with the same question (or retire). */
  missed(id: string) {
    if (!this.memory.question(id)) return
    this.memory.markAsked(id, 'shown')
    if (!this.ready()) void this.prepare()
  }

  /** What the user answered (typed or spoken), with the exchange so far: a short reply, and what was remembered. */
  async answer(id: string, text: string, history: Line[] = []): Promise<WeevilReply> {
    const said = text.trim().slice(0, 1200)
    const replyLang: Lang = detectLang(said) ?? lang()
    const fallback = (): WeevilReply => ({ reply: withLang(replyLang, () => tr(W).fallback), learned: [], done: true })
    if (!said) return { reply: '', learned: [], done: true }
    const asked = this.memory.question(id)
    const question = asked?.text ?? history.find((l) => l.role === 'weevil')?.text ?? ''
    if (asked) this.memory.markAsked(id, 'answered')
    if (!this.can()) return fallback()

    const t = tr(W)
    const name = user()
    const lines = history.length && history[0].role === 'weevil' ? history : [{ role: 'weevil' as const, text: question }, ...history]
    const exchange = [...lines, { role: 'user' as const, text: said }]
      .filter((l) => l.text)
      .map((l) => (l.role === 'weevil' ? t.lineWeevil(l.text) : t.lineUser(name, l.text)))
      .join('\n')
    const canFollow = followups(lines) < MAX_FOLLOWUPS
    let out: { reply?: unknown; done?: unknown; memory?: unknown } | null
    try {
      out = parseJson(await smart(t.answer(name, this.memory.asText(), exchange, t.langName(replyLang), t.langName(lang()), canFollow)))
    } catch (e) {
      console.error(`[weevil] réponse : ${(e as Error).message}`)
      out = null
    }
    const reply = typeof out?.reply === 'string' ? out.reply.replace(/\p{Extended_Pictographic}/gu, '').trim().slice(0, 400) : ''
    if (!out || !reply) {
      void this.prepare()
      return fallback()
    }
    const learned = this.apply(Array.isArray(out.memory) ? (out.memory as Op[]) : [], question, answers(lines, said))
    const done = !canFollow || out.done !== false
    if (done) void this.prepare()
    return { reply, learned, done }
  }

  /**
   * The model's memory changes, checked: known ids only, no secret, no duplicate, a few at most. Each one keeps where
   * it came from as a matching pair: the question that opened the exchange and every answer given in it (the store
   * masks secrets in them).
   */
  private apply(ops: Op[], q: string, a: string): MemoryItem[] {
    const learned: MemoryItem[] = []
    const from = { q, a }
    for (const op of ops.slice(0, 3 * MAX_OPS)) {
      if (learned.length >= MAX_OPS) break
      const text = typeof op?.text === 'string' ? op.text.replace(/\s+/g, ' ').trim() : ''
      if (!text || text.length > MAX_FACT || looksSecret(text)) continue
      try {
        if (op.op === 'update' && typeof op.id === 'string' && this.memory.get(op.id)) {
          if (this.memory.get(op.id)!.text === text) continue
          learned.push(this.memory.update(op.id, text, from))
        } else if (op.op === 'add' || op.op === 'update') {
          if (this.memory.list().some((m) => norm(m.text) === norm(text))) continue
          learned.push(this.memory.add(text, { source: 'answer', ...from }))
        }
      } catch (e) {
        console.error(`[weevil] mémoire : ${(e as Error).message}`)
      }
    }
    return learned
  }
}

/** GET /api/weevil → { question } · POST /api/weevil/:id/missed · POST /api/weevil/:id/answer { text, history } → WeevilReply */
export function weevilRoutes(f: Flyers, json: Json, readBody: ReadBody): [string, RegExp, Handler][] {
  return [
    ['GET', /^\/api\/weevil$/, async (_req, res) => json(res, 200, { question: await f.next() })],
    ['POST', /^\/api\/weevil\/([\w-]+)\/missed$/, (_req, res, _u, [id]) => {
      f.missed(id)
      json(res, 200, { ok: true })
    }],
    ['POST', /^\/api\/weevil\/([\w-]+)\/answer$/, async (req, res, _u, [id]) => {
      const body = await readBody(req)
      json(res, 200, await f.answer(id, String(body.text ?? ''), readHistory(body.history)))
    }],
  ]
}
