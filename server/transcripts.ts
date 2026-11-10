// Lecture incrémentale des transcripts Claude Code (~/.claude/projects) et Codex (~/.codex/sessions).
// Formats non documentés : on lit ce qui est utile et on ignore le reste sans jamais planter.

import fs from 'node:fs'
import path from 'node:path'
import type { Message, Subagent, Tool } from '../shared/api.ts'
import { tr } from './i18n.ts'
import M from './i18n/transcripts.ts'
import { authorName, parseSigned } from './authors.ts'
import { backgroundOf, bgLine, emptyBg, procInfo as procInfoOf, type BgState, type ProcInfo } from './background.ts'

export interface Transcript {
  id: string
  tool: Tool
  file: string
  cwd: string
  branch?: string
  /** Titre automatique de l'outil (ai-title). */
  title?: string
  /** Titre choisi par l'utilisateur dans l'outil (/rename) : prime sur tout. */
  customTitle?: string
  firstPrompt?: string
  originator?: string
  openedAt: number
  lastActivityAt: number
  workStartedAt: number | null
  /** Dernier état lu dans le fil. */
  phase: 'working' | 'idle'
  messages: Message[]
  /** Sous-agents, étapes de workflow et commandes d'arrière-plan (server/background.ts), récents et finis compris. */
  subagents: Subagent[]
  /** claude : ce que le fil dit du travail d'arrière-plan (lancements, fins annoncées, bilans de fin de tour). */
  bg?: BgState
  /** Interne : offset de lecture et ligne incomplète. */
  offset: number
  partial: string
  lastAssistantId?: string
  /** Modèle vu dans la dernière réponse (claude) ou le dernier turn_context (codex). */
  model?: string
  /** codex : approval_policy du dernier turn_context. */
  approval?: string
  /** claude : effort de la dernière requête (output_config.effort). */
  effort?: string
  /** Messages mis en file pendant que l'agent travaille, pas encore repris comme messages de l'utilisateur. */
  queued: { key: string; at: number }[]
}

const MAX_MESSAGES = 400
const pidAlive = (pid: number | undefined): boolean => {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}
/** Un texte dicté ou collé arrive enveloppé dans <pasted_content id="…">…</pasted_content> : on garde le dedans. */
export const unwrapPasted = (text: string) => text.replace(/<pasted_content\b[^>]*>/g, '').replace(/<\/pasted_content>/g, '').trim()
const userMsg = (id: string, raw: string, at: number): Message => {
  const text = unwrapPasted(raw)
  // Signé « [from:<id>] » (ou l'ancien « [weevils] ») : écrit par weevboss ou un agent externe, pas par l'utilisateur.
  const signed = parseSigned(text)
  return signed ? { id, role: 'orchestrator', author: signed.author, text: signed.text, at } : { id, role: 'user', text, at }
}
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
/** Bruit : balises système (command-name, local-command-stdout, system-reminder…), interruptions, caveats. Un bloc collé n'en est pas. */
const isNoise = (text: string) => {
  const t = unwrapPasted(text)
  return !t || /^</.test(t) || /^\[Request interrupted by user/.test(t) || t.startsWith('Caveat:') || /^#?\s*AGENTS\.md instructions/i.test(t) || t.includes('<INSTRUCTIONS>')
}

/** Ligne qui remet une <task-notification> à l'agent : mise en file, ou message « user » qui la porte. */
const notifies = (o: any): boolean => {
  if (o.type === 'queue-operation') return o.operation === 'enqueue' && typeof o.content === 'string' && o.content.includes('<task-notification>')
  if (o.type !== 'user') return false
  const c = o.message?.content
  if (typeof c === 'string') return c.includes('<task-notification>')
  return Array.isArray(c) && c.some((p: any) => p?.type === 'text' && typeof p.text === 'string' && p.text.includes('<task-notification>'))
}

const queueKey = (text: string) => unwrapPasted(text).replace(/\s+/g, ' ').slice(0, 200)
/** Le message repris par l'agent était en file : on le retire de la file (il est déjà dans le fil). */
function dequeue(t: Transcript, text: string): boolean {
  const k = queueKey(text)
  const i = t.queued.findIndex((q) => q.key === k)
  if (i < 0) return false
  t.queued.splice(i, 1)
  return true
}

function push(t: Transcript, m: Message) {
  t.messages.push(m)
  if (t.messages.length > MAX_MESSAGES) t.messages.splice(0, t.messages.length - MAX_MESSAGES)
}

function toolSummary(name: string, input: Record<string, unknown> | undefined): string {
  const i = input ?? {}
  const pick = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '')
  const detail = pick('description') || pick('file_path') || pick('command') || pick('pattern') || pick('url') || pick('query') || pick('prompt')
  return `${name}${detail ? ` · ${short(oneLine(detail), 90)}` : ''}`
}

function touch(t: Transcript, at: number) {
  if (!at || Number.isNaN(at)) return
  if (!t.openedAt || at < t.openedAt) t.openedAt = at
  if (at > t.lastActivityAt) t.lastActivityAt = at
}

// ---------------------------------------------------------------------------
// Claude Code

function claudeLine(t: Transcript, o: any) {
  const at = o.timestamp ? Date.parse(o.timestamp) : 0
  bgLine((t.bg ??= emptyBg()), o, at)
  if (o.cwd) t.cwd = o.cwd
  if (o.gitBranch && o.gitBranch !== 'HEAD') t.branch = o.gitBranch
  if (o.type === 'ai-title' && o.aiTitle) t.title = o.aiTitle
  if (o.type === 'custom-title' && o.customTitle) t.customTitle = o.customTitle
  if (o.isSidechain) return

  // Fin d'un travail d'arrière-plan annoncée (<task-notification>, ligne « bruit » ignorée plus bas) : Claude Code la
  // traite aussitôt dans un nouveau tour. Sans ça, la session repasserait « idle » quelques secondes (et pousserait un
  // « a fini » trop tôt) entre la fin du dernier sous-agent et la première réponse.
  if (t.phase === 'idle' && notifies(o)) {
    touch(t, at)
    t.phase = 'working'
    t.workStartedAt = at
  }

  // Message envoyé pendant que l'agent travaillait : Claude Code ne l'écrit pas comme « user » mais comme pièce jointe absorbée.
  if (o.type === 'attachment' && o.attachment?.type === 'queued_command' && typeof o.attachment.prompt === 'string') {
    const text = o.attachment.prompt
    if (isNoise(text)) return
    touch(t, at)
    t.firstPrompt ??= text
    t.queued.push({ key: queueKey(text), at })
    push(t, userMsg(o.uuid ?? `${t.id}-${at}-q`, text, at))
    return
  }
  if (o.type === 'api-request-blob') {
    const effort = o.message?.output_config?.effort
    if (typeof effort === 'string' && effort) t.effort = effort
    return
  }

  if (o.type === 'user') {
    touch(t, at)
    // Un message mis en file est remis à l'agent avec le pas suivant de son tour (résultat d'outil ou nouveau message) :
    // tout ce qui a été mis en file avant ce pas est donc traité.
    if (t.queued.length) t.queued = t.queued.filter((q) => q.at >= at)
    const c = o.message?.content
    if (typeof c === 'string') {
      if (o.isMeta || isNoise(c)) return
      t.firstPrompt ??= c
      t.phase = 'working'
      t.workStartedAt = at
      if (!dequeue(t, c)) push(t, userMsg(o.uuid ?? `${t.id}-${at}`, c, at))
      return
    }
    if (Array.isArray(c)) {
      for (const part of c) {
        if (part?.type === 'text' && !o.isMeta && !isNoise(part.text ?? '')) {
          t.firstPrompt ??= part.text
          t.phase = 'working'
          t.workStartedAt = at
          if (dequeue(t, String(part.text))) continue
          push(t, userMsg(`${o.uuid}-t`, String(part.text), at))
        } else if (part?.type === 'tool_result') {
          t.phase = 'working'
        }
      }
    }
    return
  }

  if (o.type === 'assistant') {
    touch(t, at)
    const msg = o.message ?? {}
    if (typeof msg.model === 'string' && msg.model) t.model = msg.model
    for (const part of msg.content ?? []) {
      if (part?.type === 'text' && part.text?.trim()) {
        const prev = t.messages[t.messages.length - 1]
        if (prev && prev.role === 'assistant' && t.lastAssistantId === msg.id) prev.text += `\n\n${part.text.trim()}`
        else push(t, { id: `${msg.id ?? o.uuid}-${t.messages.length}`, role: 'assistant', text: part.text.trim(), at })
        t.lastAssistantId = msg.id
      } else if (part?.type === 'tool_use') {
        push(t, { id: part.id ?? `${o.uuid}-tool`, role: 'event', text: toolSummary(part.name, part.input), at })
        t.lastAssistantId = undefined
      }
    }
    t.phase = msg.stop_reason === 'end_turn' ? 'idle' : 'working'
    if (t.phase === 'idle') t.workStartedAt = null
  }
}

// ---------------------------------------------------------------------------
// Codex

function codexLine(t: Transcript, o: any) {
  const at = o.timestamp ? Date.parse(o.timestamp) : 0
  const p = o.payload ?? {}
  if (o.type === 'session_meta') {
    if (p.id) t.id = p.id
    if (p.cwd) t.cwd = p.cwd
    t.originator = p.originator
    if (p.git?.branch) t.branch = p.git.branch
    touch(t, at)
    return
  }
  if (o.type === 'turn_context') {
    if (p.cwd) t.cwd = p.cwd
    if (typeof p.model === 'string' && p.model) t.model = p.model
    if (typeof p.approval_policy === 'string') t.approval = p.approval_policy
  }
  if (o.type === 'event_msg') {
    if (p.type === 'task_started') {
      t.phase = 'working'
      t.workStartedAt = at
      touch(t, at)
    } else if (p.type === 'task_complete' || p.type === 'turn_aborted') {
      t.phase = 'idle'
      t.workStartedAt = null
      touch(t, at)
    }
    return
  }
  if (o.type !== 'response_item') return
  if (p.type === 'message') {
    const text = (p.content ?? [])
      .map((c: any) => c?.text ?? '')
      .join('\n')
      .trim()
    if (p.role === 'user') {
      if (isNoise(text)) return
      t.firstPrompt ??= text
      touch(t, at)
      push(t, userMsg(p.id ?? `${t.id}-${at}`, text, at))
    } else if (p.role === 'assistant' && text) {
      touch(t, at)
      push(t, { id: p.id ?? `${t.id}-${at}-a`, role: 'assistant', text, at })
    }
    return
  }
  if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
    touch(t, at)
    let input: any = {}
    try {
      input = typeof p.arguments === 'string' ? JSON.parse(p.arguments) : (p.arguments ?? p.action ?? {})
    } catch {
      input = { command: String(p.arguments ?? '') }
    }
    if (Array.isArray(input.command)) input.command = input.command.join(' ')
    if (Array.isArray(input.cmd)) input.command = input.cmd.join(' ')
    else if (typeof input.cmd === 'string') input.command = input.cmd
    push(t, { id: p.call_id ?? `${t.id}-${at}-f`, role: 'event', text: toolSummary(p.name ?? tr(M).tool, input), at })
  }
}

// ---------------------------------------------------------------------------
// Lecture incrémentale

function emptyTranscript(file: string, tool: Tool): Transcript {
  const base = path.basename(file, '.jsonl')
  const id = tool === 'claude' ? base : (base.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)?.[0] ?? base)
  return { id, tool, file, cwd: '', openedAt: 0, lastActivityAt: 0, workStartedAt: null, phase: 'idle', messages: [], subagents: [], bg: tool === 'claude' ? emptyBg() : undefined, offset: 0, partial: '', queued: [] }
}

/** Lit la suite du fichier ; renvoie true si quelque chose a changé. */
export function readMore(t: Transcript, size: number): boolean {
  if (size < t.offset) {
    // Fichier réécrit : on repart de zéro.
    Object.assign(t, emptyTranscript(t.file, t.tool))
  }
  if (size === t.offset) return false
  const fd = fs.openSync(t.file, 'r')
  try {
    const len = size - t.offset
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, t.offset)
    t.offset = size
    const text = t.partial + buf.toString('utf8')
    const lines = text.split('\n')
    t.partial = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      let o: unknown
      try {
        o = JSON.parse(line)
      } catch {
        continue
      }
      if (t.tool === 'claude') claudeLine(t, o)
      else codexLine(t, o)
    }
  } finally {
    fs.closeSync(fd)
  }
  return true
}

function listClaudeFiles(root: string): string[] {
  const out: string[] = []
  let dirs: string[] = []
  try {
    dirs = fs.readdirSync(root)
  } catch {
    return out
  }
  for (const d of dirs) {
    try {
      for (const f of fs.readdirSync(path.join(root, d))) if (f.endsWith('.jsonl')) out.push(path.join(root, d, f))
    } catch {
      /* pas un dossier */
    }
  }
  return out
}

function listCodexFiles(root: string, now: number, recentMs: number): string[] {
  const out: string[] = []
  // Arborescence AAAA/MM/JJ : on ne descend que dans les jours récents.
  for (let d = 0; d <= Math.ceil(recentMs / 86400_000); d++) {
    const day = new Date(now - d * 86400_000)
    const dir = path.join(root, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'))
    try {
      for (const f of fs.readdirSync(dir)) if (f.endsWith('.jsonl')) out.push(path.join(dir, f))
    } catch {
      /* jour sans session */
    }
  }
  return out
}

export class TranscriptStore {
  readonly byFile = new Map<string, Transcript>()
  claudeDir: string
  codexDir: string
  recentMs: number
  /** Pid du processus claude d'une session (pane tmux, sinon hook), pour les preuves de vie de son arrière-plan. */
  pidOf?: (id: string) => number | undefined

  constructor(claudeDir: string, codexDir: string, recentMs: number) {
    this.claudeDir = claudeDir
    this.codexDir = codexDir
    this.recentMs = recentMs
  }

  /** Un passage de scan ; renvoie true si au moins un transcript a changé. */
  scan(now: number): boolean {
    let changed = false
    const files: [string, Tool][] = [
      ...listClaudeFiles(this.claudeDir).map((f) => [f, 'claude'] as [string, Tool]),
      ...listCodexFiles(this.codexDir, now, this.recentMs).map((f) => [f, 'codex'] as [string, Tool]),
    ]
    for (const [file, tool] of files) {
      let st: fs.Stats
      try {
        st = fs.statSync(file)
      } catch {
        continue
      }
      let t = this.byFile.get(file)
      if (!t) {
        if (now - st.mtimeMs > this.recentMs) continue
        t = emptyTranscript(file, tool)
        this.byFile.set(file, t)
      }
      let grew = false
      try {
        grew = readMore(t, st.size)
        if (grew) changed = true
      } catch {
        /* lecture ratée : on réessaiera */
      }
      // Un arrière-plan qui tourne se relit même quand le fil principal se tait depuis longtemps (workflow de plusieurs heures) ;
      // un fil qui vient d'être lu (premier passage après un redémarrage, fin annoncée) aussi, et toute session dont le
      // processus claude vit : un élément coupé par la borne de sûreté qui se remet à écrire doit repasser « working ».
      if (tool === 'claude' && (grew || now - t.lastActivityAt < 3600_000 || t.subagents.some((s) => s.status === 'working') || (t.subagents.length > 0 && pidAlive(this.pidOf?.(t.id))))) {
        let proc: ProcInfo | null | undefined
        const subs = backgroundOf(t.file, (t.bg ??= emptyBg()), now, () => (proc === undefined ? (proc = procInfoOf(this.pidOf?.(t.id))) : proc))
        if (JSON.stringify(subs) !== JSON.stringify(t.subagents)) {
          t.subagents = subs
          changed = true
        }
      }
    }
    return changed
  }

  all(): Transcript[] {
    return [...this.byFile.values()].filter((t) => t.lastActivityAt > 0)
  }

  get(id: string): Transcript | undefined {
    return this.all().find((t) => t.id === id)
  }
}

const unsigned = (s: string | undefined) => (s ? (parseSigned(s)?.text ?? s) : s)
export const titleOf = (t: Transcript) => short(oneLine(t.customTitle || t.title || unsigned(t.firstPrompt) || tr(M).newSession).replace(/^[#>*\s-]+/, ''), 60)
/** Matière pour le renommeur : début de la session et ses derniers échanges, compacts. */
export const digestOf = (t: Transcript, lastN = 10) => {
  const s = tr(M)
  const recent = t.messages.slice(-lastN).map((m) => s.said(m.role === 'user' ? s.userLabel : m.role === 'orchestrator' ? authorName(m.author) : m.role === 'assistant' ? 'agent' : '→', short(oneLine(m.text), m.role === 'event' ? 80 : 320)))
  return { debut: short(oneLine(unsigned(t.firstPrompt) ?? ''), 200), recents: recent }
}
export const lastMessageOf = (t: Transcript) => {
  const m = [...t.messages].reverse().find((x) => x.role !== 'event')
  return m ? short(oneLine(m.text), 120) : undefined
}
