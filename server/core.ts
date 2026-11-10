// Le cœur de weevilsd : transcripts + hooks + panes zellij → sessions, projets, H24, agent principal.

import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { ConversationDetail, ConversationSummary, H24Activity, Message, Project, Session, SessionDetail, Snapshot, SubagentDetail, Tool } from '../shared/api.ts'
import { CLAUDE_DIR, CODEX_DIR, DATA_DIR, EXPOSE_DOMAIN, PUBLIC_URL, USER_NAME, DONE_AFTER_MS, HOME, KILL_AFTER_MS, INBOX_DIR, LOGS_DIR, MACHINE, ORCHESTRATOR, ORCH_DIR, PROJECT_ROOTS, PROJECTS_DIR, RECENT_MS, REMOTES, STALE_MS } from './config.ts'
import { Remote, parseRemotes } from './remotes.ts'
import { ConversationStore, parseExport, readExportFile } from './conversations.ts'
import { llmClassify, ruleMatch } from './classify.ts'
import { Push } from './push.ts'
import type { CatalogEntry } from './classify.ts'
import { MISC, familyOf, place, projectLabel } from './projects.ts'
import { locale } from '../shared/i18n.ts'
import M from './i18n/core.ts'
import P from './i18n/push.ts'
import { setCartesiaVoice } from './fast.ts'
import { keepWarm, warmCues } from './voicepipe.ts'
import { detectLang } from '../shared/detect-lang.ts'
import { devilConfig, devilMessages, devilSend, devilWorking } from './devil.ts'
import { claudeLogged, withoutContext, type Setup } from './setup.ts'
import { splitChips } from '../shared/setup.ts'
import { isDemoJob, type TourKeeper } from './tour.ts'
import TM from './i18n/tour.ts'
import { createRepo, describeRepos, listRepos, loadBlurbs, remoteFile, remoteFiles } from './github.ts'
import { TranscriptStore, digestOf, lastMessageOf, titleOf } from './transcripts.ts'
import { emptyBg, subagentSteps } from './background.ts'
import { llmTitles, needsTitle, shortNow } from './titles.ts'
import type { Titled } from './titles.ts'
import type { Transcript } from './transcripts.ts'
import type { WvSession } from './mux.ts'
import { capture, dialogOnScreen, flatScreen, killWv, listWv, sendKey, sendText, setOpt, spawnWv } from './mux.ts'
import { lang, onLangChange, tr, user, type Lang } from './i18n.ts'
import TipsM from './i18n/tips.ts'
import { normalizeFrom, parseSigned, publicAuthors, signAs } from './authors.ts'

interface HookState {
  event: string
  at: number
  message?: string
  pid?: number
}

/** Session tmux wv-* vue au dernier passage, avec ce qu'on lit à son écran. */
interface ManagedPane extends WvSession {
  screenAttention?: string
}

interface Persisted {
  hooks?: [string, HookState][]
  titles?: [string, Titled][]
  /** Id de la session Claude de l'orchestrateur (stable : on la reprend après un redémarrage). */
  orchestratorId?: string
  pinnedRepos?: string[]
  voiceId?: string
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

/** Comme on les lance d'habitude : sans demande de permission. WEEVILS_SAFE=1 pour revenir aux confirmations. */
const SAFE = process.env.WEEVILS_SAFE === '1'
const CLAUDE = SAFE ? ['claude'] : ['claude', '--dangerously-skip-permissions']
const CODEX_FLAGS = SAFE ? [] : ['--dangerously-bypass-approvals-and-sandbox']

const pidAlive = (pid?: number) => {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Remonte les parents d'un hook jusqu'au processus claude. */
export function findClaudePid(start: number): number | undefined {
  let pid = start
  for (let i = 0; i < 8 && pid > 1; i++) {
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      if (/(^|\/|\0)claude(\0|$)/.test(cmd) || cmd.includes('claude-code') || /\0claude\0/.test(`\0${cmd}`)) return pid
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
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
export function withFiles(text: string, saved: { path: string; image: boolean }[]): string {
  const n = saved.length
  const allImages = saved.every((s) => s.image)
  const t = tr(M)
  const lead = text.trim() || (allImages ? (n > 1 ? t.lookPhotos : t.lookPhoto) : n > 1 ? t.someFiles : t.oneFile)
  return `${lead} ${saved.map((s) => t.attached(s.image, s.path)).join(' ')}`
}

export class Weevils {
  store = new TranscriptStore(CLAUDE_DIR, CODEX_DIR, RECENT_MS)
  hooks = new Map<string, HookState>()
  panes: ManagedPane[] = []
  orchestratorId: string | null = null
  h24: H24Activity[] = []
  remotes: Remote[] = []
  convs = new ConversationStore(DATA_DIR)
  pinnedRepos: string[] = []
  /** Accueil et branchements (server/setup.ts), posé par index.ts : ses messages se mêlent au fil de weevboss. */
  setup: Setup | null = null
  /** Premiers pas (server/tour.ts), posé par index.ts. */
  tour: TourKeeper | null = null
  /** Clé des pages statiques des repos (index.ts, dérivée du code d'accès). */
  siteKey = ''
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
      const t = this.orchestratorId ? this.store.get(this.orchestratorId) : undefined
      const replies = t?.messages.filter((m) => m.role === 'assistant' && m.at >= since - 500) ?? []
      calm = replies.length && !this.orchestratorWorking(Date.now()) ? calm + 1 : 0
      if (calm >= 3) return replies.map((m) => m.text).join('\n\n')
    }
    const t = this.orchestratorId ? this.store.get(this.orchestratorId) : undefined
    return t?.messages.filter((m) => m.role === 'assistant' && m.at >= since - 500).map((m) => m.text).join('\n\n') || null
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
  titles = new Map<string, Titled>()
  private titling = false
  private catalogCache: { at: number; list: CatalogEntry[] } | null = null
  version = 1
  private listeners = new Set<() => void>()
  private bumpTimer: NodeJS.Timeout | null = null
  private snap: Snapshot | null = null
  private persistTimer: NodeJS.Timeout | null = null
  private retitleSoon: NodeJS.Timeout | undefined

  constructor() {
    // Preuves de vie de l'arrière-plan d'une session : le processus claude de sa pane, sinon celui que ses hooks ont donné.
    this.store.pidOf = (id) => this.paneFor(id)?.pid ?? this.hooks.get(id)?.pid
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
      this.titles = new Map(p.titles ?? [])
      this.orchestratorId = p.orchestratorId ?? null
      this.pinnedRepos = p.pinnedRepos ?? []
      this.voiceId = p.voiceId
      setCartesiaVoice(this.voiceId)
      warmCues(this.voiceId)
    } catch {
      /* premier démarrage */
    }
  }

  // ---------------------------------------------------------------- boucle

  start() {
    void this.push.init()
    this.remotes = parseRemotes(REMOTES).map(([id, url]) => new Remote(id, url, () => this.bump()))
    for (const r of this.remotes) r.start()
    this.store.scan(Date.now())
    this.refreshH24()
    setInterval(() => {
      if (this.store.scan(Date.now())) this.bump()
      this.linkCodexPanes()
    }, 1500)
    setInterval(() => void this.watchPanes(), 2500)
    setInterval(() => void this.reapPanes(), 60_000)
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
    }, 200)
  }

  /** Notification quand une session se met à t'attendre, ou finit un travail de plus d'une minute. */
  private notifyTransitions() {
    if (!this.push.enabled) return
    const snap = this.snapshot()
    const now = Date.now()
    const first = this.prevStatus.size === 0
    const next = new Map<string, { status: Session['status']; since: number; notifiedAt?: number }>()
    for (const s of snap.sessions) {
      const prev = this.prevStatus.get(s.id)
      const entry = prev && prev.status === s.status ? prev : { status: s.status, since: now, notifiedAt: prev?.notifiedAt }
      next.set(s.id, entry)
      if (first || !prev || prev.status === s.status) continue
      if (prev.notifiedAt && now - prev.notifiedAt < 60_000) continue
      const project = snap.projects.find((p) => p.id === s.projectId)?.name ?? s.projectId
      let title: string | null = null
      let body: string | null = null
      if (s.status === 'needs_user') {
        title = tr(P).waitingTitle(project)
        body = s.attention ?? tr(P).waitingBody
      } else if (prev.status === 'working' && (s.status === 'idle' || s.status === 'done') && now - prev.since > 15_000 && s.lastMessage) {
        title = tr(P).doneTitle(project)
        body = s.lastMessage
      }
      if (!title || !body) continue
      entry.notifiedAt = now
      void this.push.send({ title, body: body.replace(/\s+/g, ' ').slice(0, 180), url: `/#s=${encodeURIComponent(s.id)}`, tag: s.id })
    }
    this.prevStatus = next
  }

  private persist() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true })
      // Les hooks des trois derniers jours suffisent (pid des sessions encore ouvertes).
      const hooks = [...this.hooks].filter(([, h]) => Date.now() - h.at < RECENT_MS)
      const titles = [...this.titles].filter(([, t]) => Date.now() - t.at < 14 * 86400_000)
      const data: Persisted = { hooks, titles, orchestratorId: this.orchestratorId ?? undefined, pinnedRepos: this.pinnedRepos, voiceId: this.voiceId }
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
    this.hooks.set(id, { event: body.hook_event_name ?? 'unknown', at: Date.now(), message: body.message, pid })
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
      let screenAttention = prev?.screenAttention
      try {
        screenAttention = dialogOnScreen(await capture(p.name))
      } catch {
        /* écran illisible un instant */
      }
      next.push({ ...p, sessionId: p.sessionId ?? prev?.sessionId, screenAttention })
    }
    for (const old of this.panes) {
      if (next.some((p) => p.name === old.name)) continue
      const t = old.sessionId ? this.store.get(old.sessionId) : undefined
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
  private async reapPanes() {
    const now = Date.now()
    for (const p of this.panes) {
      if (this.isOrchestratorPane(p)) continue
      const t = p.sessionId ? this.store.get(p.sessionId) : undefined
      const last = Math.max(t?.lastActivityAt ?? 0, this.hooks.get(p.sessionId ?? '')?.at ?? 0, p.createdAt)
      if (now - last < KILL_AFTER_MS) continue
      if (t?.phase === 'working' && now - t.lastActivityAt < 10 * 60_000) continue
      // Des sous-agents, un workflow ou une commande tournent encore : fermer la pane les tuerait.
      if (t && this.toSession(t, now).background > 0) continue
      try {
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

  private toSession(t: Transcript, now: number): Session {
    let where = place(t.cwd, PROJECT_ROOTS)
    if (where.kind === 'invented') where = this.inferPlace(t) ?? where
    const pane = this.paneFor(t.id)
    const hook = this.hooks.get(t.id)
    const hookAlive = hook?.pid ? pidAlive(hook.pid) : undefined
    const live = !!pane || hookAlive === true || (hookAlive === undefined && now - t.lastActivityAt < STALE_MS && t.originator !== 'codex_exec')

    let status: Session['status'] = 'idle'
    let attention: string | undefined
    if (!live || hook?.event === 'SessionEnd') status = 'done'
    else if (pane?.screenAttention) {
      status = 'needs_user'
      attention = pane.screenAttention
    } else if (hook?.event === 'Notification' && hook.at >= t.lastActivityAt - 2000 && !/waiting for your input/i.test(hook.message ?? '')) {
      status = 'needs_user'
      attention = hook.message
    } else if (hook && hookAlive && hook.at >= t.lastActivityAt - 2000 && ['UserPromptSubmit', 'PostToolUse'].includes(hook.event)) status = 'working'
    else if (hook?.event === 'Stop' && hook.at >= t.lastActivityAt - 2000) status = 'idle'
    else if (t.phase === 'working' && now - t.lastActivityAt < 10 * 60_000) status = 'working'
    // Une pane weevils qui n'a rien fait depuis 30 min rejoint les sessions terminées (lui écrire la réveille, son contexte est là).
    if (status === 'idle' && pane && !this.isOrchestratorPane(pane) && now - t.lastActivityAt > DONE_AFTER_MS) status = 'done'
    // Le tour principal, sans l'arrière-plan : la file d'attente de Claude Code ne vit que pendant un tour.
    const turnWorking = status === 'working'

    // Arrière-plan (sous-agents, étapes de workflow, commandes) : il meurt avec le processus claude, jamais de « working » fantôme.
    const alive = live && hook?.event !== 'SessionEnd'
    const lastSeen = Math.max(t.lastActivityAt, hook?.at ?? 0)
    const subagents = alive ? t.subagents : t.subagents.map((s) => (s.status === 'working' ? { ...s, status: 'stopped' as const, endedAt: Math.max(s.startedAt, lastSeen) } : s))
    const running = subagents.filter((s) => s.status === 'working')
    // Tant qu'il tourne, la session travaille : ni « idle », ni « done » après 30 min, ni « a fini » (notifyTransitions).
    if (running.length && status !== 'needs_user') status = 'working'

    // Ouverte dans un terminal que weevils ne pilote pas : on ne peut ni lui écrire ni la reprendre sans risque.
    const unmanagedLive = live && !pane
    return {
      id: t.id,
      projectId: where.projectId,
      repo: where.repo,
      machineId: MACHINE.id,
      tool: t.tool,
      // Le titre choisi par l'utilisateur dans l'outil prime ; sinon celui du renommeur (ce dont la session parle maintenant) ; sinon le début.
      title: t.customTitle ? titleOf(t) : (this.titles.get(t.id)?.title ?? titleOf(t)),
      // En attendant l'activité réécrite : le dernier pas de l'agent (outil) plutôt que l'ancienne tâche.
      now: shortNow(this.titles.get(t.id)?.now || (t.phase === 'working' ? stepOf(t) : '')) || undefined,
      status,
      attention,
      cwd: t.cwd,
      branch: t.branch,
      openedAt: t.openedAt,
      lastActivityAt: t.lastActivityAt,
      workStartedAt: status === 'working' ? (t.workStartedAt ?? (running.length ? Math.min(...running.map((s) => s.startedAt)) : t.lastActivityAt)) : null,
      origin: pane ? 'weevils' : t.originator === 'codex_exec' ? 'headless' : 'terminal',
      controllable: !unmanagedLive,
      live,
      hasScreen: !!pane,
      subagents,
      background: running.length,
      turnWorking,
      lastMessage: lastMessageOf(t),
      messageCount: t.messages.length,
      settings: t.model || t.approval || t.effort ? { model: t.model, approval: t.approval, effort: t.effort } : undefined,
      // Une file ne survit pas à la fin du tour : si la session ne travaille plus, tout a été traité.
      queued: turnWorking ? t.queued.length : 0,
    }
  }

  /** Pane lancée par weevils dont le transcript n'existe pas encore. */
  private placeholder(p: ManagedPane, now: number): Session {
    const where = place(p.cwd, PROJECT_ROOTS)
    return {
      id: p.sessionId ?? p.name,
      projectId: where.projectId,
      repo: where.repo,
      machineId: MACHINE.id,
      tool: p.tool,
      title: p.title,
      status: p.screenAttention ? 'needs_user' : now - p.createdAt > DONE_AFTER_MS ? 'done' : 'working',
      attention: p.screenAttention,
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
    }
  }

  sessions(now = Date.now()): Session[] {
    const list = this.store
      .all()
      .filter((t) => now - t.lastActivityAt < RECENT_MS && (t.messages.length > 0 || this.paneFor(t.id)) && !t.cwd.startsWith(DATA_DIR))
      .map((t) => this.toSession(t, now))
    const known = new Set(list.map((s) => s.id))
    for (const p of this.panes) {
      const id = p.sessionId ?? p.name
      // L'orchestrateur (dossier sous DATA_DIR) n'est pas une session de projet.
      if (!known.has(id) && !p.cwd.startsWith(DATA_DIR)) list.push(this.placeholder(p, now))
    }
    // Les sessions ouvertes dans un terminal que weevils ne pilote pas polluent la liste sans servir : cachées.
    return list.filter((s) => s.controllable).sort((a, b) => b.lastActivityAt - a.lastActivityAt)
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
      cur.lastActivityAt = Math.max(cur.lastActivityAt, p.lastActivityAt)
      if (p.kind === 'repo') cur.kind = 'repo'
    }
    const merged = [...map.values()]
    merged.push(...this.pinnedProjects(merged))
    // Les projets d'abord, les catégories inventées ensuite ; chacun par activité récente.
    return merged.sort((a, b) => (a.kind === b.kind ? b.lastActivityAt - a.lastActivityAt : a.kind === 'repo' ? -1 : 1))
  }

  snapshot(): Snapshot {
    if (this.snap) return this.snap
    const now = Date.now()
    const remote = this.remotes.filter((r) => r.online && r.snap)
    const sessions = [...this.sessions(now), ...remote.flatMap((r) => r.snap!.sessions)].sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    this.snap = {
      version: this.version,
      now,
      machines: [
        { ...MACHINE, online: true },
        // Une machine distante : seulement ce qui se calcule (nom, en ligne), jamais sa description.
        ...this.remotes.map((r) => ({ id: r.snap?.machines[0]?.id ?? r.id, name: r.snap?.machines[0]?.name ?? r.id, online: r.online })),
      ],
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
      mainQueued: this.orchestratorQueued(now),
      devil: { enabled: !!devilConfig(), working: devilWorking() },
      setup: this.setup?.flags(),
      tour: this.tour?.current() ?? undefined,
      pinnedRepos: this.pinnedRepos,
      config: { userName: USER_NAME, exposeDomain: EXPOSE_DOMAIN, publicHost: PUBLIC_URL ? new URL(PUBLIC_URL).host : '', authors: publicAuthors(), siteKey: this.siteKey },
    }
    return this.snap
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
    const todo = this.store
      .all()
      .filter((t) => now - t.lastActivityAt < RECENT_MS && !t.customTitle && !t.cwd.startsWith(DATA_DIR) && t.originator !== 'codex_exec')
      .filter((t) => needsTitle(this.titles.get(t.id), t.messages.length, now - t.lastActivityAt < STALE_MS, now))
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .slice(0, 8)
    if (!todo.length) return
    this.titling = true
    try {
      const items = todo.map((t) => {
        const where = place(t.cwd, PROJECT_ROOTS)
        return { id: t.id, tool: t.tool, where: where.repo ?? t.cwd.replace(HOME, '~'), ...digestOf(t) }
      })
      const out = await llmTitles(items, path.join(DATA_DIR, 'titles'))
      for (const r of out) {
        const t = todo.find((x) => x.id === r.id)
        if (t) this.titles.set(r.id, { title: r.title, now: r.now, at: now, messageCount: t.messages.length })
      }
      this.persist()
      this.bump()
    } catch (e) {
      console.error(`[titres] ${(e as Error).message}`)
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

  /** Écrit dans la session ; si elle n'a plus de processus, la rouvre dans une pane weevils. */
  async send(id: string, text: string, from?: string): Promise<{ id: string }> {
    // Signé par un auteur (weevboss, un agent externe) : le fil le montre comme son message, pas celui de l'utilisateur.
    // Signé ici, avant un éventuel relais : l'autre machine n'a pas besoin de connaître l'auteur.
    const author = normalizeFrom(from)
    // Vide avant la signature : « [from:weevboss] » seul n'est pas un message.
    if (!text.trim()) throw new Error(tr(M).emptyMessage)
    if (author) text = signAs(author, text)
    const remote = this.remoteFor(id)
    if (remote) return remote.call('POST', `/api/sessions/${encodeURIComponent(id)}/send`, { text })
    const real = this.resolveId(id)
    const s = this.snapshot().sessions.find((x) => x.id === real)
    if (!s) {
      // Absente de la liste parce qu'ouverte dans un terminal que weevils ne pilote pas : le dire, plutôt que « introuvable ».
      const t = this.store.get(real)
      throw new Error(t && !this.toSession(t, Date.now()).controllable ? tr(M).unmanaged : tr(M).sessionNotFound)
    }
    const pane = this.paneFor(real)
    if (pane) {
      console.log(`[sessions] ${pane.name} ← message${author ? ` (${author})` : ''} · ${text.replace(/\s+/g, ' ').slice(0, 60)}`)
      await this.deliver(pane.name, real, text)
      return { id: real }
    }
    const cwd = s.cwd && fs.existsSync(s.cwd) ? s.cwd : HOME
    const command = s.tool === 'claude' ? [...CLAUDE, '--resume', s.id, text] : ['codex', 'resume', ...CODEX_FLAGS, s.id, text]
    await this.spawn(s.tool, cwd, s.title, command, s.id)
    return { id: real }
  }

  /** Message avec des photos : les fichiers sont posés sur la machine de la session, l'agent reçoit leur chemin et va les regarder. */
  async attach(id: string, text: string, files: { name: string; type: string; data: string }[]): Promise<{ id: string }> {
    const remote = this.remoteFor(id)
    if (remote) return remote.call('POST', `/api/sessions/${encodeURIComponent(id)}/attach`, { text, files })
    if (!files.length) return this.send(id, text)
    return this.send(id, withFiles(text, saveInbox(path.join(DATA_DIR, 'inbox'), files)))
  }

  /** Fichiers (photos, PDF, zip…) pour l'orchestrateur : déposés dans INBOX_DIR/<date>-<nom>, le message dit « (fichier : /chemin) ». */
  async attachMain(text: string, files: { name: string; type: string; data: string }[]) {
    if (!files.length) return this.sendMain(text)
    return this.sendMain(withFiles(text, saveInbox(INBOX_DIR, files)))
  }

  async key(id: string, key: string) {
    const remote = this.remoteFor(id)
    if (remote) return void (await remote.call('POST', `/api/sessions/${encodeURIComponent(id)}/key`, { key }))
    const pane = this.paneFor(this.resolveId(id))
    if (!pane) throw new Error(tr(M).noScreen)
    if (key === 'esc' && /trust|confiance/i.test(pane.screenAttention ?? '')) throw new Error(tr(M).escWouldClose)
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

  async create(input: { projectId: string; repo?: string; tool: Tool; text: string; machineId?: string; from?: string }): Promise<{ id: string }> {
    const author = normalizeFrom(input.from)
    if (author && input.text) input = { ...input, text: signAs(author, input.text) }
    const project = this.snapshot().projects.find((p) => p.id === input.projectId)
    const repoGuess = input.repo ?? project?.repos[0]
    const machineId = input.machineId ?? (repoGuess ? project?.where[repoGuess] : undefined)
    const remote = this.remoteById(machineId)
    if (remote) return remote.call('POST', '/api/sessions', { ...input, from: undefined, repo: repoGuess, machineId: remote.snap?.machines[0]?.id })
    const repo = repoGuess ?? (this.repoRoot(input.projectId) ? input.projectId : undefined)
    const cwd = repo ? path.join(this.repoRoot(repo) ?? PROJECTS_DIR, repo) : PROJECTS_DIR
    if (!fs.existsSync(cwd)) throw new Error(tr(M).dirNotFound(cwd))
    const text = input.text.trim()
    const title = text ? text.replace(/\s+/g, ' ').slice(0, 60) : tr(M).newSession
    if (input.tool === 'claude') {
      const id = crypto.randomUUID()
      await this.spawn('claude', cwd, title, [...CLAUDE, '--session-id', id, ...(text ? [text] : [])], id)
      return { id }
    }
    const name = await this.spawn('codex', cwd, title, ['codex', ...CODEX_FLAGS, ...(text ? [text] : [])])
    return { id: name }
  }

  private async spawn(tool: Tool, cwd: string, title: string, command: string[], sessionId?: string): Promise<string> {
    const short = crypto.randomBytes(3).toString('hex')
    const name = `wv-${path.basename(cwd).slice(0, 18)}-${short}`
    // Jamais de dialogue de confiance au lancement : le dossier est marqué sûr avant.
    if (tool === 'claude') trustDirs([cwd])
    try {
      await spawnWv(name, cwd, tool, title.slice(0, 60), command, sessionId)
    } catch (e) {
      console.error(`[sessions] lancement de ${name} (${tool}, ${cwd}) refusé : ${(e as Error).message}`)
      throw e
    }
    console.log(`[sessions] ${name} lancée · ${tool} · ${cwd} · ${sessionId?.slice(0, 8) ?? 'id à venir'} · « ${title.slice(0, 50)} »`)
    this.panes.push({ name, tool, sessionId, title, cwd, createdAt: Date.now() })
    this.bump()
    return name
  }

  // ---------------------------------------------------------------- agent principal

  // ---------------------------------------------------------------- orchestrateur (la bande du haut)

  /** Le dossier de l'orchestrateur : son CLAUDE.md (rôle + commande weevils) suit le repo. */
  private prepareOrchestrator() {
    fs.mkdirSync(ORCH_DIR, { recursive: true })
    // Un gabarit par langue (orchestrator.fr.md, orchestrator.en.md) ; weevboss répond dans la langue où on lui écrit.
    const src = path.join(import.meta.dirname, `orchestrator.${lang()}.md`)
    try {
      // Gabarit : {{user}} (prénom configuré, sinon « l'utilisateur » / « the user »), {{owner}} (compte GitHub configuré, sinon
      // demandé à gh) et {{projects}} (premier dossier de WEEVILS_PROJECTS, ~/projects par défaut).
      const owner = process.env.WEEVILS_GH_OWNER?.trim() || '$(gh api user -q .login)'
      const projects = PROJECTS_DIR.startsWith(HOME + path.sep) ? '~' + PROJECTS_DIR.slice(HOME.length) : PROJECTS_DIR
      const text = fs.readFileSync(src, 'utf8').replaceAll('{{user}}', user()).replaceAll('{{owner}}', owner).replaceAll('{{projects}}', projects)
      fs.writeFileSync(path.join(ORCH_DIR, 'CLAUDE.md'), text)
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

  private orchestratorPane() {
    return this.orchestratorId ? this.paneFor(this.orchestratorId) : undefined
  }

  private orchestratorSettings() {
    const t = this.orchestratorId ? this.store.get(this.orchestratorId) : undefined
    return t?.model || t?.approval || t?.effort ? { model: t.model, approval: t.approval, effort: t.effort } : undefined
  }

  private orchestratorQueued(now: number) {
    const t = this.orchestratorId ? this.store.get(this.orchestratorId) : undefined
    return t && this.orchestratorWorking(now) ? t.queued.length : 0
  }

  /** Commande slash (/model opus, /effort high, /fast, /compact, /clear, /approvals…) tapée dans la pane de la session : pas un message, pas signée. */
  async command(id: string, command: string): Promise<{ ok: true }> {
    const remote = this.remoteFor(id)
    if (remote) return remote.call('POST', `/api/sessions/${encodeURIComponent(id)}/command`, { command })
    const pane = this.paneFor(this.resolveId(id))
    if (!pane) throw new Error(tr(M).onlyInPane)
    await this.runCommand(pane.name, checkCommand(command))
    return { ok: true }
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
    await killWv(pane.name)
    console.log(`[sessions] ${pane.name} fermée depuis l'app`)
    this.panes = this.panes.filter((p) => p.name !== pane.name)
    this.bump()
    return { ok: true }
  }

  /** La même chose pour la session de l'orchestrateur. */
  async commandMain(command: string): Promise<{ ok: true }> {
    const pane = this.orchestratorPane()
    if (!pane) throw new Error(tr(M).orchNotRunning)
    await this.runCommand(pane.name, checkCommand(command))
    this.bump()
    return { ok: true }
  }

  // ---------------------------------------------------------------- livraison vérifiée

  /**
   * Commande de réglage : /model ou /fast ouvrent parfois une confirmation (crédits, mode rapide…). Échap l'annulait
   * (« Kept model as … ») : ici on la confirme par Entrée, jusqu'à trois fois, puis on rend la main.
   */
  private async runCommand(pane: string, command: string) {
    await this.clearDialog(pane)
    await sendText(pane, command)
    for (let i = 0; i < 3; i++) {
      await sleep(700)
      const dlg = dialogOnScreen(await capture(pane).catch(() => ''))
      if (!dlg) break
      console.log(`[sessions] ${pane} ${command} · confirmation acceptée : ${dlg}`)
      await sendKey(pane, 'enter')
    }
    console.log(`[sessions] ${pane} ← ${command}`)
  }

  /** Un dialogue bloque l'écran ? Échap, puis on vérifie qu'il a disparu. Renvoie le texte du dialogue fermé. */
  private async clearDialog(pane: string): Promise<string | undefined> {
    const dlg = dialogOnScreen(await capture(pane).catch(() => ''))
    if (!dlg) return undefined
    // Dialogue de confiance : Échap ferait quitter claude. On accepte (le dossier est à l'utilisateur) ; sinon, Échap ferme le menu.
    await sendKey(pane, /trust|confiance/i.test(dlg) ? 'enter' : 'esc')
    await sleep(600)
    return dlg
  }

  /**
   * Écrit le message dans la pane et attend la preuve qu'il est arrivé : hook UserPromptSubmit de la session (claude),
   * message de l'utilisateur dans le transcript, ou le texte visible à l'écran (saisi ou en file d'attente) sans dialogue par-dessus.
   * Sinon : écran capturé, Échap si un menu/dialogue est là, un seul nouvel essai, et une erreur à l'appelant.
   */
  private async deliver(pane: string, sessionId: string | undefined, text: string): Promise<void> {
    const attempt = async (): Promise<string | undefined> => {
      const before = Date.now()
      await sendText(pane, text)
      if (await this.confirmDelivery(pane, sessionId, text, before)) return undefined
      return dialogOnScreen(await capture(pane).catch(() => '')) ?? tr(M).noConfirmation
    }
    const blocked = await this.clearDialog(pane)
    const first = await attempt()
    if (!first) return
    // Un dialogue a pu apparaître entre-temps (ou avaler l'Entrée) : on le ferme et on réessaie une fois.
    const dlg = await this.clearDialog(pane)
    const second = await attempt()
    if (!second) return
    const why = dlg ?? blocked ?? first
    throw new Error(tr(M).notReceived(why))
  }

  private async confirmDelivery(pane: string, sessionId: string | undefined, text: string, before: number): Promise<boolean> {
    // L'écran montre le texte tel que tapé (signé « [from:x] … ») ; le transcript le garde sans signature (parseSigned).
    const mark = flatScreen(text).slice(0, 48).trim()
    const tmark = flatScreen(parseSigned(text)?.text ?? text).slice(0, 32).trim()
    const deadline = before + 6000
    while (Date.now() < deadline) {
      await sleep(300)
      if (sessionId) {
        const hook = this.hooks.get(sessionId)
        if (hook && hook.at > before && hook.event === 'UserPromptSubmit') return true
        const t = this.store.get(sessionId)
        if (tmark && t?.messages.slice(-6).some((m) => (m.role === 'user' || m.role === 'orchestrator') && m.at >= before - 1500 && flatScreen(m.text).includes(tmark))) return true
      }
      // Toutes les secondes : l'écran. Le texte y est (envoyé, ou en file pendant que l'agent travaille) et aucun dialogue ne le recouvre.
      if (Math.round((Date.now() - before) / 300) % 3 === 0) {
        const screen = await capture(pane).catch(() => '')
        if (screen && !dialogOnScreen(screen) && mark.length >= 8 && flatScreen(screen).includes(mark)) return true
      }
    }
    return false
  }

  private orchestratorMessages(): Message[] {
    const t = this.orchestratorId ? this.store.get(this.orchestratorId) : undefined
    // La bande du haut : tes messages et les réponses de weevils, pas ses appels d'outils.
    // Le devil mode écrit dans le même fil : ses échanges sont mêlés par ordre d'arrivée.
    // L'accueil et les branchements, écrits par weevilsd au nom de weevboss, aussi. Le bloc de contexte joint à un message
    // pour weevboss (ce qu'il n'a pas vu passer) ne s'affiche jamais.
    const own = (t?.messages.filter((m) => m.role !== 'event') ?? []).map((m) => (m.role === 'user' ? { ...m, text: withoutContext(m.text) } : m))
    const msgs = [...own, ...devilMessages(), ...(this.setup?.messages() ?? [])]
      .sort((a, b) => a.at - b.at)
      .slice(-40)
      .map((m) => {
        if (m.role !== 'assistant' || m.devil) return m
        const { text, chips } = splitChips(m.text)
        return chips.length ? { ...m, text, chips } : m
      })
    if (!msgs.length && ORCHESTRATOR) {
      return [{ id: 'hello', role: 'assistant', text: tr(M).hello, at: Date.now() }]
    }
    return msgs
  }

  private orchestratorWorking(now: number) {
    const t = this.orchestratorId ? this.store.get(this.orchestratorId) : undefined
    if (!t) return false
    const hook = this.hooks.get(t.id)
    if (hook && hook.at >= t.lastActivityAt - 2000 && ['UserPromptSubmit', 'PostToolUse'].includes(hook.event)) return true
    if (hook?.event === 'Stop' && hook.at >= t.lastActivityAt - 2000) return false
    return t.phase === 'working' && now - t.lastActivityAt < 10 * 60_000
  }

  /** L'utilisateur parle à weevboss : le message part dans la session Claude de l'orchestrateur (lancée ou reprise au besoin).
   * « brief » : la marche à suivre d'un bouton de branchement, jointe au bloc ⟦weevils …⟧ (jamais affichée). */
  async sendMain(text: string, brief?: string) {
    if (!ORCHESTRATOR) throw new Error(tr(M).orchNotHere)
    if (!text.trim()) throw new Error(tr(M).emptyMessage)
    // Claude Code pas connecté sur cette machine : weevboss ne peut pas répondre. Le message reste dans le fil, et la marche
    // à suivre y arrive à sa place (weevilsd préviendra dès que la connexion est faite).
    if (this.setup && !claudeLogged()) {
      await this.setup.offline(text)
      return { id: 'setup' }
    }
    this.prepareOrchestrator()
    // Ce que weevilsd a écrit en son nom depuis sa dernière réponse (accueil, branchements) : joint au message.
    text = text + (this.setup?.contextFor(brief) ?? '')
    // Mesure : temps de réponse complet de weevboss, au journal.
    const since = Date.now()
    void this.waitMainReply(since, 300_000).then((r) => r && console.log(`[voix] weevboss a répondu en ${Date.now() - since} ms`))
    const pane = this.orchestratorPane()
    if (pane) {
      await this.deliver(pane.name, this.orchestratorId!, text)
      this.bump()
      return { id: this.orchestratorId! }
    }
    const known = this.orchestratorId && this.store.get(this.orchestratorId)
    if (!this.orchestratorId || !known) this.orchestratorId = crypto.randomUUID()
    const id = this.orchestratorId
    const command = known ? [...CLAUDE, '--resume', id, text] : [...CLAUDE, '--session-id', id, text]
    await this.spawn('claude', ORCH_DIR, 'weevboss', command, id)
    this.persist()
    return { id }
  }

  // ---------------------------------------------------------------- H24

  /** Jobs longs (LOGS_DIR, WEEVILS_LOGS_DIR) et timers systemd « wv-* ». */
  refreshH24() {
    const now = Date.now()
    const out: H24Activity[] = []
    try {
      for (const f of fs.readdirSync(LOGS_DIR)) {
        if (!f.endsWith('.log') || f === 'weevils.log' || f === 'weevilsd.log') continue
        const file = path.join(LOGS_DIR, f)
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
          title: isDemoJob(name) ? tr(TM).jobTitle : name,
          kind: 'job',
          projectId: familyOf(name),
          schedule: tr(M).manualJob,
          enabled: true,
          runState: running ? 'running' : 'waiting',
          runStartedAt: running ? st.birthtimeMs || null : st.mtimeMs,
          lastEvent: last.slice(0, 160) || '—',
          canToggle: false,
          ...(isDemoJob(name) ? { demo: true } : {}),
        })
      }
    } catch {
      /* pas de dossier de jobs */
    }
    execFile('systemctl', ['--user', 'list-timers', '--all', '--output=json'], { timeout: 4000 }, (err, stdout) => {
      const t = tr(M)
      const when = (us: number) => new Date(us / 1000).toLocaleString(locale(lang()))
      if (!err) {
        try {
          for (const x of JSON.parse(stdout) as { unit: string; next?: number; last?: number; activates: string }[]) {
            if (!x.unit.startsWith('wv-')) continue
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
            })
          }
        } catch {
          /* format inattendu */
        }
      }
      out.sort((a, b) => Number(b.runState === 'running') - Number(a.runState === 'running') || a.title.localeCompare(b.title))
      out.splice(16)
      if (JSON.stringify(out) !== JSON.stringify(this.h24)) {
        this.h24 = out
        this.bump()
      }
    })
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
    return PROJECT_ROOTS.find((root) => fs.existsSync(path.join(root, repo)))
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
    for (const root of PROJECT_ROOTS) {
      try {
        for (const e of fs.readdirSync(root, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith('.')) out.add(e.name)
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
