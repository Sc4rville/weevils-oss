// Premiers pas (contrat : shared/tour.ts, app : src/ui/tour.tsx). Tout part de l'état réel : ce qui marche déjà est
// coché d'office (« déjà prêt ») et jamais reproposé ; ce qui manque se joue d'abord en démo, puis se branche.
//
// - state() : chaque étape, recalculée à partir de Setup.detect() (mis en cache), des gestes déjà faits (hints.json),
//   de l'installation (install.json, écrit par install.sh) et de ce que l'utilisateur a déjà sur la machine
//   (~/.claude/projects, ses repos). « ready » = déjà là au tout premier calcul ; « done » = fait depuis.
// - demo() : les démos jouables sur place. Elles sont marquées « démo » partout (Message.demo, H24Activity.demo),
//   ne partent jamais chez weevboss (Setup.contextFor) et disparaissent dès que la vraie brique est branchée.

import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import type { H24Activity, Snapshot } from '../shared/api.ts'
import { TOUR_IDS, groupOf, type Handoff, type Tour, type TourId, type TourState, type TourStep } from '../shared/tour.ts'
import { CLAUDE_DIR, DATA_DIR, HOME, LOGS_DIR, PROJECT_ROOTS } from './config.ts'
import { edgeTts, tts } from './fast.ts'
import { lang, tr } from './i18n.ts'
import M from './i18n/tour.ts'
import type { Setup, SetupState } from './setup.ts'

const FILE = path.join(DATA_DIR, 'tour.json')
const INSTALL_FILE = path.join(DATA_DIR, 'install.json')
/** Le job de démo du 24/7 : un vrai job local, au nom qui le marque comme démo (core.ts : H24Activity.demo). */
export const DEMO_JOB = 'demo-veille'

interface Persisted {
  /** Ce qui était déjà là au premier calcul. */
  ready: TourId[]
  done: TourId[]
  skip: TourId[]
  played: TourId[]
  open: boolean
  intro: boolean
  /** Un appareil mobile a ouvert l'app. */
  phone: boolean
  at: number
}

export interface TourDeps {
  setup: Setup
  /** Ids des gestes et bulles déjà vus (hints.json). */
  seen: () => string[]
  snapshot: () => Snapshot
  /** Le fil de weevboss a déjà servi : une installation existante, pas un nouveau venu. */
  veteran: () => boolean
  bump: () => void
  /** Relit le 24/7 tout de suite (le job de démo y apparaît sans attendre). */
  refreshH24: () => void
}

const readJson = <T>(f: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8')) as T
  } catch {
    return null
  }
}

/** Ce que l'installation a laissé (install.json) : qui l'a faite, et si le lien du téléphone a été donné. */
export function handoff(): Handoff | undefined {
  const j = readJson<Partial<Handoff> & { v?: number }>(INSTALL_FILE)
  if (!j || typeof j.at !== 'number') return undefined
  return {
    by: j.by === 'agent' || j.by === 'script' ? j.by : 'terminal',
    agent: typeof j.agent === 'string' ? j.agent.slice(0, 20) : '',
    at: j.at,
    mode: j.mode === 'public' || j.mode === 'lan' ? j.mode : 'local',
    phoneLink: !!j.phoneLink,
  }
}

/** L'abonnement de Claude Code (Pro, Max…), tel que /login l'a noté. */
export function claudePlan(): string {
  const j = readJson<{ claudeAiOauth?: { subscriptionType?: string } }>(path.join(HOME, '.claude', '.credentials.json'))
  const p = j?.claudeAiOauth?.subscriptionType ?? ''
  return /^[a-z0-9_-]{1,20}$/i.test(p) ? p.toLowerCase() : ''
}

let historyCache: { at: number; v: { projects: number; sessions: number; repos: number } } | null = null
/** Ce que l'utilisateur avait déjà : ses projets et sessions Claude Code, ses repos. Le dossier de weevboss ne compte pas. */
export function history() {
  if (historyCache && Date.now() - historyCache.at < 60_000) return historyCache.v
  let projects = 0
  let sessions = 0
  try {
    for (const d of fs.readdirSync(CLAUDE_DIR, { withFileTypes: true })) {
      if (!d.isDirectory() || /weevils-orchestr|weevils-fresh|^-tmp/.test(d.name)) continue
      const n = fs.readdirSync(path.join(CLAUDE_DIR, d.name)).filter((f) => f.endsWith('.jsonl')).length
      if (!n) continue
      projects++
      sessions += n
    }
  } catch {
    /* pas de Claude Code ici */
  }
  let repos = 0
  for (const root of PROJECT_ROOTS) {
    try {
      for (const d of fs.readdirSync(root, { withFileTypes: true })) if (d.isDirectory() && fs.existsSync(path.join(root, d.name, '.git'))) repos++
    } catch {
      /* dossier absent */
    }
  }
  historyCache = { at: Date.now(), v: { projects, sessions, repos } }
  return historyCache.v
}

/** Un geste de l'app et l'id (hints.json) qui dit qu'il a été fait. */
const GESTURE_SEEN: Record<string, string> = { 'g-talk': 'voice', 'g-repos': 'repos', 'g-calm': 'calm', 'g-back': 'g-back' }

/** Ce qui est vrai maintenant, étape par étape (sans « first », que l'app signale elle-même). */
export function satisfied(s: SetupState, extra: { seen: Set<string>; h24: H24Activity[]; phone: boolean; install?: Handoff; history: { projects: number; sessions: number; repos: number } }): Partial<Record<TourId, boolean>> {
  const m = s.machine
  return {
    install: !!extra.install,
    machine: true,
    claude: s.claude.logged,
    history: extra.history.projects + extra.history.repos > 0,
    phone: extra.phone || s.phone.push > 0,
    github: s.github.logged,
    // Parler en marchant : la dictée (clé OpenAI) et une voix pour répondre.
    voice: !!s.voice.spoken && s.voice.openai,
    push: s.phone.push > 0,
    h24: extra.h24.some((a) => !a.demo),
    mail: s.mail.on,
    devil: s.devil.plugged,
    night: m.alwaysOn === true || m.othersAlwaysOn,
    codex: s.codex.logged,
    'g-talk': extra.seen.has(GESTURE_SEEN['g-talk']),
    'g-repos': extra.seen.has(GESTURE_SEEN['g-repos']),
    'g-calm': extra.seen.has(GESTURE_SEEN['g-calm']),
    'g-back': extra.seen.has(GESTURE_SEEN['g-back']),
  }
}

/** Les étapes à partir de ce qui est vrai, de ce qui l'était au départ et de ce qui a été passé. Pure (testée). */
export function buildSteps(now: Partial<Record<TourId, boolean>>, p: Pick<Persisted, 'ready' | 'done' | 'skip' | 'played'>, facts: Partial<Record<TourId, TourStep['facts']>>): TourStep[] {
  const out: TourStep[] = []
  for (const id of TOUR_IDS) {
    const ok = id === 'first' ? p.done.includes('first') || p.ready.includes('first') : !!now[id]
    // Ce qui était déjà là au premier lancement (installation notée, historique) : affiché seulement dans ce cas, pour
    // que le total ne bouge pas en route (le premier projet créé n'est pas « de l'historique »).
    if ((id === 'install' || id === 'history') && !p.ready.includes(id)) continue
    let state: TourState
    if (ok) state = p.ready.includes(id) ? 'ready' : 'done'
    else state = p.skip.includes(id) ? 'skip' : 'todo'
    // Une base (machine, Claude…) n'est jamais « passée » : sans elle rien ne marche.
    if (state === 'skip' && groupOf(id) === 'base' && id !== 'phone') state = 'todo'
    out.push({ id, state, ...(p.played.includes(id) && !ok ? { played: true } : {}), ...(facts[id] ? { facts: facts[id] } : {}) })
  }
  return out
}

export class TourKeeper {
  private p: Persisted
  private deps: TourDeps
  private last: Tour | null = null
  private demoTimer: NodeJS.Timeout | null = null

  constructor(deps: TourDeps) {
    this.deps = deps
    const raw = readJson<Partial<Persisted>>(FILE)
    this.p = {
      ready: raw?.ready ?? [],
      done: raw?.done ?? [],
      skip: raw?.skip ?? [],
      played: raw?.played ?? [],
      open: raw?.open ?? true,
      intro: raw?.intro ?? false,
      phone: raw?.phone ?? false,
      at: raw?.at ?? 0,
    }
    // Les démos d'avant un redémarrage : le job de démo ne tourne plus, son journal part.
    fs.rmSync(path.join(LOGS_DIR, `${DEMO_JOB}.log`), { force: true })
    // Tant que la bande est ouverte : une connexion faite ailleurs (terminal, autre appareil) se coche toute seule.
    // Fermée, rien ne tourne : l'état est recalculé à la demande (GET /api/tour, réglages, weevils setup).
    setInterval(() => this.p.open && !this.last?.finished && void this.refresh(), 5000).unref()
  }

  private save() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true })
      fs.writeFileSync(FILE, JSON.stringify(this.p))
    } catch {
      /* disque plein : gardé en mémoire */
    }
  }

  /** Le dernier état calculé (pour le snapshot : jamais de sous-processus ici). */
  current = (): Tour | null => this.last

  /** Recalcule ; au tout premier calcul, ce qui est vrai devient « déjà prêt ». Une brique branchée retire ses démos. */
  async refresh(force = false, init = false): Promise<Tour | null> {
    // Le premier calcul attend un vrai client (GET /api/tour) : au démarrage, le fil de weevboss n'est pas encore lu et
    // une installation existante passerait pour neuve.
    if (!this.p.at && !init) return null
    const s = await this.deps.setup.detect(force)
    const snap = this.deps.snapshot()
    const install = handoff()
    const hist = history()
    const now = satisfied(s, { seen: new Set(this.deps.seen()), h24: snap.h24, phone: this.p.phone, install, history: hist })
    let dirty = false
    if (!this.p.at) {
      this.p.at = Date.now()
      this.p.ready = TOUR_IDS.filter((id) => now[id])
      // Quelqu'un qui parle déjà à weevboss n'est pas un nouveau venu : rien ne s'impose, tout reste dans les réglages.
      if (this.deps.veteran()) {
        this.p.ready.push('first')
        this.p.open = false
        this.p.intro = true
      }
      dirty = true
    }
    for (const id of TOUR_IDS) {
      if (now[id] && this.p.played.includes(id)) {
        // Branchée pour de vrai : la démo s'efface.
        this.p.played = this.p.played.filter((x) => x !== id)
        this.deps.setup.dropDemo(id)
        if (id === 'h24') this.stopDemoJob()
        dirty = true
      }
    }
    const m = s.machine
    const facts: Partial<Record<TourId, TourStep['facts']>> = {
      install: install ? { by: install.by, agent: install.agent, at: install.at } : undefined,
      machine: { kind: m.kind, os: m.os, cpus: m.cpus, ram: Math.round(m.ramGb), provider: m.provider ?? '', always: m.alwaysOn === true, host: m.host },
      claude: s.claude.logged ? { plan: claudePlan() } : { installed: s.claude.installed },
      history: { projects: hist.projects, sessions: hist.sessions, repos: hist.repos },
      // Joignable seulement depuis cette machine : le téléphone passe d'abord par « me joindre de partout ».
      phone: { reach: s.reach },
      github: s.github.login ? { login: s.github.login } : undefined,
      voice: s.voice.spoken ? { voice: s.voice.spoken } : { tts: !!edgeTts() },
      mail: s.mail.address ? { address: s.mail.address } : undefined,
      devil: s.devil.model ? { model: s.devil.model } : undefined,
      night: { kind: m.kind, others: m.others.length },
    }
    const steps = buildSteps(now, this.p, facts)
    const tour: Tour = {
      steps,
      open: this.p.open,
      intro: this.p.intro,
      finished: steps.every((x) => x.state !== 'todo'),
      ...(install ? { install } : {}),
    }
    if (dirty) this.save()
    if (JSON.stringify(tour) !== JSON.stringify(this.last)) {
      this.last = tour
      this.deps.bump()
    }
    return tour
  }

  /** Les actions de l'app : passer une étape, fermer ou rouvrir la bande, premier écran vu, première demande faite. */
  async act(action: string, id?: TourId, mobile?: boolean): Promise<Tour | null> {
    if (mobile && !this.p.phone) this.p.phone = true
    if (action === 'skip' && id && !this.p.skip.includes(id)) this.p.skip.push(id)
    if (action === 'unskip' && id) this.p.skip = this.p.skip.filter((x) => x !== id)
    if (action === 'done' && id === 'first' && !this.p.done.includes('first')) this.p.done.push('first')
    if (action === 'close') this.p.open = false
    if (action === 'open') {
      this.p.open = true
      // Rouvrir les premiers pas : ce qui avait été passé revient.
      this.p.skip = []
    }
    if (action === 'intro') this.p.intro = true
    this.save()
    return this.refresh(true, true)
  }

  /** Ce que weevboss lit (weevils setup) : où en sont les premiers pas, pour reprendre naturellement. */
  report(): string {
    const t = this.last
    if (!t) return 'first steps: not computed yet'
    const by = (st: TourState) => t.steps.filter((x) => x.state === st).map((x) => x.id).join(', ') || 'none'
    return [
      `first steps (tour): ${t.open ? 'band shown' : 'band closed'} · ${t.finished ? 'finished' : 'in progress'} · reopen with \`weevils tour open\``,
      `  already there: ${by('ready')} · done since: ${by('done')} · left: ${by('todo')} · skipped: ${by('skip')}`,
      `  demos played (not plugged yet): ${this.p.played.join(', ') || 'none'}`,
      t.install ? `  installed by: ${t.install.by}${t.install.agent ? ` (${t.install.agent})` : ''}, ${Math.round((Date.now() - t.install.at) / 60_000)} min ago` : '',
    ]
      .filter(Boolean)
      .join('\n')
  }

  // ---------------------------------------------------------------- démos

  private played(id: TourId) {
    if (!this.p.played.includes(id)) this.p.played.push(id)
    this.save()
  }

  /** Joue la démo d'un usage. Renvoie ce que l'app doit jouer elle-même (la voix). */
  async demo(id: TourId): Promise<{ text?: string; audio?: string }> {
    const t = tr(M)
    const snap = this.deps.snapshot()
    this.played(id)
    const summary = this.summary(snap)
    if (id === 'voice') {
      const text = t.voiceDemo(summary)
      // La vraie voix du serveur quand elle est là ; sinon celle du navigateur (l'app s'en charge).
      const audio = edgeTts() ? await tts(text, lang()).then((b) => b.toString('base64')).catch(() => undefined) : undefined
      void this.refresh()
      return { text, ...(audio ? { audio } : {}) }
    }
    if (id === 'mail') {
      this.deps.setup.demoSay('orchestrator', t.mailDemoAsk, 'mail', 'chatgpt')
      setTimeout(() => this.deps.setup.demoSay('assistant', t.mailDemoReply(summary), 'mail'), 1600)
    }
    if (id === 'devil') {
      this.deps.setup.demoSay('assistant', t.devilDemo, 'devil', undefined, true)
    }
    if (id === 'h24') this.startDemoJob()
    void this.refresh()
    return {}
  }

  /** Une phrase vraie sur ce qui se passe : sessions qui travaillent, qui attendent, projets. */
  private summary(snap: Snapshot): string {
    const t = tr(M)
    const live = snap.sessions.filter((x) => x.status !== 'done')
    const working = live.filter((x) => x.status === 'working').length
    const waiting = live.filter((x) => x.status === 'needs_user').length
    const names = snap.projects.slice(0, 3).map((p) => p.name)
    return t.summary(working, waiting, snap.projects.length, names, history().sessions)
  }

  /** Un vrai job local de 90 s, visible dans le 24/7 : il passe sur chaque repo et dit ce qui a bougé. */
  private startDemoJob() {
    this.stopDemoJob()
    const t = tr(M)
    const log = path.join(LOGS_DIR, `${DEMO_JOB}.log`)
    try {
      fs.mkdirSync(LOGS_DIR, { recursive: true })
      fs.writeFileSync(log, `${t.jobStart}\n`)
    } catch {
      return
    }
    this.deps.refreshH24()
    const repos: string[] = []
    for (const root of PROJECT_ROOTS) {
      try {
        for (const d of fs.readdirSync(root, { withFileTypes: true })) if (d.isDirectory() && fs.existsSync(path.join(root, d.name, '.git'))) repos.push(path.join(root, d.name))
      } catch {
        /* dossier absent */
      }
    }
    const started = Date.now()
    const changed = new Set<string>()
    let i = 0
    const tick = () => {
      if (Date.now() - started > 90_000) {
        fs.appendFileSync(log, `${t.jobEnd(repos.length, changed.size, [...changed].slice(0, 2))}\n`)
        this.deps.refreshH24()
        this.demoTimer = setTimeout(() => this.stopDemoJob(), 45_000)
        return
      }
      const repo = repos.length ? repos[i++ % repos.length] : ''
      if (!repo) {
        fs.appendFileSync(log, `${t.jobTick(i++)}\n`)
        this.demoTimer = setTimeout(tick, 6000)
        return
      }
      execFile('git', ['-C', repo, 'status', '--porcelain'], { timeout: 4000 }, (err, out) => {
        const n = err ? -1 : String(out).split('\n').filter(Boolean).length
        if (n > 0) changed.add(path.basename(repo))
        try {
          fs.appendFileSync(log, `${t.jobRepo(path.basename(repo), n)}\n`)
        } catch {
          /* journal parti */
        }
        this.deps.refreshH24()
        this.demoTimer = setTimeout(tick, 6000)
      })
    }
    this.demoTimer = setTimeout(tick, 1500)
  }

  private stopDemoJob() {
    if (this.demoTimer) clearTimeout(this.demoTimer)
    this.demoTimer = null
    fs.rmSync(path.join(LOGS_DIR, `${DEMO_JOB}.log`), { force: true })
    this.deps.refreshH24()
  }

  /** L'app ouverte sur un téléphone : l'étape du téléphone est faite. */
  seenFrom(mobile: boolean) {
    if (!mobile || this.p.phone) return
    this.p.phone = true
    this.save()
    void this.refresh()
  }
}

/** Le job de démo, reconnu par son nom (core.ts le marque demo dans le 24/7). */
export const isDemoJob = (name: string) => name === DEMO_JOB
