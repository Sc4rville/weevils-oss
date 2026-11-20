// weevboss as stateless turns (server/boss-view.ts builds what each turn sees). One message = one `claude -p` run in the
// orchestrator's folder (same CLAUDE.md, same tools: Bash, weevils, Read…), launched in a tmux pane so it survives a
// restart of weevilsd. Messages that arrive during a turn wait their turn here, persisted on disk.

import fs from 'node:fs'
import path from 'node:path'
import { CLAUDE_DIR, DATA_DIR, ORCH_DIR } from './config.ts'
import { BossJournal, BossSummaries, buildView, groupKey, GROUP, recall, tokensOf, type Summarize, type ViewState } from './boss-view.ts'

export const BOSS_DIR = path.join(DATA_DIR, 'boss')
/** On by default; WEEVILS_BOSS_TURNS=0 keeps the former single interactive conversation. */
export const BOSS_TURNS = process.env.WEEVILS_BOSS_TURNS !== '0'
/** Size of the view each turn receives, in tokens (stable ladder + word-for-word part). */
export const BOSS_VIEW_TOKENS = Math.max(8000, Number(process.env.WEEVILS_BOSS_VIEW_TOKENS ?? 40_000) || 40_000)
/** The claude.ai connectors and MCP servers in weevboss's turns (off: they weigh ~15k tokens on every message). */
export const BOSS_MCP = process.env.WEEVILS_BOSS_MCP === '1'
/** The models weevboss's turns can run on (Claude Code aliases, always the latest of each family) and their efforts. */
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
export const BOSS_MODELS = [
  { id: 'opus', label: 'Opus', efforts: EFFORTS, defaultEffort: 'medium' },
  { id: 'fable', label: 'Fable', efforts: EFFORTS, defaultEffort: 'medium' },
  { id: 'sonnet', label: 'Sonnet', efforts: EFFORTS, defaultEffort: 'medium' },
]
/** weevboss's default when nothing was chosen in the app (Scarville, 2026-11-14: Opus, medium effort). */
export const BOSS_MODEL = process.env.WEEVILS_BOSS_MODEL || 'opus'
export const BOSS_EFFORT = process.env.WEEVILS_BOSS_EFFORT || 'medium'
const readOr = (file: string) => { try { return fs.readFileSync(file, 'utf8') } catch { return '' } }
/** Where Claude Code keeps the orchestrator's transcripts and its memory folder. */
export const orchTranscriptsDir = (claudeDir = CLAUDE_DIR, orchDir = ORCH_DIR) => path.join(claudeDir, orchDir.replace(/[^a-zA-Z0-9]/g, '-'))

/** The hidden blocks at the end of a message (« ⟦weevils — …⟧ »), peeled off so a turn can join them into one. */
export function peelContext(text: string): { text: string; parts: string[] } {
  const parts: string[] = []
  let rest = text
  for (;;) {
    const m = /\s*⟦weevils(?:\s*—\s*)?([^⟧]*)⟧\s*$/.exec(rest)
    if (!m) break
    if (m[1].trim()) parts.unshift(m[1].trim())
    rest = rest.slice(0, m.index)
  }
  return { text: rest.trim(), parts }
}

export interface Queued {
  text: string
  at: number
  tries?: number
  /** Capture id of the message in the request ledger (server/boss-ledger.ts). */
  cid?: string
}

interface TurnsState {
  view: ViewState
  /** Session ids of the turns, newest last (bounded). */
  turns: string[]
  queue: Queued[]
  model?: string
  effort?: string
}

export interface PreparedTurn {
  id: string
  command: string[]
  stableTokens: number
  recentTokens: number
  /** Size of the request ledger's digest joined to the message. */
  ledgerTokens?: number
  rebuilt: boolean
}

export class BossTurns {
  readonly journal: BossJournal
  readonly summaries: BossSummaries
  private s: TurnsState = { view: {}, turns: [], queue: [] }
  private readonly file: string
  private warming = false

  readonly dir: string
  readonly transcripts: string
  readonly budget: number

  constructor(summarize: Summarize, dir = BOSS_DIR, transcripts = orchTranscriptsDir(), budget = BOSS_VIEW_TOKENS) {
    this.dir = dir
    this.transcripts = transcripts
    this.budget = budget
    this.journal = new BossJournal(transcripts, dir)
    this.summaries = new BossSummaries(dir, summarize)
    this.file = path.join(dir, 'turns.json')
    try { this.s = { view: {}, turns: [], queue: [], ...JSON.parse(fs.readFileSync(this.file, 'utf8')) } } catch { /* first run */ }
  }

  private save() {
    fs.mkdirSync(this.dir, { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(this.s, null, 1))
  }

  get queue(): readonly Queued[] { return this.s.queue }
  isTurn(id: string | undefined) { return !!id && this.s.turns.includes(id) }
  lastTurn(): string | undefined { return this.s.turns.at(-1) }

  enqueue(text: string, cid?: string) {
    this.s.queue.push({ text, at: Date.now(), ...(cid ? { cid } : {}) })
    this.save()
  }

  /** The head turn could not start: retried a few times, then dropped (said in the log). */
  failed(e: Error) {
    const q = this.s.queue[0]
    if (!q) return
    q.tries = (q.tries ?? 0) + 1
    console.error(`[weevboss] tour refusé (${q.tries}/3) : ${e.message}`)
    if (q.tries >= 3) this.s.queue.shift()
    this.save()
  }

  /** The newest handoff note in the orchestrator's memory folder, when recent (the log covers the rest). */
  private handoff(now: number): string {
    const dir = path.join(this.transcripts, 'memory')
    try {
      const files = fs.readdirSync(dir).filter((f) => /^handoff-.*\.md$/.test(f)).map((f) => path.join(dir, f))
      const newest = files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]
      if (!newest || now - fs.statSync(newest).mtimeMs > 14 * 86400_000) return ''
      const body = fs.readFileSync(newest, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').trim()
      return body ? `## Handoff note (${path.basename(newest)}, written by your former single conversation)\n${body}` : ''
    } catch {
      return ''
    }
  }

  /** The model and effort of the next turns: the app's choice, else the default (never the global Claude Code setting). */
  get model() { return this.s.model || BOSS_MODEL }
  get effort() { return this.s.effort || BOSS_EFFORT }

  /** Sets model and effort for the next turns (a running turn keeps its own), then reads them back from disk. */
  choose(model: string, effort: string): { model: string; effort: string } {
    const m = BOSS_MODELS.find((x) => x.id === model)
    if (!m || !m.efforts.includes(effort)) throw new Error(`unknown model or effort: ${model} ${effort}`) // i18n-ignore
    this.s.model = model
    this.s.effort = effort
    this.save()
    const disk = JSON.parse(fs.readFileSync(this.file, 'utf8')) as TurnsState
    return { model: disk.model || BOSS_MODEL, effort: disk.effort || BOSS_EFFORT }
  }

  /** The model the newest finished turn really ran on, read from its transcript. */
  lastModel(): string | undefined {
    for (const id of [...this.s.turns].reverse().slice(0, 3)) {
      const found = readOr(path.join(this.transcripts, `${id}.jsonl`)).match(/"model":"(claude-[^"]+)"/g)
      if (found?.length) return found[found.length - 1].slice(9, -1)
    }
    return undefined
  }

  /** Slash commands typed in weevboss's thread, in turn mode: model and effort stick to the next turns. */
  command(text: string): boolean {
    const [cmd, value] = text.trim().split(/\s+/)
    if (cmd === '/model' && value) this.s.model = value
    else if (cmd === '/effort' && value) this.s.effort = value
    // Nothing piles up any more: /compact and /clear rebuild the ladder, keeping only the last exchanges word for word.
    else if (cmd === '/compact' || cmd === '/clear' || cmd === '/new') this.s.view = {}
    else return false
    this.save()
    return true
  }

  /** Builds the view and the command of the next turn (the head of the queue). */
  async prepare(o: { id: string; claude: string[]; memory: string; ledger?: string; instructions?: string; summaryMs?: number; now?: number }): Promise<PreparedTurn> {
    const q = this.s.queue[0]
    if (!q) throw new Error('empty queue') // i18n-ignore : internal guard, never shown
    const now = o.now ?? Date.now()
    this.journal.sync()
    const head = [this.handoff(now), o.memory ? `## What weevils remembers about the user (newest first; full list with ids: weevils memory)\n${o.memory}` : ''].filter(Boolean).join('\n\n')
    const instructions = o.instructions ?? readOr(path.join(ORCH_DIR, 'CLAUDE.md'))
    const view = await buildView({ entries: this.journal.entries(), summaries: this.summaries, state: this.s.view, budget: this.budget, dataDir: this.dir, head, instructions, summaryMs: o.summaryMs ?? 20_000, now })
    const { text, parts } = peelContext(q.text)
    const recent = view.recent ? `the latest exchanges of your thread before this message, word for word, oldest first (ids work with weevils recall):\n${view.recent}` : ''
    // The request ledger's digest (fixed budget): open requests, stale first, goals, the user's rules.
    const ledger = o.ledger?.trim() ? `your request ledger right now (this message is not in it yet):\n${o.ledger.trim()}` : ''
    const block = [...parts, ledger, recent].filter(Boolean).join(' — ').replace(/⟧/g, ']')
    const prompt = block ? `${text} ⟦weevils — ${block}⟧` : text
    const turns = path.join(this.dir, 'turns')
    fs.mkdirSync(turns, { recursive: true })
    const promptFile = path.join(turns, `${o.id}.txt`)
    fs.writeFileSync(promptFile, prompt)
    try {
      const old = fs.readdirSync(turns).map((f) => path.join(turns, f))
      old.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs).slice(30).forEach((f) => fs.rmSync(f, { force: true }))
    } catch { /* nothing to tidy */ }
    const [bin, ...flags] = o.claude
    const args = [
      ...flags, '-p', '--session-id', o.id,
      // Date, folder and git state out of the system prompt: the stable prefix stays byte for byte the same.
      '--exclude-dynamic-system-prompt-sections',
      '--append-system-prompt-file', view.stableFile,
      // Lean by construction: its CLAUDE.md (and the same AGENTS.md for Codex) is already in the cached prefix, not loaded again uncached, no
      // skill listing, and no MCP connectors (Bash, Read, weevils… are what it needs; WEEVILS_BOSS_MCP=1 brings them back).
      '--settings', JSON.stringify({ claudeMdExcludes: [path.join(ORCH_DIR, 'CLAUDE.md'), path.join(ORCH_DIR, 'AGENTS.md')] }),
      '--disable-slash-commands',
      ...(BOSS_MCP ? [] : ['--strict-mcp-config']),
      '--model', this.model,
      '--effort', this.effort,
    ]
    // The prompt goes through a file (stdin): no tmux command-length limit, the whole message reaches the turn.
    const command = ['env', ...(BOSS_MCP ? [] : ['ENABLE_CLAUDEAI_MCP_SERVERS=false']), 'bash', '-c', 'f=$1; shift; exec "$@" < "$f"', 'weevboss-turn', promptFile, bin, ...args]
    this.save()
    return { id: o.id, command, stableTokens: view.stableTokens, recentTokens: view.recentTokens + tokensOf(text), ledgerTokens: tokensOf(ledger), rebuilt: view.rebuilt }
  }

  /** The head turn is running: it leaves the queue (returned), its id joins the turns. */
  started(t: PreparedTurn): Queued | undefined {
    const q = this.s.queue.shift()
    this.s.turns = [...this.s.turns, t.id].slice(-2000)
    this.save()
    fs.appendFileSync(path.join(this.dir, 'metrics.jsonl'), JSON.stringify({ id: t.id, at: Date.now(), stable: t.stableTokens, recent: t.recentTokens, ledger: t.ledgerTokens ?? 0, rebuilt: t.rebuilt }) + '\n')
    return q
  }

  recall(id: string): string | null {
    this.journal.sync()
    return recall(this.journal.entries(), this.summaries, id)
  }

  /** Between turns: the summaries the next ladder will need, written ahead (Haiku, once per message). */
  async prewarm(deadlineMs = 10 * 60_000) {
    if (this.warming) return
    this.warming = true
    try {
      this.journal.sync()
      const conv = this.journal.entries().filter((e) => e.role !== 'event')
      const lines = conv.slice(0, -2)
      const full = Math.floor(conv.length / GROUP)
      const groups = Array.from({ length: full }, (_, k) => {
        const members = conv.slice(k * GROUP, k * GROUP + GROUP)
        return { key: groupKey(k, members), members }
      })
      await this.summaries.ensure({ lines, groups, days: [] }, Date.now() + deadlineMs)
    } finally {
      this.warming = false
    }
  }

  status() {
    const v = this.s.view
    let stable = 0
    try { if (v.stableFile) stable = tokensOf(fs.readFileSync(v.stableFile, 'utf8')) } catch { /* rebuilt next turn */ }
    return { mode: 'turns' as const, budget: this.budget, stableTokens: stable, rebuilds: v.rebuilds ?? 0, builtAt: v.builtAt, turns: this.s.turns.length, queued: this.s.queue.length, model: this.model, effort: this.effort, lastModel: this.lastModel(), journal: this.journal.entries().length }
  }
}
