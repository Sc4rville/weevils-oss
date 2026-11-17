import { InstallationIdentity } from './recursive-identity.ts'
import { isScratchDir } from './scratch.ts'
import AgentMessages from './i18n/agent-messages.ts'
import { CLAUDE, CODEX_FLAGS, projectClaude, projectCodexFlags } from './agent-launch.ts'
import { MessageOrigins } from './message-origins.ts'
import CB from './i18n/codex-bridge.ts'
import { automationSourceRoot } from './automation-workspaces.ts'
import MachineProse from './i18n/machine-prose.ts'
import { isModelControl, type ModelControls, type ModelSelection } from '../shared/model-controls.ts'
import ModelM from './i18n/model-controls.ts'
import { titlePresentation } from './title-presentation.ts'
import { SessionProgressReader } from './session-progress.ts'
import { deliveryContext, OutboxError, OutboxDeferred } from './outbox.ts'
import OutboxM from './i18n/outbox.ts'
import { CodexBridge } from './codex-bridge.ts'
import { preferredTool, providerReady, providerUnavailable } from './provider.ts'
import { notificationText, notificationQuestion } from '../shared/notification-policy.ts'
import { humanFeedText } from '../shared/feed-text.ts'
import { noticeKey } from '../shared/notices.ts'
// Le cœur de weevilsd : transcripts + hooks + panes zellij → sessions, projets, H24, agent principal.

import { execFile, execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { AutoDetail, AutoRun, AutoRunDetail, ConversationDetail, ConversationSummary, H24Activity, InterruptReason, Message, Project, Session, SessionDetail, Snapshot, Subagent, SubagentDetail, Tool } from '../shared/api.ts'
import { CLAUDE_DIR, CODEX_DIR, DATA_DIR, EXPOSE_DOMAIN, PUBLIC_URL, USER_NAME, DONE_AFTER_MS, HOME, KILL_AFTER_MS, INBOX_DIR, LOGS_DIRS, MACHINE, ORCHESTRATOR, ORCH_DIR, PROJECT_ROOTS, PROJECTS_DIR, RECENT_MS, REMOTES, STALE_MS } from './config.ts'
import { Remote, parseRemotes } from './remotes.ts'
import { ConversationStore, parseExport, readExportFile } from './conversations.ts'
import { llmClassify, ruleMatch } from './classify.ts'
import { Push } from './push.ts'
import type { CatalogEntry } from './classify.ts'
import { MISC, familyOf, place, projectLabel } from './projects.ts'
import { locale } from '../shared/i18n.ts'
import M from './i18n/core.ts'
import MuxM from './i18n/mux.ts'
import P from './i18n/push.ts'
import { setCartesiaVoice } from './fast.ts'
import { keepWarm, warmCues } from './voicepipe.ts'
import { detectLang } from '../shared/detect-lang.ts'
import { devilConfig, devilMessages, devilSend, devilWorking } from './devil.ts'
import { claudeLogged, withoutContext, type Setup } from './setup.ts'
import { BOSS_DIR, BOSS_MODELS, BOSS_TURNS, BossTurns, orchTranscriptsDir } from './boss-turns.ts'

/** What a Claude Code session can switch to from the app's header (one tap, applied before its next turn). */
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'max']
const CLAUDE_MODELS = ['fable', 'opus', 'sonnet', 'haiku'].map((id) => ({ id, label: id, efforts: CLAUDE_EFFORTS, defaultEffort: 'medium' }))
const family = (model?: string) => /opus|sonnet|haiku|fable/i.exec(model ?? '')?.[0].toLowerCase()

import { recordOrigin, type BossOrigin } from './boss-origins.ts'
import { Ledger } from './boss-ledger.ts'
import { claudeHaiku } from './fast.ts'
import type { Memory } from './memory.ts'
import type { Optimizers } from './optimizers.ts'
import type { Sleep } from './sleep.ts'
import type { ForYou, MailIn } from './foryou.ts'
import { PLAN_MARKER, clockOf, type Relay, type RelayHost } from './relay.ts'
import R from './i18n/relay.ts'
import { parseTimerShow } from './schedule.ts'
import { extractLinks, journalRuns, tailLines, unitDescriptions, type JournalRun } from './auto-runs.ts'
import { chipsInPlace } from '../shared/setup.ts'
import { asksUser, type Ask } from '../shared/asks.ts'
import { createRepo, describeRepos, listRepos, loadBlurbs, remoteFile, remoteFiles } from './github.ts'
import { judgeAsk } from './asks-judge.ts'
import { TranscriptStore, borrowedTitle, digestOf, lastMessageOf, realTitle, titleOf } from './transcripts.ts'
import { emptyBg, subagentSteps } from './background.ts'
import { failedLine } from '../shared/failed-line.ts'
import { llmTitles, needsTitle, shortNow, stableTitle, TitleRetry } from './titles.ts'
import type { Titled } from './titles.ts'
import type { Transcript } from './transcripts.ts'
import type { WvSession } from './mux.ts'
import { pumpCall, pumpCommand, pumpForget, pumpReady, pumpState, structuredOn } from './pump.ts'
import { accounts, accountsOn } from './claude-accounts.ts'
import { capture, type ScreenDialog, flatScreen, killWv, listWv, sendKey, sendText, setOpt, spawnWv, wvName } from './mux.ts'
import TerminalM from './i18n/terminal.ts'
import { moves, readScreen, redactScreen, screenId, stuckChoices, stuckQuestion, type Hold, type Reading, type TerminalState } from './terminal.ts'
import { activeRequestLang, installationLang, lang, onLangChange, tr, user, withLang, type Lang } from './i18n.ts'
import TipsM from './i18n/tips.ts'
import { normalizeFrom, parseSigned, publicAuthors, signAs } from './authors.ts'

interface HookState {
  event: string
  at: number
  message?: string
  pid?: number
  /** SessionEnd : pourquoi la session s'est fermée (prompt_input_exit, clear, logout, other…). */
  reason?: string
}

type Cut = { at: number; reason: InterruptReason }
/** Fins propres d'une session (SessionEnd) : /exit, /clear, /logout. Sans raison (ancien hook) : propre aussi. */
const CLEAN_END = new Set(['prompt_input_exit', 'clear', 'logout'])
/** Une coupure plus ancienne que ça, découverte après coup (redémarrage, déploiement), n'est pas annoncée : seulement montrée. */
const ANNOUNCE_WITHIN_MS = 6 * 3600_000
/** A timer's journal: the fields its runs are read from (journalRuns), and how many of its newest entries. */
const JOURNAL_FIELDS = '_SYSTEMD_INVOCATION_ID,USER_INVOCATION_ID,INVOCATION_ID,MESSAGE,EXIT_STATUS,UNIT_RESULT,JOB_RESULT'
const JOURNAL_LINES = 20_000
/** Une session lancée pour un test (son brief commence par « [test] », ou par « TEST » en majuscules juste après la
 * signature d'un agent [from:…] : jamais un simple « TEST » tapé dans un terminal) : elle reste visible dans l'app, mais ne prévient jamais (ni notification, ni message dans le fil de weevboss).
 * Les tests de weevils lui-même tournent sur un serveur jetable (CONTRIBUTING.md) ; ceci protège le vrai fil des autres. */
export const isTestBrief = (p?: string) => !!p && /^\s*(?:\[test\]|\[from:[^\]]*\]\s*TEST(?![\p{L}\p{N}_]))/u.test(p)

/** Le dossier a du travail non commité (fichiers modifiés ou nouveaux) ; pas un dépôt git, ou git muet : non. */
export function gitDirty(cwd: string): Promise<boolean> {
  // Never in an « auto » task's folder: its jailed agent could have pointed git at a config of its own (an fsmonitor run
  // here, unjailed). Its runs are read by server/auto-runs.ts, with git's dirs pinned.
  if (cwd.split(path.sep).includes('.auto')) return Promise.resolve(false)
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'status', '--porcelain'], { timeout: 5000, maxBuffer: 4 << 20 }, (err, stdout) => resolve(!err && stdout.trim().length > 0))
  })
}

/** Session tmux wv-* vue au dernier passage, avec ce qu'on lit à son écran. */
interface ManagedPane extends WvSession {
  screenAttention?: string
  screenDialog?: ScreenDialog
  screenWorking?: boolean
  screenQueued?: number
  /** A calm status read on the screen (usage limit, signed out, stopped) and since when. */
  screenHold?: Hold & { since: number }
  /** Continue / Go back for the screen as it is now, when it has no input box and no known dialog: what a waiting
   * session without a question of its own (a hook notification) offers, so its card is never button-less. */
  screenFallback?: ScreenDialog['options']
}

/** How long an unchanged screen with no input box, no progress and no known dialog waits before it becomes a question. */
const STUCK_AFTER_MS = 90_000

interface Persisted {
  directCodexBoss?: { pane?: string; sessionId?: string; since: number }
  hooks?: [string, HookState][]
  titles?: [string, Titled][]
  /** Id de la session Claude de l'orchestrateur (stable : on la reprend après un redémarrage). */
  orchestratorId?: string
  pinnedRepos?: string[]
  voiceId?: string
  /** Coupures vues au passage, reprises ou laissées, coupures déjà annoncées. */
  cuts?: [string, Cut][]
  cleared?: [string, number][]
  announced?: (string | [string, number])[]
  archived?: string[]
  closedByUs?: [string, number][]
}

const STATE_FILE = path.join(DATA_DIR, 'state.json')
/** Dernier appel d'outil, en mots : « Bash · Build and deploy » → « build and deploy ». */
const stepOf = (t: { messages: { role: string; text: string }[] }) => {
  const e = [...t.messages].reverse().find((m) => m.role === 'event')
  if (!e) return ''
  const [, detail] = e.text.split(' · ')
  return (detail ?? e.text).replace(/^\//, '').toLowerCase()
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Marque des dossiers comme de confiance dans ~/.claude.json : Claude Code n'affiche plus « Is this a project you trust? ». */
export function trustDirs(dirs: string[]) {
  const cfg = path.join(HOME, '.claude.json')
  let d: any = {}
  try {
    d = JSON.parse(fs.readFileSync(cfg, 'utf8'))
  } catch {
    /* premier lancement : fichier absent */
  }
  d.projects ??= {}
  let changed = false
  for (const dir of dirs) {
    if (d.projects[dir]?.hasTrustDialogAccepted) continue
    d.projects[dir] = { ...(d.projects[dir] ?? {}), hasTrustDialogAccepted: true }
    changed = true
  }
  if (changed) fs.writeFileSync(cfg, JSON.stringify(d, null, 2))
  return changed
}


const pidAlive = (pid?: number) => {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** How findClaudePid reads a process: its command line (arguments separated by NUL, as /proc gives them) and its
 * parent. Both throw when the process can't be read. */
export interface ProcRead {
  cmd(pid: number): string
  ppid(pid: number): number
}
/** Linux: /proc. */
const procFs: ProcRead = {
  cmd: (pid) => fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'),
  ppid: (pid) => {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
  },
}

/** One line of `ps -o ppid= -o command=`: the parent, and the command line with its arguments NUL-separated. */
export function parsePsParent(out: string): { ppid: number; cmd: string } | null {
  const m = /^\s*(\d+)\s+(\S.*?)\s*$/m.exec(out)
  return m ? { ppid: Number(m[1]), cmd: m[2].split(/\s+/).join('\0') } : null
}
/** -ww: the whole command line (without a terminal, ps cuts it at 80 columns). */
const psOne = (pid: number) => execFileSync('/bin/ps', ['-ww', '-o', 'ppid=', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] })
/**
 * macOS (no /proc): `ps`, one process at a time. Hooks fire several times a second and this runs while they wait, so
 * what ps said of a process (or that it is gone) is kept keepMs, and at most perSecond ps are started in a second:
 * beyond that the process counts as unreadable (the session keeps the pid its last hook gave).
 */
export function psReader(run: (pid: number) => string = psOne, clock: () => number = Date.now, keepMs = 10_000, perSecond = 8): ProcRead {
  const seen = new Map<number, { at: number; v: { ppid: number; cmd: string } | null }>()
  let second = 0
  let spent = 0
  const row = (pid: number) => {
    const now = clock()
    let c = seen.get(pid)
    if (!c || now - c.at >= keepMs) {
      if (now - second >= 1000) [second, spent] = [now, 0]
      if (++spent > perSecond) throw new Error('ps: too many at once') // i18n-ignore: caught by findClaudePid, never shown
      let v: { ppid: number; cmd: string } | null = null
      try {
        v = parsePsParent(run(pid))
      } catch {
        /* no such process */
      }
      if (seen.size >= 512) seen.clear()
      seen.set(pid, (c = { at: now, v }))
    }
    if (!c.v) throw new Error('ps: no such process') // i18n-ignore: caught by findClaudePid, never shown
    return c.v
  }
  return { cmd: (pid) => row(pid).cmd, ppid: (pid) => row(pid).ppid }
}
const procRead: ProcRead = process.platform === 'darwin' ? psReader() : procFs

/** Remonte les parents d'un hook jusqu'au processus claude. */
export function findClaudePid(start: number, read: ProcRead = procRead): number | undefined {
  let pid = start
  for (let i = 0; i < 8 && pid > 1; i++) {
    try {
      const cmd = read.cmd(pid)
      if (/(^|\/|\0)claude(\0|$)/.test(cmd) || cmd.includes('claude-code') || /\0claude\0/.test(`\0${cmd}`)) return pid
      pid = read.ppid(pid)
    } catch {
      return undefined
    }
  }
  return undefined
}

const norm = (t: string) =>
  t
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()


// ---------------------------------------------------------------- Pièces jointes

const IMAGE_RE = /^image\//i

/** Écrit les fichiers reçus (base64) dans `dir`, sous <date>-<nom> (nom nettoyé, suffixe si déjà pris) ; renvoie les chemins. */
export function saveInbox(dir: string, files: { name: string; type: string; data: string }[]): { path: string; image: boolean }[] {
  fs.mkdirSync(dir, { recursive: true })
  const day = new Date().toISOString().slice(0, 10)
  const out: { path: string; image: boolean }[] = []
  for (const f of files.slice(0, 8)) {
    const image = IMAGE_RE.test(f.type)
    let base = path.basename(f.name || '').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80)
    if (!base || base === '.' || base === '..') base = image ? 'photo.jpg' : tr(M).fileName
    if (image && !path.extname(base)) base += `.${(/\/(png|jpe?g|gif|webp|heic)$/i.exec(f.type)?.[1] ?? 'jpg').toLowerCase().replace('jpeg', 'jpg')}`
    let file = path.join(dir, `${day}-${base}`)
    if (fs.existsSync(file)) {
      const ext = path.extname(base)
      file = path.join(dir, `${day}-${base.slice(0, base.length - ext.length)}-${crypto.randomBytes(2).toString('hex')}${ext}`)
    }
    fs.writeFileSync(file, Buffer.from(f.data, 'base64'))
    out.push({ path: file, image })
  }
  return out
}

/** Seules les commandes de réglage passent : une ligne, pas de texte libre caché derrière. */
export function checkCommand(command: string): string {
  const c = command.trim()
  if (!/^\/(model|effort|fast|compact|clear|new|approvals)([ \t]+[\w.-]+)?$/.test(c)) throw new Error(tr(M).commandRefused(c))
  return c
}

/** Le message tel que l'agent le reçoit : le texte, puis « (photo : /chemin) » ou « (fichier : /chemin) » pour chaque pièce. */
/** Au-delà, un message ne passe plus par tmux (« command too long » : une commande tmux tient en 16 Ko, arguments
 * compris) : un mail de manifeste, un long collage. */
export const TERMINAL_MAX = 6000

/** Un message trop long pour le terminal : le texte intégral va dans l'inbox (fichier .md), l'agent reçoit son début
 * (signature « [from:x] » comprise) et le chemin du fichier. Un message court passe tel quel. */
export function fitTerminal(text: string, dir = INBOX_DIR): string {
  if (Buffer.byteLength(text) <= TERMINAL_MAX) return text
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${new Date().toISOString().slice(0, 10)}-message-${crypto.randomBytes(3).toString('hex')}.md`)
  fs.writeFileSync(file, text)
  const cut = text.slice(0, 1500)
  const head = cut.slice(0, Math.max(cut.lastIndexOf(' '), 1000)).trimEnd()
  return `${head}… ${tr(M).longMessage(file)}`
}

export function withFiles(text: string, saved: { path: string; image: boolean }[]): string {
  const n = saved.length
  const allImages = saved.every((s) => s.image)
  const t = tr(M)
  const lead = text.trim() || (allImages ? (n > 1 ? t.lookPhotos : t.lookPhoto) : n > 1 ? t.someFiles : t.oneFile)
  return `${lead} ${saved.map((s) => t.attached(s.image, s.path)).join(' ')}`
}

/** Le bloc de contexte caché d'un message pour weevboss (« ⟦weevils — … ⟧ », un seul, en fin de message), avec une partie de plus. */
export const joinContext = (block: string, extra: string): string => {
  const more = extra.replace(/⟧/g, ']').trim()
  if (!more) return block
  return block.trim() ? block.replace(/⟧\s*$/, ` — ${more}⟧`) : ` ⟦weevils — ${more}⟧`
}

/** The app-locale instruction rides on a session's first brief only: never on a slash command (« /effort high ⟦…⟧ » is no
 *  longer a command), never twice (every message ended with it, sessions answered « no task in this message yet » and
 *  were all titled after it). */
export const withAppLocale = (text: string, first: boolean): string =>
  first && activeRequestLang() && text.trim() && !text.trimStart().startsWith('/') && !text.includes('⟦weevils') ? text + joinContext('', tr(M).appLocale) : text

export class Weevils {
  private installationIdentity = new InstallationIdentity(path.join(import.meta.dirname,'..'),MACHINE.id)
  workstreamForRepo(repo:string) {
    const root=this.repoRoot(repo)
    return root ? this.installationIdentity.classify(path.join(root,repo),familyOf(repo),repo,'automation-target') : undefined
  }
  sourceAccessForRepo(repo:string) {
    const root=this.repoRoot(repo)
    return root ? this.installationIdentity.access(path.join(root,repo)) : undefined
  }
  assertSourceExecution(cwd:string) {
    const access=this.installationIdentity.access(cwd)
    if(access&&!access.canExecute)throw new OutboxError(403,access.reason==='no-checkout'?tr(M).installationReadOnly:tr(M).sourceReadOnly)
  }
  assertRepoExecution(repo:string) { this.assertSourceExecution(this.repoDir(repo)) }
  store = new TranscriptStore(CLAUDE_DIR, CODEX_DIR, RECENT_MS)
  private messageOrigins = new MessageOrigins(path.join(DATA_DIR,'message-origins.json'))
  hooks = new Map<string, HookState>()
  panes: ManagedPane[] = []
  orchestratorId: string | null = null
  /** weevboss as stateless turns over a fixed-size view of its whole thread (server/boss-turns.ts); null: the former
   *  single interactive conversation (WEEVILS_BOSS_TURNS=0). */
  bossTurns: BossTurns | null = ORCHESTRATOR && BOSS_TURNS ? new BossTurns((prompt, schema) => claudeHaiku(prompt, 120_000, schema)) : null
  private turnStarting = false
  /** weevboss's request ledger, goals, work trace and knowledge (server/boss-ledger.ts); on the main machine only. */
  ledger: Ledger | null = ORCHESTRATOR ? new Ledger({
    dir: BOSS_DIR,
    budget: Math.max(400, Number(process.env.WEEVILS_BOSS_LEDGER_TOKENS ?? 1800) || 1800),
    model: (prompt, schema) => claudeHaiku(prompt, 180_000, schema),
    host: {
      sessions: () => this.sessions(),
      detail: (id) => this.detailAny(id),
      turnRunning: (id) => id === this.orchestratorId && (this.turnStarting || this.bossWorking('claude') || !!this.paneFor(id)),
      journal: () => { const j = this.bossTurns?.journal; if (!j) return []; j.sync(); return j.entries() },
      lang: () => lang(),
      user: () => user(),
      memory: () => this.memory?.asText(60) ?? '',
    },
  }) : null
  h24: H24Activity[] = []
  remotes: Remote[] = []
  convs = new ConversationStore(DATA_DIR)
  pinnedRepos: string[] = []
  /** Accueil et branchements (server/setup.ts), posé par index.ts : ses messages se mêlent au fil de weevboss. */
  setup: Setup | null = null
  /** Clé des pages statiques des repos (index.ts, dérivée du code d'accès). */
  siteKey = ''
  /** What weevils remembers about the user (server/memory.ts), on the main machine. */
  memory: Memory | null = null
  /** The h24 background tasks (server/optimizers.ts), on the main machine. */
  optimizers: Optimizers | null = null
  /** The « for you » stream (server/foryou.ts), on the main machine. */
  foryou: ForYou | null = null
  /** Sleep mode (server/sleep.ts), on the main machine. */
  sleep: Sleep | null = null
  /** Codex relay while Claude is at its usage limit (server/relay.ts). */
  relay: Relay | null = null
  private githubCache: Map<string, number> = new Map()

  // ---------------------------------------------------------------- repos GitHub

  async githubRepos(force = false) {
    const list = await listRepos(force)
    this.githubCache = new Map(list.map((r) => [r.name, r.pushedAt]))
    const blurbs = loadBlurbs(DATA_DIR)
    void describeRepos(list, PROJECT_ROOTS, DATA_DIR, () => this.bump())
    return list.map((r) => ({ ...r, blurb: blurbs[r.name] }))
  }

  voiceId: string | undefined
  setVoice(id: string | undefined) {
    this.voiceId = id
    setCartesiaVoice(id)
    this.persist()
    warmCues(id, this.speakerLang())
  }

  /** La langue dans laquelle l'utilisateur parle à weevboss (ses derniers messages), sinon la langue réglée. Pour l'accroche. */
  speakerLang(): Lang {
    const said = this.orchestratorMessages()
      .filter((m) => m.role === 'user' && !m.devil)
      .slice(-6)
      .map((m) => m.text)
      .join('\n')
    return detectLang(said) ?? lang()
  }

  /** Attend la réponse écrite de weevboss à un message envoyé à `since` : terminée quand il ne travaille plus. */
  /** Devil mode : le message va à l'autre modèle, avec l'historique récent du fil. */
  devil(text: string) {
    return devilSend(text, this.orchestratorMessages(), () => this.bump())
  }

  async waitMainReply(since: number, timeoutMs: number): Promise<string | null> {
    const end = Date.now() + timeoutMs
    let calm = 0
    while (Date.now() < end) {
      await sleep(500)
      const replies = this.bossTranscripts().flatMap((t) => t.messages.filter((m) => m.role === 'assistant' && m.at >= since - 500))
      calm = replies.length && !this.orchestratorWorking(Date.now()) ? calm + 1 : 0
      if (calm >= 3) return replies.map((m) => m.text).join('\n\n')
    }
    return this.bossTranscripts().flatMap((t) => t.messages.filter((m) => m.role === 'assistant' && m.at >= since - 500)).map((m) => m.text).join('\n\n') || null
  }
  /** Attend la réponse d'une session (locale ou d'une autre machine) à un message envoyé à `since` : terminée quand elle ne travaille plus. */
  async waitReply(id: string, since: number, timeoutMs: number): Promise<{ id: string; text: string; done: boolean; attention?: string }> {
    const end = Date.now() + timeoutMs
    let calm = 0
    let real = id
    let replies: Message[] = []
    let attention: string | undefined
    while (Date.now() < end) {
      await sleep(1500)
      const d = await this.detailAny(this.resolveId(id)).catch(() => undefined)
      if (!d) continue
      real = d.session.id
      replies = d.messages.filter((m) => m.role === 'assistant' && m.at >= since - 500)
      attention = d.session.status === 'needs_user' ? (d.session.attention ?? '') : undefined
      // Le tour principal, pas l'arrière-plan : une session qui a lancé un workflow et répondu « lancé » a répondu.
      calm = replies.length && !(d.session.turnWorking ?? d.session.status === 'working') ? calm + 1 : 0
      if (calm >= 3) return { id: real, text: replies.map((m) => m.text).join('\n\n'), done: true, attention }
    }
    return { id: real, text: replies.map((m) => m.text).join('\n\n'), done: false, attention }
  }

  /** Le pont e-mail a reçu et routé un mail (BridgeDeps.mailed) : le flux « pour toi » le retient. */
  mailed(m: MailIn) {
    this.foryou?.mail(m)
  }

  pinRepo(repo: string, pinned: boolean) {
    if (!/^[\w.@+-]+$/.test(repo)) throw new Error(tr(M).badRepo)
    const has = this.pinnedRepos.includes(repo)
    if (pinned && !has) this.pinnedRepos.push(repo)
    if (!pinned && has) this.pinnedRepos = this.pinnedRepos.filter((r) => r !== repo)
    this.persist()
    this.bump()
  }

  async newRepo(name: string, description: string) {
    const r = await createRepo(name, description, PROJECTS_DIR)
    this.pinRepo(r.name, true)
    await this.githubRepos(true)
    return r
  }

  /** Les repos épinglés deviennent des projets du fil, même sans session. */
  private pinnedProjects(existing: Project[]): Project[] {
    const out: Project[] = []
    for (const repo of this.pinnedRepos) {
      const id = familyOf(repo)
      const cur = existing.find((p) => p.id === id)
      if (cur) {
        if (!cur.repos.includes(repo)) {
          cur.repos.push(repo)
          cur.where[repo] = MACHINE.id
        }
        continue
      }
      out.push({ id, name: id, kind: 'repo', repos: [repo], where: { [repo]: MACHINE.id }, lastActivityAt: this.githubCache.get(repo) ?? 0 })
    }
    return out
  }
  /** Au démarrage : ce qui avait été rangé dans une catégorie thématique inventée repart à classer (les catégories sont les projets). */
  private migrateCategories() {
    const n = this.convs.dropInventedCategories()
    if (n) console.log(`[classement] ${n} conversations sorties de catégories inventées, à reclasser`)
  }
  push = new Push()
  private prevStatus = new Map<string, { status: Session['status']; since: number; notifiedAt?: number }>()
  classifier: Snapshot['classifier'] = { running: false, queued: 0 }
  /** Titres écrits par le renommeur, par session. */
  private directCodexBoss?: { pane?: string; sessionId?: string; since: number }
  titles = new Map<string, Titled>()
  private codexBridge = new CodexBridge(process.env.WEEVILS_CODEX_SOCKET ?? '', undefined, () => this.bump(), path.join(DATA_DIR,'session-names.json'), () =>
    this.store.all().filter(t => t.tool === 'codex' && t.originator !== 'codex_exec' && Date.now()-t.lastActivityAt < RECENT_MS).map(t => t.id))
  private progressReader = new SessionProgressReader()
  private titling = false
  private titleRetry = new TitleRetry()
  private catalogCache: { at: number; list: CatalogEntry[] } | null = null
  version = 1
  private listeners = new Set<() => void>()
  private bumpTimer: NodeJS.Timeout | null = null
  private snap: Snapshot | null = null
  private snapLang: Lang | null = null
  private persistTimer: NodeJS.Timeout | null = null
  private retitleSoon: NodeJS.Timeout | undefined
  /** Sessions vues mourir en plein travail (ou avec du travail non commité) : id → quand, pourquoi. */
  cuts = new Map<string, Cut>()
  /** Reprise ou « laisser » : une coupure antérieure à cette date est réglée. */
  cleared = new Map<string, number>()
  /** Coupures déjà annoncées (push, fil de weevboss) : id → quand. Une par épisode, même si son heure se précise ensuite. */
  private announced = new Map<string, number>()
  /** Fermées par weevils (bouton fermer, ménage des panes) : leur fin n'est pas une coupure. */
  private archived = new Set<string>()
  private closedByUs = new Map<string, number>()
  /** Dernier passage de watchCuts : la session vivait-elle, et dans quel état. */
  private lastSeen = new Map<string, { alive: boolean; status: Session['status'] }>()

  constructor() {
    // Preuves de vie de l'arrière-plan d'une session : le processus claude de sa pane, sinon celui que ses hooks ont donné.
    this.store.pidOf = (id) => this.paneFor(id)?.pid ?? this.hooks.get(id)?.pid
    this.store.authorOfThread = (id) => {
      if(id===this.orchestratorId||id===this.relay?.boss?.sessionId||this.store.get(id)?.cwd===ORCH_DIR)return 'weevboss'
      const tool=this.store.get(id)?.tool
      return tool==='codex'||tool==='claude'?tool:undefined
    }
    let origins=this.messageOrigins.snapshot()
    this.store.refreshOrigins=()=>{origins=this.messageOrigins.snapshot()}
    this.store.originOfMessage=(id,message)=>{
      const origin=origins(id,message)
      return origin?{author:origin.author,sourceThreadId:origin.sourceThreadId}:undefined
    }
    this.migrateCategories()
    if (ORCHESTRATOR) {
      this.prepareOrchestrator()
      // Langue changée dans l'app : le CLAUDE.md de weevboss est réécrit dans la nouvelle langue.
      onLangChange(() => this.prepareOrchestrator())
    }
    // Langue changée dans l'app : libellés du snapshot (projets réservés, 24/7, accueil de weevboss) réécrits aussitôt.
    onLangChange(() => {
      this.refreshH24()
      this.bump()
    })
    keepWarm()
    // Tous les repos connus sont de confiance d'avance.
    try {
      if (trustDirs(this.allRepos().map((r) => this.repoDir(r)))) console.log('[sessions] dossiers de ~/projects marqués de confiance pour Claude Code')
    } catch (e) {
      console.error(`[sessions] confiance : ${(e as Error).message}`)
    }
    try {
      const p = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as Persisted
      this.hooks = new Map(p.hooks ?? [])
      this.directCodexBoss = p.directCodexBoss
      // Titles written from the app-locale block (« Weevils app locale ») are dropped: the renamer writes them again
      // from the session's real subject.
      this.titles = new Map((p.titles ?? []).filter(([, v]: [string, Titled]) => realTitle(v?.title)))
      this.orchestratorId = p.orchestratorId ?? null
      this.pinnedRepos = p.pinnedRepos ?? []
      this.voiceId = p.voiceId
      this.cuts = new Map(p.cuts ?? [])
      this.cleared = new Map(p.cleared ?? [])
      // Premier format (« id@quand ») : relu tel quel.
      this.announced = new Map((p.announced ?? []).map((a): [string, number] => (typeof a === 'string' ? [a.split('@')[0], Number(a.split('@')[1]) || 0] : a)))
      this.archived = new Set(p.archived ?? [])
      this.closedByUs = new Map(p.closedByUs ?? [])
      setCartesiaVoice(this.voiceId)
      warmCues(this.voiceId)
    } catch {
      /* premier démarrage */
    }
  }

  // ---------------------------------------------------------------- boucle

  start() {
    void this.codexBridge.refresh()
    setInterval(() => void this.codexBridge.refresh(), 10_000)
    void this.push.init()
    this.remotes = parseRemotes(REMOTES).map(([id, url]) => new Remote(id, url, () => this.bump()))
    for (const r of this.remotes) r.start()
    this.store.scan(Date.now())
    this.refreshH24()
    setInterval(() => {
      if (this.store.scan(Date.now())) this.bump()
      this.linkCodexPanes()
    }, 1500)
    setInterval(() => void this.watchPanes().then(() => this.watchCuts()).then(() => Promise.all([...this.modelWish.keys()].map((id) => this.applyModelWish(id)))), 2500)
    setInterval(() => void this.reapPanes(), 60_000)
    if (this.bossTurns) {
      setInterval(() => void this.pumpTurns(), 1000)
      // The summaries of the whole log, written ahead in the background (Haiku, once per message).
      setTimeout(() => void this.bossTurns?.prewarm().catch(() => undefined), 20_000)
    }
    if (this.ledger) {
      const ledger = this.ledger
      // First run: today's requests are read back from the log, so the ledger starts with what is still open.
      if (ledger.fresh && this.bossTurns) setTimeout(() => void ledger.backfill(24).then((r) => console.log(`[ledger] backfill: ${r.messages} messages → ${r.asks} requests`)).catch((e) => console.error(`[ledger] backfill: ${(e as Error).message}`)), 30_000)
      ledger.onChange(() => this.bump())
      setInterval(() => void this.ledgerTick(), 30_000)
    }
    setInterval(() => void this.watchImports(), 30_000)
    setInterval(() => void this.classify(), 60_000)
    setTimeout(() => void this.classify(), 5000)
    setInterval(() => void this.retitle(), 45_000)
    setTimeout(() => void this.retitle(), 15_000)
    setInterval(() => this.refreshH24(), 10_000)
    // Les durées et états « périmés » évoluent avec le temps.
    setInterval(() => this.bump(), 30_000)
  }

  onChange(fn: () => void) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  bump() {
    this.snap = null
    if (this.bumpTimer) return
    this.bumpTimer = setTimeout(() => {
      this.bumpTimer = null
      this.version++
      this.snap = null
      for (const fn of this.listeners) fn()
      this.notifyTransitions()
      this.announceCuts()
    }, 200)
  }

  /** Notification quand une session se met à t'attendre, ou finit un travail de plus d'une minute. */
  private notifyTransitions() {
    // Personne à prévenir : ni notifications, ni flux « pour toi ».
    if (!this.push.enabled && !this.foryou) return
    const snap = this.snapshot()
    const now = Date.now()
    const first = this.prevStatus.size === 0
    const next = new Map<string, { status: Session['status']; since: number; notifiedAt?: number }>()
    for (const s of snap.sessions) {
      const prev = this.prevStatus.get(s.id)
      const entry = prev && prev.status === s.status ? prev : { status: s.status, since: now, notifiedAt: prev?.notifiedAt }
      next.set(s.id, entry)
      if (s.archived || first || !prev || prev.status === s.status) continue
      const rested = (s.status === 'idle' || s.status === 'done') && !!s.lastMessage
      const ended = prev.status === 'working' && rested
      // Le flux « pour toi » retient chaque question et chaque fin de tour (un item par session : ni délai, ni seuil),
      // y compris une question réglée sans que le travail ait été vu reprendre.
      if (s.status === 'needs_user') this.foryou?.sessionTurn(s, 'question')
      else if (ended || (prev.status === 'needs_user' && rested)) this.foryou?.sessionTurn(s, 'result')
      if (!this.push.enabled) continue
      if (prev.notifiedAt && now - prev.notifiedAt < 60_000) continue
      const project = snap.projects.find((p) => p.id === s.projectId)?.name ?? s.projectId
      let title: string | null = null
      let body: string | null = null
      let category: 'question' | 'result' | undefined
      if (s.status === 'needs_user') {
        const question = notificationQuestion(s.attention || s.lastMessage || '')
        if (!question) continue
        category = 'question'
        title = tr(P).waitingTitle(project)
        body = question
      } else if (ended && now - prev.since > 15_000) {
        category = 'result'
        title = tr(P).doneTitle(project)
        body = notificationText(s.lastMessage ?? '')
      }
      if (!title || !body) continue
      if (isTestBrief(this.store.get(s.id)?.firstPrompt) || isScratchDir(s.cwd)) continue
      entry.notifiedAt = now
      void this.push.send({ title: `${title} · ${humanFeedText(s.title || '')}`.slice(0, 160), body: body.replace(/\s+/g, ' ').slice(0, 220), url: `/#s=${encodeURIComponent(s.id)}`, tag: s.id, category, sessionId: s.id, eventAt: s.lastActivityAt })
    }
    this.prevStatus = next
  }

  private persist() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true })
      // Les hooks des trois derniers jours suffisent (pid des sessions encore ouvertes).
      const hooks = [...this.hooks].filter(([, h]) => Date.now() - h.at < RECENT_MS)
      const titles = [...this.titles].filter(([, t]) => Date.now() - t.at < 14 * 86400_000)
      const recent = (at: number) => Date.now() - at < RECENT_MS
      const data: Persisted = {
        hooks,
        directCodexBoss: this.directCodexBoss,
        titles,
        orchestratorId: this.orchestratorId ?? undefined,
        pinnedRepos: this.pinnedRepos,
        voiceId: this.voiceId,
        cuts: [...this.cuts].filter(([, c]) => recent(c.at)),
        cleared: [...this.cleared].filter(([, at]) => recent(at)),
        announced: [...this.announced].filter(([, at]) => recent(at)),
        archived: [...this.archived],
        closedByUs: [...this.closedByUs].filter(([, at]) => recent(at)),
      }
      fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 1))
    } catch {
      /* disque plein ? on continue en mémoire */
    }
  }

  // ---------------------------------------------------------------- hooks Claude Code

  hook(body: any, pidHeader?: string) {
    const id = body?.session_id
    if (!id) return
    const prev = this.hooks.get(id)
    const pid = pidHeader ? (findClaudePid(Number(pidHeader)) ?? prev?.pid) : prev?.pid
    this.hooks.set(id, { event: body.hook_event_name ?? 'unknown', at: Date.now(), message: body.message, pid, ...(typeof body.reason === 'string' ? { reason: body.reason } : {}) })
    // Nouveau message : l'activité précédente ne vaut plus, on l'efface et on la réécrit dès que possible.
    if (body.hook_event_name === 'UserPromptSubmit') {
      const t = this.titles.get(id)
      if (t?.now) this.titles.set(id, { ...t, now: '' })
      clearTimeout(this.retitleSoon)
      this.retitleSoon = setTimeout(() => void this.retitle(), 8000)
    }
    this.bump()
    // Écriture groupée : PostToolUse peut tomber plusieurs fois par seconde.
    if (!this.persistTimer) {
      this.persistTimer = setTimeout(() => {
        this.persistTimer = null
        this.persist()
      }, 2000)
    }
  }

  // ---------------------------------------------------------------- panes pilotées

  /** tmux est le registre : on relit les sessions wv-* et leur écran. */
  private async watchPanes() {
    const found = await listWv()
    const next: ManagedPane[] = []
    for (const p of found) {
      const prev = this.panes.find((x) => x.name === p.name)
      let screenAttention: string | undefined
      let dialog: ScreenDialog | undefined
      let screenWorking = false
      let screenQueued = 0
      let screenHold: ManagedPane['screenHold']
      let screenFallback: ManagedPane['screenFallback']
      if (p.mode === 'structured') {
        // Structured session: its state comes from Claude's own events (server/claude-pump.mjs), never from the screen.
        const st = pumpState(p.name)
        const q = st?.question
        next.push({ ...p, sessionId: p.sessionId ?? st?.sessionId ?? prev?.sessionId, screenWorking: !!st?.working, screenQueued: st?.queued ?? 0,
          ...(q ? { screenAttention: q.question, screenDialog: { question: q.question, ...(q.detail ? { detail: q.detail } : {}), options: q.options, selected: -1 } } : {}) })
        continue
      }
      try {
        const screen = await capture(p.name)
        const reading = readScreen(screen, p.tool)
        const state = this.stuckOr(p, screen, reading)
        if (state.kind === 'question') {
          dialog = { question: state.question, ...(state.detail ? { detail: state.detail } : {}), options: state.choices, selected: state.menu?.selected ?? -1 }
          screenAttention = state.question
          if (state.name.startsWith('unknown')) this.keepUnknown(p.name, screen, state.name)
        } else if (state.kind === 'auto') void this.answerAuto(p.name, screen, state)
        else if (state.kind === 'picker') void this.closePicker(p.name, screen)
        const hold = state.kind === 'hold' ? state.hold : state.kind === 'auto' ? state.hold : undefined
        if (hold) screenHold = { ...hold, since: prev?.screenHold?.text === hold.text ? prev.screenHold.since : Date.now() }
        screenWorking = reading.working
        screenQueued = reading.queued
        if (state.kind !== 'question' && !reading.composer && !reading.working && screen.trim()) screenFallback = stuckChoices(screen)
      } catch {
        /* écran illisible un instant */
      }
      next.push({ ...p, sessionId: p.sessionId ?? prev?.sessionId, screenAttention, screenDialog: dialog, screenWorking, screenQueued, ...(screenHold ? { screenHold } : {}), ...(screenFallback ? { screenFallback } : {}) })
    }
    for (const old of this.panes) {
      if (next.some((p) => p.name === old.name)) continue
      const t = old.sessionId ? this.store.get(old.sessionId) : undefined
      if (old.mode === 'structured') pumpForget(old.name)
      console.log(`[sessions] ${old.name} disparue après ${Math.round((Date.now() - old.createdAt) / 1000)} s · ${t ? `${t.messages.length} messages` : 'aucun transcript'}${old.screenAttention ? ` · dernier écran : ${old.screenAttention}` : ''}`)
    }
    const changed = JSON.stringify(next) !== JSON.stringify(this.panes)
    this.panes = next
    if (changed) this.bump()
  }

  /** Codex ne permet pas de choisir l'identifiant : on relie la pane au transcript qui apparaît dans le même dossier. */
  private linkCodexPanes() {
    for (const p of this.panes) {
      if (p.sessionId || p.tool !== 'codex') continue
      const taken = new Set(this.panes.map((x) => x.sessionId).filter(Boolean))
      const t = this.store
        .all()
        .filter((x) => x.tool === 'codex' && x.cwd === p.cwd && x.openedAt >= p.createdAt - 15_000 && !taken.has(x.id))
        .sort((a, b) => a.openedAt - b.openedAt)[0]
      if (t) {
        p.sessionId = t.id
        if (this.archived.delete(p.name)) { this.archived.add(t.id); this.persist() }
        void setOpt(p.name, '@wv_session_id', t.id).catch(() => undefined)
        this.bump()
      }
    }
  }

  private paneFor(id: string) {
    return this.panes.find((p) => p.sessionId === id) ?? this.panes.find((p) => p.name === id)
  }

  private isOrchestratorPane(p: ManagedPane) {
    return p.cwd.startsWith(DATA_DIR) || (!!this.orchestratorId && p.sessionId === this.orchestratorId)
  }

  /** Une pane weevils inactive depuis 2 h est fermée : la machine respire, la session reste reprenable par --resume. */
  // ---------------------------------------------------------------- terminal screens (server/terminal.ts)

  /** Panes whose screen weevils is answering or changing right now: a command, a choice, an automatic answer. */
  private driving = new Set<string>()
  /** Last screen of each pane and since when it has not changed (stuck-screen fallback). */
  private stillSince = new Map<string, { id: string; since: number }>()
  /** Automatic answers already sent for a screen: never twice the same keys on the same screen in a row. */
  private answered = new Map<string, { id: string; at: number }>()
  private unknownSeen = new Set<string>()

  /** Nothing known on screen, no input box, no progress, unchanged for STUCK_AFTER_MS: a plain question, never a silent block. */
  private stuckOr(p: ManagedPane, screen: string, reading: Reading): TerminalState {
    const id = screenId(screen)
    const was = this.stillSince.get(p.name)
    const since = was?.id === id ? was.since : Date.now()
    this.stillSince.set(p.name, { id, since })
    const state = reading.state
    if (state.kind !== 'none' || reading.composer || reading.working || !screen.trim()) return state
    if (this.driving.has(p.name) || Date.now() - since < STUCK_AFTER_MS || Date.now() - p.createdAt < STUCK_AFTER_MS) return state
    const t = p.sessionId ? this.store.get(p.sessionId) : undefined
    if (t && Date.now() - t.lastActivityAt < STUCK_AFTER_MS) return state
    if (this.isOrchestratorPane(p) && this.bossTurns?.isTurn(p.sessionId)) return state
    return stuckQuestion(screen, p.tool)
  }

  /** An unknown screen is kept (redacted) so it gets a proper translation later; once per screen. */
  private keepUnknown(pane: string, screen: string, name: string) {
    const id = screenId(screen)
    if (this.unknownSeen.has(id)) return
    this.unknownSeen.add(id)
    try {
      const dir = path.join(DATA_DIR, 'terminal-unknown')
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      fs.writeFileSync(path.join(dir, `${new Date().toISOString().slice(0, 10)}-${id}.txt`), redactScreen(screen.split('\n').slice(-40).join('\n')) + '\n', { mode: 0o600 })
    } catch { /* the question is shown anyway */ }
    console.log(`[terminal] ${pane} · screen not recognized (${name}), kept as terminal-unknown/${id}`)
  }

  /** Moves to an option of the current menu and confirms it. */
  private async pick(pane: string, menu: NonNullable<Extract<TerminalState, { kind: 'question' }>['menu']>, index: number) {
    for (const key of moves(menu, index)) await sendKey(pane, key)
    await sendKey(pane, 'enter')
  }

  /** Safe, already-authorized answers (trust, bypass warning, updates, nudges, resume, usage wait): sent by weevils. */
  private async answerAuto(pane: string, screen: string, state: Extract<TerminalState, { kind: 'auto' }>) {
    const id = screenId(screen)
    const last = this.answered.get(pane)
    if (this.driving.has(pane) || (last?.id === id && Date.now() - last.at < 20_000)) return
    this.answered.set(pane, { id, at: Date.now() })
    this.driving.add(pane)
    try {
      // Some dialogs refuse keys for a moment after they open (Claude's trust prompt).
      await sleep(500)
      const fresh = readScreen(await capture(pane), this.panes.find((p) => p.name === pane)?.tool).state
      if (fresh.kind !== 'auto' || fresh.name !== state.name) return
      if (fresh.pick === 'enter' || !fresh.menu) await sendKey(pane, 'enter')
      else await this.pick(pane, fresh.menu, fresh.pick)
      const label = fresh.pick === 'enter' ? 'enter' : fresh.menu?.options[fresh.pick]?.raw
      console.log(`[terminal] ${pane} · answered by weevils: ${fresh.name} → ${label}`)
    } catch (e) {
      console.error(`[terminal] ${pane} · automatic answer failed: ${(e as Error).message}`)
    } finally {
      this.driving.delete(pane)
      this.bump()
    }
  }

  /** A settings menu or panel nobody is using holds the input box: closed (Escape changes nothing). */
  private async closePicker(pane: string, screen: string) {
    const id = screenId(screen)
    const was = this.stillSince.get(pane)
    if (this.driving.has(pane) || !was || was.id !== id || Date.now() - was.since < 4000) return
    const last = this.answered.get(pane)
    if (last?.id === id && Date.now() - last.at < 20_000) return
    this.answered.set(pane, { id, at: Date.now() })
    console.log(`[terminal] ${pane} · settings menu left open, closed`)
    await sendKey(pane, 'esc').catch(() => undefined)
  }

  private async reapPanes() {
    const now = Date.now()
    for (const p of this.panes) {
      if (this.isOrchestratorPane(p)) continue
      const t = p.sessionId ? this.store.get(p.sessionId) : undefined
      // No local transcript means unknown activity, never permission to destroy a foreign pane.
      if (!t) continue
      const last = Math.max(t?.lastActivityAt ?? 0, this.hooks.get(p.sessionId ?? '')?.at ?? 0, p.createdAt)
      if (now - last < KILL_AFTER_MS) continue
      // A pending question stays until someone answers it: closing the pane would lose it silently.
      if (p.screenDialog) continue
      if (t?.phase === 'working' && now - t.lastActivityAt < 10 * 60_000) continue
      // Des sous-agents, un workflow ou une commande tournent encore : fermer la pane les tuerait.
      if (t && this.toSession(t, now).background > 0) continue
      try {
        if (p.sessionId) this.closedByUs.set(p.sessionId, now)
        this.persist()
        await killWv(p.name)
        console.log(`[sessions] ${p.name} fermée après ${Math.round((now - last) / 60_000)} min sans activité`)
      } catch (e) {
        console.error(`[sessions] fermeture de ${p.name} : ${(e as Error).message}`)
      }
    }
  }

  // ---------------------------------------------------------------- sessions

  /** Rattachement par le contenu, quand le dossier de travail n'est pas un repo (session lancée depuis ~/Documents, /tmp…). */
  private inferred = new Map<string, { count: number; where: ReturnType<typeof place> | null }>()
  private inferPlace(t: Transcript): ReturnType<typeof place> | null {
    const cached = this.inferred.get(t.id)
    if (cached && cached.count === t.messages.length) return cached.where
    const repos = new Set<string>(this.allRepos())
    for (const e of this.catalogCache?.list ?? []) for (const r of e.repos) repos.add(r)
    const score = new Map<string, number>()
    const bump = (repo: string, n: number) => score.set(repo, (score.get(repo) ?? 0) + n)
    const text = t.messages.map((m) => m.text).join('\n')
    // Chemins : ~/projects/<repo>/… comptent fort.
    for (const m of text.matchAll(/projects\/(\.night\/)?([A-Za-z0-9][\w.-]*)/g)) if (repos.has(m[2])) bump(m[2], 3)
    // Noms de repo ou de famille cités dans le fil (≥ 4 lettres, pour éviter le bruit).
    const low = ` ${norm(text)} `
    for (const repo of repos) {
      const fam = familyOf(repo)
      for (const term of new Set([repo.toLowerCase(), fam])) {
        if (term.length < 4) continue
        const n = low.split(` ${term} `).length - 1
        if (n) bump(repo, n)
      }
    }
    const best = [...score.entries()].sort((a, b) => b[1] - a[1])[0]
    const where = best && best[1] >= 2 ? { projectId: familyOf(best[0]), projectName: familyOf(best[0]), kind: 'repo' as const, repo: best[0] } : null
    this.inferred.set(t.id, { count: t.messages.length, where })
    return where
  }

  /** Ce qu'on sait de la vie d'une session : sa pane, son dernier hook, son processus. alive : vivante et pas fermée (SessionEnd). */
  private lifeOf(t: Transcript, now: number) {
    const pane = this.paneFor(t.id)
    const hook = this.hooks.get(t.id)
    const hookAlive = hook?.pid ? pidAlive(hook.pid) : undefined
    const live = !!this.codexBridge.activityOf?.(t.id) || !!pane || hookAlive === true || (hookAlive === undefined && now - t.lastActivityAt < STALE_MS && t.originator !== 'codex_exec')
    return { pane, hook, hookAlive, live, alive: live && hook?.event !== 'SessionEnd' }
  }

  /** Fin voulue : /exit, /clear, /logout (SessionEnd), ou pane fermée par weevils (bouton, ménage). */
  private endedCleanly(id: string, hook: HookState | undefined) {
    if (hook?.event === 'SessionEnd' && (!hook.reason || CLEAN_END.has(hook.reason))) return true
    return this.closedByUs.has(id)
  }

  /**
   * Session coupée en plein travail, tant que personne ne l'a reprise ni laissée : tour arrêté par une erreur (limite
   * d'usage, connexion, API, compaction), processus disparu au milieu d'un tour ou de son arrière-plan, ou mort vue au
   * passage (watchCuts : elle travaillait, ou laissait du travail non commité). Une fin voulue n'en est jamais une.
   */
  private cutOf(t: Transcript, alive: boolean, hook: HookState | undefined, bgRunning: boolean): Session['interrupted'] {
    // Appels ponctuels (claude -p, codex exec) : un script les attend, pas une personne.
    if (t.headless || t.originator === 'codex_exec') return undefined
    const settled = this.cleared.get(t.id) ?? 0
    const clean = !alive && this.endedCleanly(t.id, hook)
    if (t.stopError && t.stopError.at > settled && !clean) return { at: t.stopError.at, reason: t.stopError.reason, detail: t.stopError.text || undefined }
    if (alive || clean) return undefined
    const seen = this.cuts.get(t.id)
    // Une activité après la coupure : elle a été reprise (message écrit, --resume), cette coupure-là est réglée.
    if (seen && seen.at > settled && t.lastActivityAt <= seen.at) return { ...seen }
    const at = Math.max(t.lastActivityAt, hook?.at ?? 0)
    if ((t.phase === 'working' || bgRunning) && at > settled) return { at, reason: 'died' } // i18n-ignore : code de raison, pas un texte affiché
    return undefined
  }

  /** Resumes sessions stopped together, one after another; a session that can't be resumed falls back to a cut. */
  private async healAll(ids: string[]) {
    console.log(`[sessions] ${ids.length} sessions stopped together, resumed by weevils`)
    let ok = 0
    for (const id of ids) {
      try {
        await sleep(1500)
        await this.resume(id)
        ok++
      } catch (e) {
        console.error(`[sessions] ${id.slice(0, 8)} could not be resumed: ${(e as Error).message}`)
        this.cuts.set(id, { at: Date.now(), reason: 'died' }) // i18n-ignore : code de raison, pas un texte affiché
        this.cleared.delete(id)
      }
    }
    if (ok) try { this.foryou?.post(tr(M).healed(ok), undefined, 'weevils') } catch { /* the sessions are back anyway */ }
    this.persist()
    this.bump()
  }

  /**
   * Toutes les 2,5 s, après la relecture des panes : une session qui vivait et ne vit plus, sans fin voulue, est coupée si
   * elle travaillait (ou attendait une réponse), ou si son dossier garde du travail non commité.
   */
  private async watchCuts(now = Date.now()) {
    const seen = new Map<string, { alive: boolean; status: Session['status'] }>()
    const died: { id: string; cwd: string; status: Session['status'] }[] = []
    for (const s of this.sessions(now)) {
      const t = this.store.get(s.id)
      if (!t) continue
      const { alive, hook } = this.lifeOf(t, now)
      const prev = this.lastSeen.get(s.id)
      seen.set(s.id, { alive, status: s.status })
      if (prev?.alive && !alive && !this.endedCleanly(s.id, hook)) died.push({ id: s.id, cwd: s.cwd, status: prev.status })
    }
    this.lastSeen = seen
    // Several sessions gone in the same pass: their terminal server was closed under them (a « tmux kill-server »).
    // Not N cut-off alerts: the ones at work or waiting on a question are resumed, and one calm line says so.
    if (died.length >= 2) {
      const heal = died.filter((d) => d.status === 'working' || d.status === 'needs_user')
      for (const d of heal) this.cleared.set(d.id, now)
      if (heal.length) void this.healAll(heal.map((d) => d.id))
      const rest = new Set(heal.map((d) => d.id))
      died.splice(0, died.length, ...died.filter((d) => !rest.has(d.id)))
    }
    for (const d of died) {
      const working = d.status === 'working' || d.status === 'needs_user'
      const reason: InterruptReason | null = working ? 'died' : d.cwd && (await gitDirty(d.cwd)) ? 'dirty' : null
      console.log(`[sessions] ${d.id.slice(0, 8)} arrêtée sans fin voulue (était ${d.status})${reason ? ` · coupée : ${reason}` : ''}`)
      if (!reason) continue
      this.cuts.set(d.id, { at: now, reason })
      this.persist()
      this.bump()
    }
  }

  /** Une coupure nouvelle : notification push et message dans le fil de weevboss, une fois. Celles découvertes tard : montrées seulement. */
  private announceCuts() {
    const snap = this.snapshot()
    const now = Date.now()
    let changed = false
    for (const s of snap.sessions) {
      if (s.archived || s.status !== 'interrupted' || !s.interrupted) continue
      // Déjà annoncée, et pas reprise depuis (ni rouverte, ni réglée) : le même épisode, dont l'heure a pu se préciser.
      const last = this.announced.get(s.id)
      if (last !== undefined && (this.cleared.get(s.id) ?? 0) <= last && s.lastActivityAt <= last + 30_000) continue
      this.announced.set(s.id, now)
      changed = true
      // Le flux « pour toi » la montre, même découverte tard (il écarte lui-même les sessions de test).
      this.foryou?.sessionTurn(s, 'cut')
      if (now - s.interrupted.at > ANNOUNCE_WITHIN_MS) continue
      // Une session de test (vérifier la détection elle-même) : montrée, jamais annoncée dans le vrai fil.
      if (isTestBrief(this.store.get(s.id)?.firstPrompt) || isScratchDir(s.cwd)) continue
      // Arrêtée par la limite de Claude et Codex peut prendre le relais : une seule annonce, celle du relais (server/relay.ts).
      if (s.machineId === MACHINE.id && this.relay?.covers(s)) continue
      const project = snap.projects.find((p) => p.id === s.projectId)?.name ?? s.projectId
      const why = tr(M).cutWhy(s.interrupted.reason)
      console.log(`[sessions] ${s.id.slice(0, 8)} coupée en plein travail (${s.interrupted.reason}) · « ${s.title} »`)
      if (this.push.enabled) void this.push.send({ title: tr(P).cutTitle(project), body: `${s.title} · ${why}`.replace(/\s+/g, ' ').slice(0, 180), url: `/#s=${encodeURIComponent(s.id)}`, tag: `cut-${s.id}` })
      // Le fil de weevboss (machine principale) ; ailleurs, personne ne le lit : sans effet.
      this.setup?.say(tr(M).cutSaid(s.title, project, why))
    }
    if (changed) this.persist()
  }

  /** Haiku's verdict on a session's candidate question, by message: the reworded question, null (not one, or not yet). */
  private asks = new Map<string, { said: string | null; at: number; failed?: boolean }>()
  private askVerdict(t: Transcript, last: { id?: string; at: number; text: string }, said: string, where: string): string | null {
    const key = `${t.id}:${last.id ?? last.at}`
    const v = this.asks.get(key)
    if (v && !(v.failed && Date.now() - v.at > 10 * 60_000)) return v.said
    if (this.asks.size > 500) for (const k of [...this.asks.keys()].slice(0, 100)) this.asks.delete(k)
    this.asks.set(key, { said: null, at: Date.now() })
    const session = realTitle(this.titles.get(t.id)?.title) ?? titleOf(t)
    void judgeAsk({ session, where, message: last.text, said })
      .then((said) => this.asks.set(key, { said, at: Date.now() }))
      .catch((e) => {
        console.error(`[questions] ${t.id.slice(0, 8)}: ${(e as Error).message.slice(0, 120)}`)
        this.asks.set(key, { said: null, at: Date.now(), failed: true })
      })
      .finally(() => this.bump())
    return null
  }

  private toSession(t: Transcript, now: number): Session {
    let where = place(t.cwd, PROJECT_ROOTS)
    if (where.kind === 'invented') {
      const dir=this.installationIdentity.repositoryDirectory,repo=dir?path.basename(dir):null
      const canonical=repo&&this.repoRoot(repo)===path.dirname(dir!) ? this.installationIdentity.classify(t.cwd,familyOf(repo),repo) : undefined
      where=canonical?{projectId:canonical.target.projectId,projectName:projectLabel(canonical.target.projectId),kind:'repo',repo}:this.inferPlace(t)??where
    }
    const { pane, hook, hookAlive, live, alive } = this.lifeOf(t, now)

    const observedDaemon = t.tool === 'codex' ? this.codexBridge.activityOf?.(t.id) : undefined
    // A cached runtime sample must not override a newer recorded turn transition.
    const daemon = observedDaemon && observedDaemon.at >= t.lastActivityAt ? observedDaemon : undefined
    let status: Session['status'] = 'idle'
    let attention: string | undefined
    if (!live || hook?.event === 'SessionEnd') status = 'done'
    else if (daemon?.type === 'active' && !daemon.waiting) status = 'working'
    else if (daemon?.type === 'idle') status = 'idle'
    else if (pane?.screenAttention) {
      status = 'needs_user'
      attention = pane.screenAttention
    } else if (pane?.screenWorking) status = 'working'
    else if (pane?.mode === 'structured') status = 'idle' // Claude's own events said the turn ended: no hook or screen guess
    else if (hook?.event === 'Notification' && hook.at >= t.lastActivityAt - 2000 && !/waiting for your input/i.test(hook.message ?? '')) {
      status = 'needs_user'
      attention = hook.message
    } else if (hook && hookAlive && hook.at >= t.lastActivityAt - 2000 && ['UserPromptSubmit', 'PostToolUse'].includes(hook.event)) status = 'working'
    else if (hook?.event === 'Stop' && hook.at >= t.lastActivityAt - 2000) status = 'idle'
    else if (t.phase === 'working' && now - t.lastActivityAt < 10 * 60_000) status = 'working'
    // Tour fini sur une question ou une demande (lien, valeur à coller, choix), sans réponse depuis : la session attend
    // l'utilisateur, même si ses sous-agents tournent encore (sinon elle passait pour « travaille »).
    let ask: Ask | undefined
    // Avant la règle des 30 min : une question sans réponse attend, elle ne devient pas « terminée ».
    if (status === 'idle' && live && !(pane && this.isOrchestratorPane(pane))) {
      const last = t.messages.findLast((m) => m.role !== 'event')
      ask = last?.role === 'assistant' ? (asksUser(last.text) ?? undefined) : undefined
      // A « ? » is only a candidate: the question mark and the « reply » card wait for Haiku to confirm a real question
      // for the human, reworded as one clear sentence. Pending, refused or unreachable: no question mark.
      const said = ask && last ? this.askVerdict(t, last, ask.text, where.repo ?? where.projectName ?? '') : null
      if (ask && said) {
        status = 'needs_user'
        attention = said
      } else ask = undefined
    }
    // Une pane weevils qui n'a rien fait depuis 30 min rejoint les sessions terminées (lui écrire la réveille, son contexte est là).
    if (status === 'idle' && pane && !this.isOrchestratorPane(pane) && now - t.lastActivityAt > DONE_AFTER_MS) status = 'done'
    // Le tour principal, sans l'arrière-plan : la file d'attente de Claude Code ne vit que pendant un tour.
    const turnWorking = status === 'working'

    // Arrière-plan (sous-agents, étapes de workflow, commandes) : il meurt avec le processus claude, jamais de « working » fantôme.
    const lastSeen = Math.max(t.lastActivityAt, hook?.at ?? 0)
    const subagents = alive ? t.subagents : t.subagents.map((s) => (s.status === 'working' ? { ...s, status: 'stopped' as const, endedAt: Math.max(s.startedAt, lastSeen) } : s))
    const running = subagents.filter((s) => s.status === 'working')
    // Tant qu'il tourne, la session travaille : ni « idle », ni « done » après 30 min, ni « a fini » (notifyTransitions).
    if (running.length && status !== 'needs_user') status = 'working'
    // Coupée en plein travail : ni « terminée », ni « travaille » ; elle attend une reprise.
    let interrupted = this.cutOf(t, alive, hook, t.subagents.some((x) => x.status === 'working'))
    // Read on the screen: paused by the usage limit, signed out, stopped. A calm status, nothing to answer.
    if (!interrupted && pane?.screenHold && status !== 'working' && status !== 'needs_user')
      interrupted = { at: pane.screenHold.since, reason: pane.screenHold.reason, detail: pane.screenHold.text }
    if (interrupted) status = 'interrupted'

    // Ouverte dans un terminal que weevils ne pilote pas : on ne peut ni lui écrire ni la reprendre sans risque.
    const unmanagedLive = (live || (t.originator === 'codex-tui' && !!t.delegationSources?.size)) && !pane
    // Relais Codex (server/relay.ts) : la session Codex porte le titre de la session Claude qu'elle reprend.
    const relayOf = t.tool === 'codex' ? this.relay?.relayOf(t.id, pane?.name) : undefined
    const relayedBy = t.tool === 'claude' ? this.relay?.relayedBy(t.id) : undefined
    const names = [where.repo ?? '', MACHINE.name].filter(Boolean)
    const titled = this.titles.get(t.id)
    const explicitTitle = realTitle(t.tool === 'codex' ? this.codexBridge.nameOf?.(t.id) : undefined) || realTitle(t.customTitle)
    const presentation = titled ? titlePresentation(t.id, explicitTitle ? { ...titled, title: '' } : titled, lang(), this.foryou?.localization, names) : undefined
    const relayTitled = relayOf ? this.titles.get(relayOf) : undefined
    const relayTitle = relayOf && !t.customTitle ? ((relayTitled ? titlePresentation(relayOf, relayTitled, lang(), this.foryou?.localization, names).title : undefined) ?? (this.store.get(relayOf) ? titleOf(this.store.get(relayOf)!) : undefined)) : undefined
    const userTurn = t.messages.findLast((m) => m.role === 'user' || m.role === 'orchestrator')?.id ?? t.openedAt
    const source = pane?.screenDialog ? t.messages.findLast((m) => m.role === 'event')?.id : t.messages.findLast((m) => m.role === 'assistant')?.id
    const noticeId = status === 'needs_user' ? noticeKey('question', t.id, userTurn, source ?? [attention, pane?.screenDialog?.options.map((o) => o.id)])
      : status === 'interrupted' ? noticeKey('cut', t.id, userTurn) : undefined
    return {
      id: t.id,
      workstream: this.installationIdentity.classify(t.cwd,where.projectId,where.repo),
      sourceAccess: this.installationIdentity.access(t.cwd),
      projectId: where.projectId,
      repo: where.repo,
      machineId: MACHINE.id,
      tool: t.tool,
      // Le titre choisi par l'utilisateur dans l'outil prime ; sinon celui du renommeur (ce dont la session parle maintenant) ; sinon le début.
      title: explicitTitle || relayTitle || presentation?.title || titleOf(t),
      // En attendant l'activité réécrite : le dernier pas de l'agent (outil) plutôt que l'ancienne tâche.
      now: shortNow(presentation?.now || (t.phase === 'working' || pane?.screenWorking ? stepOf(t) : '')) || undefined,
      status,
      ...(noticeId ? { noticeId } : {}),
      attention: status === 'needs_user' ? attention : undefined,
      ...(status === 'needs_user' && pane?.screenDialog?.options.length ? { choices: pane.screenDialog.options, ...(pane.screenDialog.detail ? { attentionDetail: pane.screenDialog.detail } : {}) } : {}),
      // Waiting with nothing to tap (a hook notification, a question read without answers) and no input box on screen:
      // Continue / Go back, never a card that blocks without a button. With an input box, the composer is the answer.
      ...(status === 'needs_user' && !ask && !pane?.screenDialog?.options.length && pane?.screenFallback ? { choices: pane.screenFallback } : {}),
      ...(ask && status === 'needs_user' ? { ask } : {}),
      ...(interrupted ? { interrupted } : {}),
      cwd: t.cwd,
      branch: t.branch,
      openedAt: t.openedAt,
      lastActivityAt: t.lastActivityAt,
      workStartedAt: status === 'working' ? (t.workStartedAt ?? (running.length ? Math.min(...running.map((s) => s.startedAt)) : t.lastActivityAt)) : null,
      origin: pane ? 'weevils' : t.originator === 'codex_exec' ? 'headless' : 'terminal',
      controllable: !unmanagedLive || (t.tool === 'codex' && this.codexBridge.can(t.id)),
      live,
      hasScreen: !!pane,
      // Plus the long jobs it started into a logs folder: nested here, never on the automated page. They outlive the
      // claude process and never make the session « working » (a server left running is not the agent's turn).
      subagents: [...subagents, ...this.logJobsOf(t)],
      background: running.length,
      turnWorking,
      ...(!relayedBy ? { progress: this.progressReader.read(t.cwd, now) } : {}),
      lastMessage: lastMessageOf(t),
      messageCount: t.messages.length,
      settings: (t.model || t.approval || t.effort || this.codexBridge.settingsOf?.(t.id) || this.modelWish.has(t.id) ? { model: t.model, approval: t.approval, effort: t.effort, ...this.codexBridge.settingsOf?.(t.id), ...(this.modelWish.has(t.id) ? this.claudeSelected(t.id) : {}) } : undefined),
      // Une file ne survit pas à la fin du tour : si la session ne travaille plus, tout a été traité.
      queued: Math.max(this.codexBridge.queuedOf?.(t.id) ?? 0, turnWorking ? Math.max(t.queued.length, pane?.screenQueued ?? 0) : 0),
      ...(relayOf ? { relayOf } : {}),
      ...(relayedBy ? { relayedBy } : {}),
    }
  }

  /**
   * The h24 jobs (logs folders) a session started, as shell rows of that session: its agent's description for a label,
   * running while the log grows, failed when its last line says so. When several sessions wrote the same log name, the
   * latest launch before the log's last write owns it. Without a launch seen in any transcript, a job stays « by hand ».
   */
  private logJobsOf(t: Transcript): Subagent[] {
    const mine = t.bg?.logJobs
    if (!mine) return []
    const out: Subagent[] = []
    for (const [name, job] of Object.entries(mine)) {
      const a = this.h24.find((x) => x.id === `job:${name}` && x.kind === 'job')
      const last = a?.lastRunAt ?? 0
      // A log older than this launch belongs to an earlier run (or to someone else).
      if (!a || last < job.at - 60_000 || this.jobOwner(name, last) !== t.id) continue
      const running = a.runState === 'running'
      out.push({
        id: a.id,
        kind: 'shell',
        label: job.label,
        activity: job.label,
        status: running ? 'working' : failedLine(a.lastEvent) ? 'failed' : 'done',
        startedAt: Math.round(job.at),
        ...(running ? {} : { endedAt: Math.round(last) }),
      })
    }
    return out
  }

  /** Which transcript launched the job writing `name`.log last (before `last`, its latest write). */
  private jobOwner(name: string, last: number): string | undefined {
    let best: { id: string; at: number } | undefined
    for (const x of this.store.all()) {
      const at = x.bg?.logJobs?.[name]?.at
      if (at !== undefined && at <= last + 60_000 && (!best || at > best.at)) best = { id: x.id, at }
    }
    return best?.id
  }

  /** Pane lancée par weevils dont le transcript n'existe pas encore. */
  private placeholder(p: ManagedPane, now: number): Session {
    const where = place(p.cwd, PROJECT_ROOTS)
    return {
      id: p.sessionId ?? p.name,
      sourceAccess: this.installationIdentity.access(p.cwd),
      projectId: where.projectId,
      repo: where.repo,
      machineId: MACHINE.id,
      tool: p.tool,
      title: p.title,
      status: p.screenAttention ? 'needs_user' : now - p.createdAt > DONE_AFTER_MS ? 'done' : 'working',
      attention: p.screenAttention,
      ...(p.screenDialog ? { choices: p.screenDialog.options, ...(p.screenDialog.detail ? { attentionDetail: p.screenDialog.detail } : {}) } : {}),
      cwd: p.cwd,
      openedAt: p.createdAt,
      lastActivityAt: p.createdAt,
      workStartedAt: p.screenAttention || now - p.createdAt > DONE_AFTER_MS ? null : p.createdAt,
      origin: 'weevils',
      controllable: true,
      live: true,
      hasScreen: true,
      subagents: [],
      background: 0,
      messageCount: 0,
      queued: 0,
      lastMessage: now - p.createdAt < 60_000 ? tr(M).starting : undefined,
      ...(p.tool === 'codex' && this.relay?.relayOf(p.sessionId, p.name) ? { relayOf: this.relay.relayOf(p.sessionId, p.name) } : {}),
    }
  }

  sessions(now = Date.now()): Session[] {
    const list = this.store
      .all()
      .filter((t) => now - Math.max(t.lastActivityAt, this.store.broughtAt?.(t.id) ?? 0) < RECENT_MS && (t.messages.length > 0 || this.paneFor(t.id)) && !t.cwd.startsWith(DATA_DIR) && !t.firstPrompt?.startsWith(PLAN_MARKER))
      .map((t) => this.toSession(t, now))
    const known = new Set(list.map((s) => s.id))
    for (const p of this.panes) {
      const id = p.sessionId ?? p.name
      // L'orchestrateur (dossier sous DATA_DIR) n'est pas une session de projet.
      if (!known.has(id) && !p.cwd.startsWith(DATA_DIR)) list.push(this.placeholder(p, now))
    }
    // Les sessions ouvertes dans un terminal que weevils ne pilote pas polluent la liste sans servir : cachées.
    return list.filter((s) => s.controllable || (this.store.get(s.id)?.originator === 'codex-tui' && !!this.store.get(s.id)?.delegationSources?.size)).map((s) => this.archived.has(s.id) ? { ...s, archived: true } : s).sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  }

  /** Projets de cette machine seule (chaque weevilsd les calcule pour ses sessions). */
  localProjects(sessions: Session[]): Project[] {
    const map = new Map<string, Project>()
    for (const s of sessions) {
      // Le projet d'une session est déjà tranché dans toSession (dossier, sinon contenu du fil).
      const kind: Project['kind'] = s.repo ? 'repo' : place(s.cwd, PROJECT_ROOTS).kind
      const p = map.get(s.projectId) ?? { id: s.projectId, name: projectLabel(s.projectId), kind, repos: [], where: {}, lastActivityAt: 0 }
      if (s.repo && !p.repos.includes(s.repo)) {
        p.repos.push(s.repo)
        p.where[s.repo] = MACHINE.id
      }
      p.lastActivityAt = Math.max(p.lastActivityAt, s.lastActivityAt)
      map.set(p.id, p)
    }
    // Canonical source stays discoverable even when no project session is currently open.
    for(const repo of this.allRepos()){
      const identity=this.workstreamForRepo(repo)
      if(!identity)continue
      const id=identity.target.projectId
      const p:Project=map.get(id)??{id,name:projectLabel(id),kind:'repo',repos:[],where:{},lastActivityAt:0}
      if(!p.repos.includes(repo))p.repos.push(repo)
      p.installation=this.installationIdentity.info()
      p.where[repo]=MACHINE.id;p.workstream={...identity,evidence:'repository-identity'};p.sourceAccess=this.sourceAccessForRepo(repo);map.set(id,p)
    }
    if(!this.installationIdentity.repositoryDirectory){
      const installation=this.installationIdentity.info(),id=`installation:${installation.id}`
      map.set(id,{id,name:'weevils',kind:'installation',installation,
        sourceAccess:this.installationIdentity.access(this.installationIdentity.directory),
        repos:[],where:{},lastActivityAt:0})
    }
    return [...map.values()]
  }

  /** Fusion par projet : un même projet regroupe ses repos et sessions de toutes les machines. */
  projects(sessions: Session[], extra: Project[] = []): Project[] {
    const map = new Map<string, Project>()
    for (const p of [...this.localProjects(sessions.filter((s) => s.machineId === MACHINE.id)), ...extra]) {
      const cur = map.get(p.id)
      if (!cur) {
        // Nom des projets réservés (divers…) dans la langue d'ici, même venu d'une autre machine.
        map.set(p.id, { ...p, name: projectLabel(p.id) === p.id ? p.name : projectLabel(p.id), repos: [...p.repos], where: { ...p.where } })
        continue
      }
      for (const r of p.repos) {
        if (!cur.repos.includes(r)) cur.repos.push(r)
        cur.where[r] ??= p.where[r]
      }
      if(!cur.workstream){cur.workstream=p.workstream;cur.sourceAccess=p.sourceAccess;cur.installation??=p.installation}
      cur.lastActivityAt = Math.max(cur.lastActivityAt, p.lastActivityAt)
      if (p.kind === 'repo') cur.kind = 'repo'
    }
    const merged = [...map.values()]
    merged.push(...this.pinnedProjects(merged))
    // Les projets d'abord, les catégories inventées ensuite ; chacun par activité récente.
    const rank={repo:0,installation:1,invented:2}
    return merged.sort((a, b) => rank[a.kind]-rank[b.kind] || b.lastActivityAt-a.lastActivityAt)
  }

  snapshot(): Snapshot {
    const locale = lang()
    if (this.snap && this.snapLang === locale) return this.snap
    const now = Date.now()
    const remote = this.remotes.filter((r) => r.online && r.snap && r.snap.machines[0]?.id !== MACHINE.id)
    const sessions = [...new Map([...remote.flatMap((r) => r.snap!.sessions.filter((s) => s.machineId === r.snap!.machines[0]?.id)), ...this.sessions(now)].map((s) => [s.id, this.archived.has(s.id) ? { ...s, archived: true } : s])).values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    this.snap = {
      version: this.version,
      now,
      machines: [...new Map([
        { ...MACHINE, online: true },
        // Une machine distante : seulement ce qui se calcule (nom, en ligne), jamais sa description.
        ...this.remotes.filter((r) => r.snap?.machines[0]?.id !== MACHINE.id).map((r) => ({ id: r.snap?.machines[0]?.id ?? r.id, name: r.snap?.machines[0]?.name ?? r.id, online: r.online })),
      ].map((m) => [m.id, m])).values()],
      projects: this.withConversationProjects(this.projects(sessions, remote.flatMap((r) => r.snap!.projects)), now),
      sessions,
      h24: [...this.h24, ...remote.flatMap((r) => r.snap!.h24)],
      conversations: this.convs.summaries(),
      conversationCounts: this.convs.counts(),
      classifier: this.classifier,
      main: this.orchestratorMessages(),
      mainWorking: this.orchestratorWorking(now),
      mainSettings: this.orchestratorSettings(),
      mainHasScreen: !!this.orchestratorPane(),
      ...this.mainQuestion(),
      mainQueued: this.orchestratorQueued(now),
      devil: { enabled: !!devilConfig(), working: devilWorking() },
      setup: this.setup?.flags(),
      pinnedRepos: this.pinnedRepos,
      memoryCount: this.memory?.count,
      asksOpen: this.ledger?.openCount,
      optimizers: this.optimizers?.list() ?? [],
      autoMachine: this.optimizers?.machine(),
      relay: this.relayView(now, remote.flatMap((r) => r.snap!.relay?.plans ?? [])),
      ...(this.optimizers ? { autoRound: { busy: this.optimizers.roundBusy } } : {}),
      ...(this.sleep ? { sleep: this.sleep.state() } : {}),
      config: { userName: USER_NAME, exposeDomain: EXPOSE_DOMAIN, publicHost: PUBLIC_URL ? new URL(PUBLIC_URL).host : '', authors: publicAuthors(), siteKey: this.siteKey, autoUpdate: process.env.WEEVILS_AUTO_UPDATE !== '0' },
    }
    this.snapLang = locale
    // « Pour toi » : sa marque (révision, non vus) se calcule sur le snapshot qu'on vient de poser, sans rappeler snapshot().
    // Le flux lui-même n'y est jamais ; une erreur de son côté ne prive personne du snapshot.
    const snap = this.snap
    try {
      const mark = this.foryou?.mark(snap)
      if (mark) snap.foryou = mark
    } catch (e) {
      console.error(`[foryou] marque : ${(e as Error).message}`)
    }
    return snap
  }

  /** L'id d'une session à partir de celui qu'on a reçu à son lancement (Codex : le nom de sa pane, avant son transcript). */
  sessionIdOf(id: string) {
    return this.resolveId(id)
  }

  /** A message to this id lands in weevboss's thread: '__main', its current conversation or an older one. */
  isBossTarget(id: string): boolean {
    if (id === '__main' || id === 'turns') return true
    const real = this.resolveId(id)
    return real === this.bossConversation() || (!!this.orchestratorId && real === this.orchestratorId) || this.isBossThread(real)
  }

  private resolveId(id: string) {
    const p = this.panes.find((x) => x.name === id && x.sessionId)
    return p?.sessionId ?? id
  }

  /** Un projet sans session mais avec des conversations récentes a lui aussi sa bande ; idem pour les catégories inventées. */
  private withConversationProjects(projects: Project[], now: number): Project[] {
    const known = new Set(projects.map((p) => p.id))
    const latest = new Map<string, number>()
    for (const c of this.convs.summaries()) if (c.projectId) latest.set(c.projectId, Math.max(latest.get(c.projectId) ?? 0, c.updatedAt))
    const extra: Project[] = []
    for (const [id, at] of latest) {
      if (known.has(id) || now - at > 14 * 86400_000) continue
      const entry = this.catalogCache?.list.find((e) => e.id === id)
      if (!entry) continue // un projet est un repo : rien d'autre ne crée de bande
      extra.push({
        id,
        name: entry.name,
        kind: 'repo',
        repos: entry?.repos ?? [],
        where: Object.fromEntries((entry?.repos ?? []).map((r) => [r, MACHINE.id])),
        lastActivityAt: at,
      })
    }
    const all = [...projects, ...extra]
    for (const p of all) {
      const at = latest.get(p.id)
      if (at && at > p.lastActivityAt && !projects.includes(p)) p.lastActivityAt = at
    }
    return all.sort((a, b) => (a.kind === b.kind ? b.lastActivityAt - a.lastActivityAt : a.kind === 'repo' ? -1 : 1))
  }

  // ---------------------------------------------------------------- conversations

  async importFile(file: string) {
    const parsed = parseExport(await readExportFile(file))
    const r = this.convs.import(parsed)
    this.bump()
    void this.classify()
    return { ...r, total: parsed.length }
  }

  /** Dépose un export dans ~/weevils-imports (scp, navigateur…) : il est importé tout seul. */
  private async watchImports() {
    const dir = path.join(HOME, 'weevils-imports')
    let files: string[] = []
    try {
      files = fs.readdirSync(dir).filter((f) => /\.(zip|json)$/i.test(f))
    } catch {
      return
    }
    for (const f of files) {
      const full = path.join(dir, f)
      try {
        const r = await this.importFile(full)
        console.log(`[import] ${f} : ${r.added} nouvelles, ${r.updated} mises à jour`)
        const done = 'importés' // i18n-ignore : nom de dossier sur disque, stable
        fs.mkdirSync(path.join(dir, done), { recursive: true })
        fs.renameSync(full, path.join(dir, done, f))
      } catch (e) {
        console.error(`[import] ${f} : ${(e as Error).message}`)
      }
    }
  }

  conversationDetail(id: string): ConversationDetail | undefined {
    return this.convs.detail(id)
  }

  conversationList(opts: { projectId?: string; q?: string }): ConversationSummary[] {
    if (opts.q) return this.convs.search(opts.q)
    if (opts.projectId) return this.convs.byProject(opts.projectId)
    return this.convs.summaries(500)
  }

  /** Renomme les sessions dont le fil a avancé : titre = sujet actuel, now = ce qu'elle fait. Lots de 8, une passe à la fois. */
  async retitle() {
    if (this.titling) return
    const now = Date.now()
    if (!this.titleRetry.ready(now)) return
    const recent = this.store.all().filter((t) => now - t.lastActivityAt < RECENT_MS && !t.cwd.startsWith(DATA_DIR) && t.originator !== 'codex_exec')
    // Titles written from the app-locale block (« weevils locale setup » on a session that never spoke of locales): forgotten,
    // the renamer writes them again from the real subject.
    for (const t of recent) if (borrowedTitle(t, this.titles.get(t.id)?.title)) this.titles.delete(t.id)
    const todo = recent
      .filter((t) => needsTitle(this.titles.get(t.id), t.messages.length, now - t.lastActivityAt < STALE_MS, now))
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .slice(0, 8)
    if (!todo.length) return
    this.titling = true
    try {
      const items = todo.map((t) => {
        const where = place(t.cwd, PROJECT_ROOTS)
        return { id: t.id, previousTitle: realTitle(t.tool === 'codex' ? this.codexBridge.nameOf?.(t.id) : undefined) || realTitle(t.customTitle) || realTitle(this.titles.get(t.id)?.title), tool: t.tool, where: where.repo ?? t.cwd.replace(HOME, '~'), ...digestOf(t) }
      })
      const out = await llmTitles(items, path.join(DATA_DIR, 'titles'))
      if (!out.some(r => todo.some(t => t.id === r.id))) throw new Error('empty title result') // i18n-ignore: internal diagnostic, never returned to the user
      this.titleRetry.succeeded()
      for (const r of out) {
        const t = todo.find((x) => x.id === r.id)
        if (t) {
          const previous = this.titles.get(r.id)
          const title = realTitle(t.tool === 'codex' ? this.codexBridge.nameOf?.(t.id) : undefined) || realTitle(t.customTitle) || stableTitle(realTitle(previous?.title), r.title, r.topicChanged)
          this.titles.set(r.id, { title, titleLang: title === previous?.title ? previous.titleLang ?? detectLang(title) ?? undefined : lang(), now: r.now, nowLang: lang(), at: now, messageCount: t.messages.length })
        }
      }
      this.persist()
      this.bump()
    } catch (e) {
      this.titleRetry.failed(Date.now())
      // exec errors include the entire private prompt: log only the process code here.
      const code = (e as NodeJS.ErrnoException).code
      console.error(`[titres] failed; retry delayed; code=${code ?? 'unknown'}`)
      // On note le passage pour ne pas réessayer en boucle sur la même matière.
      for (const t of todo) this.titles.set(t.id, this.titles.get(t.id) ?? { title: titleOf(t), now: '', at: now, messageCount: t.messages.length })
    } finally {
      this.titling = false
    }
  }

  classifyManually(id: string, target: { projectId?: string }) {
    const projectId = target.projectId
    if (!projectId) throw new Error(tr(M).missingProject)
    this.convs.correct(id, projectId)
    this.bump()
  }

  /** Repos de toutes les machines, regroupés par famille : la liste des destinations possibles. */
  private async catalog(): Promise<CatalogEntry[]> {
    if (this.catalogCache && Date.now() - this.catalogCache.at < 10 * 60_000) return this.catalogCache.list
    const repos = new Set(this.allRepos())
    for (const r of this.remotes.filter((x) => x.online)) {
      try {
        for (const name of (await r.call<{ repos: string[] }>('GET', '/api/repos')).repos) repos.add(name)
      } catch {
        /* machine indisponible */
      }
    }
    const fam = new Map<string, CatalogEntry>()
    for (const repo of repos) {
      const id = familyOf(repo)
      const e = fam.get(id) ?? { id, name: id, repos: [] }
      e.repos.push(repo)
      if (!e.about) {
        try {
          const readme = fs.readFileSync(path.join(this.repoDir(repo), 'README.md'), 'utf8')
          e.about = readme
            .split('\n')
            .map((l) => l.replace(/^#+\s*/, '').trim())
            .filter((l) => l && !l.startsWith('!') && !l.startsWith('<'))
            .slice(0, 2)
            .join(' — ')
            .slice(0, 160)
        } catch {
          /* pas de README ici */
        }
      }
      fam.set(id, e)
    }
    const list = [...fam.values()]
    this.catalogCache = { at: Date.now(), list }
    return list
  }

  /** Une passe de classement : règles pour tout, LLM pour ce qui reste et qui est récent. */
  async classify() {
    if (this.classifier.running) return
    const todo = this.convs.unclassified(400)
    if (!todo.length) return
    this.classifier = { running: true, queued: todo.length }
    this.bump()
    try {
      const catalog = await this.catalog()
      const known = new Set(catalog.map((c) => c.id))
      const forLlm: typeof todo = []
      for (const c of todo) {
        const hit = ruleMatch(`${c.title} ${c.preview}`, catalog)
        if (hit) this.convs.setClassification(c.id, { projectId: hit.id, status: 'auto', reason: hit.reason, confidence: hit.confidence })
        else if (Date.now() - c.updatedAt < 180 * 86400_000) forLlm.push(c)
        else this.convs.setClassification(c.id, { projectId: null, status: 'none', reason: tr(M).oldUnsorted })
      }
      this.bump()
      // Lots de 25, plafonnés par passe pour ménager le quota de l'abonnement.
      for (let i = 0; i < Math.min(forLlm.length, 100); i += 25) {
        const batch = forLlm.slice(i, i + 25)
        this.classifier = { running: true, queued: forLlm.length - i }
        this.bump()
        const items = batch.map((b) => ({ id: b.id, title: b.title, excerpt: this.convs.excerpt(b.id) || b.preview }))
        const verdicts = await llmClassify(items, catalog, this.convs.corrections(), path.join(DATA_DIR, 'classifier'))
        for (const v of verdicts) {
          if (!batch.some((b) => b.id === v.id)) continue
          const projectId = v.project && known.has(v.project) ? v.project : null
          if (projectId && v.confidence >= 0.7) this.convs.setClassification(v.id, { projectId, status: 'auto', reason: v.reason, confidence: v.confidence })
          else this.convs.setClassification(v.id, { projectId: null, status: 'pending', suggested: projectId, reason: v.reason, confidence: v.confidence })
        }
      }
      this.classifier = { running: false, queued: this.convs.unclassified(1).length }
    } catch (e) {
      this.classifier = { running: false, queued: this.convs.unclassified(400).length, lastError: (e as Error).message.slice(0, 200) }
      console.error('[classement]', (e as Error).message)
    }
    this.bump()
  }

  /** « Continuer ici » : une nouvelle session d'agent qui reçoit la conversation en contexte. */
  async continueConversation(id: string, tool: Tool, text: string) {
    const d = this.convs.detail(id)
    const t = tr(M)
    if (!d) throw new Error(t.conversationNotFound)
    let context = ''
    for (const m of [...d.messages].reverse()) {
      const line = `${t.said(m.role === 'user' ? t.me : d.conversation.source === 'chatgpt' ? 'ChatGPT' : 'Claude', m.text)}\n\n`
      if (context.length + line.length > 8000) break
      context = line + context
    }
    const prompt = t.continuePrompt(d.conversation.source === 'chatgpt' ? 'ChatGPT' : 'Claude.ai', d.conversation.title, context, text)
    const projectId = d.conversation.projectId ?? MISC
    return this.create({ projectId, tool, text: prompt })
  }

  /** Machine distante qui porte cette session (ou ce repo), sinon undefined = ici. */
  remoteFor(sessionId: string) {
    return this.remotes.find((r) => r.has(sessionId))
  }
  remoteById(machineId?: string) {
    if (!machineId || machineId === MACHINE.id) return undefined
    const r = this.remotes.find((x) => x.id === machineId)
    if (!r) throw new Error(tr(M).unknownMachine(machineId))
    return r
  }

  async detailAny(id: string): Promise<SessionDetail | undefined> {
    const local = this.detail(id)
    if (local) return local
    const r = this.remoteFor(id)
    return r ? r.call<SessionDetail>('GET', `/api/sessions/${encodeURIComponent(id)}`) : undefined
  }

  detail(id: string): SessionDetail | undefined {
    const real = this.resolveId(id)
    // Seulement les sessions de CETTE machine : le snapshot fusionné contient aussi celles du PC, dont le fil est là-bas.
    const session = this.snapshot().sessions.find((s) => s.id === real && s.machineId === MACHINE.id)
    if (!session) return undefined
    const t = this.store.get(real)
    return { session, messages: t?.messages ?? [] }
  }

  /** Détail d'un sous-agent, d'une étape de workflow ou d'une commande d'arrière-plan : ses derniers pas (lus par la fin). */
  async subagentAny(id: string, subId: string): Promise<SubagentDetail | undefined> {
    const local = this.subagent(id, subId)
    if (local) return local
    const r = this.remoteFor(id)
    return r ? r.call<SubagentDetail>('GET', `/api/sessions/${encodeURIComponent(id)}/subagents/${encodeURIComponent(subId)}`) : undefined
  }

  subagent(id: string, subId: string): SubagentDetail | undefined {
    const d = this.detail(id)
    const t = d && this.store.get(d.session.id)
    const sub = d?.session.subagents.find((s) => s.id === subId)
    if (!t || !sub) return undefined
    return { subagent: sub, steps: subagentSteps(t.file, t.bg ?? emptyBg(), sub) }
  }

  // ---------------------------------------------------------------- actions

  /** Archive presentation only: no key, signal, close, or file deletion. Also works for an offline peer. */
  archive(id: string, archived: boolean): { ok: true } {
    const real = this.resolveId(id)
    if (archived) this.archived.add(real)
    else this.archived.delete(real)
    this.persist()
    this.bump()
    return { ok: true }
  }

  /** Écrit dans la session ; si elle n'a plus de processus, la rouvre dans une pane weevils. */
  async send(id: string, text: string, from?: string, sourceThreadId?: string): Promise<{ id: string; control?: 'model' }> {
    if (this.foryou && !from) return this.foryou.directRequest(text, this.resolveId(id), () => this.sendOne(id, text, from, sourceThreadId))
    return this.sendOne(id, text, from, sourceThreadId)
  }

  private async sendOne(id: string, text: string, from?: string, sourceThreadId?: string): Promise<{ id: string; control?: 'model' }> {
    if (isModelControl(text)) return {id:this.resolveId(id),control:'model'}
    if (/^\/(?:model|effort)\s+/i.test(text.trim())) { await this.command(id,text);return {id:this.resolveId(id),control:'model'} }
    // Signé par un auteur (weevboss, un agent externe) : le fil le montre comme son message, pas celui de l'utilisateur.
    // Signé ici, avant un éventuel relais : l'autre machine n'a pas besoin de connaître l'auteur.
    const author = normalizeFrom(from)
    // Vide avant la signature : « [from:weevboss] » seul n'est pas un message.
    if (!text.trim()) throw new Error(tr(M).emptyMessage)
    // A test (its brief starts with [test]) never writes into weevboss's thread, whoever relays it.
    if (this.isBossTarget(id) && (isTestBrief(text) || (sourceThreadId && isTestBrief(this.store.get(this.resolveId(sourceThreadId))?.firstPrompt)))) throw new OutboxError(409, tr(M).testNotInBoss)
    const remote = this.remoteFor(id)
    // First brief only: a local session with no message from the user (or an agent) yet. A remote session got it at creation.
    if (!remote) {
      const target = this.store.get(this.relay?.deliveryTarget?.(this.resolveId(id)) ?? this.resolveId(id))
      text = withAppLocale(text, !target?.messages.some((m) => m.role === 'user' || m.role === 'orchestrator'))
    }
    if (author) text = signAs(author, text, sourceThreadId)
    if (remote) {
      const s = this.snapshot().sessions.find((x) => x.id === id)
      const result = await remote.call<{ id: string }>('POST', `/api/sessions/${encodeURIComponent(id)}/send`, { text })
      if (s) this.foryou?.resolveSession(s)
      return result
    }
    const resolved = this.resolveId(id)
    const real = this.relay?.deliveryTarget?.(resolved) ?? resolved
    const s = this.snapshot().sessions.find((x) => x.id === real)
    if (!s) {
      // Absente de la liste parce qu'ouverte dans un terminal que weevils ne pilote pas : le dire, plutôt que « introuvable ».
      const t = this.store.get(real)
      throw new OutboxError(t ? 409 : 404, t && !this.toSession(t, Date.now()).controllable ? tr(M).unmanaged : tr(M).sessionNotFound)
    }
    this.assertSourceExecution(s.cwd)
    this.guardProvider(s)
    if (s.tool === 'codex' && this.codexBridge.can(real)) {
      await this.codexBridge.send(real, text)
      this.foryou?.resolveSession(s)
      return { id: real }
    }
    const external = this.store.get(real)
    if (!this.paneFor(real) && external?.originator === 'codex-tui' && external.delegationSources?.size) throw new OutboxError(409, tr(M).unmanaged)
    if (!s.controllable) throw new OutboxError(409, tr(M).unmanaged)
    let pane = this.paneFor(real)
    // Still open under a Claude account that is no longer the active one: reopened under the active one.
    if (pane && s.tool === 'claude' && !this.isOrchestratorPane(pane) && accounts()?.mustReopen(pane.sessionId)) {
      await killWv(pane.name).catch(() => undefined)
      this.panes = this.panes.filter((p) => p.name !== pane!.name)
      pane = undefined
    }
    if (pane) {
      console.log(`[sessions] ${pane.name} ← message${author ? ` (${author})` : ''} · ${text.replace(/\s+/g, ' ').slice(0, 60)}`)
      await this.deliver(pane.name, real, text)
      this.foryou?.resolveSession(s)
      return { id: real }
    }
    const cwd = s.cwd && fs.existsSync(s.cwd) ? s.cwd : HOME
    // A project session gets the plain-voice rule back on every relaunch; a weevboss conversation never does.
    const boss = cwd.startsWith(DATA_DIR) || this.isBossThread(s.id)
    const command = s.tool === 'claude' ? [...(boss ? CLAUDE : projectClaude()), '--resume', s.id, text] : ['codex', 'resume', ...(boss ? CODEX_FLAGS : projectCodexFlags()), s.id, text]
    const at = Date.now()
    await this.spawn(s.tool, cwd, s.title, command, s.id)
    // Rouverte : une coupure d'avant est réglée (une nouvelle, plus tard, comptera).
    this.cleared.set(real, at)
    this.closedByUs.delete(real)
    this.foryou?.resolveSession(s)
    this.persist()
    return { id: real }
  }

  /**
   * Reprise en un geste d'une session coupée : relancée avec --resume (ou, encore ouverte après une erreur d'API, dans sa
   * pane) et un message signé weevboss qui lui dit de repartir de son travail sur disque.
   */
  async resume(id: string): Promise<{ id: string }> {
    const remote = this.remoteFor(id)
    if (remote) return remote.call('POST', `/api/sessions/${encodeURIComponent(id)}/resume`, {})
    const real = this.resolveId(id)
    const s = this.snapshot().sessions.find((x) => x.id === real && x.machineId === MACHINE.id)
    if (!s) throw new Error(tr(M).sessionNotFound)
    const at = Date.now()
    const t = tr(M)
    const r = await this.send(real, t.resumePrompt(t.cutWhy(s.interrupted?.reason ?? 'died'), s.cwd), 'weevboss')
    this.cleared.set(real, at)
    this.cuts.delete(real)
    console.log(`[sessions] ${real.slice(0, 8)} reprise après coupure (${s.interrupted?.reason ?? s.status})`)
    this.persist()
    this.bump()
    return r
  }

  /** « Laisser » : la coupure est vue, la session redevient une session terminée (lui écrire la reprend toujours). */
  async dismiss(id: string): Promise<{ ok: true }> {
    const remote = this.remoteFor(id)
    if (remote) return remote.call('POST', `/api/sessions/${encodeURIComponent(id)}/dismiss`, {})
    const real = this.resolveId(id)
    this.cleared.set(real, Date.now())
    this.cuts.delete(real)
    this.persist()
    this.bump()
    return { ok: true }
  }

  /** Message avec des photos : les fichiers sont posés sur la machine de la session, l'agent reçoit leur chemin et va les regarder. */
  private guardProvider(s: Session) {
    if (this.relay?.providerReady?.(s.tool) === false && (s.controllable || this.codexBridge.can(s.id))) {
      if (s.tool === 'codex') this.relay.requestReturn(s, true)
      throw new OutboxDeferred(this.relay.retryAt(), tr(OutboxM).providerWaiting)
    }
  }
  async attach(id: string, text: string, files: { name: string; type: string; data: string }[]): Promise<{ id: string }> {
    const remote = this.remoteFor(id)
    if (remote) return remote.call('POST', `/api/sessions/${encodeURIComponent(id)}/attach`, { text, files })
    if (!files.length) return this.send(id, text)
    const target = this.relay?.deliveryTarget?.(this.resolveId(id)) ?? this.resolveId(id)
    const s = this.snapshot().sessions.find(s => s.id === target)
    if (s) { this.assertSourceExecution(s.cwd);this.guardProvider(s) }
    return this.send(id, withFiles(text, saveInbox(path.join(DATA_DIR, 'inbox'), files)))
  }

  /** Fichiers (photos, PDF, zip…) pour l'orchestrateur : déposés dans INBOX_DIR/<date>-<nom>, le message dit « (fichier : /chemin) ». */
  async attachMain(text: string, files: { name: string; type: string; data: string }[], origin: BossOrigin = 'server') {
    if (!files.length) return this.sendMain(text, undefined, origin)
    const chosen = this.relay?.executionTool?.(preferredTool())
    if ((chosen === null && (!this.setup || providerReady())) || (chosen && this.bossWorking(chosen === 'claude' ? 'codex' : 'claude'))) throw new OutboxDeferred(this.relay?.retryAt() ?? Date.now() + 60_000, tr(OutboxM).providerWaiting)
    return this.sendMain(withFiles(text, saveInbox(INBOX_DIR, files)), undefined, origin)
  }

  async key(id: string, key: string) {
    const remote = this.remoteFor(id)
    if (remote) {
      const s = this.snapshot().sessions.find((x) => x.id === id)
      await remote.call('POST', `/api/sessions/${encodeURIComponent(id)}/key`, { key })
      if (s && key.startsWith('choice:')) this.foryou?.resolveSession(s)
      return
    }
    const real = this.resolveId(id)
    const s = this.snapshot().sessions.find((x) => x.id === real)
    const pane = this.paneFor(real)
    if (!pane) throw new Error(tr(M).noScreen)
    // A weevboss turn has no prompt to interrupt: Escape stops the turn (its transcript stays in the thread).
    if (key === 'esc' && this.bossTurns?.isTurn(pane.sessionId)) {
      await killWv(pane.name).catch(() => undefined)
      this.panes = this.panes.filter((p) => p.name !== pane.name)
      this.bump()
      return
    }
    if (pane.mode === 'structured') {
      if (key === 'esc') await pumpCall(pane.name, { op: 'interrupt' })
      else if (key.startsWith('choice:')) await pumpCall(pane.name, { op: 'answer', choice: key.slice(7) }).catch(() => { throw new Error(tr(TerminalM).choiceGone) })
      else throw new Error(tr(MuxM).keyRefused(key))
      console.log(`[structured] ${pane.name} ← ${key}`)
      if (s && key.startsWith('choice:')) this.foryou?.resolveSession(s)
      this.bump()
      return
    }
    if (key === 'esc' && /trust|confiance/i.test(pane.screenAttention ?? '')) throw new Error(tr(M).escWouldClose)
    if (key.startsWith('choice:')) {
      const id = key.slice(7)
      // The id must match the question on screen now (or the stuck-screen question still shown): never a stale tap.
      const screen = await capture(pane.name)
      const read = readScreen(screen, pane.tool).state
      // A Continue / Go back fallback only while the screen is exactly the one it was offered for.
      const shown = pane.screenDialog?.options.some((o) => o.id === id) || (!!pane.screenFallback?.some((o) => o.id === id) && stuckChoices(screen).some((o) => o.id === id))
      const state = read.kind === 'question' && read.choices.some((o) => o.id === id) ? read : undefined
      if (!state && !(shown && /:(?:enter|esc)$/.test(id))) throw new Error(tr(TerminalM).choiceGone)
      this.driving.add(pane.name)
      try {
        const tail = id.slice(id.lastIndexOf(':') + 1)
        if (tail === 'enter' || tail === 'esc') await sendKey(pane.name, tail)
        else if (tail === 'y' || tail === 'n') {
          await sendKey(pane.name, tail)
          await sendKey(pane.name, 'enter')
        } else if (state?.menu) await this.pick(pane.name, state.menu, Number(tail))
        console.log(`[terminal] ${pane.name} · answered from the app: ${state?.question ?? pane.screenAttention} → ${pane.screenDialog?.options.find((o) => o.id === id)?.label ?? tail}`)
      } finally {
        this.driving.delete(pane.name)
        this.stillSince.delete(pane.name)
      }
      if (s) this.foryou?.resolveSession(s)
      this.bump()
      return
    }
    console.log(`[sessions] ${pane.name} ← touche ${key}`)
    await sendKey(pane.name, key)
  }

  async screen(id: string): Promise<string | null> {
    const remote = this.remoteFor(id)
    if (remote) return (await remote.call<{ screen: string | null }>('GET', `/api/sessions/${encodeURIComponent(id)}/screen`)).screen
    const pane = this.paneFor(this.resolveId(id))
    if (!pane) return null
    return capture(pane.name)
  }

  async create(input: { projectId: string; repo?: string; tool: Tool; text: string; machineId?: string; from?: string; sourceThreadId?:string }): Promise<{ id: string }> {
    const author = normalizeFrom(input.from)
    if (author && input.text) input = { ...input, text: signAs(author, input.text, input.sourceThreadId) }
    const project = this.snapshot().projects.find((p) => p.id === input.projectId)
    if(project?.kind==='installation')throw new OutboxError(403,tr(M).installationReadOnly)
    const repoGuess = input.repo ?? project?.repos[0]
    const machineId = input.machineId ?? (repoGuess ? project?.where[repoGuess] : undefined)
    const remote = this.remoteById(machineId)
    if (remote) return remote.call('POST', '/api/sessions', { ...input, from: undefined, repo: repoGuess, machineId: remote.snap?.machines[0]?.id })
    const repo = repoGuess ?? (this.repoRoot(input.projectId) ? input.projectId : undefined)
    const cwd = repo ? path.join(this.repoRoot(repo) ?? PROJECTS_DIR, repo) : PROJECTS_DIR
    if (!fs.existsSync(cwd)) throw new Error(tr(M).dirNotFound(cwd))
    this.assertSourceExecution(cwd)
    let text = input.text.trim()
    const title = text ? (parseSigned(text)?.text ?? text).replace(/\s+/g, ' ').slice(0, 60) : tr(M).newSession
    text = withAppLocale(text, true)
    if (input.tool === 'claude') {
      if (structuredOn()) {
        const id = crypto.randomUUID()
        const name = await this.spawn('claude', cwd, title, [...projectClaude(), '--session-id', id], id, text).catch((e) => { console.error(`[structured] launch refused: ${(e as Error).message}`); return undefined })
        if (name && await pumpReady(name)) return { id }
        // Fallback: the structured session did not come up. Close what started and launch the ordinary tmux way,
        // under a new id (the first one may have half a transcript).
        console.error(`[structured] ${name ?? 'session'} did not start, falling back to the tmux path`)
        if (name) {
          await killWv(name).catch(() => undefined)
          this.panes = this.panes.filter((p) => p.name !== name)
          pumpForget(name)
        }
      }
      const id = crypto.randomUUID()
      await this.spawn('claude', cwd, title, [...projectClaude(), '--session-id', id, ...(text ? [text] : [])], id)
      return { id }
    }
    const socket = process.env.WEEVILS_CODEX_SOCKET?.trim()
    if (structuredOn() && socket && fs.statSync(socket, { throwIfNoEntry: false })?.isSocket()) {
      // Through Codex's shared app-server, explicitly: the bridge (server/codex-bridge.ts) then sends, queues and reads
      // its state as messages. If the TUI cannot reach the server it exits at once: then the ordinary tmux launch.
      const name = await this.spawn('codex', cwd, title, ['codex', '--remote', `unix://${socket}`, ...projectCodexFlags(), ...(text ? [text] : [])]).catch(() => undefined)
      await sleep(6000)
      if (name && (await listWv()).some((p) => p.name === name)) return { id: name }
      console.error(`[structured] codex ${name ?? ''} could not use the shared app-server, falling back to the tmux path`)
      if (name) this.panes = this.panes.filter((p) => p.name !== name)
    }
    const name = await this.spawn('codex', cwd, title, ['codex', ...projectCodexFlags(), ...(text ? [text] : [])])
    return { id: name }
  }

  /** structuredFirst (a string, possibly empty): launch through server/claude-pump.mjs, with this first message. */
  private async spawn(tool: Tool, cwd: string, title: string, command: string[], sessionId?: string, structuredFirst?: string): Promise<string> {
    this.assertSourceExecution(cwd)
    const short = crypto.randomBytes(3).toString('hex')
    const name = wvName(path.basename(cwd), short)
    // Jamais de dialogue de confiance au lancement : le dossier est marqué sûr avant.
    if (tool === 'claude') trustDirs([cwd])
    // Several Claude accounts (server/claude-accounts.ts): the session starts under the active one.
    const acc = tool === 'claude' && accounts()?.on() ? accounts() : null
    acc?.trust(cwd)
    const extra = acc?.spawnEnv() ?? {}
    const mode = structuredFirst !== undefined && tool === 'claude' ? 'structured' as const : undefined
    // Le message de départ (dernier argument) passe lui aussi par tmux ; en mode structuré, par un fichier.
    command = mode ? pumpCommand(name, command, structuredFirst) : command.map((a) => fitTerminal(a))
    try {
      await (acc ? spawnWv(name, cwd, tool, title.slice(0, 60), command, sessionId, mode, extra) : mode ? spawnWv(name, cwd, tool, title.slice(0, 60), command, sessionId, mode) : spawnWv(name, cwd, tool, title.slice(0, 60), command, sessionId))
      acc?.noteOwner(sessionId)
    } catch (e) {
      console.error(`[sessions] lancement de ${name} (${tool}, ${cwd}) refusé : ${(e as Error).message}`)
      throw e
    }
    console.log(`[sessions] ${name} lancée · ${tool} · ${cwd} · ${sessionId?.slice(0, 8) ?? 'id à venir'} · « ${title.slice(0, 50)} »`)
    this.panes.push({ name, tool, sessionId, title, cwd, createdAt: Date.now(), ...(mode ? { mode } : {}) })
    this.bump()
    return name
  }

  // ---------------------------------------------------------------- agent principal

  // ---------------------------------------------------------------- orchestrateur (la bande du haut)

  /** Le dossier de l'orchestrateur : son CLAUDE.md (rôle + commande weevils) suit le repo. */
  private prepareOrchestrator() {
    fs.mkdirSync(ORCH_DIR, { recursive: true })
    // Un gabarit par langue (orchestrator.fr.md, orchestrator.en.md) ; weevboss répond dans la langue où on lui écrit.
    const src = path.join(import.meta.dirname, `orchestrator.${installationLang()}.md`)
    try {
      // Gabarit : {{user}} (prénom configuré, sinon « l'utilisateur » / « the user »), {{owner}} (compte GitHub configuré, sinon
      // demandé à gh) et {{projects}} (premier dossier de WEEVILS_PROJECTS, ~/projects par défaut).
      const owner = process.env.WEEVILS_GH_OWNER?.trim() || '$(gh api user -q .login)'
      const projects = PROJECTS_DIR.startsWith(HOME + path.sep) ? '~' + PROJECTS_DIR.slice(HOME.length) : PROJECTS_DIR
      const text = fs.readFileSync(src, 'utf8').replaceAll('{{user}}', withLang(installationLang(), user)).replaceAll('{{owner}}', owner).replaceAll('{{projects}}', projects).replaceAll('{{machineProse}}', MachineProse[installationLang()].rule).replaceAll('{{agentMessages}}', AgentMessages[installationLang()].rule + '\n\n' + AgentMessages[installationLang()].automation)
        // Several Claude accounts: weevboss hears of them only where the feature is on.
        .replace(/<!-- claude-accounts -->\n([\s\S]*?)<!-- \/claude-accounts -->\n/g, (_m, body: string) => (accountsOn() ? body : ''))
      fs.writeFileSync(path.join(ORCH_DIR, 'CLAUDE.md'), text)
      // Les mêmes consignes pour Codex, qui répond à la place de Claude pendant sa limite d'usage (server/relay.ts).
      fs.writeFileSync(path.join(ORCH_DIR, 'AGENTS.md'), text)
    } catch (e) {
      console.error(`[orchestrateur] CLAUDE.md : ${(e as Error).message}`)
    }
    // Claude Code demande « tu fais confiance à ce dossier ? » au premier lancement : on répond oui d'avance.
    try {
      trustDirs([ORCH_DIR])
    } catch (e) {
      console.error(`[orchestrateur] trust : ${(e as Error).message}`)
    }
  }

  private claudeBossPane() {
    return this.orchestratorId ? this.paneFor(this.orchestratorId) : undefined
  }

  /** weevboss sur Codex pendant que Claude est à sa limite (server/relay.ts) : sa pane, son transcript une fois relié. */
  private codexBoss() {
    const b = preferredTool() === 'codex' ? this.directCodexBoss ?? this.relay?.boss : this.relay?.boss ?? this.directCodexBoss
    if (!b) return undefined
    const named = b.pane ? this.panes.find((p) => p.name === b.pane) : undefined
    const pane = (named && (!b.sessionId || named.sessionId === b.sessionId) ? named : undefined) ?? (b.sessionId ? this.paneFor(b.sessionId) : undefined)
    if (pane?.sessionId && !b.sessionId) {
      if (b === this.directCodexBoss) { this.directCodexBoss = { ...b, sessionId: pane.sessionId }; this.persist() }
      else this.relay?.setBoss({ ...b, sessionId: pane.sessionId })
    }
    const id = b.sessionId ?? pane?.sessionId
    return { since: b.since, pane, id, t: id ? this.store.get(id) : undefined }
  }

  /** Les transcripts du fil de weevboss : celui de Claude, et celui de Codex quand il a pris le relais. */
  private bossTranscripts(): Transcript[] {
    const codex = this.codexBoss()?.t
    // Turn mode: one transcript per message (and the former single conversation), all in the orchestrator's folder.
    if (this.bossTurns) return [...this.store.all().filter((t) => t.tool === 'claude' && (t.cwd === ORCH_DIR || path.dirname(t.file) === this.bossTurns!.transcripts)), ...(codex ? [codex] : [])]
    const claude = this.orchestratorId ? this.store.get(this.orchestratorId) : undefined
    return [claude, codex].filter((t): t is Transcript => !!t)
  }

  private bossWorking(tool: Tool): boolean {
    const t = tool === 'codex' ? this.codexBoss()?.t : this.orchestratorId ? this.store.get(this.orchestratorId) : undefined
    if (tool === 'codex' && t) {
      const activity = this.codexBridge.activityOf?.(t.id)
      if (activity && activity.at >= t.lastActivityAt) return activity.type === 'active' && !activity.waiting
    }
    if (tool === 'claude' && t) {
      const hook = this.hooks.get(t.id)
      if (hook && hook.at >= t.lastActivityAt - 2000) {
        if (['UserPromptSubmit', 'PostToolUse'].includes(hook.event)) return true
        if (hook.event === 'Stop') return false
      }
    }
    return t?.phase === 'working'
  }
  private bossTool(): Tool {
    if (this.bossWorking('codex')) return 'codex'
    if (this.bossWorking('claude')) return 'claude'
    return this.relay?.executionTool?.(preferredTool()) ?? (preferredTool() === 'codex' || this.relay?.bossOn() ? 'codex' : 'claude')
  }

  /** La pane où weevboss répond en ce moment : celle de Codex pendant le relais, sinon celle de Claude. */
  private orchestratorPane() {
    return (this.bossTool() === 'codex' ? this.codexBoss()?.pane : undefined) ?? this.claudeBossPane()
  }

  /** A question on weevboss's pane, shown in its thread like any session's (server/terminal.ts). */
  private mainQuestion(): { mainQuestion?: Snapshot['mainQuestion'] } {
    const p = this.orchestratorPane()
    const d = p?.screenDialog
    if (!p || !d || d.kind === 'settings') return {}
    return { mainQuestion: { id: p.name, attention: d.question, ...(d.detail ? { attentionDetail: d.detail } : {}), choices: d.options } }
  }

  private orchestratorSettings() {
    if (this.bossTurns && this.bossTool() === 'claude') return { model: this.bossTurns.model, effort: this.bossTurns.effort }
    const t = (this.bossTool() === 'codex' ? this.codexBoss()?.t : undefined) ?? (this.orchestratorId ? this.store.get(this.orchestratorId) : undefined)
    const confirmed = t ? this.codexBridge.settingsOf?.(t.id) : undefined
    if (confirmed) return {approval:t?.approval,...confirmed}
    return t?.model || t?.approval || t?.effort ? { model: t.model, approval: t.approval, effort: t.effort } : undefined
  }

  private orchestratorQueued(now: number) {
    if (this.bossTurns && this.bossTool() === 'claude') {
      const waiting = this.bossTurns.queue.length
      return Math.max(0, waiting - (this.turnStarting || !this.claudeBossPane() ? 1 : 0))
    }
    const owner=this.bossConversation()
    const t = owner ? this.store.get(owner) : undefined
    return Math.max(owner ? this.codexBridge.queuedOf?.(owner) ?? 0 : 0, t && this.orchestratorWorking(now) ? t.queued.length : 0)
  }

  async modelControls(id: string, selection?: ModelSelection): Promise<ModelControls> {
    const remote = id === '__main' ? undefined : this.remoteFor(id)
    if (remote) return remote.call(selection !== undefined ? 'POST' : 'GET', `/api/sessions/${encodeURIComponent(id)}/model-controls`, selection)
    // Turn mode: weevboss's model lives with its turns; the choice is read back from disk before it is confirmed.
    if (id === '__main' && this.bossTurns && this.bossTool() === 'claude') {
      const b = this.bossTurns
      let selected = { model: b.model, effort: b.effort }
      if (selection !== undefined) {
        try { selected = b.choose(String(selection.model), String(selection.effort)) } catch { throw new Error(tr(ModelM).invalid) }
        this.bump()
      }
      return { threadId: '__main', tool: 'claude', models: BOSS_MODELS, selected, active: true, appliesTo: 'next-turn' }
    }
    const real = id === '__main' ? this.bossConversation() : this.resolveId(id)
    const t = real ? this.store.get(real) : undefined
    if (real && t?.tool === 'claude' && this.paneFor(real)) {
      // Claude Code: the choice is kept here and typed into its own pane (/model, /effort) only between turns — never a
      // message, never during a turn. Until its next request shows the new model, the header reads this choice.
      if (selection !== undefined) {
        const m = CLAUDE_MODELS.find((x) => x.id === String(selection.model))
        if (!m || !m.efforts.includes(String(selection.effort))) throw new Error(tr(ModelM).invalid)
        // What the pane runs now: the last choice typed into it, else what its transcript last showed.
        const prev = this.modelWish.get(real)
        const from = prev?.applied ? { model: prev.model, effort: prev.effort } : prev ? prev.from : { model: family(t.model), effort: t.effort }
        this.modelWish.set(real, { model: m.id, effort: String(selection.effort), from })
        this.bump()
        void this.applyModelWish(real)
      }
      return { threadId: real, tool: 'claude', models: CLAUDE_MODELS, selected: this.claudeSelected(real), active: t.phase === 'working', appliesTo: 'next-turn' }
    }
    if (!real || t?.tool !== 'codex') throw new Error(tr(ModelM).unavailable)
    return this.codexBridge.modelControls(real, selection)
  }

  /** Model choices made in the app for Claude Code sessions, waiting for (or just past) their switch in the pane. */
  private modelWish = new Map<string, { model: string; effort: string; from: { model?: string; effort?: string }; applied?: boolean }>()

  /** The model and effort a Claude session runs its next turn with: the app's choice until its transcript moves past it. */
  private claudeSelected(id: string): { model?: string; effort?: string } {
    const t = this.store.get(id)
    const w = this.modelWish.get(id)
    if (w && t && w.applied && family(t.model) === w.model && t.effort === w.effort) this.modelWish.delete(id)
    else if (w) return { model: w.model, effort: w.effort }
    return { model: family(t?.model), effort: t?.effort }
  }

  /** Types the waiting choice into the session's pane when it is between turns (no work, no question on screen). */
  private async applyModelWish(id: string) {
    const w = this.modelWish.get(id)
    const pane = this.paneFor(id)
    if (!w || w.applied || !pane || pane.tool === 'codex' || pane.screenWorking || pane.screenAttention || this.driving.has(pane.name)) return
    w.applied = true
    try {
      if (w.model !== w.from.model) await this.runCommand(pane.name, `/model ${w.model}`)
      if (w.effort !== w.from.effort) await this.runCommand(pane.name, `/effort ${w.effort}`)
    } catch (e) {
      w.applied = false
      console.log(`[model] ${pane.name} switch failed: ${(e as Error).message}`)
    }
    this.bump()
  }

  /** Commande slash (/model opus, /effort high, /fast, /compact, /clear, /approvals…) tapée dans la pane de la session : pas un message, pas signée. */
  async command(id: string, command: string): Promise<{ ok: true; control?: 'model' }> {
    const c = checkCommand(command)
    if (isModelControl(c)) return {ok:true,control:'model'}
    const thread = this.store.get(this.resolveId(id))
    if (thread?.tool === 'codex' && /^\/(?:model|effort)\s/.test(c)) {
      const controls=await this.modelControls(id)
      const [kind,value]=c.split(/\s+/)
      const model=kind==='/model'?value:controls.selected.model
      const choice=controls.models.find(m=>m.id===model)
      const effort=kind==='/effort'?value:(choice?.efforts.includes(controls.selected.effort??'')?controls.selected.effort:choice?.defaultEffort)
      if(!model || !effort)throw new Error(tr(ModelM).invalid)
      await this.modelControls(id,{model,effort});return {ok:true}
    }
    const remote = this.remoteFor(id)
    if (remote) return remote.call('POST', `/api/sessions/${encodeURIComponent(id)}/command`, { command })
    const pane = this.paneFor(this.resolveId(id))
    if (!pane) throw new Error(tr(M).onlyInPane)
    await this.runCommand(pane.name, checkCommand(command))
    return { ok: true }
  }

  /** One of weevboss's own conversations, current or older (For you never opens it as a session page). */
  isBossThread(id: string): boolean {
    return this.store.authorOfThread?.(id) === 'weevboss'
  }

  /**
   * Ferme une session que weevils pilote (sa pane tmux), comme le fait le ménage des panes inactives : le processus
   * s'arrête, le transcript reste et la session est reprenable (lui écrire la rouvre avec --resume). Jamais l'orchestrateur.
   */
  async close(id: string): Promise<{ ok: true }> {
    const remote = this.remoteFor(id)
    if (remote) return remote.call('POST', `/api/sessions/${encodeURIComponent(id)}/close`, {})
    const pane = this.paneFor(this.resolveId(id))
    if (!pane || this.isOrchestratorPane(pane)) throw new Error(tr(TipsM).notClosable)
    if (pane.sessionId) this.closedByUs.set(pane.sessionId, Date.now())
    this.persist()
    await killWv(pane.name)
    console.log(`[sessions] ${pane.name} fermée depuis l'app`)
    this.panes = this.panes.filter((p) => p.name !== pane.name)
    this.bump()
    return { ok: true }
  }

  /** La même chose pour la session de l'orchestrateur. */
  async commandMain(command: string): Promise<{ ok: true; control?: 'model' }> {
    const owner=this.bossConversation()
    if (isModelControl(command)) return {ok:true,control:'model'}
    if(owner && this.store.get(owner)?.tool==='codex' && /^\/(?:model|effort)\s/.test(command.trim()))return this.command(owner,command)
    // Turn mode: no conversation to type into; the setting applies to the next turns.
    if (this.bossTurns && this.bossTool() === 'claude' && this.bossTurns.command(checkCommand(command))) { this.bump(); return { ok: true } }
    const pane = this.orchestratorPane()
    if (!pane) throw new Error(tr(M).orchNotRunning)
    await this.runCommand(pane.name, checkCommand(command))
    // /clear ou /new : même pane, même id pour weevils, mais weevboss repart de zéro ; il doit recevoir la mémoire à nouveau.
    if (/^\/(clear|new)\b/.test(command.trim())) this.setup?.bossReset()
    this.bump()
    return { ok: true }
  }

  // ---------------------------------------------------------------- livraison vérifiée

  /**
   * Commande de réglage : /model ou /fast ouvrent parfois une confirmation (crédits, mode rapide…). Échap l'annulait
   * (« Kept model as … ») : ici on la confirme par Entrée, jusqu'à trois fois, puis on rend la main.
   */
  private async runCommand(pane: string, command: string) {
    if (this.panes.find((p) => p.name === pane)?.mode === 'structured') {
      const model = /^\/model\s+(\S+)/.exec(command.trim())?.[1]
      // No effort control in Claude's stream-json mode: skipped (never sent to the agent as words).
      if (/^\/effort\b/.test(command.trim())) return void console.log(`[structured] ${pane} · ${command} skipped`)
      await pumpCall(pane, model ? { op: 'model', model } : { op: 'send', text: command })
      console.log(`[structured] ${pane} ← ${command}`)
      return
    }
    this.driving.add(pane)
    try {
      await this.clearDialog(pane)
      await sendText(pane, command)
      for (let i = 0; i < 3; i++) {
        await sleep(700)
        const state = readScreen(await capture(pane).catch(() => ''), this.toolOf(pane)).state
        // The confirmation the command itself asks ("Switch model?"), answered yes; a menu is left to the app.
        const yes = state.kind === 'auto' ? state.pick : state.kind === 'question' && state.menu ? state.menu.options.findIndex((o) => /^yes\b/i.test(o.raw)) : -1
        if ((state.kind !== 'auto' && state.kind !== 'question') || yes === -1) break
        console.log(`[terminal] ${pane} ${command} · confirmed: ${state.kind === 'question' ? state.question : state.name}`)
        if (yes === 'enter' || !state.menu) await sendKey(pane, 'enter')
        else await this.pick(pane, state.menu, yes)
      }
      console.log(`[sessions] ${pane} ← ${command}`)
    } finally {
      this.driving.delete(pane)
    }
  }

  private toolOf = (pane: string) => this.panes.find((p) => p.name === pane)?.tool

  /**
   * Before a message: what covers the input box is answered or closed, never by a blind key.
   * A safe automatic answer is sent; a settings menu is closed; a permission or plan question is declined (the message
   * is the answer: "no, do this instead"); a launch question gets its own "no" when that keeps the agent running.
   * Anything else stays, and the message waits (409) for the question to be answered in the app.
   */
  private async clearDialog(pane: string, known?: TerminalState): Promise<string | undefined> {
    const state = known ?? readScreen(await capture(pane).catch(() => ''), this.toolOf(pane)).state
    if (state.kind === 'none' || state.kind === 'hold') return undefined
    if (state.kind === 'auto') {
      if (state.pick === 'enter' || !state.menu) await sendKey(pane, 'enter')
      else await this.pick(pane, state.menu, state.pick)
      console.log(`[terminal] ${pane} · answered by weevils before a message: ${state.name}`)
    } else if (state.kind === 'picker') await sendKey(pane, 'esc')
    else if (['permission', 'plan', 'enter-plan', 'choice', 'yes-no', 'unknown-stuck'].includes(state.name) || state.name === 'unknown') {
      await sendKey(pane, 'esc')
      console.log(`[terminal] ${pane} · question answered by the message: ${state.question}`)
    } else {
      const no = state.menu?.options.findIndex((o) => /^no\b|without|skip/i.test(o.raw) && !/exit|quit/i.test(o.raw)) ?? -1
      if (no < 0 || !state.menu) throw new OutboxError(409, tr(M).notReceived(state.question))
      await this.pick(pane, state.menu, no)
      console.log(`[terminal] ${pane} · launch question declined before a message: ${state.question}`)
    }
    await sleep(600)
    return state.kind === 'question' ? state.question : state.name
  }

  /**
   * A message sent while the agent asks a question with a free-text row (Claude's "Type something."): it is the
   * answer. Moves to the row, types it, confirms; delivered when that question is gone from the screen.
   */
  private async answerByText(pane: string, text: string, state: TerminalState): Promise<boolean> {
    if (state.kind !== 'question' || state.typeIndex === undefined || !state.menu) return false
    this.driving.add(pane)
    try {
      for (const key of moves(state.menu, state.typeIndex)) await sendKey(pane, key)
      await sendText(pane, text)
      for (let i = 0; i < 20; i++) {
        await sleep(300)
        const now = readScreen(await capture(pane).catch(() => ''), this.toolOf(pane)).state
        if (now.kind !== 'question' || now.question !== state.question) {
          console.log(`[terminal] ${pane} · question answered in words: ${state.question}`)
          return true
        }
      }
      throw new Error(tr(M).noConfirmation)
    } finally {
      this.driving.delete(pane)
    }
  }

  /**
   * Écrit le message dans la pane et attend la preuve qu'il est arrivé : hook UserPromptSubmit de la session (claude),
   * message de l'utilisateur dans le transcript, ou le texte visible à l'écran (saisi ou en file d'attente) sans dialogue par-dessus.
   * Sinon : écran capturé, Échap si un menu/dialogue est là, un seul nouvel essai, et une erreur à l'appelant.
   */
  private deliveryLocks = new Map<string, Promise<void>>()

  private async deliver(pane: string, sessionId: string | undefined, text: string): Promise<void> {
    const previous = this.deliveryLocks.get(pane) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(() => this.deliverOne(pane, sessionId, text))
    this.deliveryLocks.set(pane, next)
    try { await next } finally { if (this.deliveryLocks.get(pane) === next) this.deliveryLocks.delete(pane) }
  }

  private async deliverOne(pane: string, sessionId: string | undefined, text: string): Promise<void> {
    const managed = this.panes.find((p) => p.name === pane)
    // A model chosen in the app goes in first, so this message is answered by it.
    if (sessionId && this.modelWish.has(sessionId)) await this.applyModelWish(sessionId)
    if (managed?.mode === 'structured') {
      // The pump's acknowledgement is delivery: the message is in Claude's input (or answers its open question).
      await pumpCall(pane, { op: 'send', text })
      return
    }
    if (managed?.tool === 'codex') {
      let screen = await capture(pane)
      let reading = readScreen(screen, 'codex')
      // An update, a nudge, a menu nobody uses: answered or closed first, then the message goes.
      if (reading.state.kind === 'auto' || reading.state.kind === 'picker') {
        await this.clearDialog(pane)
        screen = await capture(pane)
        reading = readScreen(screen, 'codex')
      }
      if (reading.state.kind === 'question' || reading.state.kind === 'auto' || reading.state.kind === 'picker')
        throw new OutboxError(409, tr(M).notReceived(reading.state.kind === 'question' ? reading.state.question : tr(TerminalM).choiceGone))
      const t = sessionId ? this.store.get(sessionId) : undefined
      const queued = reading.working || t?.phase === 'working'
      const before = Date.now()
      await sendText(pane, fitTerminal(text), queued ? 'Tab' : 'Enter')
      // Tab queues in Codex; the transcript is written only at the next turn. No blind resend:
      // an uncertain confirmation must never duplicate a message or interrupt the running turn.
      if (!await this.confirmDelivery(pane, sessionId, text, before, true, screen)) throw new Error(tr(M).noConfirmation)
      return
    }
    text = fitTerminal(text)
    const state = readScreen(await capture(pane).catch(() => ''), 'claude').state
    if (await this.answerByText(pane, text, state)) return
    await this.clearDialog(pane, state)
    const before = Date.now()
    await sendText(pane, text)
    // No confirmation is not proof of rejection. Never submit a second copy.
    if (!await this.confirmDelivery(pane, sessionId, text, before)) throw new Error(tr(M).noConfirmation)
  }

  private async confirmDelivery(pane: string, sessionId: string | undefined, text: string, before: number, codex = false, previousScreen = ''): Promise<boolean> {
    // L'écran montre le texte tel que tapé (signé « [from:x] … ») ; le transcript le garde sans signature (parseSigned).
    const mark = flatScreen(text).slice(0, 48).trim()
    const tmark = flatScreen(parseSigned(text)?.text ?? text).slice(0, 32).trim()
    const deadline = before + (deliveryContext.getStore() ? 120_000 : 12_000)
    while (Date.now() < deadline) {
      await sleep(300)
      if (sessionId) {
        const hook = this.hooks.get(sessionId)
        if (hook && hook.at > before && hook.event === 'UserPromptSubmit') return true
        const t = this.store.get(sessionId)
        if (tmark && t?.messages.some((m) => (m.role === 'user' || m.role === 'orchestrator') && m.at >= before && (tmark.length < 8 ? flatScreen(m.text).trim() === tmark : flatScreen(m.text).includes(tmark)))) return true
      }
      // Toutes les secondes : l'écran. Le texte y est (envoyé, ou en file pendant que l'agent travaille) et aucun dialogue ne le recouvre.
      if (Math.round((Date.now() - before) / 300) % 3 === 0) {
        const screen = await capture(pane).catch(() => '')
        if (screen && readScreen(screen, this.toolOf(pane)).state.kind === 'none' && mark && flatScreen(screen).includes(mark)) {
          if (!codex && mark.length >= 8) return true
          const queueOf = (value: string) => value.split('Queued follow-up inputs')[1]?.split(/^[›❯>]/m)[0] ?? ''
          const exactReplies = (value: string) => queueOf(value).split('\n')
            .filter((line) => flatScreen(line.replace(/^\s*↳\s*/, '')).trim() === mark).length
          // Short answers need a new complete queue entry, never a substring in the composer.
          if (codex && (mark.length >= 8
            ? flatScreen(queueOf(screen)).includes(mark)
            : exactReplies(screen) > exactReplies(previousScreen))) return true
        }
      }
    }
    return false
  }

  /** The last messages of weevboss's thread (live voice mode: context for the voice layer). */
  recentMain(n: number): Message[] {
    return this.orchestratorMessages().slice(-n)
  }
  private orchestratorMessages(): Message[] {
    const boss = this.codexBoss()
    // La bande du haut : tes messages et les réponses de weevils, pas ses appels d'outils.
    // Le devil mode écrit dans le même fil : ses échanges sont mêlés par ordre d'arrivée.
    // L'accueil et les branchements, écrits par weevilsd au nom de weevboss, aussi. Le bloc de contexte joint à un message
    // pour weevboss (ce qu'il n'a pas vu passer) ne s'affiche jamais.
    // Pendant la limite de Claude, Codex répond à sa place : ses échanges sont dans le même fil. Un message qui n'est
    // que du contexte (la reprise d'un message resté sans réponse) ne s'affiche pas.
    // Incoming agent coordination belongs to the recipient transcript, not the user-facing boss chat.
    const own = this.bossTranscripts()
      .flatMap((t) => t.messages.filter((m) => m.role !== 'event' && m.role !== 'orchestrator' && (t.tool === 'claude' || m.at >= (boss?.since ?? 0) - 60_000)))
      .map((m) => (m.role === 'user' ? { ...m, text: withoutContext(m.text).trim() } : m))
      .filter((m) => m.text)
    const msgs = [...own, ...devilMessages(), ...(this.setup?.messages() ?? [])]
      .sort((a, b) => a.at - b.at)
      .slice(-40)
      .map((m) => {
        if (m.role !== 'assistant' || m.devil) return m
        // Les puces restent à leur place dans la phrase : l'app en fait un bouton (« … via [bouton]. »), pas un trou.
        const { text, chips } = chipsInPlace(m.text)
        return chips.length ? { ...m, text, chips } : m
      })
    if (!msgs.length && ORCHESTRATOR) {
      return [{ id: 'hello', role: 'assistant', text: tr(M).hello, at: Date.now() }]
    }
    return msgs
  }

  private orchestratorWorking(now: number) {
    if (this.bossTurns && (this.turnStarting || this.bossTurns.queue.length)) return true
    const owner = this.codexBoss()?.id
    const daemon = owner ? this.codexBridge.activityOf?.(owner) : undefined
    const codex = this.codexBoss()?.t
    if (this.bossTool() === 'codex') {
      if (daemon && daemon.at >= (codex?.lastActivityAt ?? 0)) return daemon.type === 'active' && !daemon.waiting
      if (codex?.phase === 'working' && now - codex.lastActivityAt < 10 * 60_000) return true
    }
    const t = this.orchestratorId ? this.store.get(this.orchestratorId) : undefined
    if (!t) return false
    const hook = this.hooks.get(t.id)
    if (hook && hook.at >= t.lastActivityAt - 2000 && ['UserPromptSubmit', 'PostToolUse'].includes(hook.event)) return true
    if (hook?.event === 'Stop' && hook.at >= t.lastActivityAt - 2000) return false
    return t.phase === 'working' && now - t.lastActivityAt < 10 * 60_000
  }

  /** La conversation de weevboss où ira le prochain message (son pane est ouvert ou son transcript connu) ; null : sendMain
   * en ouvrira une nouvelle (Setup.contextFor lui redonne alors la mémoire). */
  bossConversation(): string | null {
    if (this.bossTool() === 'codex') return this.codexBoss()?.id ?? null
    const id = this.orchestratorId
    return id && (this.orchestratorPane() || this.store.get(id)) ? id : null
  }

  /** L'utilisateur parle à weevboss : le message part dans la session Claude de l'orchestrateur (lancée ou reprise au besoin).
   * « brief » : la marche à suivre d'un bouton de branchement, jointe au bloc ⟦weevils …⟧ (jamais affichée). */
  private bossSendLock: Promise<unknown> = Promise.resolve()
  async sendMain(text: string, brief?: string, origin: BossOrigin = 'server'): Promise<{ id: string }> {
    const run = () => {
      const next = this.bossSendLock.catch(() => undefined).then(() => this.sendMainOne(text, brief, origin))
      this.bossSendLock = next
      return next
    }
    return this.foryou ? this.foryou.directRequest(text, undefined, run) : run()
  }

  private async sendMainOne(text: string, brief?: string, origin: BossOrigin = 'server') {
    if (isModelControl(text)) return {id:this.bossConversation() ?? '__main',control:'model' as const}
    if (/^\/(?:model|effort)\s+/i.test(text.trim())) { await this.commandMain(text);return {id:this.bossConversation() ?? '__main',control:'model' as const} }
    if (!ORCHESTRATOR) throw new Error(tr(M).orchNotHere)
    if (!text.trim()) throw new Error(tr(M).emptyMessage)
    // A test never writes into weevboss's thread (CONTRIBUTING.md: a test brief starts with [test]).
    if (isTestBrief(text)) throw new OutboxError(409, tr(M).testNotInBoss)
    recordOrigin(BOSS_DIR, text, origin)
    // A new weevboss conversation gets it once; the ongoing one already has it.
    // Stateless turns never remember it: every turn gets it.
    text = withAppLocale(text, !!this.bossTurns || !this.bossConversation())
    // Claude à sa limite (ou tout près) : weevboss répond par Codex, même dossier, mêmes consignes (server/relay.ts).
    const chosen = this.relay?.executionTool ? this.relay.executionTool(preferredTool()) : (preferredTool() === 'codex' || this.relay?.bossOn() ? 'codex' : 'claude')
    if ((!chosen || chosen === 'codex') && preferredTool() === 'codex' && !providerReady()) {
      if (this.setup) { await this.setup.offline(text); return { id: 'setup' } }
      throw new Error(providerUnavailable('codex'))
    }
    if (!chosen && this.setup && !providerReady()) { await this.setup.offline(text); return { id: 'setup' } }
    if (!chosen) throw new OutboxDeferred(this.relay?.retryAt() ?? Date.now() + 60_000, tr(OutboxM).providerWaiting)
    if (this.bossWorking(chosen === 'claude' ? 'codex' : 'claude')) throw new OutboxDeferred(this.relay?.retryAt() ?? Date.now() + 60_000, tr(OutboxM).providerWaiting)
    // Into the request ledger before anything can fail: what the user asks is never lost (server/boss-ledger.ts).
    const cid = this.captureAsk(text, brief)
    if (chosen === 'codex') {
      const since = Date.now()
      void this.waitMainReply(since, 300_000).then((r) => r && console.log(`[voix] weevboss (codex) a répondu en ${Date.now() - since} ms`))
      const claude = this.orchestratorId ? this.store.get(this.orchestratorId) : undefined
      const codex = this.codexBoss()?.t
      const previous = claude && codex && claude.lastActivityAt > codex.lastActivityAt ? this.threadDigest(this.orchestratorMessages().slice(-12)) : ''
      return this.sendBossCodex(text, joinContext(this.setup?.contextFor(brief) ?? '', previous))
    }
    // Claude Code pas connecté sur cette machine : weevboss ne peut pas répondre. Le message reste dans le fil, et la marche
    // à suivre y arrive à sa place (weevilsd préviendra dès que la connexion est faite).
    if (this.setup && !claudeLogged()) {
      await this.setup.offline(text)
      return { id: 'setup' }
    }
    this.prepareOrchestrator()
    // Ce que weevilsd a écrit en son nom depuis sa dernière réponse (accueil, branchements) : joint au message.
    text = text + joinContext(this.setup?.contextFor(brief) ?? '', this.bossBackContext())
    if (this.bossTurns) {
      // One stateless turn per message, in order; a message that arrives during a turn waits for the next one.
      this.bossTurns.enqueue(text, cid ?? undefined)
      this.relay?.takeBossBack()
      const since = Date.now()
      void this.waitMainReply(since, 300_000).then((r) => r && console.log(`[voix] weevboss a répondu en ${Date.now() - since} ms`))
      void this.pumpTurns()
      this.bump()
      return { id: this.orchestratorId ?? '__main' }
    }
    // Mesure : temps de réponse complet de weevboss, au journal.
    const since = Date.now()
    void this.waitMainReply(since, 300_000).then((r) => r && console.log(`[voix] weevboss a répondu en ${Date.now() - since} ms`))
    const pane = this.claudeBossPane()
    if (pane) {
      await this.deliver(pane.name, this.orchestratorId!, text)
      this.relay?.takeBossBack()
      this.bump()
      return { id: this.orchestratorId! }
    }
    const known = this.orchestratorId && this.store.get(this.orchestratorId)
    if (!this.orchestratorId || !known) this.orchestratorId = crypto.randomUUID()
    const id = this.orchestratorId
    const command = known ? [...CLAUDE, '--resume', id, text] : [...CLAUDE, '--session-id', id, text]
    await this.spawn('claude', ORCH_DIR, 'weevboss', command, id)
    this.relay?.takeBossBack()
    this.persist()
    return { id }
  }

  /**
   * Turn mode: starts the next queued message as a stateless turn once nothing else is running. The former single
   * conversation, if its pane is still open, is closed first, only once it is calm (never in the middle of a reply).
   */
  private async pumpTurns() {
    const turns = this.bossTurns
    if (!turns || !turns.queue.length || this.turnStarting) return
    const now = Date.now()
    const pane = this.claudeBossPane()
    if (pane) {
      if (turns.isTurn(pane.sessionId)) return
      const t = pane.sessionId ? this.store.get(pane.sessionId) : undefined
      if (this.bossWorking('claude') || (t && (t.queued.length || this.toSession(t, now).background > 0))) return
      if (pane.sessionId) this.closedByUs.set(pane.sessionId, now)
      await killWv(pane.name).catch(() => undefined)
      this.panes = this.panes.filter((p) => p.name !== pane.name)
      console.log(`[weevboss] conversation unique ${pane.sessionId?.slice(0, 8)} fermée : weevboss passe en tours sans état`)
    }
    if (this.bossWorking('codex')) return
    this.turnStarting = true
    this.bump()
    try {
      const id = crypto.randomUUID()
      const head = turns.queue[0]
      const turn = await turns.prepare({ id, claude: [...CLAUDE], memory: this.memory?.digest() ?? '', ledger: this.ledger?.digest(undefined, head?.cid) ?? '' })
      // The previous turn is over: its message can be read into the ledger.
      void this.ledgerTick()
      this.orchestratorId = id
      await this.spawn('claude', ORCH_DIR, 'weevboss', turn.command, id)
      const q = turns.started(turn)
      if (q?.cid) this.ledger?.attach(q.cid, id)
      this.persist()
      console.log(`[weevboss] tour ${id.slice(0, 8)} · vue ${turn.stableTokens} + ${turn.recentTokens} + registre ${turn.ledgerTokens ?? 0} tokens${turn.rebuilt ? ' · paliers reconstruits' : ''}`)
      void turns.prewarm(5 * 60_000).catch(() => undefined)
    } catch (e) {
      turns.failed(e as Error)
    } finally {
      this.turnStarting = false
      this.bump()
    }
  }

  /** A message for weevboss, into the request ledger (its hidden blocks peeled off; a button's brief kept short). */
  private captureAsk(text: string, brief?: string): string | null {
    if (!this.ledger) return null
    try {
      const said = withoutContext(text).trim()
      return this.ledger.capture(brief?.trim() ? `${said} (${brief.replace(/\s+/g, ' ').trim().slice(0, 400)})` : said)
    } catch (e) {
      console.error(`[ledger] capture: ${(e as Error).message}`)
      return null
    }
  }

  /** Reads finished turns into the ledger and closes the loop on sessions that stopped. */
  private ledgerTicking = false
  async ledgerTick() {
    const ledger = this.ledger
    if (!ledger || this.ledgerTicking) return
    this.ledgerTicking = true
    try {
      const transcripts = this.bossTurns?.transcripts ?? orchTranscriptsDir()
      while (await ledger.reconcile(transcripts)) { /* batches of six until the inbox is read */ }
      await ledger.closeLoop()
    } catch (e) {
      console.error(`[ledger] ${(e as Error).message}`)
    } finally {
      this.ledgerTicking = false
    }
  }

  /** `weevils recall <id>`: a line of weevboss's log, back to the original. */
  bossRecall(id: string): string | null {
    return this.bossTurns?.recall(id) ?? null
  }

  /** `weevils boss`: how weevboss runs and the size of what it reads on each message. */
  bossStatus() {
    if (this.bossTurns) return { ...this.bossTurns.status(), current: this.orchestratorId }
    const t = this.orchestratorId ? this.store.get(this.orchestratorId) : undefined
    return { mode: 'conversation' as const, current: this.orchestratorId, messages: t?.messages.length ?? 0 }
  }

  /** Les derniers échanges du fil, en une ligne, pour celui qui prend (ou reprend) le fil. */
  private threadDigest(msgs: Message[], max = 3000, me = 'you') {
    return msgs
      .filter((m) => m.role !== 'event' && m.text.trim())
      .map((m) => `${m.role === 'user' ? 'user' : m.role === 'orchestrator' ? (m.author ?? 'agent') : me}: ${m.text.replace(/\s+/g, ' ').slice(0, 400)}`)
      .join(' | ')
      .slice(-max)
      .replace(/⟧/g, ']')
  }

  /**
   * weevboss sur Codex : dans sa pane si elle est ouverte, sinon une session Codex dans le dossier de l'orchestrateur
   * (AGENTS.md = ses consignes), reprise si elle existe déjà. Son premier message porte, caché, les derniers échanges du fil.
   * unanswered : aucun texte de l'utilisateur, seulement le contexte (son dernier message est resté sans réponse).
   */
  private async sendBossCodex(text: string, context = '', unanswered = false): Promise<{ id: string }> {
    this.prepareOrchestrator()
    const boss = this.codexBoss()
    if (boss?.id && (this.codexBridge.can(boss.id) || await this.codexBridge.reachable?.(boss.id))) {
      await this.codexBridge.send(boss.id, (text + joinContext(context, unanswered ? tr(R).bossUnanswered : '')).trim())
      this.bump()
      return { id: boss.id }
    }
    if (boss?.pane) {
      await this.deliver(boss.pane.name, boss.pane.sessionId, (text + joinContext(context, unanswered ? tr(R).bossUnanswered : '')).trim())
      this.bump()
      return { id: boss.id ?? boss.pane.name }
    }
    if (boss?.t?.originator === 'codex-tui' && boss.t.delegationSources?.size) throw new OutboxError(409, tr(CB).unavailable)
    const e = this.relay?.episode()
    const t = tr(R)
    const until = e?.until ? t.until(clockOf(e.until, Date.now(), e.tz)) : ''
    const first = (text + joinContext(context, preferredTool() === 'codex' ? this.threadDigest(this.orchestratorMessages().slice(-12)) : t.bossIn(t[`bossWhy_${e?.kind ?? 'limit'}`], until, this.threadDigest(this.orchestratorMessages().slice(-12)), unanswered))).trim()
    const known = boss?.id && boss.t ? boss.id : undefined
    const command = known ? ['codex', 'resume', ...CODEX_FLAGS, known, first] : ['codex', ...CODEX_FLAGS, first]
    const name = await this.spawn('codex', ORCH_DIR, 'weevboss', command, known)
    void this.acceptTrust(name)
    const registered = { pane: name, sessionId: known, since: boss?.since ?? Date.now() }
    if (preferredTool() === 'codex') { this.directCodexBoss = registered; this.persist() }
    else this.relay?.setBoss(registered)
    console.log(`[relais] weevboss répond par Codex (${name})`)
    return { id: known ?? name }
  }

  /** Carry context back without terminating a pane that may still own external jobs. */
  private bossBackContext(): string {
    const since = (this.relay?.peekBossBack ? this.relay.peekBossBack() : this.relay?.takeBossBack()) ?? (preferredTool() === 'codex' ? 0 : undefined)
    if (since === undefined) return ''
    const boss = this.codexBoss()
    const said = (boss?.t?.messages ?? []).filter((m) => m.at >= since - 60_000).map((m) => (m.role === 'user' ? { ...m, text: withoutContext(m.text) } : m))
    if (!said.some((m) => m.role === 'assistant')) return ''
    return tr(R).bossBack(this.threadDigest(said, 3000, 'codex'))
  }

  /** Le relais vu par l'app : celui de cette machine, plus les plans de reprise des autres. */
  private relayView(now: number, far: NonNullable<Snapshot['relay']>['plans']) {
    const v = this.relay?.view(now)
    return v && far.length ? { ...v, plans: [...v.plans, ...far] } : v
  }

  /**
   * Une session Codex que weevils lance sans personne devant (relais, weevboss sur Codex, tâche auto) : dans un dossier
   * qu'il ne connaît pas, Codex demande d'abord « Trust this folder? », et rien n'avance. Le dossier est à l'utilisateur
   * (comme pour Claude, marqué de confiance d'avance) : on accepte, pendant les premières secondes seulement.
   */
  private async acceptTrust(pane: string) {
    for (let i = 0; i < 14; i++) {
      await sleep(1500)
      const screen = await capture(pane).catch(() => '')
      const state = readScreen(screen, 'codex').state
      if (state.kind === 'auto' && state.name === 'trust') {
        await this.answerAuto(pane, screen, state)
        return
      }
    }
  }

  /** Ce que le relais Codex (server/relay.ts) demande à weevilsd. */
  relayHost(): RelayHost {
    return {
      sessions: (now) => this.sessions(now),
      transcript: (id) => this.store.get(id),
      send: (id, text, from) => this.send(id, text, from),
      resume: (id) => this.resume(id),
      settle: (id) => {
        this.cleared.set(id, Date.now())
        this.cuts.delete(id)
        this.persist()
        this.bump()
      },
      openCodex: async (cwd, title, text) => (await this.createIn(cwd, title, text, [], {}, 'codex')).id,
      openClaude: async (cwd, title, text, id) => (await this.createIn(cwd, title, text, [], {}, 'claude', id)).id,
      autoReturn: (id, text, targetId, tool = 'claude') => this.optimizers!.relayRun(id, text, tool, tool === 'claude' ? targetId : undefined),
      resumeCodex: (id, text, requestId) => deliveryContext.run({ messageId: requestId }, async () => (await this.send(id, text)).id),
      codexBossStop: () => this.codexBoss()?.t?.stopError,
      codexBossSession: () => { const t = this.codexBoss()?.t; return t ? this.toSession(t, Date.now()) : undefined },
      mainBusy: () => this.bossWorking('claude') || this.bossWorking('codex'),
      returnMain: (text, requestId) => deliveryContext.run({ messageId: requestId }, async () => (await this.sendMain(text)).id),
      resolve: (id) => this.resolveId(id),
      bossStop: () => (this.orchestratorId ? this.store.get(this.orchestratorId)?.stopError : undefined),
      bossRelayCut: () => this.sendBossCodex('', '', true),
      autoOwns: (id) => !!this.optimizers?.owns(id),
      autoRun: (id, text) => this.optimizers!.relayRun(id, text),
      autoTick: () => this.optimizers?.poke(),
      carryOn: async (id, text) => {
        await this.send(id, text, 'weevboss')
        this.cleared.set(id, Date.now())
        this.cuts.delete(id)
        this.persist()
        this.bump()
      },
      notify: (title, body, url, tag) => {
        if (this.push.enabled) void this.push.send({ title, body: body.replace(/\s+/g, ' ').slice(0, 180), url, tag })
      },
      say: (text) => void this.setup?.say(text),
      bump: () => this.bump(),
    }
  }

  // ---------------------------------------------------------------- H24

  /** Jobs longs (LOGS_DIRS : WEEVILS_LOGS_DIR, sinon ~/logs et le dossier de weevils) et timers systemd « wv-* ».
   *  Hors Linux (un Mac) : les jobs seulement, sans lancer systemctl. */
  refreshH24(platform: NodeJS.Platform = process.platform) {
    const now = Date.now()
    const out: H24Activity[] = []
    for (const dir of LOGS_DIRS) try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.log') || f === 'weevils.log' || f === 'weevilsd.log') continue
        if (out.some((a) => a.id === `job:${f.replace(/\.log$/, '')}`)) continue
        const file = path.join(dir, f)
        const st = fs.statSync(file)
        const running = now - st.mtimeMs < 120_000
        // Ce qui tourne, plus ce qui a fini dans les 3 dernières heures.
        if (!running && now - st.mtimeMs > 3 * 3600_000) continue
        let last = ''
        try {
          const fd = fs.openSync(file, 'r')
          const len = Math.min(2048, st.size)
          const buf = Buffer.alloc(len)
          fs.readSync(fd, buf, 0, len, st.size - len)
          fs.closeSync(fd)
          last =
            buf
              .toString('utf8')
              .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean)
              .pop() ?? ''
        } catch {
          /* illisible */
        }
        const name = f.replace(/\.log$/, '')
        out.push({
          id: `job:${name}`,
          title: name,
          kind: 'job',
          projectId: familyOf(name),
          schedule: tr(M).manualJob,
          enabled: true,
          runState: running ? 'running' : 'waiting',
          runStartedAt: running ? st.birthtimeMs || null : st.mtimeMs,
          lastEvent: last.slice(0, 160) || '—',
          canToggle: false,
          since: st.birthtimeMs || null,
          lastRunAt: st.mtimeMs,
          group: familyOf(name),
          // Over: its one run, from the log's birth to its last write.
          ...(running ? {} : { lastDurMs: Math.max(0, st.mtimeMs - (st.birthtimeMs || st.mtimeMs)), runCount: 1 }),
        })
      }
    } catch {
      /* pas de dossier de jobs */
    }
    // Timers are systemd's. Anywhere else there is none to list: the jobs are published as they are, and no command
    // is started only to fail on every pass.
    if (platform !== 'linux') return this.publishH24(out)
    execFile('systemctl', ['--user', 'list-timers', '--all', '--output=json'], { timeout: 4000 }, (err, stdout) => {
      const t = tr(M)
      const when = (us: number) => new Date(us / 1000).toLocaleString(locale(lang()))
      if (!err) {
        try {
          for (const x of JSON.parse(stdout) as { unit: string; next?: number; last?: number; activates: string }[]) {
            if (!x.unit.startsWith('wv-')) continue
            if (x.activates) this.timerSvc.set(x.unit, x.activates)
            out.push({
              id: `timer:${x.unit}`,
              title: x.unit.replace(/^wv-/, '').replace(/\.timer$/, ''),
              kind: 'timer',
              projectId: null,
              schedule: x.next ? t.nextRun(when(x.next)) : t.scheduled,
              enabled: !!x.next,
              runState: x.next ? 'waiting' : 'paused',
              runStartedAt: null,
              lastEvent: x.last ? t.lastRun(when(x.last)) : t.neverRun,
              canToggle: true,
              nextRunAt: x.next ? Math.round(x.next / 1000) : null,
              lastRunAt: x.last ? Math.round(x.last / 1000) : null,
              since: unitSince(x.unit),
              group: familyOf(x.unit.replace(/^wv-/, '')),
            })
          }
        } catch {
          /* format inattendu */
        }
      }
      // La période de chaque timer, lue dans son planning (OnCalendar, OnUnitActiveSec) : « / 6 h » dans la bande auto.
      // Relue toutes les 10 min (ou quand la liste change), pas à chaque passage.
      const timers = out.filter((a) => a.kind === 'timer').map((a) => a.id.replace(/^timer:/, ''))
      // Plus what it is for (its service's Description=, else the timer's) and its runs in the journal (last one's
      // length and outcome, how many in 30 days), re-read when it ran again.
      const apply = (every: Map<string, number | null>, desc: Map<string, string>) => {
        for (const a of out) {
          if (a.kind !== 'timer') continue
          const unit = a.id.replace(/^timer:/, '')
          a.everyMs = every.get(unit) ?? (a.nextRunAt && a.lastRunAt && a.nextRunAt > a.lastRunAt ? a.nextRunAt - a.lastRunAt : null)
          const d = desc.get(this.timerSvc.get(unit) ?? '') ?? desc.get(unit)
          if (d) a.description = d
          const runs = this.timerRunsCache.get(unit)
          if (!runs || runs.key !== String(a.lastRunAt ?? '') || now - runs.at > 600_000) void this.timerRuns(unit, String(a.lastRunAt ?? '')).then((r) => r.fresh && this.refreshH24(platform))
          const last = runs?.runs.at(-1)
          if (last) {
            a.lastDurMs = last.at - last.startedAt
            a.lastOk = last.ok
          }
          if (runs) a.runCount = runs.runs.length
        }
        this.publishH24(out)
      }
      const key = timers.join(' ')
      const cached = this.timerEvery
      if (!timers.length || (cached && cached.key === key && now - cached.at < 600_000)) return apply(cached?.map ?? new Map(), cached?.desc ?? new Map())
      const services = timers.map((u) => this.timerSvc.get(u)).filter((u): u is string => !!u)
      execFile('systemctl', ['--user', 'show', ...timers, ...services, '-p', 'Id', '-p', 'TimersCalendar', '-p', 'TimersMonotonic', '-p', 'Description'], { timeout: 4000 }, (e2, show) => {
        const map = e2 ? new Map<string, number | null>() : parseTimerShow(show)
        const desc = e2 ? new Map<string, string>() : unitDescriptions(show)
        this.timerEvery = { at: now, key, map, desc }
        apply(map, desc)
      })
    })
  }

  private timerEvery: { at: number; key: string; map: Map<string, number | null>; desc: Map<string, string> } | null = null
  /** The service each wv-* timer starts (list-timers' « activates »). */
  private timerSvc = new Map<string, string>()
  /** A timer's runs read in the journal (30 days), and for which last run (key: its lastRunAt). */
  private timerRunsCache = new Map<string, { key: string; at: number; runs: JournalRun[] }>()
  private timerRunsLoading = new Map<string, Promise<{ runs: JournalRun[]; fresh: boolean }>>()

  /** A timer's runs from the user journal (one per invocation of its service, oldest first); cached until it runs again. */
  private timerRuns(unit: string, key: string, maxAgeMs = 600_000): Promise<{ runs: JournalRun[]; fresh: boolean }> {
    const c = this.timerRunsCache.get(unit)
    if (c && c.key === key && Date.now() - c.at < maxAgeMs) return Promise.resolve({ runs: c.runs, fresh: false })
    const loading = this.timerRunsLoading.get(unit)
    if (loading) return loading
    const svc = this.timerSvc.get(unit) ?? unit.replace(/\.timer$/, '.service')
    // Only the fields a run is read from, and only the newest entries (still oldest first): a chatty service never
    // fills the buffer with its oldest weeks, nor holds the event loop on a huge parse.
    const args = ['--user', '-u', svc, '-o', 'json', `--output-fields=${JOURNAL_FIELDS}`, '--since', '-30d', '-n', String(JOURNAL_LINES), '--no-pager', '-q']
    const p = new Promise<{ runs: JournalRun[]; fresh: boolean }>((resolve) =>
      execFile('journalctl', args, { timeout: 10_000, maxBuffer: 32 << 20 }, (err, stdout) => {
        // Cut short (too big anyway): what it gave is the oldest part, never read as the last runs; what was known stays.
        const cut = (err as NodeJS.ErrnoException | null)?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        // No journal for this user: no runs, kept as such until it runs again (never a loop).
        const runs = cut ? (c?.runs ?? []) : err && !stdout ? [] : journalRuns(stdout)
        this.timerRunsCache.set(unit, { key, at: Date.now(), runs })
        resolve({ runs, fresh: !cut })
      }),
    ).finally(() => this.timerRunsLoading.delete(unit))
    this.timerRunsLoading.set(unit, p)
    return p
  }

  /** The log file of a job (job:<name>), in the first logs folder that has it. */
  private jobFile(id: string): string | null {
    const name = id.replace(/^job:/, '')
    // Its own logs never (refreshH24 leaves them out too): they are not a job.
    if (!name || name.includes('/') || name.includes('\\') || name.startsWith('.') || name === 'weevils' || name === 'weevilsd') return null
    for (const dir of LOGS_DIRS) {
      const f = path.join(dir, `${name}.log`)
      if (fs.existsSync(f)) return f
    }
    return null
  }

  /** A job's one run (its log's birth → last write), once it is over (a running one is live, not a run yet). */
  private jobRun(file: string): AutoRun | null {
    const st = fs.statSync(file, { throwIfNoEntry: false })
    if (!st || Date.now() - st.mtimeMs < 120_000) return null
    const at = Math.round(st.mtimeMs)
    return { at, startedAt: Math.min(at, Math.round(st.birthtimeMs || st.mtimeMs)), ok: true }
  }

  /** GET /api/auto/:id for a timer (its runs in the journal, newest first) or a job (one run). Local ones only. */
  async h24Detail(id: string): Promise<AutoDetail | null> {
    if (id.startsWith('timer:')) {
      const a = this.h24.find((x) => x.id === id)
      if (!a) return null
      const { runs } = await this.timerRuns(id.slice(6), String(a.lastRunAt ?? ''), 60_000)
      return { id, runs: runs.slice(-30).reverse().map(({ inv: _i, lines: _l, ...r }) => r), machine: MACHINE.id }
    }
    const f = id.startsWith('job:') ? this.jobFile(id) : null
    if (!f) return null
    const run = this.jobRun(f)
    return { id, runs: run ? [run] : [], machine: MACHINE.id }
  }

  /** GET /api/auto/:id/runs/:at for a timer (that invocation's journal lines) or a job (its log's last lines). */
  async h24Run(id: string, at: number): Promise<AutoRunDetail | null> {
    if (id.startsWith('timer:')) {
      const a = this.h24.find((x) => x.id === id)
      if (!a) return null
      const { runs } = await this.timerRuns(id.slice(6), String(a.lastRunAt ?? ''), 60_000)
      const r = runs.find((x) => x.at === at)
      if (!r) return null
      const { inv: _i, lines, ...run } = r
      const log = lines.join('\n')
      return { run, files: [], links: extractLinks(log), images: [], log }
    }
    const f = id.startsWith('job:') ? this.jobFile(id) : null
    const run = f ? this.jobRun(f) : null
    if (!f || !run) return null
    const log = tailLines(f)
    return { run, files: [], links: extractLinks(log), images: [], log }
  }

  private publishH24(out: H24Activity[]) {
    out.sort((a, b) => Number(b.runState === 'running') - Number(a.runState === 'running') || a.title.localeCompare(b.title))
    out.splice(16)
    if (JSON.stringify(out) !== JSON.stringify(this.h24)) {
      this.h24 = out
      this.bump()
    }
  }

  /** Session Claude locale lancée dans un dossier donné, avec son titre (tâches de fond de la bande auto, server/optimizers.ts).
   *  args : arguments de plus pour claude (les interdits de la tâche, --settings). env : variables posées (set) ou retirées
   *  (unset) pour cette session seulement (les barrières de la tâche : gh sans compte, git qui ne pousse pas…), par
   *  « env » devant claude : tmux lance la commande sans shell, une valeur n'est jamais interprétée. wrap : une commande
   *  devant tout le reste (la prison bwrap de la tâche). */
  async createIn(cwd: string, title: string, text: string, args: string[] = [], env: { set?: Record<string, string>; unset?: string[]; wrap?: string[] } = {}, tool: Tool = preferredTool(), sessionId?: string): Promise<{ id: string }> {
    this.assertSourceExecution(cwd)
    if (tool === 'codex') {
      const un = (env.unset ?? []).filter((k) => /^[A-Za-z_]\w*$/.test(k)).flatMap((k) => ['-u', k])
      const st = Object.entries(env.set ?? {}).filter(([k]) => /^[A-Za-z_]\w*$/.test(k)).map(([k, v]) => `${k}=${v}`)
      // Codex ne laisse pas choisir l'identifiant : c'est le nom de la pane, jusqu'à ce que son transcript apparaisse.
      const name = await this.spawn('codex', cwd, title, [...(env.wrap ?? []), ...(un.length || st.length ? ['env', ...un, ...st] : []), 'codex', ...projectCodexFlags(), ...args, text])
      void this.acceptTrust(name)
      return { id: name }
    }
    const id = sessionId ?? crypto.randomUUID()
    const unset = (env.unset ?? []).filter((k) => /^[A-Za-z_]\w*$/.test(k)).flatMap((k) => ['-u', k])
    const set = Object.entries(env.set ?? {}).filter(([k]) => /^[A-Za-z_]\w*$/.test(k)).map(([k, v]) => `${k}=${v}`)
    const prefix = unset.length || set.length ? ['env', ...unset, ...set] : []
    await this.spawn('claude', cwd, title, [...(env.wrap ?? []), ...prefix, ...projectClaude(), ...args, '--session-id', id, text], id)
    return { id }
  }

  async toggleH24(id: string) {
    const a = this.h24.find((x) => x.id === id)
    if (!a?.canToggle) throw new Error(tr(M).cantPause)
    const unit = id.replace(/^timer:/, '')
    await new Promise<void>((resolve, reject) =>
      execFile('systemctl', ['--user', a.enabled ? 'stop' : 'start', unit], { timeout: 5000 }, (err) => (err ? reject(err) : resolve())),
    )
    this.refreshH24()
  }

  // ---------------------------------------------------------------- fichiers

  /** Racine de projets qui contient ce repo, sur cette machine. */
  repoRoot(repo: string) {
    const configured=PROJECT_ROOTS.flatMap(root=>[root,...(automationSourceRoot(root)?[automationSourceRoot(root)!]:[])]).find((root) => fs.existsSync(path.join(root, repo)))
    if(configured)return configured
    const own=this.installationIdentity.repositoryDirectory
    return own&&path.basename(own)===repo ? path.dirname(own) : undefined
  }

  repoDir(repo: string) {
    if (!/^[\w.@+-]+$/.test(repo) || repo.startsWith('.')) throw new Error(tr(M).badRepo)
    const root = this.repoRoot(repo)
    if (!root) throw new Error(tr(M).repoNotFound)
    return path.join(root, repo)
  }

  /** Tous les repos de cette machine (pour lancer une session ailleurs que dans un projet actif). */
  allRepos(): string[] {
    const out = new Set<string>()
    const own=this.installationIdentity.repositoryDirectory
    if(own)out.add(path.basename(own))
    for (const root of PROJECT_ROOTS.flatMap(root=>[root,...(automationSourceRoot(root)?[automationSourceRoot(root)!]:[])])) {
      try {
        for (const e of fs.readdirSync(root, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith('.')) {
          if(!own&&fs.realpathSync(path.join(root,e.name))===this.installationIdentity.directory)continue
          out.add(e.name)
        }
      } catch {
        /* racine absente */
      }
    }
    return [...out].sort()
  }

  async files(repo: string): Promise<string[]> {
    if (!this.repoRoot(repo)) return remoteFiles(repo)
    const dir = this.repoDir(repo)
    return new Promise((resolve) => {
      execFile('git', ['-C', dir, 'ls-files', '--cached', '--others', '--exclude-standard'], { timeout: 8000, maxBuffer: 32 << 20 }, (err, stdout) => {
        if (!err) return resolve(stdout.split('\n').filter(Boolean).slice(0, 20000))
        // Pas un repo git : simple parcours, sans node_modules ni dossiers cachés.
        const out: string[] = []
        const walk = (rel: string) => {
          if (out.length > 5000) return
          for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
            if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist') continue
            const r = rel ? `${rel}/${e.name}` : e.name
            if (e.isDirectory()) walk(r)
            else out.push(r)
          }
        }
        try {
          walk('')
        } catch {
          /* dossier illisible */
        }
        resolve(out)
      })
    })
  }

  async file(repo: string, rel: string): Promise<{ path: string; size: number; binary: boolean; content: string; truncated: boolean }> {
    if (!this.repoRoot(repo)) return remoteFile(repo, rel)
    const dir = this.repoDir(repo)
    const full = path.resolve(dir, rel)
    if (!full.startsWith(dir + path.sep)) throw new Error(tr(M).pathRefused)
    const real = fs.realpathSync(full)
    if (!real.startsWith(fs.realpathSync(dir) + path.sep)) throw new Error(tr(M).pathRefused)
    const st = fs.statSync(real)
    const max = 400_000
    const fd = fs.openSync(real, 'r')
    const buf = Buffer.alloc(Math.min(st.size, max))
    fs.readSync(fd, buf, 0, buf.length, 0)
    fs.closeSync(fd)
    const binary = buf.subarray(0, 8000).includes(0)
    return { path: rel, size: st.size, binary, content: binary ? '' : buf.toString('utf8'), truncated: st.size > max }
  }
}

/** Depuis quand un timer systemd existe : la date de son fichier d'unité (bande auto). */
function unitSince(unit: string): number | null {
  try {
    const st = fs.statSync(path.join(HOME, '.config', 'systemd', 'user', unit))
    return Math.round(st.birthtimeMs || st.mtimeMs) || null
  } catch {
    return null
  }
}
