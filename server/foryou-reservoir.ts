import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { acknowledgementOnly, rawEngineeringNotice } from '../shared/feed-text.ts'
import { isRepeat } from './optimizers.ts'

export const RELEASE_MS = 30_000
export const BATCH_SIZE = 24
export const MAX_QUEUE = 72
const MAX_AGE = 6 * 3600_000
const FORMATS = ['idea', 'story', 'question', 'observation', 'before-after', 'discovery'] as const
export const BATCH_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['items'],
  properties: { items: { type: 'array', maxItems: BATCH_SIZE, items: {
    type: 'object', additionalProperties: false, required: ['title', 'format', 'text', 'sources'],
    properties: { title: { type: 'string', minLength: 1, maxLength: 100 }, format: { type: 'string', enum: [...FORMATS] }, text: { type: 'string', minLength: 1, maxLength: 600 }, sources: { type: 'array', minItems: 1, items: { type: 'string' } } },
  } } },
}
export interface Story { id: string; title: string; format: string; text: string; sources: string[]; at: number; lang: string }
/** Durable, bounded queue. Stable ids prevent duplicate cards after a crash. */
export class Reservoir {
  readonly file: string
  queue: Story[] = []
  history: { text: string; format: string }[] = []
  last = 0
  filled = 0

  constructor(file: string) {
    this.file = file
    try {
      const x = JSON.parse(fs.readFileSync(file, 'utf8'))
      this.queue = Array.isArray(x.queue) ? x.queue.filter((s: Story) => s && typeof s.id === 'string' && typeof s.title === 'string' && typeof s.format === 'string' && typeof s.text === 'string' && Array.isArray(s.sources) && s.sources.every(id => typeof id === 'string') && Number.isFinite(s.at)).slice(0, MAX_QUEUE) : []
      this.history = Array.isArray(x.history) ? x.history.filter((s: { text: string; format: string }) => typeof s?.text === 'string' && typeof s.format === 'string').slice(-300) : []
      this.last = Number(x.last) || 0
      this.filled = Number(x.filled) || 0
    } catch { /* new queue */ }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file + '.tmp', JSON.stringify({ queue: this.queue, history: this.history, last: this.last, filled: this.filled }), { mode: 0o600 })
    fs.renameSync(this.file + '.tmp', this.file)
  }

  add(raw: unknown, sources: Set<string>, known: string[], now: number, lang: string) {
    this.filled = now
    for (const v of Array.isArray(raw) ? raw.slice(0, BATCH_SIZE) : []) {
      if (this.queue.length >= MAX_QUEUE) break
      if (!v || typeof v.text !== 'string' || typeof v.title !== 'string' || !FORMATS.includes(v.format) || !Array.isArray(v.sources)) continue
      const text = v.text.trim(), title = v.title.trim()
      const refs = v.sources.filter((x: unknown): x is string => typeof x === 'string')
      if (!title || title.length > 100 || !text || text.length > 600 || !refs.length || refs.length !== v.sources.length || refs.some((x: string) => !sources.has(x)) || acknowledgementOnly(text) || rawEngineeringNotice(title, text)) continue
      if (isRepeat(text, [...known, ...this.history.map(s => s.text), ...this.queue.map(s => s.text)].map(title => ({ title })))) continue
      this.queue.push({ id: 'r:' + crypto.createHash('sha256').update(text).digest('hex').slice(0, 20), title, format: v.format, text, sources: refs, at: now, lang })
    }
    this.save()
  }

  /** Private editorial intake, validated through the same gates as generated candidates. */
  ingest(sources: Set<string>, known: string[], now: number, lang: string) {
    const incoming = this.file + ".incoming.json"
    if (!fs.existsSync(incoming) || this.queue.length > MAX_QUEUE - BATCH_SIZE) return
    const raw = JSON.parse(fs.readFileSync(incoming, "utf8"))
    if (raw.lang !== lang || !Array.isArray(raw.items) || raw.items.length > BATCH_SIZE) return
    this.add(raw.items, sources, known, now, lang)
    fs.unlinkSync(incoming)
  }

  publish(now: number, sources: Set<string>, lang: string, send: (story: Story) => void) {
    const before = this.queue.length
    this.queue = this.queue.filter(s => now - s.at < MAX_AGE && s.sources.every(id => sources.has(id)))
    if (before !== this.queue.length) this.save()
    if (now - this.last < RELEASE_MS) return
    const eligible = (s: Story) => s.lang === lang
    let index = this.queue.findIndex(s => eligible(s) && s.format !== this.history.at(-1)?.format)
    if (index < 0) index = this.queue.findIndex(eligible)
    if (index < 0) return
    const story = this.queue[index]
    send(story)
    this.queue.splice(index, 1)
    this.history = [...this.history, { text: story.text, format: story.format }].slice(-300)
    this.last = now
    this.save()
  }
}
