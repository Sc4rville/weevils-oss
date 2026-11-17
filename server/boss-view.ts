// weevboss without a growing conversation. Each message runs as a stateless turn (claude -p) that receives a view of
// FIXED size over the whole thread, rebuilt by weevilsd:
//   - a stable prefix, passed as an appended system prompt so the prompt cache keeps it from one turn to the next:
//     the latest handoff note, then the older history summarised more and more strongly, on a logarithmic ladder
//     (one line per day, then one line per group of messages, then one line per message);
//   - the latest exchanges, word for word, joined to the message in the hidden ⟦weevils …⟧ block (never displayed).
// Every line carries an id; `weevils recall <id>` reopens the original word for word (a message) or the lines inside
// (a group, a day). The summaries are written once per message by Haiku and kept on disk.
//
// The journal is read from the orchestrator's transcripts (the old interactive conversation and every turn since), so
// nothing is lost and the app's thread keeps reading the same transcripts as before.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { parseSigned } from './authors.ts'
import { originOf, readOrigins, type BossOrigin } from './boss-origins.ts'
import { withoutContext } from './setup.ts'

export type EntryRole = 'user' | 'assistant' | 'agent' | 'event'
export interface Entry {
  id: string
  at: number
  role: EntryRole
  text: string
  /** agent: the declared source ([from:x]). */
  author?: string
  /** user: where the message came from (server/boss-origins.ts), when weevilsd sent it. Audit only. */
  origin?: BossOrigin
}

/** Rough token count of a text (mixed French and English prose, ids, code). */
export const tokensOf = (s: string) => Math.ceil(s.length / 3.2)
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s)
const hash = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12)
export const shortId = (id: string) => id.replace(/-/g, '').slice(0, 8)

// ---------------------------------------------------------------- journal

const isNoise = (t: string) => !t || /^</.test(t) || /^\[Request interrupted by user/.test(t) || t.startsWith('Caveat:') || t.includes('<task-notification>')

/** The entries of one Claude Code transcript line (exported for the tests). */
export function entriesOfLine(o: any): Entry[] {
  if (!o || o.isSidechain || o.isMeta || o.isCompactSummary) return []
  const at = o.timestamp ? Date.parse(o.timestamp) : 0
  const id = String(o.uuid ?? '')
  if (!id || !at) return []
  const content = o.message?.content
  if (o.type === 'user') {
    const texts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter((p: any) => p?.type === 'text' && typeof p.text === 'string').map((p: any) => p.text) : []
    const raw = texts.join('\n').trim()
    if (isNoise(raw)) return []
    const text = withoutContext(raw).trim()
    if (!text) return []
    const signed = parseSigned(text)
    return [signed ? { id, at, role: 'agent', text: signed.text, author: signed.author } : { id, at, role: 'user', text }]
  }
  if (o.type === 'assistant' && Array.isArray(content)) {
    const out: Entry[] = []
    content.forEach((p: any, i: number) => {
      const pid = i ? `${id}.${i}` : id
      if (p?.type === 'text' && typeof p.text === 'string' && p.text.trim()) out.push({ id: pid, at, role: 'assistant', text: p.text.trim() })
      else if (p?.type === 'tool_use') {
        const input = p.input ?? {}
        const detail = [input.command, input.description, input.file_path, input.prompt, input.pattern, input.url].find((v) => typeof v === 'string' && v.trim())
        out.push({ id: pid, at, role: 'event', text: `${p.name}${detail ? ` · ${clip(oneLine(detail), 160)}` : ''}` })
      }
    })
    return out
  }
  return []
}

interface Offsets {
  [file: string]: { offset: number; ino?: number }
}

/** Every exchange weevboss ever had, read incrementally from the orchestrator's transcripts and kept on disk. */
export class BossJournal {
  private list: Entry[] = []
  private ids = new Set<string>()
  private offsets: Offsets = {}
  private readonly journalFile: string
  private readonly offsetsFile: string
  private loaded = false
  private usedOrigins = new Set<string>()

  /** ~/.claude/projects/<slug of the orchestrator's folder> */
  readonly transcriptsDir: string
  readonly dataDir: string

  constructor(transcriptsDir: string, dataDir: string) {
    this.transcriptsDir = transcriptsDir
    this.dataDir = dataDir
    this.journalFile = path.join(dataDir, 'journal.jsonl')
    this.offsetsFile = path.join(dataDir, 'offsets.json')
  }

  private load() {
    if (this.loaded) return
    this.loaded = true
    try {
      for (const line of fs.readFileSync(this.journalFile, 'utf8').split('\n')) {
        if (!line) continue
        try {
          const e = JSON.parse(line) as Entry
          if (!this.ids.has(e.id)) { this.ids.add(e.id); this.list.push(e) }
        } catch { /* a torn last line */ }
      }
    } catch { /* first run */ }
    try { this.offsets = JSON.parse(fs.readFileSync(this.offsetsFile, 'utf8')) } catch { this.offsets = {} }
  }

  /** Reads what the transcripts gained since the last pass. Returns how many entries were added. */
  sync(): number {
    this.load()
    let files: string[] = []
    try { files = fs.readdirSync(this.transcriptsDir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(this.transcriptsDir, f)) } catch { return 0 }
    const fresh: Entry[] = []
    for (const file of files) {
      let st: fs.Stats
      try { st = fs.statSync(file) } catch { continue }
      const known = this.offsets[file]
      let offset = known && known.ino === st.ino && known.offset <= st.size ? known.offset : 0
      if (offset >= st.size) continue
      const fd = fs.openSync(file, 'r')
      try {
        const chunk = 8 << 20
        let rest = ''
        while (offset < st.size) {
          const buf = Buffer.alloc(Math.min(chunk, st.size - offset))
          const n = fs.readSync(fd, buf, 0, buf.length, offset)
          if (n <= 0) break
          const text = rest + buf.subarray(0, n).toString('utf8')
          const lines = text.split('\n')
          rest = lines.pop() ?? ''
          offset += n
          for (const line of lines) {
            if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue
            let o: any
            try { o = JSON.parse(line) } catch { continue }
            for (const e of entriesOfLine(o)) if (!this.ids.has(e.id)) { this.ids.add(e.id); fresh.push(e) }
          }
        }
        // An incomplete last line is read again next time.
        this.offsets[file] = { offset: offset - Buffer.byteLength(rest), ino: st.ino }
      } finally {
        fs.closeSync(fd)
      }
    }
    if (fresh.length) {
      fresh.sort((a, b) => a.at - b.at)
      if (fresh.some((e) => e.role === 'user')) {
        const records = readOrigins(this.dataDir)
        for (const e of fresh) {
          const origin = e.role === 'user' && records.length ? originOf(records, e.text, e.at, this.usedOrigins) : undefined
          if (origin) e.origin = origin
        }
      }
      fs.mkdirSync(this.dataDir, { recursive: true })
      fs.appendFileSync(this.journalFile, fresh.map((e) => JSON.stringify(e)).join('\n') + '\n')
      this.list.push(...fresh)
      // Two transcripts can interleave (an old conversation still open next to the first turns): time order.
      this.list.sort((a, b) => a.at - b.at)
    }
    fs.mkdirSync(this.dataDir, { recursive: true })
    fs.writeFileSync(this.offsetsFile, JSON.stringify(this.offsets))
    return fresh.length
  }

  entries(): Entry[] {
    this.load()
    return this.list
  }
}

// ---------------------------------------------------------------- summaries (Haiku, once, on disk)

export type Summarize = (prompt: string, schema: object) => Promise<string>
export interface Group {
  key: string
  members: Entry[]
}

interface SummaryStore {
  lines: Record<string, string>
  groups: Record<string, string>
  days: Record<string, string>
}

const LINES_SCHEMA = { type: 'object', properties: { lines: { type: 'array', items: { type: 'string' } } }, required: ['lines'] }

/** Short enough to stand as its own summary line. */
const SHORT = 180

const said = (e: Entry) => (e.role === 'user' ? 'user' : e.role === 'agent' ? `agent ${e.author ?? ''}`.trim() : e.role === 'assistant' ? 'weevboss' : 'tool')

export class BossSummaries {
  private s: SummaryStore = { lines: {}, groups: {}, days: {} }
  private readonly file: string
  private readonly run: Summarize
  constructor(dataDir: string, run: Summarize) {
    this.run = run
    this.file = path.join(dataDir, 'summaries.json')
    try { this.s = { lines: {}, groups: {}, days: {}, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) } } catch { /* first run */ }
  }
  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(this.s))
  }

  line(e: Entry): string {
    const t = oneLine(e.text)
    return t.length <= SHORT ? t : this.s.lines[e.id] ?? clip(t, SHORT)
  }
  group(key: string, members: Entry[]): string {
    return this.s.groups[key] ?? clip(members.map((e) => `${said(e)}: ${this.line(e)}`).join(' / '), 260)
  }
  day(key: string, fallback: string): string {
    return this.s.days[key] ?? clip(fallback, 300)
  }
  hasGroup(key: string) { return key in this.s.groups }
  hasDay(key: string) { return key in this.s.days }

  private async ask(prompt: string, n: number): Promise<string[] | null> {
    try {
      const out = JSON.parse(await this.run(prompt, LINES_SCHEMA)) as { lines?: unknown }
      const lines = Array.isArray(out?.lines) ? out.lines.map((l) => oneLine(String(l ?? ''))) : []
      return lines.length === n && lines.every(Boolean) ? lines : null
    } catch (e) {
      console.error(`[weevboss] résumé : ${(e as Error).message.slice(0, 160)}`)
      return null
    }
  }

  /** Writes what is missing, in batches, until the deadline. Whatever is still missing falls back to a clipped text. */
  async ensure(need: { lines: Entry[]; groups: Group[]; days: { key: string; groups: Group[] }[] }, deadline: number, concurrency = 4) {
    const jobs: (() => Promise<void>)[] = []
    const lines = need.lines.filter((e) => oneLine(e.text).length > SHORT && !this.s.lines[e.id])
    for (let i = 0; i < lines.length; i += 20) {
      const batch = lines.slice(i, i + 20)
      jobs.push(async () => {
        const got = await this.ask(
          `Summarise each numbered message from an assistant's chat log in ONE line of at most 22 words, in the message's own language. Keep names, session ids, project names, numbers, decisions and requests; drop politeness. Return exactly ${batch.length} lines, in order.\n\n` +
            batch.map((e, j) => `${j + 1}. ${said(e)}: ${clip(oneLine(e.text), 2400)}`).join('\n'),
          batch.length,
        )
        got?.forEach((l, j) => (this.s.lines[batch[j].id] = clip(l, 220)))
        if (got) this.save()
      })
    }
    const groups = need.groups.filter((g) => !this.s.groups[g.key])
    for (let i = 0; i < groups.length; i += 6) {
      const batch = groups.slice(i, i + 6)
      jobs.push(async () => {
        const got = await this.ask(
          `Each numbered block is a stretch of a chat between a user and their assistant weevboss (who dispatches work to coding sessions). Summarise each block in ONE line of at most 30 words, in the chat's language: what was asked, decided or dispatched, and to which project or session. Return exactly ${batch.length} lines, in order.\n\n` +
            batch.map((g, j) => `${j + 1}. ${g.members.map((e) => `${said(e)}: ${clip(oneLine(e.text), 500)}`).join(' / ')}`).join('\n\n'),
          batch.length,
        )
        got?.forEach((l, j) => (this.s.groups[batch[j].key] = clip(l, 300)))
        if (got) this.save()
      })
    }
    // Days come from their group lines: they run after the groups.
    const dayJobs: (() => Promise<void>)[] = []
    const days = need.days.filter((d) => !this.s.days[d.key])
    for (let i = 0; i < days.length; i += 5) {
      const batch = days.slice(i, i + 5)
      dayJobs.push(async () => {
        const got = await this.ask(
          `Each numbered block lists what happened during one day of a chat between a user and their assistant weevboss. Summarise each day in ONE line of at most 40 words, in the chat's language: the main threads of work, decisions and what stayed open. Return exactly ${batch.length} lines, in order.\n\n` +
            batch.map((d, j) => `${j + 1}. ${clip(d.groups.map((g) => this.group(g.key, g.members)).join(' / '), 12000)}`).join('\n\n'),
          batch.length,
        )
        got?.forEach((l, j) => (this.s.days[batch[j].key] = clip(l, 360)))
        if (got) this.save()
      })
    }
    const pool = async (list: (() => Promise<void>)[]) => {
      let next = 0
      await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, async () => {
        while (next < list.length && Date.now() < deadline) await list[next++]()
      }))
      this.save()
    }
    await pool(jobs)
    await pool(dayJobs)
  }
}

// ---------------------------------------------------------------- the view

export const budgetParts = (total: number) => ({
  stable: Math.round(total * 0.4),
  /** The word-for-word part grows up to this, then the ladder is rebuilt and it shrinks back to `recentTarget`. */
  recentMax: Math.round(total * 0.5),
  recentTarget: Math.round(total * 0.2),
})

/** Fixed groups of messages (events left out): group k holds conversation messages k*G … k*G+G-1. */
export const GROUP = 8

export const groupKey = (k: number, members: Entry[]) => `g${k}:${hash(members.map((e) => e.id).join())}`

const stamp = (at: number) => {
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
const dayOf = (at: number) => {
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** The word-for-word part: entries from `from` on, tool calls folded into one line per run. */
export function renderRecent(entries: Entry[], perMessage = 6000): string {
  const out: string[] = []
  let tools: string[] = []
  const flush = () => {
    if (tools.length) out.push(`  (tools: ${clip(tools.join('; '), 400)})`)
    tools = []
  }
  for (const e of entries) {
    if (e.role === 'event') { tools.push(e.text); continue }
    flush()
    const body = e.text.length > perMessage ? `${e.text.slice(0, perMessage)}… (cut: weevils recall ${shortId(e.id)})` : e.text
    out.push(`[${shortId(e.id)}] ${stamp(e.at)} ${said(e)}: ${body}`)
  }
  flush()
  return out.join('\n')
}

export interface ViewState {
  /** Id of the first conversation message of the word-for-word part. */
  cutId?: string
  /** File holding the stable prefix of the current ladder, and what it was built from. */
  stableFile?: string
  stableKey?: string
  builtAt?: number
  rebuilds?: number
}

export interface BuiltView {
  stableFile: string
  stableTokens: number
  recent: string
  recentTokens: number
  rebuilt: boolean
}

/** Picks the ranges of the ladder over `conv` (older than the cut), oldest tier last. Exported for the tests. */
export function ladder(conv: Entry[], cut: number, stableBudget: number, lineLen: (e: Entry) => number) {
  const t1Budget = stableBudget * 0.55
  const t2Budget = stableBudget * 0.3
  // Tier 1: one line per message, back from the cut, then down to a group boundary.
  let s1 = cut
  let used = 0
  while (s1 > 0 && used + (lineLen(conv[s1 - 1]) + 24) / 3.2 <= t1Budget) used += (lineLen(conv[--s1]) + 24) / 3.2
  s1 = Math.floor(s1 / GROUP) * GROUP
  // Tier 2: whole groups before s1.
  let s2 = s1
  used = 0
  while (s2 >= GROUP && used + 300 / 3.2 <= t2Budget) { s2 -= GROUP; used += 300 / 3.2 }
  return { s1, s2 }
}

export interface ViewInputs {
  entries: Entry[]
  summaries: BossSummaries
  state: ViewState
  budget: number
  dataDir: string
  /** Text placed first in the stable prefix (the newest handoff note, what weevils remembers). */
  head: string
  /** weevboss's instructions (its CLAUDE.md), at the very top of the stable prefix so the cache keeps them too. */
  instructions?: string
  /** Time allowed to write missing summaries before falling back to clipped texts. */
  summaryMs: number
  now?: number
}

/** Builds the view for the next turn; rebuilds the ladder only when the word-for-word part outgrew its share. */
export async function buildView(i: ViewInputs): Promise<BuiltView> {
  const parts = budgetParts(i.budget)
  const conv = i.entries.filter((e) => e.role !== 'event')
  const indexOf = (id?: string) => (id ? i.entries.findIndex((e) => e.id === id) : -1)
  let from = indexOf(i.state.cutId)
  let recent = renderRecent(from >= 0 ? i.entries.slice(from) : [])
  const headKey = hash((i.instructions ?? '') + '\0' + i.head)
  const stableOk = !!i.state.stableFile && fs.existsSync(i.state.stableFile) && from >= 0 && i.state.stableKey?.startsWith(headKey)
  if (stableOk && tokensOf(recent) <= parts.recentMax) {
    return { stableFile: i.state.stableFile!, stableTokens: tokensOf(fs.readFileSync(i.state.stableFile!, 'utf8')), recent, recentTokens: tokensOf(recent), rebuilt: false }
  }
  // New cut: keep about recentTarget tokens word for word (at least the last two messages).
  let c = conv.length
  let size = 0
  while (c > 0) {
    const e = conv[c - 1]
    const add = tokensOf(e.text.slice(0, 6000)) + 12
    if (conv.length - c >= 2 && size + add > parts.recentTarget) break
    size += add
    c--
  }
  // The cut lands on a message: the tool calls before it belong to the summarised past.
  from = c < conv.length ? indexOf(conv[c].id) : i.entries.length
  recent = renderRecent(i.entries.slice(from))
  const { s1, s2 } = ladder(conv, c, parts.stable, (e) => Math.min(oneLine(e.text).length, SHORT))
  const t1 = conv.slice(s1, c)
  const groupAt = (k: number): Group => {
    const members = conv.slice(k * GROUP, k * GROUP + GROUP)
    return { key: groupKey(k, members), members }
  }
  const groups: Group[] = []
  for (let k = s2 / GROUP; k < s1 / GROUP; k++) groups.push(groupAt(k))
  // Tier 3: one line per day before s2, from the summaries of that day's groups (a group belongs to the day it starts).
  const byDay = new Map<string, Group[]>()
  for (let k = 0; k < s2 / GROUP; k++) {
    const g = groupAt(k)
    const day = dayOf(g.members[0].at)
    byDay.set(day, [...(byDay.get(day) ?? []), g])
  }
  const days = [...byDay].map(([day, gs]) => ({ day, key: `d${day}:${hash(gs.map((g) => g.key).join())}`, groups: gs, count: gs.reduce((n, g) => n + g.members.length, 0) }))
  await i.summaries.ensure({ lines: t1, groups: [...groups, ...days.flatMap((d) => d.groups)], days }, Date.now() + i.summaryMs)
  // Days whose text would not fit: the oldest go, with a pointer.
  const t3Budget = parts.stable * 0.15
  let dayLines = days.map((d) => `[d${d.day}] ${d.count} messages: ${i.summaries.day(d.key, d.groups.map((g) => i.summaries.group(g.key, g.members)).join(' / '))}`)
  let dropped = 0
  while (dayLines.length > 1 && tokensOf(dayLines.join('\n')) > t3Budget) { dayLines = dayLines.slice(1); dropped++ }
  if (dropped) dayLines.unshift(`(${dropped} earlier day(s) not shown: weevils recall d${days[0].day} and the following days)`)
  const groupLines = groups.map((g) => {
    const k = g.key.split(':')[0]
    return `[${k}] ${stamp(g.members[0].at)}–${stamp(g.members[g.members.length - 1].at).slice(6)} ${i.summaries.group(g.key, g.members)}`
  })
  const msgLines = t1.map((e) => `[${shortId(e.id)}] ${stamp(e.at)} ${said(e)}: ${i.summaries.line(e)}`)
  const stable = [
    ...(i.instructions?.trim() ? [i.instructions.trim(), ''] : []),
    '# Your thread with the user so far',
    '',
    'You run as stateless turns: no conversation is kept between messages. This log, then the latest exchanges joined to the message (word for word), are your whole memory of the thread. The oldest part is summarised more strongly: one line per day, then per group of messages, then per message. Each line starts with an id: `weevils recall <id>` opens the original word for word (a message) or the lines inside (a group or a day). Recall only when a detail really matters; never re-read the whole log. Live state (sessions, setup, quotas) is never in here: read it with the weevils commands.',
    '',
    i.head.trim(),
    '',
    dayLines.length ? '## Days\n' + dayLines.join('\n') : '',
    groupLines.length ? '## Groups of messages\n' + groupLines.join('\n') : '',
    msgLines.length ? '## Messages\n' + msgLines.join('\n') : '',
  ].filter((l, k, a) => l !== '' || a[k - 1] !== '').join('\n')
  const key = `${headKey}:${hash(stable)}`
  const file = path.join(i.dataDir, `stable-${hash(stable)}.md`)
  fs.mkdirSync(i.dataDir, { recursive: true })
  if (!fs.existsSync(file)) fs.writeFileSync(file, stable)
  // Old prefixes: keep the last few (a turn may still be reading one).
  try {
    const old = fs.readdirSync(i.dataDir).filter((f) => /^stable-.*\.md$/.test(f)).map((f) => path.join(i.dataDir, f)).filter((f) => f !== file)
    old.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs).slice(4).forEach((f) => fs.rmSync(f, { force: true }))
  } catch { /* nothing to tidy */ }
  i.state.cutId = from < i.entries.length ? i.entries[from].id : undefined
  i.state.stableFile = file
  i.state.stableKey = key
  i.state.builtAt = i.now ?? Date.now()
  i.state.rebuilds = (i.state.rebuilds ?? 0) + 1
  return { stableFile: file, stableTokens: tokensOf(stable), recent, recentTokens: tokensOf(recent), rebuilt: true }
}

// ---------------------------------------------------------------- recall

/** `weevils recall <id>`: a message word for word (with the tool calls of its turn), or the lines of a group or a day. */
export function recall(entries: Entry[], summaries: BossSummaries, raw: string): string | null {
  const want = raw.trim().replace(/^\[|\]$/g, '')
  const conv = entries.filter((e) => e.role !== 'event')
  const g = /^g(\d+)$/.exec(want)
  if (g) {
    const k = Number(g[1])
    const members = conv.slice(k * GROUP, k * GROUP + GROUP)
    if (!members.length) return null
    return members.map((e) => `[${shortId(e.id)}] ${stamp(e.at)} ${said(e)}: ${summaries.line(e)}`).join('\n')
  }
  const d = /^d(\d{4}-\d{2}-\d{2})$/.exec(want)
  if (d) {
    const lines: string[] = []
    conv.forEach((e, n) => {
      if (dayOf(e.at) !== d[1]) return
      const k = Math.floor(n / GROUP)
      const members = conv.slice(k * GROUP, k * GROUP + GROUP)
      if (!lines.length || !lines[lines.length - 1].startsWith(`[g${k}]`)) lines.push(`[g${k}] ${stamp(e.at)} ${summaries.group(groupKey(k, members), members)}`)
    })
    return lines.length ? lines.join('\n') : null
  }
  const key = want.replace(/-/g, '').toLowerCase()
  if (key.length < 6) return null
  const at = entries.findIndex((e) => e.id.replace(/-/g, '').toLowerCase().startsWith(key))
  if (at < 0) return null
  const e = entries[at]
  const out = [`[${shortId(e.id)}] ${stamp(e.at)} ${said(e)}:`, e.text]
  if (e.role === 'assistant' || e.role === 'user' || e.role === 'agent') {
    const tools: string[] = []
    for (let j = at + 1; j < entries.length && entries[j].role !== 'user' && entries[j].role !== 'agent'; j++) if (entries[j].role === 'event') tools.push(entries[j].text)
    if (tools.length) out.push('', `(tools in that turn: ${clip(tools.join('; '), 3000)})`)
  }
  return out.join('\n')
}
