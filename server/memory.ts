// What weevils remembers about the user: goals, wishes, projects, tastes. Fed by the answers given to the weevil's questions
// (server/weevil.ts) and edited by hand in the app (memory page, bottom of the machines band).
//
// Stored in ~/.config/weevils/memory.json (mode 600): outside every repo, never committed, never sent anywhere but to
// the model that writes the weevils' questions, the h24 proposals (server/optimizers.ts) and weevboss's context.
// The questions already asked live in the same file, so a question is never asked twice.

import crypto from 'node:crypto'
import fs from 'node:fs'
import type http from 'node:http'
import path from 'node:path'
import type { MemoryItem } from '../shared/api.ts'
import { CONFIG_DIR } from './config.ts'
import { tr } from './i18n.ts'
import M from './i18n/memory.ts'

/** Generous caps: the whole memory goes into prompts. */
const MAX_ITEMS = 300
const MAX_TEXT = 400
const MAX_ASKED = 400
const MAX_ANSWER = 1200

/** A question asked by the weevil, and what became of it. */
export interface Asked {
  id: string
  text: string
  at: number
  /** shown: flew by without being caught; answered: someone answered at least once. */
  state: 'pending' | 'shown' | 'answered'
  /** How many times it flew by without being caught. */
  misses?: number
}

interface Stored {
  items: MemoryItem[]
  asked: Asked[]
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL, params: string[]) => Promise<void> | void
type Json = (res: http.ServerResponse, status: number, body: unknown) => void
type ReadBody = (req: http.IncomingMessage) => Promise<any>

const clean = (s: unknown) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT)

// ---------------------------------------------------------------- secrets

// Never kept, whoever writes (the « + » and edits on the memory page, `weevils memory add`, weevboss, a weevil's
// answer): keys, tokens, passwords, e-mails, phone numbers. The memory goes into prompts and sits in a plain file.
const SECRET: RegExp[] = [
  // e-mail
  /[\w.+-]+@[\w-]+\.[\w.-]+/,
  // phone numbers (06 12 34 56 78, +33 6 12 34 56 78, 0612345678) and any long run of digits
  /(?:\+\d{1,3}[\s.]?)?(?<!\d)0?\d(?:[\s.-]?\d{2}){4}(?!\d)/,
  /\d{9,}/,
  // API keys and tokens with a known prefix
  /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|github_pat|xox[abpr]|AKIA|AIza|glpat)[-_]?[A-Za-z0-9_-]{8,}/,
  // a long run mixing letters and digits (keys, hashes, tokens)
  /(?=[A-Za-z0-9_+/=-]*\d)(?=[A-Za-z0-9_+/=-]*[A-Za-z])[A-Za-z0-9_+/=-]{24,}/,
  // i18n-ignore : vocabulaire des secrets (détection, jamais affiché)
  /\b(?:password|passwd|passcode|passphrase|mot de passe|mdp|api[ _-]?key|cl[ée] (?:api|secr[èe]te|priv[ée]e)|token|jeton|iban|pin code|code pin)\b/i,
]

/** Looks like a secret, a contact or a credential: never remembered. */
export const looksSecret = (s: string) => SECRET.some((r) => r.test(s))

/** The same text with anything secret-looking masked (the raw answer kept next to a memory). */
export const redact = (s: string) =>
  SECRET.slice(0, 5)
    .reduce((t, r) => t.replace(new RegExp(r.source, 'g'), '•••'), s)
    // i18n-ignore : vocabulaire des secrets (détection, jamais affiché)
    .replace(/\b(password|passwd|passcode|passphrase|mot de passe|mdp|api[ _-]?key|cl[ée] (?:api|secr[èe]te|priv[ée]e)|token|jeton|iban|pin code|code pin)(\s*(?:[:=]|is|est|c'est)?\s*)[^\s,;]+/gi, '$1$2•••')

/** The raw answer kept next to a memory: secrets masked, capped. */
const answer = (s: unknown) => redact(String(s ?? '').trim()).slice(0, MAX_ANSWER)

/** The text of a memory, ready to keep: one line, capped. Throws on an empty text or a secret. */
function checked(text: unknown): string {
  const t = clean(text)
  if (!t) throw new Error(tr(M).empty)
  if (looksSecret(t)) throw new Error(tr(M).secret)
  return t
}

export class Memory {
  readonly file: string
  private s: Stored
  private listeners = new Set<() => void>()

  constructor(file = path.join(CONFIG_DIR, 'memory.json')) {
    this.file = file
    this.s = (() => {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Stored>
        const items = (Array.isArray(raw.items) ? raw.items : []).filter((m) => m && typeof m.id === 'string' && typeof m.text === 'string')
        return { items, asked: Array.isArray(raw.asked) ? raw.asked : [] }
      } catch {
        return { items: [], asked: [] }
      }
    })()
  }

  /** Called after every change (snapshot count, weevboss's context, h24 proposals). */
  onChange(fn: () => void) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private save() {
    // Caps kept in memory too (the oldest go first): what is counted and listed is what is on disk.
    if (this.s.items.length > MAX_ITEMS) this.s.items = this.s.items.slice(-MAX_ITEMS)
    if (this.s.asked.length > MAX_ASKED) this.s.asked = this.s.asked.slice(-MAX_ASKED)
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ items: this.s.items, asked: this.s.asked }, null, 1), { mode: 0o600 })
      fs.chmodSync(tmp, 0o600)
      fs.renameSync(tmp, this.file)
    } catch (e) {
      console.error(`[mémoire] écriture : ${(e as Error).message}`)
    }
    for (const fn of this.listeners) fn()
  }

  // ---------------------------------------------------------------- souvenirs

  /** Newest first. */
  list(): MemoryItem[] {
    return [...this.s.items].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  get count() {
    return this.s.items.length
  }

  get(id: string) {
    return this.s.items.find((m) => m.id === id)
  }

  /** A new memory. Throws (catalog message) on an empty text or one that looks like a secret. */
  add(text: string, from: { source?: MemoryItem['source']; q?: string; a?: string } = {}): MemoryItem {
    const t = checked(text)
    const now = Date.now()
    const item: MemoryItem = { id: crypto.randomBytes(5).toString('hex'), text: t, source: from.source ?? 'manual', at: now, updatedAt: now }
    if (from.q) item.q = redact(clean(from.q))
    if (from.a) item.a = answer(from.a)
    this.s.items.push(item)
    this.save()
    return item
  }

  /** Text changed by hand or rewritten by the model from a newer answer (then q/a follow it); the source always stays. */
  update(id: string, text: string, from?: { q?: string; a?: string }): MemoryItem {
    const item = this.get(id)
    if (!item) throw new Error(tr(M).notFound)
    const t = checked(text)
    item.text = t
    item.updatedAt = Date.now()
    if (from?.q) item.q = redact(clean(from.q))
    if (from?.a) item.a = answer(from.a)
    this.save()
    return item
  }

  remove(id: string) {
    const n = this.s.items.length
    this.s.items = this.s.items.filter((m) => m.id !== id)
    if (this.s.items.length !== n) this.save()
  }

  /** The memory as prompt lines, newest first: « - [id] text ». Empty string when nothing is known yet. */
  asText(max = 120): string {
    return this.list()
      .slice(0, max)
      .map((m) => `- [${m.id}] ${m.text}`)
      .join('\n')
  }

  /**
   * A short digest for weevboss's context (newest first, no ids: `weevils memory` gives them). Empty when nothing is
   * known yet.
   */
  digest(max = 12, chars = 1500): string {
    let out = ''
    for (const m of this.list().slice(0, max)) {
      const line = `- ${m.text}\n`
      if (out.length + line.length > chars) break
      out += line
    }
    return out.trimEnd()
  }

  /** Changes whenever an item is added, edited or removed (weevboss gets the digest again only then). */
  signature(): string {
    if (!this.s.items.length) return ''
    return crypto.createHash('sha1').update(this.s.items.map((m) => `${m.id}:${m.updatedAt}:${m.text}`).join('\n')).digest('hex').slice(0, 16)
  }

  // ---------------------------------------------------------------- questions des weevils

  asked(): Asked[] {
    return this.s.asked
  }

  /** Records a new question (pending until it flies by or gets an answer). */
  ask(text: string): Asked {
    const q: Asked = { id: crypto.randomBytes(5).toString('hex'), text: clean(text), at: Date.now(), state: 'pending' }
    this.s.asked.push(q)
    this.save()
    return q
  }

  question(id: string) {
    return this.s.asked.find((q) => q.id === id)
  }

  markAsked(id: string, state: 'shown' | 'answered') {
    const q = this.question(id)
    if (!q) return
    if (state === 'shown') q.misses = (q.misses ?? 0) + 1
    if (q.state !== 'answered') q.state = state
    this.save()
  }

  /** Every question already asked, newest first, as prompt lines (so the model never asks the same thing twice). */
  askedText(max = 80): string {
    return [...this.s.asked]
      .reverse()
      .slice(0, max)
      .map((q) => `- ${q.text}${q.state === 'answered' ? '' : tr(M).noAnswer}`)
      .join('\n')
  }
}

/**
 * GET /api/memory → { items } · POST /api/memory { text } → { item } · PUT /api/memory/:id { text } → { item } ·
 * DELETE /api/memory/:id → { ok }
 */
export function memoryRoutes(m: Memory, json: Json, readBody: ReadBody): [string, RegExp, Handler][] {
  return [
    ['GET', /^\/api\/memory$/, (_req, res) => json(res, 200, { items: m.list() })],
    ['POST', /^\/api\/memory$/, async (req, res) => {
      const body = await readBody(req)
      // Refused (empty, a secret): 400 with the short reason, shown as is by the app and the CLI.
      try {
        json(res, 200, { item: m.add(body?.text) })
      } catch (e) {
        json(res, 400, { error: (e as Error).message })
      }
    }],
    ['PUT', /^\/api\/memory\/([\w-]+)$/, async (req, res, _u, [id]) => {
      const body = await readBody(req)
      if (!m.get(id)) return json(res, 404, { error: tr(M).notFound })
      try {
        json(res, 200, { item: m.update(id, body?.text) })
      } catch (e) {
        json(res, 400, { error: (e as Error).message })
      }
    }],
    ['DELETE', /^\/api\/memory\/([\w-]+)$/, (_req, res, _u, [id]) => {
      m.remove(id)
      json(res, 200, { ok: true })
    }],
  ]
}
