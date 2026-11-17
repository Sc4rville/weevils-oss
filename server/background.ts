// Travail d'arrière-plan d'une session Claude Code : sous-agents (outil Agent/Task), étapes de workflow (outil Workflow,
// un sous-agent par étape), commandes lancées avec run_in_background. Une session qui a fini son tour mais dont ce
// travail tourne encore n'est pas finie : weevils la garde « working » tant que c'est le cas.
//
// Formats non documentés (Claude Code 2.1.x) : on lit défensivement et on ne plante jamais. Les signaux, du plus sûr au
// plus faible (voir backgroundOf) :
//   1. fin annoncée par Claude Code : <task-notification> (status completed / failed / killed) mise en file dans le
//      transcript principal, résultat de l'outil (agent au premier plan, lancement raté), méta « finished », ligne
//      « result » du journal d'un workflow, TaskStop ;
//   2. bilan de fin de tour : la ligne system/turn_duration porte pendingWorkflowCount / pendingBackgroundAgentCount
//      (absents à 0) ; à 0, tout ce qui a été lancé avant est fini ;
//   3. processus : claude redémarré depuis (--resume) → ce qu'avait lancé l'ancien processus est mort ; plus aucune
//      commande (bash « shell-snapshots ») sous claude → les commandes d'arrière-plan sont finies ;
//   4. borne de sûreté : sous-agent ou étape sans écriture depuis STALE_BG_MS (STALE_TOOL_MS s'il attend un outil), commande
//      sans sortie depuis STALE_BG_MS et sans bash vivant sous claude → coupé, jamais « working » à vie.
// Le processus claude mort (plus de pane, SessionEnd, pid mort) est traité dans core.ts : tout passe « stopped ».
//
// Coût : appelé à chaque passage du store (1,5 s). Méta, journaux et fins de fichiers sont mis en cache par taille et
// date ; les fichiers des sous-agents (jusqu'à 10 Mo et plus) ne sont lus que par la fin, jamais en entier.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Subagent, SubagentDetail } from '../shared/api.ts'
import { tr } from './i18n.ts'
import M from './i18n/transcripts.ts'

type Status = Subagent['status']

/**
 * Sans écriture depuis 20 min et sans processus vivant, un travail d'arrière-plan est tenu pour coupé.
 * Un sous-agent écrit dans son fichier à chaque pas (requête au modèle, réponse, résultat d'outil) ; son plus long
 * silence légitime est une commande au premier plan, plafonnée à 10 min par Claude Code. 20 min, c'est deux fois ce
 * plafond : assez pour ne jamais couper un vrai travail, assez court pour qu'un fantôme (processus tué sans trace,
 * format qui change) ne laisse pas la session « working » plus d'un quart d'heure de trop. Un bash vivant
 * sous claude ne prolonge que les commandes d'arrière-plan : on ne sait pas à quel sous-agent il appartiendrait.
 */
export const STALE_BG_MS = 20 * 60_000
/** Un sous-agent dont le dernier pas est un appel d'outil sans résultat attend cet outil (serveur MCP lent, sous-agent imbriqué) : borne plus large. */
export const STALE_TOOL_MS = 60 * 60_000
/** Une commande d'arrière-plan qui vient de partir peut ne pas encore apparaître sous claude. */
const SHELL_GRACE_MS = 30_000
/** Liste montrée : tout ce qui tourne, et les derniers finis. */
const KEEP_FINISHED = 12
const MAX_WORKING = 40

// ---------------------------------------------------------------------------------------------- état lu au fil de l'eau

interface Launch {
  toolUseId: string
  kind: 'agent' | 'workflow' | 'shell'
  label: string
  at: number
  async: boolean
  taskId?: string
  agentId?: string
  runId?: string
  workflow?: string
  summary?: string
  outputFile?: string
  /** Fin connue par le résultat de l'outil : agent au premier plan rendu, lancement raté. */
  ended?: { status: Status; at: number }
  /** Surveillance (outil Monitor) : ses événements ne la terminent pas ; elle expire d'elle-même à cette date. */
  monitor?: boolean
  expiresAt?: number
}
interface Note {
  status: Status
  at: number
  summary?: string
  outputFile?: string
  toolUseId?: string
}

/** Ce que le transcript principal dit du travail d'arrière-plan, lu ligne à ligne avec le reste (transcripts.ts). */
export interface BgState {
  /** Lancements, par id d'appel d'outil. */
  launches: Record<string, Launch>
  /** <task-notification>, par task-id. */
  notes: Record<string, Note>
  /** TaskStop / KillShell, par task-id. */
  stops: Record<string, number>
  /** Commandes au premier plan (Bash) et surveillances (Monitor) en attente de leur résultat, par id d'appel d'outil :
   *  Claude Code peut les passer en arrière-plan (délai de 600 s dépassé, Ctrl+B) ; retirées dès leur résultat. */
  calls: Record<string, { label: string; at: number; monitor: boolean }>
  /** Dernier bilan de fin de tour. */
  pending?: { at: number; workflows: number; agents: number }
  /** Cette version de Claude Code écrit les compteurs pending* : leur absence vaut 0. */
  sawPending: boolean
  lastTurnEndAt: number
  /** Jobs this session started writing to a log in a logs folder (« nohup … > ~/logs/<name>.log & »), by log name: the
   *  long jobs the automated page would otherwise list as « started by hand ». core.ts nests them under this session. */
  logJobs?: Record<string, LogJob>
}
export interface LogJob {
  /** The agent's description of the call, else a catalog word (never the raw command nor the log name). */
  label: string
  at: number
}
export const emptyBg = (): BgState => ({ launches: {}, notes: {}, stops: {}, calls: {}, sawPending: false, lastTurnEndAt: 0 })

/** Log files a command writes in a logs folder (~/logs, $HOME/logs, /home/u/logs, weevils' jobs folder): their names. */
export function logJobsIn(command: string): string[] {
  const out = new Set<string>()
  // Any path ending in /logs/ or /jobs/, from ~, $HOME or the root (« ~/.local/share/weevils/jobs/x.log » too).
  const re = /(?:>>?|\btee(?:\s+-a)?)\s*["']?(?:~|\$HOME|\$\{HOME\})?(?:\/[^\s"';|&<>]*?)?\/(?:logs|jobs)\/([\w.-]+?)\.log\b/g
  for (const m of command.matchAll(re)) out.add(m[1])
  return [...out]
}
// A test command, not any word « test » (« test -f x », a src/test/ path).
const TESTS = /\b(vitest|jest|playwright|pytest|cypress|e2e|pw-[\w-]+|(?:npm|pnpm|yarn|bun)(?: run)? test(?::[\w-]+)?)\b/i
/** What a shell call is called: the agent's description, else a plain catalog word (a test run, a background command). */
export function shellLabel(description: string, command: string): string {
  return description.trim() || (TESTS.test(command) ? tr(M).testRun : tr(M).bgCommand)
}

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
/** Première phrase d'un texte, sans l'annotation « [harness: …] » que le harnais met parfois en tête d'un rapport. */
const firstSentence = (s: string) => short(oneLine(s.replace(/^\s*\[harness[^\]]*\]\s*/i, '')).split(/(?<=[.!?…])\s/)[0] ?? '', 140)
const unescapeXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')

/** « Outil · détail » : ce que fait un appel d'outil, en une ligne. */
export function toolLine(name: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const detail = str(i.description) || str(i.file_path) || str(i.command) || str(i.pattern) || str(i.url) || str(i.query) || str(i.prompt)
  return `${name || tr(M).tool}${detail ? ` · ${short(oneLine(detail), 90)}` : ''}`
}

const contentText = (c: unknown): string => {
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : str(x?.text))).join('\n')
  return ''
}

function statusOf(raw: string): Status {
  const s = raw.trim().toLowerCase()
  if (/^(failed|error|errored)$/.test(s)) return 'failed'
  if (/^(killed|stopped|cancell?ed|aborted|interrupted)$/.test(s)) return 'stopped'
  return 'done'
}

/** <task-notification> : fin d'un sous-agent, d'un workflow ou d'une commande d'arrière-plan. */
function readNotifications(bg: BgState, text: string, at: number) {
  if (!text.includes('<task-notification>')) return
  for (const m of text.matchAll(/<task-notification>([\s\S]*?)(?:<\/task-notification>|$)/g)) {
    const body = m[1]
    const tag = (name: string) => unescapeXml(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)?.[1]?.trim() ?? '')
    const id = tag('task-id')
    if (!id) continue
    // Événement d'une surveillance (Monitor) : pas de <status>, elle continue ; seule son expiration la termine.
    if (!/<status>/.test(body) && !/^\[Monitor (expired|ended|stopped)/i.test(tag('event'))) continue
    bg.notes[id] = { status: statusOf(tag('status')), at, summary: tag('summary') || undefined, outputFile: tag('output-file') || undefined, toolUseId: tag('tool-use-id') || undefined }
  }
}

/** Une ligne du transcript principal. */
export function bgLine(bg: BgState, o: any, at: number) {
  if (!o || typeof o !== 'object') return
  if (o.type === 'system' && o.subtype === 'turn_duration') {
    if ('pendingWorkflowCount' in o || 'pendingBackgroundAgentCount' in o) bg.sawPending = true
    bg.pending = { at, workflows: num(o.pendingWorkflowCount), agents: num(o.pendingBackgroundAgentCount) }
    bg.lastTurnEndAt = Math.max(bg.lastTurnEndAt, at)
    return
  }
  // Les fins arrivent en file (enqueue) ; dequeue / remove répètent la même chose plus tard.
  if (o.type === 'queue-operation') {
    if (o.operation === 'enqueue' && typeof o.content === 'string') readNotifications(bg, o.content, at)
    return
  }
  if (o.type === 'attachment' && typeof o.attachment?.prompt === 'string') return readNotifications(bg, o.attachment.prompt, at)
  if (o.isSidechain) return
  if (o.type === 'assistant') {
    for (const part of o.message?.content ?? []) {
      if (part?.type !== 'tool_use' || typeof part.id !== 'string') continue
      const input = (part.input ?? {}) as Record<string, any>
      const name = str(part.name)
      if (name === 'Bash') {
        // A job started into a logs folder (« nohup … > ~/logs/x.log & »): remembered, core.ts nests it under this session.
        for (const job of logJobsIn(str(input.command))) (bg.logJobs ??= {})[job] = { label: shellLabel(str(input.description), str(input.command)), at }
      }
      if (name === 'Agent' || name === 'Task') {
        bg.launches[part.id] = { toolUseId: part.id, kind: 'agent', label: str(input.description) || str(input.subagent_type), at, async: input.run_in_background === true }
      } else if (name === 'Workflow') {
        const script = str(input.script)
        const wfName = /\bname\s*:\s*['"`]([^'"`\n]+)['"`]/.exec(script)?.[1] ?? str(input.name)
        const summary = /\bdescription\s*:\s*['"`]([^'"`\n]+)['"`]/.exec(script)?.[1]
        bg.launches[part.id] = { toolUseId: part.id, kind: 'workflow', label: wfName, workflow: wfName || undefined, summary, at, async: true }
      } else if (name === 'Bash' && input.run_in_background === true) {
        bg.launches[part.id] = { toolUseId: part.id, kind: 'shell', label: shellLabel(str(input.description), str(input.command)), at, async: true }
      } else if (name === 'Bash' || name === 'Monitor') {
        // Peut passer en arrière-plan plus tard (Bash au-delà de 600 s, Ctrl+B ; Monitor toujours) : retenu jusqu'à son résultat.
        const ids = Object.keys(bg.calls)
        if (ids.length > 200) for (const id of ids.slice(0, 100)) delete bg.calls[id]
        bg.calls[part.id] = { label: shellLabel(str(input.description), str(input.command)), at, monitor: name === 'Monitor' }
      } else if (name === 'TaskStop' || name === 'KillShell' || name === 'KillBash') {
        const id = str(input.task_id) || str(input.shell_id) || str(input.id)
        if (id) bg.stops[id] = at
      }
    }
    return
  }
  if (o.type !== 'user') return
  const c = o.message?.content
  if (typeof c === 'string') return readNotifications(bg, c, at)
  if (!Array.isArray(c)) return
  const results = c.filter((p: any) => p?.type === 'tool_result')
  for (const part of c) {
    if (part?.type === 'text') readNotifications(bg, str(part.text), at)
    if (part?.type !== 'tool_result') continue
    // toolUseResult décrit le résultat quand la ligne n'en porte qu'un : on ne croit alors que ses champs. Le texte d'un
    // agent au premier plan est son propre rapport (« le serveur tourne en arrière-plan… ») : jamais lu comme un lancement.
    const hasR = results.length === 1 && !!o.toolUseResult && typeof o.toolUseResult === 'object'
    const r = (hasR ? o.toolUseResult : {}) as Record<string, any>
    const text = contentText(part.content)
    const call = bg.calls[part.tool_use_id]
    if (call) {
      delete bg.calls[part.tool_use_id]
      // Commande passée en arrière-plan en cours de route, ou surveillance démarrée : elle devient une commande d'arrière-plan.
      const taskId = call.monitor
        ? str(r.taskId) || /^Monitor started \(task ([\w-]+)/.exec(text)?.[1]
        : str(r.backgroundTaskId) || (!hasR ? /(?:moved to the background|manually backgrounded)[^(]*\(ID: ([\w-]+)\)/i.exec(text)?.[1] : undefined)
      if (!taskId || part.is_error) continue
      const expiresAt = call.monitor && r.persistent !== true && num(r.timeoutMs) ? at + num(r.timeoutMs) : undefined
      bg.launches[part.tool_use_id] = { toolUseId: part.tool_use_id, kind: 'shell', label: call.label, at: call.at, async: true, taskId, monitor: call.monitor || undefined, expiresAt }
      continue
    }
    const l = bg.launches[part.tool_use_id]
    if (!l) continue
    const async = hasR
      ? r.status === 'async_launched' || r.isAsync === true || !!r.backgroundTaskId
      : /^\s*(Async agent launched|Workflow launched in background|Command running in background with ID)/.test(text)
    if (part.is_error && !async) {
      l.ended = { status: 'failed', at }
      continue
    }
    if (async) {
      l.async = true
      l.taskId = str(r.taskId) || str(r.backgroundTaskId) || str(r.agentId) || /\b(?:Task ID|with ID|agentId)\s*:?\s*([\w-]+)/i.exec(text)?.[1] || l.taskId
      l.agentId = str(r.agentId) || l.agentId
      l.runId = str(r.runId) || /\b(wf_[\w-]+)/.exec(text)?.[1] || l.runId
      l.workflow = str(r.workflowName) || l.workflow
      l.summary = str(r.summary) || l.summary
      l.outputFile = str(r.outputFile) || l.outputFile
      if (l.kind === 'workflow' && l.workflow) l.label = l.workflow
      continue
    }
    // Rendu sans passer en arrière-plan : agent au premier plan fini, commande finie tout de suite.
    l.agentId = str(r.agentId) || l.agentId
    l.ended = { status: 'done', at }
  }
}

// ---------------------------------------------------------------------------------------------- processus

export interface ProcInfo {
  /** Démarrage du processus claude (ms). */
  startedAt: number
  /** Lignes de commande des bash lancés par claude pour l'outil Bash (premier plan ou arrière-plan). */
  shells: string[]
}

let bootMs: number | undefined
const childrenOf = (pid: number): number[] => {
  const out: number[] = []
  for (const tid of fs.readdirSync(`/proc/${pid}/task`)) {
    for (const c of fs.readFileSync(`/proc/${pid}/task/${tid}/children`, 'utf8').split(/\s+/)) if (c) out.push(Number(c))
  }
  return out
}
/** Repli quand le noyau n'expose pas …/children : un passage sur /proc, parent par parent. */
const childrenByScan = (): Map<number, number[]> => {
  const map = new Map<number, number[]>()
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue
    try {
      const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8')
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
      map.set(ppid, [...(map.get(ppid) ?? []), Number(d)])
    } catch {
      /* processus disparu entre-temps */
    }
  }
  return map
}

// macOS has no /proc: the same two facts come from one `ps` of every process, shared by all sessions. It is read in
// the background (never while the store's pass waits for it), at most every PS_EVERY_MS and only while something asks.
// Until the first one is back, and once the last one is older than PS_KEEP_MS, there is no signal, as before.

/** Every process ps listed: when it started, whether it is a zombie, its command line; and who is whose child. */
export interface PsTable {
  rows: Map<number, { startedAt: number; zombie: boolean; cmd: string }>
  kids: Map<number, number[]>
}
/** -ww: whole command lines (without a terminal ps cuts them at 80 columns). One -o per column: read alike by BSD and Linux ps. */
const PS_ARGS = ['-ax', '-ww', '-o', 'pid=', '-o', 'ppid=', '-o', 'stat=', '-o', 'lstart=', '-o', 'command=']
/** `ps -ax -ww -o pid= -o ppid= -o stat= -o lstart= -o command=` (LC_ALL=C: lstart is « Fri Nov 13 19:28:34 2026 », local time). */
export function parsePs(out: string): PsTable {
  const t: PsTable = { rows: new Map(), kids: new Map() }
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d\d:\d\d:\d\d\s+\d{4})(?:\s+(.*))?$/.exec(line)
    if (!m) continue
    const [pid, ppid] = [Number(m[1]), Number(m[2])]
    t.rows.set(pid, { startedAt: Date.parse(m[4].replace(/\s+/g, ' ')), zombie: m[3].startsWith('Z'), cmd: m[5] ?? '' })
    t.kids.set(ppid, [...(t.kids.get(ppid) ?? []), pid])
  }
  return t
}
/** procInfo's answer out of a ps table: same rules as on Linux (zombie or unknown: null; shells up to three levels down). */
export function procInfoIn(t: PsTable, pid: number): ProcInfo | null {
  const me = t.rows.get(pid)
  if (!me || me.zombie || !Number.isFinite(me.startedAt)) return null
  const shells: string[] = []
  let frontier = [pid]
  for (let depth = 0; depth < 3 && frontier.length; depth++) {
    const next: number[] = []
    for (const p of frontier) {
      for (const c of (t.kids.get(p) ?? []).slice(0, 64)) {
        const cmd = t.rows.get(c)?.cmd ?? ''
        if (cmd.includes('shell-snapshots')) shells.push(cmd)
        else next.push(c)
      }
    }
    frontier = next
  }
  return { startedAt: me.startedAt, shells }
}

/** A new ps at most this often. */
export const PS_EVERY_MS = 5000
/** A ps older than this says nothing any more. Under SHELL_GRACE_MS: a command old enough to be judged was already
 * running when the ps that judges it was taken. */
export const PS_KEEP_MS = 15_000
export type PsRun = () => Promise<string>
const psAll: PsRun = () =>
  new Promise((resolve, reject) =>
    execFile('/bin/ps', PS_ARGS, { timeout: 5000, maxBuffer: 32 << 20, env: { ...process.env, LC_ALL: 'C' } }, (err, out) => (err ? reject(err) : resolve(String(out)))),
  )
let psLast: { at: number; table: PsTable } | null = null
let psReading = false
/** When the last ps was started, whether it worked or not: a ps that fails is not started again on every pass. */
let psAsked = -Infinity
/** Tests: forget the last ps. */
export function forgetPs(): void {
  psLast = null
  psReading = false
  psAsked = -Infinity
}
/** procInfo on a Mac: answers from the last ps (null when there is none recent enough) and asks for a new one when it is due. */
export function psProcInfo(pid: number, run: PsRun = psAll, clock: () => number = Date.now): ProcInfo | null {
  const now = clock()
  if (!psReading && now - psAsked >= PS_EVERY_MS) {
    psReading = true
    psAsked = now
    void run()
      .then(
        (out) => {
          const table = parsePs(out)
          // Nothing readable (another ps, another format): no signal rather than « every process is gone ».
          psLast = table.rows.size ? { at: clock(), table } : null
        },
        () => {
          psLast = null
        },
      )
      .finally(() => {
        psReading = false
      })
  }
  return psLast && now - psLast.at < PS_KEEP_MS ? procInfoIn(psLast.table, pid) : null
}

/**
 * Le processus claude et ses commandes en cours. null sans moyen de le lire (ni Linux ni macOS), processus introuvable,
 * ou sur un Mac tant qu'aucun ps récent n'est revenu : ce signal est alors ignoré. Les serveurs MCP, enfants de claude
 * toujours vivants, ne comptent pas : seuls les bash « shell-snapshots » de l'outil Bash sont des commandes.
 */
export function procInfo(pid?: number, platform: NodeJS.Platform = process.platform): ProcInfo | null {
  if (!pid) return null
  if (platform === 'darwin') return psProcInfo(pid)
  if (platform !== 'linux') return null
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    if (f[0] === 'Z') return null
    bootMs ??= Number(/^btime\s+(\d+)/m.exec(fs.readFileSync('/proc/stat', 'utf8'))?.[1]) * 1000
    // Champ 22 de /proc/<pid>/stat : démarrage en tops d'horloge depuis le boot (USER_HZ = 100 sous Linux).
    const startedAt = bootMs + Number(f[19]) * 10
    let scan: Map<number, number[]> | undefined
    const kids = (p: number) => {
      if (!scan) {
        try {
          return childrenOf(p)
        } catch {
          scan = childrenByScan()
        }
      }
      return scan.get(p) ?? []
    }
    const shells: string[] = []
    let frontier = [pid]
    for (let depth = 0; depth < 3 && frontier.length; depth++) {
      const next: number[] = []
      for (const p of frontier) {
        for (const c of kids(p).slice(0, 64)) {
          let cmd = ''
          try {
            cmd = fs.readFileSync(`/proc/${c}/cmdline`, 'utf8').replace(/\0/g, ' ')
          } catch {
            continue
          }
          if (cmd.includes('shell-snapshots')) shells.push(cmd)
          else next.push(c)
        }
      }
      frontier = next
    }
    return Number.isFinite(startedAt) ? { startedAt, shells } : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------------- lectures en cache

const cache = new Map<string, { key: string; value: any }>()
function cached<T>(file: string, kind: string, key: string, read: () => T): T {
  const k = `${kind}:${file}`
  const hit = cache.get(k)
  if (hit && hit.key === key) return hit.value as T
  const value = read()
  if (cache.size > 4000) cache.clear()
  cache.set(k, { key, value })
  return value
}
const statOf = (file: string): fs.Stats | undefined => {
  try {
    return fs.statSync(file)
  } catch {
    return undefined
  }
}
const readDir = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}
const readJson = (file: string, st: fs.Stats | undefined): any =>
  st
    ? cached(file, 'json', `${st.mtimeMs}:${st.size}`, () => {
        try {
          return JSON.parse(fs.readFileSync(file, 'utf8'))
        } catch {
          return {}
        }
      })
    : {}

/** Lit les `bytes` derniers octets ; la première ligne, sans doute coupée, est jetée sauf si on part du début. */
function tailLines(file: string, size: number, bytes: number): { lines: string[]; whole: boolean } {
  const len = Math.min(size, bytes)
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, size - len)
    const lines = buf.toString('utf8').split('\n')
    if (len < size) lines.shift()
    return { lines: lines.filter((l) => l.trim()), whole: len >= size }
  } finally {
    fs.closeSync(fd)
  }
}

/** Horodatage de la première ligne (début du sous-agent) : 4 Ko lus une fois. */
function headAt(file: string, st: fs.Stats): number {
  return cached(file, 'head', '1', () => {
    try {
      const fd = fs.openSync(file, 'r')
      const buf = Buffer.alloc(Math.min(4096, st.size))
      fs.readSync(fd, buf, 0, buf.length, 0)
      fs.closeSync(fd)
      const at = Date.parse(JSON.parse(buf.toString('utf8').split('\n')[0]).timestamp)
      if (at) return at
    } catch {
      /* première ligne plus longue que 4 Ko, ou illisible */
    }
    return st.birthtimeMs || st.mtimeMs
  })
}

type Step = SubagentDetail['steps'][number]

/** Les pas d'un sous-agent dans quelques lignes de son fichier : texte, appels d'outils, résultats. */
function stepsOf(lines: string[]): Step[] {
  const out: Step[] = []
  for (const line of lines) {
    let o: any
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    const at = Date.parse(o?.timestamp) || 0
    const content = o?.message?.content
    if (o?.type === 'assistant' && Array.isArray(content)) {
      for (const p of content) {
        if (p?.type === 'text' && str(p.text).trim()) out.push({ at, role: 'assistant', text: short(oneLine(p.text), 400) })
        else if (p?.type === 'tool_use') out.push({ at, role: 'tool', text: toolLine(str(p.name), p.input) })
      }
    } else if (o?.type === 'user' && Array.isArray(content)) {
      for (const p of content) {
        if (p?.type !== 'tool_result') continue
        const text = oneLine(contentText(p.content))
        if (text) out.push({ at, role: 'result', text: short(text, 200) })
      }
    }
  }
  return out
}

/** Les `n` derniers pas, par la fin du fichier : la fenêtre grandit tant qu'il en manque (lignes de plusieurs Mo). */
function lastSteps(file: string, n: number, maxBytes = 4 << 20, keep: (s: Step) => boolean = () => true): Step[] {
  const st = statOf(file)
  if (!st || !st.size) return []
  let steps: Step[] = []
  for (let bytes = 64 << 10; ; bytes *= 4) {
    const { lines, whole } = tailLines(file, st.size, Math.min(bytes, maxBytes))
    steps = stepsOf(lines).filter(keep)
    if (steps.length >= n || whole || bytes >= maxBytes) break
  }
  return steps.slice(-n)
}

/** Outils de fin de course (rendu du résultat structuré d'une étape) : ce n'est pas ce que fait l'agent. */
const isEndTool = (s: Step) => s.role === 'tool' && /^StructuredOutput\b/.test(s.text)

/** Ce que fait un sous-agent en ce moment : son dernier pas (outil, ou première phrase de son dernier texte). */
function activityOf(file: string, st: fs.Stats | undefined): string {
  if (!st) return ''
  return cached(file, 'activity', `${st.size}`, () => {
    try {
      const last = lastSteps(file, 1, 4 << 20, (s) => s.role !== 'result' && !isEndTool(s)).at(-1)
      if (!last) return ''
      return last.role === 'assistant' ? firstSentence(last.text) : last.text
    } catch {
      return ''
    }
  })
}

/** Le sous-agent attend le résultat d'un outil : son dernier pas est un appel sans réponse. */
function waitsOnTool(file: string, st: fs.Stats | undefined): boolean {
  if (!st) return false
  return cached(file, 'waits', `${st.size}`, () => {
    try {
      return lastSteps(file, 1, 1 << 20).at(-1)?.role === 'tool'
    } catch {
      return false
    }
  })
}

/** Dernière ligne écrite par une commande d'arrière-plan. */
function shellActivity(file: string | undefined): string {
  const st = file ? statOf(file) : undefined
  if (!file || !st?.size) return ''
  return cached(file, 'shell', `${st.size}`, () => {
    try {
      const { lines } = tailLines(file, st.size, 4096)
      return short(oneLine(lines.at(-1) ?? ''), 140)
    } catch {
      return ''
    }
  })
}

/** Journal d'un workflow : étapes lancées (agentId, label, phase) et résultats. */
function journalOf(file: string): { started: { agentId: string; label: string; phase?: string }[]; results: Map<string, { failed: boolean; text: string }> } {
  const st = statOf(file)
  const empty = { started: [], results: new Map() }
  if (!st) return empty
  return cached(file, 'journal', `${st.mtimeMs}:${st.size}`, () => {
    const out = { started: [] as { agentId: string; label: string; phase?: string }[], results: new Map<string, { failed: boolean; text: string }>() }
    try {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        let o: any
        try {
          o = JSON.parse(line)
        } catch {
          continue
        }
        const id = str(o?.agentId)
        if (!id) continue
        if (o.type === 'started') out.started.push({ agentId: id, label: str(o.label), phase: str(o.phase) || undefined })
        else if (o.type === 'result' || o.type === 'error' || o.type === 'failed') {
          const failed = o.type !== 'result' || o.isError === true || o.error != null
          out.results.set(id, { failed, text: str(o.result) || str(o.error) })
        }
      }
    } catch {
      /* journal illisible : aucune étape connue */
    }
    return out
  })
}


// ---------------------------------------------------------------------------------------------- assemblage

/** Dossier des sorties des tâches (/tmp/claude-<uid>/<projet>/<session>/tasks) : celui que Claude Code a annoncé, sinon deviné. */
function tasksDirOf(file: string, bg: BgState): string {
  const known = Object.values(bg.notes).find((n) => n.outputFile)?.outputFile ?? Object.values(bg.launches).find((l) => l.outputFile)?.outputFile
  if (known) return path.dirname(known)
  return path.join(os.tmpdir(), `claude-${process.getuid?.() ?? 0}`, path.basename(path.dirname(file)), path.basename(file, '.jsonl'), 'tasks')
}

/** Un élément en cours de calcul : ses dates de vie pour les règles communes. */
interface Item extends Subagent {
  /** Dernière écriture connue (fichier du sous-agent, sortie de la commande, journal). */
  lastWrite: number
  /** Sous-agent ou étape qui attend le résultat d'un outil (borne STALE_TOOL_MS). */
  waits?: boolean
  /** Surveillance (Monitor) : sa source finie, elle a fini, elle n'est pas coupée. */
  monitor?: boolean
}

/**
 * Le travail d'arrière-plan d'une session, tel qu'on peut le savoir sans le processus (core.ts applique ensuite la mort
 * du processus). `proc` n'est appelé que si quelque chose semble tourner.
 */
export function backgroundOf(file: string, bg: BgState, now: number, proc: () => ProcInfo | null = () => null): Subagent[] {
  const dir = file.replace(/\.jsonl$/, '')
  const subDir = path.join(dir, 'subagents')
  const launches = Object.values(bg.launches)
  const used = new Set<string>()
  const items: Item[] = []
  const noteFor = (l?: Launch, ...ids: (string | undefined)[]) => {
    for (const id of [...ids, l?.taskId, l?.agentId]) if (id && bg.notes[id]) return bg.notes[id]
    if (l) return Object.values(bg.notes).find((n) => n.toolUseId === l.toolUseId)
    return undefined
  }
  const stopFor = (...ids: (string | undefined)[]) => ids.map((id) => (id ? bg.stops[id] : undefined)).find((x) => x !== undefined)
  const p = bg.pending

  // Sous-agents (Agent/Task) : <session>/subagents/agent-<id>.jsonl + .meta.json.
  const agentIds = new Set<string>()
  for (const name of readDir(subDir)) {
    const m = /^agent-(.+?)\.(jsonl|meta\.json)$/.exec(name)
    if (m) agentIds.add(m[1])
  }
  for (const id of agentIds) {
    const jsonl = path.join(subDir, `agent-${id}.jsonl`)
    const metaFile = path.join(subDir, `agent-${id}.meta.json`)
    const st = statOf(jsonl)
    const meta = readJson(metaFile, statOf(metaFile))
    const l = (meta.toolUseId && bg.launches[meta.toolUseId]) || launches.find((x) => x.kind === 'agent' && (x.agentId === id || x.taskId === id))
    if (l) used.add(l.toolUseId)
    const startedAt = l?.at ?? (st ? headAt(jsonl, st) : 0)
    const lastWrite = st?.mtimeMs ?? startedAt
    const background = l?.async ?? meta.requestShape === 'background'
    const note = noteFor(l, id)
    const stop = stopFor(id, l?.taskId)
    let status: Status = 'working'
    let endedAt: number | undefined
    // Un sous-agent relancé après sa fin (SendMessage) renotifie plus tard : écrit après la note, il retravaille.
    if (note && lastWrite <= note.at + 15_000) [status, endedAt] = [note.status, note.at]
    else if (!note && l?.ended) [status, endedAt] = [l.ended.status, l.ended.at]
    else if (!note && meta.finished === true) [status, endedAt] = ['done', lastWrite]
    else if (!note && stop !== undefined) [status, endedAt] = ['stopped', stop]
    else if (!note && background && bg.sawPending && p && p.agents === 0 && p.at > startedAt && lastWrite <= p.at + 5000) [status, endedAt] = ['done', lastWrite]
    else if (!note && !background && bg.lastTurnEndAt > Math.max(startedAt, lastWrite)) [status, endedAt] = ['done', lastWrite]
    const label = str(meta.description) || l?.label || (meta.agentType && meta.agentType !== 'fork' ? str(meta.agentType) : '') || tr(M).subagent
    const activity = st ? activityOf(jsonl, st) : ''
    items.push({ id, kind: 'agent', label, activity: activity || label, status, startedAt, endedAt, lastWrite, waits: status === 'working' && waitsOnTool(jsonl, st) })
  }

  // Workflows : <session>/subagents/workflows/<wf>/journal.jsonl + agent-<id>.jsonl/.meta.json, une étape par sous-agent.
  const wfRoot = path.join(subDir, 'workflows')
  const scripts = readDir(path.join(dir, 'workflows', 'scripts'))
  const wfDirs = readDir(wfRoot).filter((d) => d.startsWith('wf_'))
  for (const wf of wfDirs) {
    const wfDir = path.join(wfRoot, wf)
    // Reprise (Workflow resumeFromRunId) : même runId, même dossier ; c'est le dernier lancement qui compte.
    const runs = launches.filter((x) => x.kind === 'workflow' && x.runId === wf).sort((a, b) => a.at - b.at)
    for (const x of runs) used.add(x.toolUseId)
    const l = runs.at(-1)
    const resumed = runs.length > 1
    const script = scripts.find((s) => s.endsWith(`-${wf}.js`))
    const name = l?.workflow || (script ? script.slice(0, -`-${wf}.js`.length) : '') || wf
    const journalFile = path.join(wfDir, 'journal.jsonl')
    const journal = journalOf(journalFile)
    const jst = statOf(journalFile)
    const wfStart = l?.at ?? (jst ? jst.birthtimeMs || jst.mtimeMs : now)
    const note = noteFor(l)
    const stop = stopFor(l?.taskId)
    const ended: { status: Status; at: number } | undefined = note
      ? { status: note.status, at: note.at }
      : l?.ended
        ? l.ended
        : stop !== undefined
          ? { status: 'stopped', at: stop }
          : bg.sawPending && p && p.workflows === 0 && p.at > wfStart
            ? { status: 'done', at: p.at }
            : undefined
    const steps = new Map<string, { label: string; phase?: string }>()
    for (const s of journal.started) steps.set(s.agentId, { label: s.label, phase: s.phase })
    for (const f of readDir(wfDir)) {
      const m = /^agent-(.+?)\.meta\.json$/.exec(f)
      if (!m || steps.has(m[1])) continue
      const meta = readJson(path.join(wfDir, f), statOf(path.join(wfDir, f)))
      steps.set(m[1], { label: str(meta.description), phase: str(meta.workflowPhase) || undefined })
    }
    let running = 0
    for (const [id, s] of steps) {
      const jsonl = path.join(wfDir, `agent-${id}.jsonl`)
      const st = statOf(jsonl)
      const startedAt = st ? headAt(jsonl, st) : wfStart
      const lastWrite = st?.mtimeMs ?? startedAt
      const res = journal.results.get(id)
      let status: Status = 'working'
      let endedAt: number | undefined
      if (res) [status, endedAt] = [res.failed ? 'failed' : 'done', lastWrite]
      // Workflow fini sans résultat pour cette étape : elle a été coupée (ou a échoué avec lui).
      else if (ended) [status, endedAt] = [ended.status === 'failed' ? 'failed' : 'stopped', Math.min(lastWrite, ended.at)]
      // Workflow repris : une étape sans résultat qui n'a plus écrit depuis la reprise appartenait au run coupé.
      else if (resumed && l && lastWrite < l.at) [status, endedAt] = ['stopped', lastWrite]
      if (status === 'working') running++
      const label = s.label || tr(M).task
      // En cours : son dernier pas ; fini : la première phrase de son rapport, sinon sa tâche.
      const activity = status === 'working' ? (st ? activityOf(jsonl, st) : '') : res?.text ? firstSentence(res.text) : ''
      items.push({ id, kind: 'step', label, activity: activity || label, workflow: name, phase: s.phase, status, startedAt, endedAt, lastWrite, waits: status === 'working' && waitsOnTool(jsonl, st) })
    }
    // Lancé, aucune étape en cours (tout début, ou entre deux phases) : le workflow lui-même tourne.
    if (!ended && !running) {
      items.push({ id: wf, kind: 'step', label: name, activity: l?.summary ?? '', workflow: name, status: 'working', startedAt: wfStart, lastWrite: jst?.mtimeMs ?? wfStart })
    }
  }

  // Lancements sans fichier encore (tout juste partis), et commandes d'arrière-plan.
  const tasksDir = tasksDirOf(file, bg)
  for (const l of launches) {
    if (used.has(l.toolUseId)) continue
    if (l.kind === 'workflow' && l.runId && wfDirs.includes(l.runId)) continue
    if (l.kind === 'agent' && !l.async && !l.ended && bg.lastTurnEndAt > l.at) continue
    const note = noteFor(l)
    const stop = stopFor(l.taskId)
    let status: Status = 'working'
    let endedAt: number | undefined
    if (note) [status, endedAt] = [note.status, note.at]
    else if (l.ended) [status, endedAt] = [l.ended.status, l.ended.at]
    else if (stop !== undefined) [status, endedAt] = ['stopped', stop]
    else if (l.expiresAt && now > l.expiresAt + SHELL_GRACE_MS) [status, endedAt] = ['done', l.expiresAt]
    else if (l.kind === 'workflow' && bg.sawPending && p && p.workflows === 0 && p.at > l.at) [status, endedAt] = ['done', p.at]
    else if (l.kind === 'agent' && bg.sawPending && p && p.agents === 0 && p.at > l.at) [status, endedAt] = ['done', p.at]
    const id = l.agentId ?? l.runId ?? l.taskId ?? l.toolUseId
    if (l.kind === 'shell') {
      const out = note?.outputFile ?? (l.taskId ? path.join(tasksDir, `${l.taskId}.output`) : undefined)
      const st = out ? statOf(out) : undefined
      items.push({ id, kind: 'shell', label: l.label || tr(M).command, activity: shellActivity(out) || l.label || tr(M).command, status, startedAt: l.at, endedAt, lastWrite: Math.max(st?.mtimeMs ?? 0, l.at), monitor: l.monitor })
    } else if (l.kind === 'workflow') {
      items.push({ id, kind: 'step', label: l.label || tr(M).workflow, activity: l.summary ?? '', workflow: l.workflow, status, startedAt: l.at, endedAt, lastWrite: l.at })
    } else {
      items.push({ id, kind: 'agent', label: l.label || tr(M).subagent, activity: l.label || tr(M).subagent, status, startedAt: l.at, endedAt, lastWrite: l.at })
    }
  }

  // Règles communes à ce qui semble tourner : processus redémarré, commandes disparues, borne de sûreté.
  if (items.some((i) => i.status === 'working')) {
    const pi = proc()
    for (const i of items) {
      if (i.status !== 'working') continue
      if (pi && pi.startedAt > i.startedAt + 5000) {
        // Lancé par un processus claude précédent (reprise --resume) : mort avec lui.
        i.status = 'stopped'
        i.endedAt = Math.min(i.lastWrite, pi.startedAt)
      } else if (i.kind === 'shell' && pi && !pi.shells.length && now - i.startedAt > SHELL_GRACE_MS) {
        i.status = i.monitor ? 'done' : 'stopped'
        i.endedAt = i.lastWrite
      } else if (i.kind === 'shell' ? !(pi && pi.shells.length) && now - i.lastWrite > STALE_BG_MS : now - i.lastWrite > (i.waits ? STALE_TOOL_MS : STALE_BG_MS)) {
        // Un bash sous claude ne prouve la vie que des commandes : on ne sait pas à quel sous-agent il appartient, et une
        // commande longue (serveur, boucle) laisserait sinon un sous-agent fantôme « working » à vie. Une commande au
        // premier plan d'un sous-agent est plafonnée à 600 s par Claude Code (passée en arrière-plan au-delà).
        i.status = 'stopped'
        i.endedAt = i.lastWrite
      }
    }
  }

  const working = items.filter((i) => i.status === 'working').sort((a, b) => a.startedAt - b.startedAt).slice(-MAX_WORKING)
  const finished = items
    .filter((i) => i.status !== 'working')
    .sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt))
    .slice(-KEEP_FINISHED)
  return [...working, ...finished]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map(({ lastWrite: _, waits: _w, monitor: _m, ...s }) => ({ ...s, startedAt: Math.round(s.startedAt), endedAt: s.endedAt === undefined ? undefined : Math.round(s.endedAt) }))
}

/** Détail d'un sous-agent : ses derniers pas, lus par la fin de son fichier (rien si introuvable). */
export function subagentSteps(file: string, bg: BgState, sub: Subagent, n = 12): SubagentDetail['steps'] {
  const dir = file.replace(/\.jsonl$/, '')
  const subDir = path.join(dir, 'subagents')
  if (!/^[\w.-]+$/.test(sub.id)) return []
  try {
    if (sub.kind === 'agent') return lastSteps(path.join(subDir, `agent-${sub.id}.jsonl`), n)
    if (sub.kind === 'step') {
      for (const wf of readDir(path.join(subDir, 'workflows'))) {
        const f = path.join(subDir, 'workflows', wf, `agent-${sub.id}.jsonl`)
        if (statOf(f)) return lastSteps(f, n)
      }
      return []
    }
    // Commande : ses dernières lignes de sortie.
    const l = Object.values(bg.launches).find((x) => x.kind === 'shell' && (x.taskId === sub.id || x.toolUseId === sub.id))
    const out = (l?.taskId && bg.notes[l.taskId]?.outputFile) || (l?.taskId ? path.join(tasksDirOf(file, bg), `${l.taskId}.output`) : undefined)
    const st = out ? statOf(out) : undefined
    if (!out || !st?.size) return []
    const at = st.mtimeMs
    return tailLines(out, st.size, 16 << 10)
      .lines.slice(-n)
      .map((text) => ({ at, role: 'result' as const, text: short(oneLine(text), 200) }))
  } catch {
    return []
  }
}
