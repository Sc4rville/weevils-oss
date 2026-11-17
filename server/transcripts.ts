import { commandDetails, toolOutputDetails, callDetails, commandSummaries, redactToolText } from './codex-command-details.ts'
import { codexToolLabel, codexToolKinds } from './codex-tool-label.ts'
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
  /** claude -p (entrypoint sdk-*) : un appel ponctuel d'un script, pas une session de travail. */
  headless?: boolean
  openedAt: number
  lastActivityAt: number
  workStartedAt: number | null
  /** Dernier état lu dans le fil. */
  phase: 'working' | 'idle'
  /** Le dernier tour s'est arrêté sur une erreur (limite d'usage, connexion expirée, erreur d'API, compaction ratée) :
   *  la session n'a pas fini son travail. Effacé dès que le fil repart (nouveau message, nouvelle réponse). */
  stopError?: StopError
  messages: Message[]
  /** Incoming bridge message IDs to source threads, for attribution after every source has been scanned. */
  delegationSources?: Map<string, string>
  delegationTexts?: Map<string, string>
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

export interface StopError {
  at: number
  reason: 'quota' | 'auth' | 'api'
  text: string
}

/** Classe une erreur qui arrête un tour : limite d'usage, connexion, ou le reste. */
export function stopErrorOf(at: number, kind: unknown, text: string): StopError {
  const k = typeof kind === 'string' ? kind : ''
  const reason = /rate_limit|quota|usage|billing/i.test(k) || /usage limit|limit reached|rate.?limit|quota|out of (extra )?usage|credit balance/i.test(text)
    ? 'quota'
    : /auth|permission/i.test(k) || /authenticat|\/login|oauth|logged out|login expired/i.test(text)
      ? 'auth'
      : 'api'
  return { at, reason, text: text.replace(/\s+/g, ' ').trim().slice(0, 200) }
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
  return signed ? { id, role: 'orchestrator', author: signed.author, ...(signed.sourceThreadId ? {sourceThreadId:signed.sourceThreadId} : {}), text: signed.text, at, ...(['codex','claude','agent'].includes(signed.author) ? {coordination:true} : {}) } : { id, role: 'user', text, at }
}
/** Only the bridge's deliberate human input, never arbitrary tool output or system context. */
export function delegationInput(raw: unknown): { source: string; text: string } | null {
  if (typeof raw !== 'string') return null
  const match = /^\s*<codex_delegation>\s*<source_thread_id>([a-zA-Z0-9_-]{1,100})<\/source_thread_id>\s*<input>([\s\S]*)<\/input>\s*<\/codex_delegation>\s*$/.exec(raw)
  if (!match) return null
  const text = match[2].replace(/&(?:lt|gt|amp|quot|apos);/g, (v) => ({ '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'" })[v]!).trim()
  return text ? { source: match[1], text } : null
}
function delegatedMessage(t: Transcript, item: any, at: number): boolean {
  const bridge = item?.namespace === 'codex_tui' && item?.name === 'send_message_to_thread'
    || ['codex_tui.send_message_to_thread', 'mcp__codex_tui__send_message_to_thread'].includes(item?.name)
  if (!bridge) return false
  const input = delegationInput(item.output)
  if (!input) return false
  const id = item.id ?? item.call_id ?? `delegation-${input.source}-${at}`
  // Codex persists both response_item and item_completed for the same incoming message.
  if (t.messages.some((m) => m.id === id)) return true
  const signed = parseSigned(unwrapPasted(input.text))
  touch(t, at)
  t.firstPrompt ??= input.text
  push(t, { ...(signed?.author==='weevboss'?{}:{coordination:true}), sourceThreadId:input.source, id, role: 'orchestrator', author: signed?.author ?? 'codex', text: signed?.text ?? unwrapPasted(input.text), at })
  ;(t.delegationSources ??= new Map()).set(id, input.source)
  ;(t.delegationTexts ??= new Map()).set(id, unwrapPasted(input.text))
  return true
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
  if (typeof o.entrypoint === 'string') t.headless = o.entrypoint.startsWith('sdk')
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
  // La requête envoyée au modèle porte le modèle exact (params.model) dès l'envoi : un /model se voit tout de suite, sans
  // attendre la première réponse (une longue réflexion du nouveau modèle laissait l'ancien dans l'en-tête). Seulement le
  // fil principal : un sous-agent ou une tâche annexe (titre, compaction) tourne souvent sur un autre modèle.
  if (o.type === 'api-request') {
    const model = o.params?.model
    const main = o.querySource === undefined || o.querySource === 'repl_main_thread' || o.querySource === 'sdk'
    if (main && typeof model === 'string' && model) t.model = model
    return
  }
  if (o.type === 'api-request-blob') {
    const effort = o.message?.output_config?.effort
    if (typeof effort === 'string' && effort) t.effort = effort
    return
  }

  if (o.type === 'user') {
    // The summary Claude Code writes when it compacts a session (« This session is being continued from a previous
    // conversation… »): the agent's memory, not a message from the user, and not a sign of work (weevils compacts
    // sessions at rest). Never in the thread.
    if (o.isCompactSummary) return
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
      t.stopError = undefined
      if (!dequeue(t, c)) push(t, userMsg(o.uuid ?? `${t.id}-${at}`, c, at))
      return
    }
    if (Array.isArray(c)) {
      for (const part of c) {
        if (part?.type === 'text' && !o.isMeta && !isNoise(part.text ?? '')) {
          t.firstPrompt ??= part.text
          t.phase = 'working'
          t.workStartedAt = at
          t.stopError = undefined
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
    // « <synthetic> » : un message écrit par Claude Code lui-même (interruption, erreur), pas par un modèle.
    if (typeof msg.model === 'string' && msg.model && msg.model !== '<synthetic>' && !o.isSidechain) t.model = msg.model
    for (const part of msg.content ?? []) {
      if (part?.type === 'text' && part.text?.trim()) {
        const prev = t.messages[t.messages.length - 1]
        if (prev && prev.role === 'assistant' && t.lastAssistantId === msg.id) prev.text += `\n\n${part.text.trim()}`
        else push(t, { id: `${msg.id ?? o.uuid}-${t.messages.length}`, role: 'assistant', text: part.text.trim(), at })
        t.lastAssistantId = msg.id
      } else if (part?.type === 'tool_use') {
        push(t, { id: part.id ?? `${o.uuid}-tool`, role: 'event', text: redactToolText(toolSummary(part.name, part.input)), at })
        t.lastAssistantId = undefined
      }
    }
    // Réponse synthétique de Claude Code quand l'API a refusé (limite d'usage, connexion expirée, surcharge…) : le tour
    // s'arrête là, sans end_turn. Ce n'est pas du travail en cours, c'est du travail interrompu.
    if (o.isApiErrorMessage) {
      const text = (msg.content ?? []).map((p: any) => (p?.type === 'text' ? p.text : '')).join(' ')
      t.stopError = stopErrorOf(at, o.error, text)
      t.phase = 'idle'
      t.workStartedAt = null
      return
    }
    t.stopError = undefined
    t.phase = msg.stop_reason === 'end_turn' ? 'idle' : 'working'
    if (t.phase === 'idle') t.workStartedAt = null
  }
  // Compaction ratée (« Error during compaction… ») : le tour ne repart pas tout seul.
  if (o.type === 'system' && o.level === 'error' && /compact/i.test(String(o.content ?? ''))) {
    touch(t, at)
    t.stopError = stopErrorOf(at, o.subtype, String(o.content))
    t.phase = 'idle'
    t.workStartedAt = null
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
    if (p.type === 'item_completed' && ['FunctionCallOutput', 'functionCallOutput', 'function_call_output'].includes(p.item?.type)) {
      delegatedMessage(t, p.item, at)
      return
    }
    if (p.type === 'task_started') {
      touch(t, at)
      t.phase = 'working'
      t.workStartedAt = at
      t.stopError = undefined
      touch(t, at)
    } else if (p.type === 'error') {
      // Erreur qui arrête le tour (limite d'usage, connexion, API) : comme côté Claude, du travail interrompu.
      t.stopError = stopErrorOf(at, p.codex_error_info ?? p.kind, String(p.message ?? ''))
      t.phase = 'idle'
      t.workStartedAt = null
      touch(t, at)
    } else if (p.type === 'task_complete' || p.type === 'turn_aborted') {
      touch(t, at)
      t.phase = 'idle'
      t.workStartedAt = null
      touch(t, at)
    }
    return
  }
  if (o.type !== 'response_item') return
  if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
    delegatedMessage(t, p, at)
    const event=t.messages.find(m=>m.role==='event' && m.id===p.call_id)
    if(event?.toolDetails?.commands.length && !event.toolDetails.commands.includes('[redacted]')) {
      const result=toolOutputDetails(p.output)
      if(result.output)Object.assign(event.toolDetails,result)
    }
    return
  }
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
    t.phase = 'working'
    t.workStartedAt ??= at
    touch(t, at)
    let input: unknown = p.arguments ?? p.input ?? p.action ?? {}
    if (typeof input === 'string') {
      try { input = JSON.parse(input) } catch { /* Free-form code stays opaque; never evaluated. */ }
    }
    const commands=commandDetails(p.name ?? 'local_shell_call', input, Infinity)
    push(t, { id: p.call_id ?? `${t.id}-${at}-f`, role: 'event', text: [codexToolLabel(p.name ?? 'local_shell_call', input), ...commandSummaries(commands)].join(' · '), toolDetails: {calls:callDetails(p.name ?? 'local_shell_call',input), summaryCommands:commandSummaries(commands), commands:commands.map(c=>c.slice(0,8000)), commandsTruncated:commands.some(c=>c.length>8000), kinds:codexToolKinds(p.name ?? 'local_shell_call', input)}, at })
  }
}

// ---------------------------------------------------------------------------
// Lecture incrémentale

function emptyTranscript(file: string, tool: Tool): Transcript {
  const base = path.basename(file, '.jsonl')
  const id = tool === 'claude' ? base : (base.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)?.[0] ?? base)
  return { id, tool, file, cwd: '', openedAt: 0, lastActivityAt: 0, workStartedAt: null, phase: 'idle', messages: [], delegationSources: new Map(), subagents: [], bg: tool === 'claude' ? emptyBg() : undefined, offset: 0, partial: '', queued: [] }
}

/** A transcript read from text already in memory (a head and a tail sent by another machine, server/bring.ts):
 * the same parsers as the live store, without touching the disk. A line cut at either end is skipped. */
export function parseTranscriptText(file: string, tool: Tool, text: string): Transcript {
  const t = emptyTranscript(file, tool)
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let o: unknown
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if (tool === 'claude') claudeLine(t, o)
    else codexLine(t, o)
  }
  return t
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
  /** The owning app knows which source thread is weevboss, including its Codex relay. */
  authorOfThread?: (id: string) => string | undefined
  /** Explicit, verified history annotations only. The raw transcript remains unchanged. */
  originOfMessage?: (threadId:string,message:Message)=>{author:string;sourceThreadId:string}|undefined
  refreshOrigins?:()=>void
  /** A conversation brought from another machine (server/bring.ts): when it arrived here. The sessions list keeps it
   * with the recent ones from then (core.ts), ready to resume; its own activity stays as it was (not « live »). */
  broughtAt?: (id: string) => number | undefined
  private originBases=new Map<Message,Pick<Message,'role'|'author'|'coordination'|'sourceThreadId'>>()

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
    const authors = new Map<string, string>()
    for (const t of this.byFile.values()) {
      if (!t.delegationSources?.size) continue
      const byId = new Map(t.messages.map((m) => [m.id, m]))
      for (const [id, source] of t.delegationSources) {
        const message = byId.get(id)
        if (!message) { t.delegationSources.delete(id); t.delegationTexts?.delete(id); continue }
        if (!authors.has(source)) authors.set(source, this.authorOfThread?.(source) ?? 'codex')
        const author = authors.get(source)!
        if (message.author !== author) { message.author = author; changed = true }
        const original=t.delegationTexts?.get(id)
        if(original!==undefined){
          const signed=parseSigned(original), text=signed?.author===author ? signed.text : original
          if(message.text!==text){message.text=text;changed=true}
        }
        if(author==='weevboss' && message.coordination!==undefined){delete message.coordination;changed=true}
        else if(author!=='weevboss'&&!message.coordination){message.coordination=true;changed=true}
      }
    }
    this.refreshOrigins?.()
    const projected=new Set<Message>()
    for(const t of this.byFile.values())for(const message of t.messages){
      const base=this.originBases.get(message)
      let origin=base?undefined:this.originOfMessage?.(t.id,message)
      if(!base&&!origin)continue
      const before=JSON.stringify([message.role,message.author,message.coordination,message.sourceThreadId])
      if(base){
        message.role=base.role
        for(const field of ['author','coordination','sourceThreadId'] as const){
          if(base[field]===undefined)delete message[field]
          else (message as any)[field]=base[field]
        }
      }
      if(base)origin=this.originOfMessage?.(t.id,message)
      if(origin){
        if(!base)this.originBases.set(message,{role:message.role,author:message.author,coordination:message.coordination,sourceThreadId:message.sourceThreadId})
        message.role='orchestrator';message.author=origin.author;message.sourceThreadId=origin.sourceThreadId
        if(origin.author==='weevboss')delete message.coordination
        else message.coordination=true
        projected.add(message)
      }else this.originBases.delete(message)
      if(before!==JSON.stringify([message.role,message.author,message.coordination,message.sourceThreadId]))changed=true
    }
    for(const message of this.originBases.keys())if(!projected.has(message))this.originBases.delete(message)
    return changed
  }

  all(): Transcript[] {
    return [...this.byFile.values()].filter((t) => t.lastActivityAt > 0)
  }

  get(id: string): Transcript | undefined {
    return this.all().find((t) => t.id === id)
  }
}

/** weevils' hidden context block (« ⟦weevils — Explicit app locale… ⟧ »), wherever it sits: never material for a title. */
export const withoutWeevilsBlock = (s: string) => s.replace(/\s*⟦weevils\b[^⟧]*(?:⟧|$)/g, '')
/** A title written from that block instead of the session's subject (« Weevils app locale »): treated as no title. */
export const LOCALE_TITLE = /\bapp[- ]locale\b|\blangue (?:explicite )?de l['’]app\b/i
export const realTitle = (s: string | undefined) => (s && !LOCALE_TITLE.test(s) ? s : undefined)
/** A title that speaks of « locale » when what the session was asked (block removed) never does: written from the block
 *  (the agent's replies may well talk of it: they answer the block). */
export const borrowedTitle = (t: Transcript, title: string | undefined) =>
  !!title && (LOCALE_TITLE.test(title) || (/\blocale\b/i.test(title) && !t.messages.some((m) => (m.role === 'user' || m.role === 'orchestrator') && /\blocale\b/i.test(withoutWeevilsBlock(m.text)))))
const unsigned = (s: string | undefined) => (s ? withoutWeevilsBlock(parseSigned(s)?.text ?? s) : s)
/** The first real brief: a slash command (« /effort high », « /model … ») tells nothing of the subject. */
const brief = (t: Transcript) => {
  const first = unsigned(t.firstPrompt)?.trim()
  if (first && !first.startsWith('/')) return first
  for (const m of t.messages) if (m.role === 'user' || m.role === 'orchestrator') {
    const said = unsigned(m.text)?.trim()
    if (said && !said.startsWith('/')) return said
  }
  return undefined
}
export const titleOf = (t: Transcript) => short(oneLine(realTitle(t.customTitle) || (borrowedTitle(t, t.title) ? undefined : t.title) || brief(t) || tr(M).newSession).replace(/^[#>*\s-]+/, ''), 60)
/** Matière pour le renommeur : début de la session et ses derniers échanges, compacts. */
export const digestOf = (t: Transcript, lastN = 10) => {
  const s = tr(M)
  const recent = t.messages.slice(-lastN).map((m) => s.said(m.role === 'user' ? s.userLabel : m.role === 'orchestrator' ? authorName(m.author) : m.role === 'assistant' ? 'agent' : '→', short(oneLine(withoutWeevilsBlock(m.text)), m.role === 'event' ? 80 : 320)))
  return { debut: short(oneLine(brief(t) ?? ''), 200), recents: recent }
}
export const lastMessageOf = (t: Transcript) => {
  const m = [...t.messages].reverse().find((x) => x.role !== 'event')
  return m ? short(oneLine(m.text), 120) : undefined
}
