import { collectionReaders } from './page-collections.ts'
import { markdownFileRoutes } from './markdown-files.ts'
import { proposeThinkLayout } from './think-ai.ts'
import { ThinkStore } from './think.ts'
import { previewTarget } from './preview-target.ts'
import { Outbox, OutboxError } from './outbox.ts'
import { executeOutbox, outboxRoute } from './outbox-http.ts'
import { bossDoor } from './boss-door.ts'
import OM from './i18n/outbox.ts'
import { rawEngineeringNotice } from '../shared/feed-text.ts'
import FY from './i18n/foryou.ts'
// weevilsd : API + flux temps réel pour l'app, et récepteur local des hooks Claude Code.
// Lancer : node server/index.ts (Node 22, TypeScript natif).

import { execFile, spawn } from 'node:child_process'
import { keepAwake } from './platform.ts'
import { claimSetup } from './get-claim.ts'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { CLAUDE_DIR, CODEX_DIR, CONFIG_DIR, CONFIG_FILE, DATA_DIR, DIST_DIR, HOME, HOOK_PORT, HOST, INBOX_DIR, KILL_AFTER_MS, MACHINE, ORCHESTRATOR, ORCH_DIR, PORT, PROJECTS_DIR, PROJECT_ROOTS, PUBLIC_URL } from './config.ts'
import { openaiKey, transcribe } from './transcribe.ts'
import { addChunk, clip, cue, finishUpload, logMarks, newShortcutToken, shortcutAuthed, shortcutToken, speakStream, voiceTurn } from './voicepipe.ts'
import { cartesia, cartesiaVoices, claudeAvailable, haiku, ledger, relay as modelRelay } from './fast.ts'
import { CostOptimizer, RUN_EVERY_MS as COST_EVERY_MS } from './cost.ts'
import CostM from './i18n/cost.ts'
import { Weevils, isTestBrief } from './core.ts'
import { lang, requestLang, withLang, setLang, tr, withInstallLang, user, installationLang } from './i18n.ts'
import M from './i18n/api.ts'
import PM from './i18n/pages.ts'
import P from './i18n/push.ts'
import V from './i18n/voice.ts'
import S from './i18n/setup.ts'
import { LoadSampler, tipRoutes } from './tips.ts'
import { Hints, hintRoutes } from './hints.ts'
import { softwareRoutes, softwareCatalog } from './softwares.ts'
import { browserSafe, configureLocalAuth, isLocal, localTokenProblem, parseLocalToken, trustedFrom, trustedSource } from './http.ts'
import { startMailBridge } from './mailbridge.ts'
import { resetAuthors, threadAuthor } from './authors.ts'
import { explain, grepRepo, readExplain } from './explain.ts'
import { brief, detail as infraDetail, listDir, readAny, startInfra } from './infra.ts'
import { jailedAllowed, jailedPeer, ownPeer, sameUserPeer } from './jail-peer.ts'
import { loginLimiter } from './login-limit.ts'
import { startDiskUsage } from './disk-usage.ts'
import { anchorFor, entries as spendEntries, logCalibration, summarize } from './spend.ts'
import { claudeQuota, claudeWindows, quotas, rate as tokenRate, today as usageToday } from './usage.ts'
import { Relay, defaultDeps } from './relay.ts'
import { ClaudeAccounts, accountsOn, defaultRoot, setAccounts } from './claude-accounts.ts'
import { ProviderHealth } from './provider-health.ts'
import { providerStatus, setProviderRoute } from './provider.ts'
import type { InfraDetail, MachineBrief, MachineFacts, Reach, TokenRate, UsageToday } from '../shared/infra.ts'
import { facts } from './discover.ts'
import { Setup, installPlan, shellEnv, which, writeConfig } from './setup.ts'
import { isBrick, isSecretName, isSetupKey, type Device } from '../shared/setup.ts'
import { Memory, memoryRoutes } from './memory.ts'
import { ledgerRoutes } from './boss-ledger-http.ts'
import { weevilRoutes } from './weevil.ts'
import { Optimizers, optimizerRoutes } from './optimizers.ts'
import { Sleep } from './sleep.ts'
import { ForYou, foryouRoutes, type MachineState } from './foryou.ts'
import { ForYouNumbers } from './foryou-numbers.ts'
import { serveAttachment } from './attachments.ts'
import { MediaShelf } from './foryou-media.ts'
import { Curator } from './foryou-curator.ts'
import { Voices, voiceParam } from './foryou-voice.ts'
import { geminiKey, liveUpgrade, sameOrigin } from './live.ts'
import { changedPieces, KEY_RE as PAGE_KEY_RE, PageRefused, Pages } from './pages.ts'
import { pageLink } from '../shared/pages.ts'
import type { MachineLoad } from '../shared/tips.ts'
import { Bring, realGit } from './bring.ts'

const w = new Weevils()
const sourceAuthor = (id: string) => threadAuthor(id, source => w.store.get(source), w.bossConversation(), ORCH_DIR)
// Bring your conversations (server/bring.ts): another computer's Claude Code and Codex conversations, resumed here.
const bring = new Bring({
  home: HOME, projectsDir: PROJECTS_DIR, roots: PROJECT_ROOTS, claudeDir: CLAUDE_DIR, codexDir: CODEX_DIR,
  codexHome: path.dirname(CODEX_DIR), dataDir: DATA_DIR, git: realGit, remotes: () => w.remotes, bump: () => w.bump(),
})
w.store.broughtAt = bring.broughtAt
w.start()
startInfra()
startDiskUsage()
// Pont e-mail (agents externes) : sur la machine de l'orchestrateur, seulement si WEEVILS_MAIL_ADDRESS / _PASSWORD sont remplis.
let mailBridge = ORCHESTRATOR ? startMailBridge(w, DATA_DIR) : null
const restartMail = () => {
  mailBridge?.stop()
  mailBridge = ORCHESTRATOR ? startMailBridge(w, DATA_DIR) : null
  mailSeen = mailKeys()
}
// Le pont et les auteurs suivent le fichier de config à chaud : un mot de passe ou un auteur saisi (dans l'app, par
// « weevils config set » ou à la main) les met en route sans redémarrer weevils.
const MAIL_KEY = /^\s*(WEEVILS_(?:MAIL|AUTHOR)_[A-Z0-9_]*)\s*=\s*(.*?)\s*$/
const mailKeys = () => JSON.stringify(Object.entries(process.env).filter(([k]) => /^WEEVILS_(MAIL|AUTHOR)_/.test(k)).sort())
let mailSeen = mailKeys()
let mailFileKeys = new Set<string>()
const readMailKeys = () => {
  const fresh = new Map<string, string>()
  try {
    for (const line of fs.readFileSync(CONFIG_FILE, 'utf8').split('\n')) {
      const m = MAIL_KEY.exec(line)
      if (m) fresh.set(m[1], m[2].replace(/^["']|["']$/g, ''))
    }
  } catch {
    return
  }
  for (const k of mailFileKeys) if (!fresh.has(k)) delete process.env[k]
  for (const [k, v] of fresh) process.env[k] = v
  mailFileKeys = new Set(fresh.keys())
}
readMailKeys()
mailSeen = mailKeys()
fs.watchFile(CONFIG_FILE, { interval: 3000 }, () => {
  readMailKeys()
  if (mailKeys() === mailSeen) return
  resetAuthors()
  console.log('[mail]', 'config changée : pont relu')
  restartMail()
})

// ---------------------------------------------------------------- secret partagé (ce soir) → passkey (demain)

fs.mkdirSync(CONFIG_DIR, { recursive: true })
fs.mkdirSync(DATA_DIR, { recursive: true })
const SECRET_FILE = path.join(CONFIG_DIR, 'secret')
if (!fs.existsSync(SECRET_FILE)) fs.writeFileSync(SECRET_FILE, crypto.randomBytes(9).toString('base64url'), { mode: 0o600 })
const SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim()
// The machine's local token: what weevils-cli, weevils-update and the main machine of a federation send
// (LOCAL_TOKEN_HEADER) to be trusted without the access code. A 0600 file in DATA_DIR, which an automation's jail
// does not see; server/install.sh may have written it first (same format, one header line).
const LOCAL_TOKEN_FILE = path.join(DATA_DIR, 'local-token')
try {
  fs.writeFileSync(LOCAL_TOKEN_FILE, `X-Weevils-Local: ${crypto.randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' })
} catch {
  /* already there */
}
fs.chmodSync(LOCAL_TOKEN_FILE, 0o600)
const LOCAL_TOKEN = parseLocalToken(fs.readFileSync(LOCAL_TOKEN_FILE, 'utf8'))
if (!LOCAL_TOKEN) throw new Error(`${LOCAL_TOKEN_FILE}: unreadable local token, delete it and restart weevilsd`) // i18n-ignore: startup error in the service log
configureLocalAuth({ token: LOCAL_TOKEN, jailed: (socket) => jailedPeer(socket) })
/** Saisie tolérante : majuscules, espaces et caractères qui se confondent (0/O, 1/l/I) ne font pas échouer. */
const foldCode = (c: string) => c.replace(/\s+/g, '').toLowerCase().replace(/o/g, '0').replace(/[il]/g, '1')
const sameCode = (a: string, b: string) => {
  const x = crypto.createHash('sha256').update(foldCode(a)).digest()
  const y = crypto.createHash('sha256').update(foldCode(b)).digest()
  return crypto.timingSafeEqual(x, y)
}
const TOKENS_FILE = path.join(DATA_DIR, 'tokens.json')
let tokens = new Set<string>()
try {
  tokens = new Set(JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')))
} catch {
  /* aucun appareil connecté */
}
const saveTokens = () => fs.writeFileSync(TOKENS_FILE, JSON.stringify([...tokens]), { mode: 0o600 })

// ---------------------------------------------------------------- accueil et branchements (server/setup.ts)

const hints = new Hints(DATA_DIR)
const setup = new Setup({
  bump: () => w.bump(),
  feed: () => ({ machines: w.snapshot().machines, projects: w.snapshot().projects.length }),
  remoteFacts: async () => (await Promise.all(w.remotes.filter((r) => r.online).map((r) => r.call<MachineFacts>('GET', '/api/infra/facts').catch(() => null)))).filter((f): f is MachineFacts => !!f),
  devices: () => tokens.size,
  push: () => w.push.count,
  shortcut: () => !!shortcutToken(),
  seen: () => hints.get().seen,
  hasHistory: () => w.snapshot().main.some((m) => m.role === 'user'),
  startMail: restartMail,
  handoff: (text, brief) => w.sendMain(text, brief),
  memory: () => w.memory,
  // Turn mode: the memory sits in every turn's view; the thread only hears when it changed.
  bossId: () => (w.bossTurns ? 'turns' : w.bossConversation()),
})
w.setup = setup

// ---------------------------------------------------------------- mémoire, auto (machine principale)

const memory = new Memory()
memory.onChange(() => w.bump())
const optimizers = new Optimizers(w, memory)
// L'optimiseur de coûts (server/cost.ts) : une automatisation intégrée de la page auto, toutes les 30 min, sans modèle.
const cost = new CostOptimizer({
  snapshot: () => w.snapshot(),
  fileOf: (id) => w.store.get(id)?.file,
  bossId: () => w.bossConversation(),
  command: (id, cmd) => w.command(id, cmd),
  commandMain: (cmd) => w.commandMain(cmd),
  key: (id, key) => w.key(id, key),
  autoTasks: () => optimizers.list(),
  ledger: () => ledger.days(7),
  post: (item) => foryou?.add(item),
})
if (ORCHESTRATOR) {
  w.memory = memory
  w.optimizers = optimizers
  // weevils' own checkout (the recursive signature) when the server runs from one inside the project roots.
  const self = path.basename(path.resolve(import.meta.dirname, '..'))
  const selfRepo = (() => { try { return w.workstreamForRepo(self) ? self : null } catch { return null } })()
  optimizers.registerBuiltin('cost', (now) => cost.run(now), { title: tr(CostM).title, why: tr(CostM).seedWhy, every: COST_EVERY_MS, repo: selfRepo })
  optimizers.start()
}

// ---------------------------------------------------------------- « pour toi » (machine principale, server/foryou.ts)

/** Niveau et disque de chaque machine, pour les alertes du flux : demandés en arrière-plan, jamais sur le chemin d'une requête. */
const machineStates = async (): Promise<MachineState[]> => {
  const here = brief()
  const disk = await fs.promises.statfs(DATA_DIR).then((d) => (d.blocks ? Math.round((1 - d.bavail / d.blocks) * 100) : undefined)).catch(() => undefined)
  const far = await Promise.all(
    w.remotes.filter((r) => r.online).map(async (r): Promise<MachineState | null> => {
      const m = await r.call<{ machines: MachineBrief[] }>('GET', '/api/infra/brief?local=1').then((d) => d.machines[0]).catch(() => null)
      return m ? { id: r.snap?.machines[0]?.id ?? r.id, name: r.snap?.machines[0]?.name ?? r.id, level: m.level } : null
    }),
  )
  return [{ id: here.id, name: here.name, level: here.level, disk }, ...far.filter((m): m is MachineState => !!m)]
}
// La charge de cette machine telle que GET /api/tips la lit (tips-state.json, écrit chaque minute), relue de temps en temps.
let tipLoad: { at: number; loads: MachineLoad[] } = { at: 0, loads: [] }
// La voix de chacun dans le flux : weevboss garde celle de l'app, chaque auteur extérieur a la sienne (server/foryou-voice.ts).
const voices = new Voices({ bossVoice: () => w.voiceId ?? cartesia()?.voice })
const mediaShelf = new MediaShelf({ file: path.join(DATA_DIR, 'foryou-media.json'), roots: [...PROJECT_ROOTS, INBOX_DIR, DATA_DIR] })
const foryou = ORCHESTRATOR
  ? new ForYou(w, {
      softwares: () => softwareCatalog(w),
      numbers: new ForYouNumbers({ ledgerFile: path.join(DATA_DIR, 'boss', 'ledger.json'), roots: PROJECT_ROOTS, fr: () => installationLang() === 'fr' }),
      shelf: mediaShelf,
      isTestBrief,
      optimizers: () => ({ accept: (id) => optimizers.accept(id) === true, refuse: (id) => optimizers.refuse(id) }),
      tips: (snap, now) => {
        if (now - tipLoad.at > 5 * 60_000) tipLoad = { at: now, loads: [new LoadSampler().local()] }
        return { snap, now, loads: tipLoad.loads, dictation: !!openaiKey(), reapMs: KILL_AFTER_MS }
      },
      quotas,
      machines: machineStates,
      mail: () => mailBridge,
      voiceOf: (who) => voices.of(who),
      op: (op) => cost.op(op),
      // Each session result card's title, from its whole closing message (subscription haiku, ~2 s).
      title: (prompt) => (claudeAvailable() ? haiku(prompt, 45_000) : Promise.resolve('')),
      // The user's own words: context for the stream, never handed back as weevils' idea.
      said: () => memory.list().map((m) => m.text),
    })
  : null
w.foryou = foryou
// ---------------------------------------------------------------- mode sommeil (server/sleep.ts, machine principale)
const sleep = new Sleep(path.join(DATA_DIR, 'sleep.json'))
if (ORCHESTRATOR) {
  w.sleep = sleep
  optimizers.sleep = sleep
  // Asleep: only real blockers reach the phone.
  w.push.asleep = () => sleep.on
  sleep.onChange((on, night, now) => {
    // Stops the runs that end on wake before the recap reads them.
    optimizers.sleepChanged(on, now)
    if (!on && night) foryou?.addRecap(night, optimizers.recapAutos())
    w.bump()
  })
}
// Ce qui est écrit ou compté dans le flux (point de weevboss, idées, « tu savais que », jalons, barres du jour) : une
// seule boucle, sur son propre minuteur, jamais sur le chemin d'une requête (server/foryou-curator.ts).
if (foryou) {
  const curator = new Curator(foryou, {
    deployment: () => {
      try { return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../dist/build.json'), 'utf8')) } catch { return null }
    },
    memory: () => w.memory,
    repoDir: (repo) => w.repoDir(repo),
    advice: async () => (await infraDetail()).advice,
  })
  foryou.curator = curator
  curator.start()
  // Recent result cards stored before titles existed (or whose title failed): titled once, in the background.
  setTimeout(() => foryou.titleRecentResults(), 15_000).unref?.()
  // And a card left untitled later (a title call that failed, a rewrite at the wrong moment) heals without a restart.
  setInterval(() => foryou.titleRecentResults(2), 10 * 60_000).unref?.()
}
// ---------------------------------------------------------------- relais Codex pendant la limite de Claude (chaque machine, pour ses sessions)

let codexSeen = { at: 0, ok: false }
const codexReady = () => {
  if (Date.now() - codexSeen.at > 30_000) codexSeen = { at: Date.now(), ok: !!which('codex') && fs.existsSync(path.join(path.dirname(CODEX_DIR), 'auth.json')) }
  return codexSeen.ok
}
// Several Claude accounts of the user's own (off unless WEEVILS_CLAUDE_ACCOUNTS=1): tried before the Codex relay.
const claudeAccounts = new ClaudeAccounts({
  root: defaultRoot(HOME), claudeHome: path.join(HOME, '.claude'), claudeJson: path.join(HOME, '.claude.json'),
  mainQuota: claudeQuota, windows: claudeWindows, bin: () => which('claude') ?? 'claude', env: () => shellEnv(),
})
setAccounts(claudeAccounts)
const health = new ProviderHealth(path.join(DATA_DIR, 'provider-health.json'), async () => ({ ...(await quotas()), claude: await claudeAccounts.quota() }), tool => {
  const s = providerStatus(tool)
  return s.installed && s.logged
})
const relay = new Relay(w.relayHost(), { ...defaultDeps(() => claudeAccounts.quota(), codexReady), health, ...(accountsOn() ? { accounts: claudeAccounts } : {}) })
w.relay = relay
setProviderRoute(tool => relay.executionTool(tool))
relay.start()

const asDevice = (d: any): Device => ({
  os: ['ios', 'android', 'mac', 'windows', 'linux'].includes(d?.os) ? d.os : 'other',
  mobile: !!d?.mobile,
  standalone: !!d?.standalone,
})
/** Le lien de connexion (avec le code), pour le QR de l'accueil : l'adresse publique, sinon celle par laquelle l'app est ouverte. */
const loginLink = (req: http.IncomingMessage) => {
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? `127.0.0.1:${PORT}`)
  const proto = String(req.headers['x-forwarded-proto'] ?? 'http')
  return `${(PUBLIC_URL || `${proto}://${host}`).replace(/\/$/, '')}/#k=${SECRET}`
}

const logins = loginLimiter()
const cookieToken = (req: http.IncomingMessage) => /(?:^|;\s*)wv=([\w-]+)/.exec(req.headers.cookie ?? '')?.[1]
/** The cookie names a browser signed in with the access code (or claimed by a real browser on this machine). */
const hasDevice = (req: http.IncomingMessage) => {
  const t = cookieToken(req)
  return !!t && tokens.has(t)
}
const authed = (req: http.IncomingMessage) => isLocal(req) || hasDevice(req)
/** A new device token, as the cookie of this browser. */
const issueDevice = (req: http.IncomingMessage, res: http.ServerResponse) => {
  const t = crypto.randomBytes(24).toString('base64url')
  tokens.add(t)
  saveTokens()
  // Secure seulement derrière HTTPS (Caddy envoie x-forwarded-proto) : sinon le navigateur jetterait le cookie en http simple.
  const secure = req.headers['x-forwarded-proto'] === 'https' ? ' Secure;' : ''
  res.setHeader('set-cookie', `wv=${t}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=31536000`)
}

// Who may speak as the user into weevboss's thread: a signed-in browser, never a script on this machine (server/boss-door.ts).
const door = bossDoor({ hasDevice, isBossTarget: (id) => w.isBossTarget(id), sourceAuthor, refusal: () => tr(M).bossUserOnly })

// ---------------------------------------------------------------- utilitaires

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

const readBody = (req: http.IncomingMessage, limit = 1 << 20) =>
  new Promise<any>((resolve, reject) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > limit) {
        reject(new Error(tr(M).bodyTooLarge))
        req.destroy()
      }
    })
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch {
        reject(new Error(tr(M).badJson))
      }
    })
    req.on('error', reject)
  })

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.wasm': 'application/wasm',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
}

function serveStatic(res: http.ServerResponse, pathname: string) {
  let file = path.join(DIST_DIR, pathname === '/' ? 'index.html' : pathname)
  if (!file.startsWith(DIST_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST_DIR, 'index.html')
  if (!fs.existsSync(file)) return json(res, 503, { error: tr(M).notBuilt })
  const ext = path.extname(file)
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  // The app's page carries this installation's language, for the devices that have picked none.
  if (file === path.join(DIST_DIR, 'index.html')) return void res.end(withInstallLang(fs.readFileSync(file, 'utf8')))
  fs.createReadStream(file).pipe(res)
}

// ---------------------------------------------------------------- pages statiques des repos (navigateur intégré)

// Une petite appli faite par un agent (index.html, chemins relatifs) s'ouvre dans l'app sans domaine de preview :
// /api/site/<clé>/<repo>/… sert les fichiers du repo (dist/ s'il n'y a pas d'index.html à la racine). La clé (dérivée du
// code d'accès, donnée dans le snapshot) remplace le cookie, que le document isolé ne porte pas. La page est servie en
// bac à sable (CSP sandbox, sans allow-same-origin) : son JavaScript n'a pas l'origine de weevils et ne peut pas piloter
// l'API, même si le repo vient d'ailleurs. Jamais de fichier caché (.git, .env…).
const SITE_KEY = crypto.createHmac('sha256', SECRET).update('weevils-site').digest('base64url').slice(0, 22)
w.siteKey = SITE_KEY
const SITE_RE = /^\/api\/site\/([\w-]{22})\/([\w.@+-]+)(\/.*)?$/

// Living-link pages (server/pages.ts, docs/LINKS.md): /p/<kind>/<slug> for the signed-in, keyed files for the sandbox.
const pages = new Pages({ dataDir: DATA_DIR, secret: SECRET, roots: [...PROJECT_ROOTS, INBOX_DIR] })
pages.collections = collectionReaders({ ledger: () => w.ledger, automations: () => optimizers.recapAutos(), repositories: () => w.allRepos().filter((name) => { try { return fs.existsSync(path.join(w.repoDir(name), '.git')) } catch { return false } }), sessions: () => w.snapshot().sessions })
for (const source of ['requests', 'automations', 'repositories'] as const) {
  try { pages.publishCollection(source, tr(PM)[source]) } catch (e) { console.error('[pages]', source, e) }
}
/** The address of a page, as a link to paste: the public one, else the one this request came by. */
const pageUrl = (req: http.IncomingMessage, p: string) => {
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? `127.0.0.1:${PORT}`)
  const proto = String(req.headers['x-forwarded-proto'] ?? 'http')
  return `${(PUBLIC_URL || `${proto}://${host}`).replace(/\/$/, '')}${p}`
}

function serveSite(res: http.ServerResponse, key: string, repo: string, rest: string | undefined) {
  const a = Buffer.from(key)
  const b = Buffer.from(SITE_KEY)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return json(res, 404, { error: tr(M).unknownRoute })
  let dir: string
  try {
    dir = w.repoDir(repo)
  } catch (e) {
    return json(res, 404, { error: (e as Error).message })
  }
  if (rest === undefined) {
    res.writeHead(302, { location: `/api/site/${key}/${repo}/` })
    return res.end()
  }
  let rel: string
  try {
    rel = decodeURIComponent(rest)
  } catch {
    return json(res, 400, { error: tr(M).unknownRoute })
  }
  if (rel.split('/').some((seg) => seg.startsWith('.'))) return json(res, 404, { error: tr(M).unknownRoute })
  if (rel === '/' && !fs.existsSync(path.join(dir, 'index.html')) && fs.existsSync(path.join(dir, 'dist', 'index.html'))) {
    res.writeHead(302, { location: `/api/site/${key}/${repo}/dist/` })
    return res.end()
  }
  let file = path.resolve(dir, `.${rel}`)
  if (file !== dir && !file.startsWith(dir + path.sep)) return json(res, 404, { error: tr(M).unknownRoute })
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html')
  if (!fs.existsSync(file)) return json(res, 404, { error: tr(M).unknownRoute })
  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
    'content-security-policy': 'sandbox allow-scripts allow-forms allow-popups allow-modals',
    'x-content-type-options': 'nosniff',
  })
  fs.createReadStream(file).pipe(res)
}

// ---------------------------------------------------------------- flux temps réel

const sseClients = new Set<http.ServerResponse>()
w.onChange(() => {
  const data = `event: version\ndata: ${w.version}\n\n`
  for (const res of sseClients) res.write(data)
})
setInterval(() => {
  for (const res of sseClients) res.write(': ping\n\n')
}, 25_000)

// ---------------------------------------------------------------- API

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL, params: string[]) => Promise<void> | void

const think = new ThinkStore(path.join(DATA_DIR, 'think.json'))
let thinkLayoutBusy = false
const routes: [string, RegExp, Handler][] = [
  ['POST', /^\/api\/think\/organise$/, async (req,res) => {
    const body=await readBody(req); const board=think.read();
    if(thinkLayoutBusy)return json(res,429,{error:'think_layout_busy'});
    if(body.revision!==board.revision)return json(res,409,{error:'think_conflict'});
    thinkLayoutBusy=true;
    try { json(res,200,await proposeThinkLayout(board,body,relay.autoOnCodex()?modelRelay:undefined)) } catch { json(res,503,{error:'think_layout_unavailable'}) } finally { thinkLayoutBusy=false }
  }],
  ['GET', /^\/api\/think$/, (_req,res) => json(res,200,think.read())],
  ['PUT', /^\/api\/think$/, async (req,res) => {
    const body=await readBody(req,48 << 20);
    try { const saved=think.write(body);json(res,saved?200:409,saved ?? {error:'think_conflict'}) }
    catch { json(res,400,{error:'think_invalid'}) }
  }],
  ['GET', /^\/api\/pages$/, (_req, res) => json(res, 200, { pages: pages.list() })],
  // weevils page (weevils-cli): a session or an automation on this machine publishes; never the phone.
  ['POST', /^\/api\/pages$/, async (req, res) => {
    if (!isLocal(req)) return json(res, 403, { error: tr(PM).localOnly })
    const b = await readBody(req)
    const from = trustedFrom(req, b) ?? undefined
    const at = (p: unknown) => path.resolve(typeof b.cwd === 'string' ? b.cwd : process.cwd(), String(p ?? ''))
    try {
      const page = b.build === 'machine' ? pages.publishMachine(from)
        : b.build === 'list' ? pages.publishList({ source: at(b.path), title: b.title, kind: b.kind, from, slug: b.slug })
        : b.build === 'library' ? pages.publishLibrary({ roots: (Array.isArray(b.roots) ? b.roots : [b.path]).map(at), title: b.title, from, slug: b.slug })
        : pages.publish({ path: at(b.path), title: b.title, kind: b.kind, from, slug: b.slug })
      json(res, 200, { slug: page.slug, kind: page.kind, title: page.title, path: page.path, url: pageUrl(req, page.path) })
    } catch (e) {
      json(res, e instanceof PageRefused ? 400 : 500, { error: (e as Error).message })
    }
  }],
  ['DELETE', /^\/api\/pages\/([a-z0-9-]{1,80})$/, (req, res, _url, [slug]) => {
    if (!isLocal(req)) return json(res, 403, { error: tr(PM).localOnly })
    const ok = pages.remove(slug)
    json(res, ok ? 200 : 404, ok ? { ok: true } : { error: tr(PM).gone })
  }],
  ['GET', /^\/api\/preview\/target$/, (_req,res,url) => {
    const snapshot = w.snapshot()
    json(res,200,previewTarget(snapshot.projects,snapshot.sessions,{projectId:url.searchParams.get('projectId') ?? '',repo:url.searchParams.get('repo') || undefined,sessionId:url.searchParams.get('sessionId') || undefined}))
  }],
  ['POST', /^\/api\/login$/, async (req, res) => {
    const body = await readBody(req)
    const who = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim()
    if (!logins.allowed(who)) {
      await new Promise((r) => setTimeout(r, 800))
      return json(res, 429, { error: tr(M).wrongCode })
    }
    if (typeof body.secret !== 'string' || !sameCode(body.secret, SECRET)) {
      logins.failed(who)
      await new Promise((r) => setTimeout(r, 800))
      return json(res, 401, { error: tr(M).wrongCode })
    }
    issueDevice(req, res)
    claimSetup()
    json(res, 200, { ok: true })
  }],
  // A real browser on this machine opened the app without the login link: it becomes a device, so the user can write
  // to weevboss from it. Never a script (no browser user agent) nor an automated browser (navigator.webdriver, headless).
  ['POST', /^\/api\/login\/local$/, async (req, res) => {
    // A browser has no local token: the loopback and browser checks, and a process of this very user (never another
    // account's, never an automation's jail).
    if (!door.localClaimAllowed(req) || jailedPeer(req.socket) || !(await ownPeer(req.socket))) return json(res, 403, { error: tr(M).bossUserOnly })
    if (!hasDevice(req)) issueDevice(req, res)
    json(res, 200, { ok: true })
  }],
  // localClaim: a browser on this machine without a device may claim one (POST /api/login/local decides).
  ['GET', /^\/api\/me$/, (req, res) => json(res, 200, { authed: authed(req), device: hasDevice(req), ...(!hasDevice(req) && door.localClaimAllowed(req) ? { localClaim: true } : {}) })],
  ['POST', /^\/api\/logout$/, (req, res) => {
    const t = cookieToken(req)
    if (t) {
      tokens.delete(t)
      saveTokens()
    }
    res.setHeader('set-cookie', 'wv=; Path=/; Max-Age=0')
    json(res, 200, { ok: true })
  }],
  ['POST', /^\/api\/prefs$/, async (req, res) => {
    const body = await readBody(req)
    // Les autres machines suivent : leurs erreurs et leurs écrans remontent dans l'app. Relayé quand l'app parle
    // (passe par le proxy) ou quand la langue change : deux machines qui se lisent l'une l'autre ne se renvoient
    // pas la requête sans fin (le relais arrive en local et ne change plus rien).
    // chosen : langue choisie dans les réglages de l'app, la seule qui change celle de l'installation (jamais celle
    // d'un navigateur : un weevils installé en anglais reste en anglais ouvert sur un téléphone en français).
    const chosen = body.chosen === true
    const changed = setLang(body.lang, chosen)
    if (changed || !isLocal(req)) for (const r of w.remotes) if (r.online) void r.call('POST', '/api/prefs', { lang: body.lang, chosen }).catch(() => undefined)
    json(res, 200, { ok: true })
  }],
  // Updates by itself (server/weevils-update, every 20 to 30 minutes when nothing is working): on unless turned off here.
  ['POST', /^\/api\/updates$/, async (req, res) => {
    const b = await readBody(req)
    writeConfig({ WEEVILS_AUTO_UPDATE: b?.on === false ? '0' : '1' })
    w.bump()
    json(res, 200, { on: process.env.WEEVILS_AUTO_UPDATE !== '0' })
  }],
  // Sleep mode: { on, since, last } ; POST { on: boolean }.
  ['GET', /^\/api\/sleep$/, (_req, res) => (w.sleep ? json(res, 200, w.sleep.state()) : json(res, 404, { error: 'sleep_unavailable' }))],
  ['POST', /^\/api\/sleep$/, async (req, res) => {
    const b = await readBody(req).catch(() => ({}))
    if (typeof b?.on !== 'boolean') return json(res, 400, { error: 'sleep_on_boolean' })
    if (!w.sleep) return json(res, 404, { error: 'sleep_unavailable' })
    json(res, 200, w.sleep.set(b.on))
  }],
  ['GET', /^\/api\/snapshot$/, (_req, res) => json(res, 200, w.snapshot())],
  ['GET', /^\/api\/events$/, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' })
    res.write(`event: version\ndata: ${w.version}\n\n`)
    sseClients.add(res)
    _req.on('close', () => sseClients.delete(res))
  }],
  ['GET', /^\/api\/sessions\/([^/]+)$/, async (_req, res, _u, [id]) => {
    const d = await w.detailAny(decodeURIComponent(id))
    d ? json(res, 200, d) : json(res, 404, { error: tr(M).sessionNotFound })
  }],
  ['GET', /^\/api\/sessions\/([^/]+)\/subagents\/([^/]+)$/, async (_req, res, _u, [id, subId]) => {
    const d = await w.subagentAny(decodeURIComponent(id), decodeURIComponent(subId))
    d ? json(res, 200, d) : json(res, 404, { error: tr(M).subagentNotFound })
  }],
  ['GET', /^\/api\/sessions\/([^/]+)\/screen$/, async (_req, res, _u, [id]) => json(res, 200, { screen: await w.screen(decodeURIComponent(id)) })],
  ['POST', /^\/api\/sessions\/([^/]+)\/send$/, async (req, res, u, [id]) => {
    const body = await readBody(req)
    door.guard(req, u.pathname, body)
    // « from » (weevils, ou un auteur déclaré) n'est accepté que d'une requête locale (l'orchestrateur, la commande weevils), jamais du téléphone.
    json(res, 200, await w.send(decodeURIComponent(id), String(body.text ?? ''), trustedFrom(req, body, sourceAuthor), trustedSource(req,body,sourceAuthor)))
  }],
  ['POST', /^\/api\/sessions\/([^/]+)\/attach$/, async (req, res, u, [id]) => {
    const body = await readBody(req, 24 << 20)
    door.guard(req, u.pathname, body)
    const files = Array.isArray(body.files) ? body.files.filter((f: any) => typeof f?.data === 'string').map((f: any) => ({ name: String(f.name ?? 'photo'), type: String(f.type ?? 'image/jpeg'), data: String(f.data) })) : []
    json(res, 200, await w.attach(decodeURIComponent(id), String(body.text ?? ''), files))
  }],
  ['GET', /^\/api\/voices$/, async (_req, res) => json(res, 200, cartesia() ? { enabled: true, voices: await cartesiaVoices(), current: w.voiceId } : { enabled: false, voices: [] })],
  ['POST', /^\/api\/voices$/, async (req, res) => {
    w.setVoice(String((await readBody(req)).id ?? '') || undefined)
    json(res, 200, { ok: true })
  }],
  ['POST', /^\/api\/devil$/, async (req, res) => json(res, 200, await w.devil(String((await readBody(req)).text ?? '')))],
  // ---- Accueil et branchements : weevboss guide dans son fil (server/setup.ts, src/ui/setup.tsx).
  ['GET', /^\/api\/setup$/, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end((await setup.report()) + '\n')
  }],
  ['GET', /^\/api\/setup\/install$/, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end(installPlan(await setup.detect(true)) + '\n')
  }],
  ['POST', /^\/api\/setup\/welcome$/, async (req, res) => {
    const mid = await setup.welcome(asDevice((await readBody(req)).device))
    json(res, 200, { ok: true, ...(mid ? { mid } : {}) })
  }],
  ['POST', /^\/api\/setup\/provider$/, async (req, res) => {
    const b = await readBody(req)
    if (b.tool !== 'claude' && b.tool !== 'codex') return json(res, 400, { error: tr(S).badBrick })
    const flow = await setup.chooseProvider(b.tool, b.device ? asDevice(b.device) : undefined)
    json(res, 200, { ok: true, flow, said: setup.lastSaid ?? undefined, open: setup.takeOpen() })
  }],
  ['POST', /^\/api\/setup\/ask$/, async (req, res) => {
    const b = await readBody(req)
    if (!isBrick(b.brick)) return json(res, 400, { error: tr(S).badBrick })
    const again = b.again === true && (b.brick === 'claude' || b.brick === 'codex')
    const flow = await setup.ask(b.brick, b.device ? asDevice(b.device) : undefined, again)
    json(res, 200, { ok: true, flow, said: setup.lastSaid ?? undefined, open: setup.takeOpen() })
  }],
  ['POST', /^\/api\/setup\/apply$/, async (req, res) => {
    const b = await readBody(req, 64 << 10)
    if (!isBrick(b.brick) || typeof b.values !== 'object' || !b.values) return json(res, 400, { error: tr(S).badBrick })
    await setup.apply(b.brick, Object.fromEntries(Object.entries(b.values as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '')])))
    json(res, 200, { ok: true, said: setup.lastSaid ?? undefined })
  }],
  // Un secret demandé par un agent : la valeur ne fait que passer (jamais renvoyée, jamais journalisée).
  ['POST', /^\/api\/setup\/key$/, async (req, res) => {
    const b = await readBody(req, 16 << 10)
    if (!isSecretName(b.name) || typeof b.value !== 'string') return json(res, 400, { error: tr(S).badKey })
    setup.saveKey(b.name, b.value)
    json(res, 200, { ok: true })
  }],
  ['POST', /^\/api\/setup\/done$/, async (req, res) => {
    const b = await readBody(req)
    if (!isBrick(b.brick)) return json(res, 400, { error: tr(S).badBrick })
    setup.done(b.brick)
    json(res, 200, { ok: true })
  }],
  ['POST', /^\/api\/setup\/mark$/, async (req, res) => {
    const id = String((await readBody(req)).id ?? '')
    if (!/^[a-z][a-zA-Z0-9:-]{0,40}$/.test(id)) return json(res, 400, { error: tr(S).badBrick })
    setup.mark(id)
    json(res, 200, { ok: true })
  }],
  // « weevils config set » : seulement depuis la machine (weevboss), seulement les clés prévues.
  ['POST', /^\/api\/setup\/config$/, async (req, res) => {
    const b = await readBody(req)
    if (!isLocal(req)) return json(res, 403, { error: tr(S).localOnly })
    if (!isSetupKey(b.key)) return json(res, 400, { error: tr(S).badKey })
    writeConfig({ [b.key]: String(b.value ?? '') })
    w.bump()
    json(res, 200, { ok: true })
  }],
  ['GET', /^\/api\/setup\/qr\.svg$/, async (req, res) => {
    const svg = await new Promise<string>((resolve) => {
      const p = spawn(which('qrencode') ?? 'qrencode', ['-t', 'SVG', '-m', '1', '-o', '-', loginLink(req)], { stdio: ['ignore', 'pipe', 'ignore'] })
      let out = ''
      p.stdout.on('data', (c) => (out += c))
      p.on('error', () => resolve(''))
      p.on('close', (code) => resolve(code === 0 ? out : ''))
    })
    if (!svg) return json(res, 404, { error: tr(S).noQr })
    res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' })
    res.end(svg)
  }],
  ['GET', /^\/api\/setup\/link$/, async (req, res) => json(res, 200, { link: loginLink(req) })],
  // ---- Voix rapide : son en flux, accroches en cache, enregistrement envoyé en morceaux, mesures.
  ['GET', /^\/api\/speak\/stream$/, async (_req, res, url) => {
    const text = url.searchParams.get('text') ?? ''
    if (rawEngineeringNotice('', text)) return json(res, 400, { error: tr(FY).technicalPost })
    return speakStream(res, text, url.searchParams.get('oral') === '1', voiceParam(url.searchParams.get('voice')))
  }],
  ['GET', /^\/api\/voice\/cue$/, async (_req, res) => {
    const mp3 = await cue(w.voiceId, w.speakerLang())
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': mp3.length, 'cache-control': 'no-store' })
    res.end(mp3)
  }],
  ['POST', /^\/api\/voice\/chunk$/, async (req, res) => {
    const b = await readBody(req, 8 << 20)
    addChunk(String(b.id), Number(b.seq), String(b.type ?? 'audio/mp4'), String(b.data ?? ''))
    json(res, 200, { ok: true })
  }],
  ['POST', /^\/api\/voice\/finish$/, async (req, res) => {
    const b = await readBody(req)
    json(res, 200, { text: await finishUpload(String(b.id), b.lang, b.expectedChunks) })
  }],
  ['POST', /^\/api\/voice\/marks$/, async (req, res) => {
    logMarks((await readBody(req)) as Record<string, number>)
    json(res, 200, { ok: true })
  }],
  // ---- Siri / bouton Action : jeton personnel, un tour de parole complet avec le vrai weevboss.
  ['GET', /^\/api\/voice\/shortcut$/, (_req, res) => json(res, 200, { token: shortcutToken(), url: process.env.WEEVILS_SHORTCUT_URL ?? '' })],
  ['POST', /^\/api\/voice\/shortcut$/, (_req, res) => json(res, 200, { token: newShortcutToken(), url: process.env.WEEVILS_SHORTCUT_URL ?? '' })],
  ['POST', /^\/api\/voice\/turn$/, async (req, res) => json(res, 200, await voiceTurn(w, await readBody(req, 16 << 20)))],
  ['GET', /^\/api\/voice\/clip\/([\w-]+)\.mp3$/, (_req, res, _u, [id]) => {
    const mp3 = clip(id)
    if (!mp3) return json(res, 404, { error: tr(M).clipExpired })
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': mp3.length, 'cache-control': 'no-store' })
    res.end(mp3)
  }],
  ['GET', /^\/api\/transcribe$/, (_req, res) => json(res, 200, { enabled: !!openaiKey() })],
  ['POST', /^\/api\/transcribe$/, async (req, res) => {
    const body = await readBody(req, 24 << 20)
    if (typeof body.data !== 'string' || !body.data) return json(res, 400, { error: tr(V).missingAudio })
    json(res, 200, { text: await transcribe(Buffer.from(body.data, 'base64'), String(body.type ?? 'audio/mp4'), body.lang) })
  }],
  ['POST', /^\/api\/sessions\/([^/]+)\/key$/, async (req, res, _u, [id]) => {
    const body = await readBody(req)
    await w.key(decodeURIComponent(id), String(body.key ?? ''))
    json(res, 200, { ok: true })
  }],
  ['POST', /^\/api\/sessions$/, async (req, res) => {
    const body = await readBody(req)
    const tool = body.tool === 'codex' ? 'codex' : 'claude'
    json(
      res,
      200,
      await w.create({
        projectId: String(body.projectId ?? ''),
        repo: body.repo ? String(body.repo) : undefined,
        tool,
        text: String(body.text ?? ''),
        machineId: body.machineId ? String(body.machineId) : undefined,
        from: trustedFrom(req, body, sourceAuthor),
        sourceThreadId: trustedSource(req,body,sourceAuthor),
      }),
    )
  }],
  ['GET', /^\/api\/boss$/, async (_req, res) => json(res, 200, w.bossStatus())],
  ['GET', /^\/api\/boss\/recall\/([^/]+)$/, async (_req, res, _u, [id]) => {
    const text = w.bossRecall(decodeURIComponent(id))
    json(res, text === null ? 404 : 200, text === null ? { error: tr(M).unknownRoute } : { text })
  }],
  ['POST', /^\/api\/main$/, async (req, res, u) => {
    const body = await readBody(req)
    door.guard(req, u.pathname, body)
    // A signed post (an agent, the weevils command) keeps its author, also when the outbox replays it.
    const { text, origin } = door.text(req, body)
    json(res, 200, await w.sendMain(text, undefined, origin))
  }],
  ['GET', /^\/api\/sessions\/([^/]+)\/model-controls$/, async (_req,res,_u,[id]) => json(res,200,await w.modelControls(decodeURIComponent(id)))],
  ['POST', /^\/api\/sessions\/([^/]+)\/model-controls$/, async (req,res,_u,[id]) => json(res,200,await w.modelControls(decodeURIComponent(id),await readBody(req)))],
  ['GET', /^\/api\/main\/model-controls$/, async (_req,res) => json(res,200,await w.modelControls('__main'))],
  ['POST', /^\/api\/main\/model-controls$/, async (req,res) => json(res,200,await w.modelControls('__main',await readBody(req)))],
  ['POST', /^\/api\/sessions\/([^/]+)\/command$/, async (req, res, _u, [id]) => {
    const body = await readBody(req)
    json(res, 200, await w.command(decodeURIComponent(id), String(body.command ?? '')))
  }],
  ['POST', /^\/api\/main\/command$/, async (req, res) => {
    const body = await readBody(req)
    json(res, 200, await w.commandMain(String(body.command ?? '')))
  }],
  ['GET', /^\/api\/attachments$/, (_req, res, url) => {
    serveAttachment(res, url.searchParams.get('path') ?? '', [INBOX_DIR, path.join(DATA_DIR, 'inbox')])
  }],
  ['POST', /^\/api\/main\/attach$/, async (req, res, u) => {
    const body = await readBody(req, 48 << 20)
    door.guard(req, u.pathname, body)
    const { text, origin } = door.text(req, body)
    const files = Array.isArray(body.files) ? body.files.filter((f: any) => typeof f?.data === 'string').map((f: any) => ({ name: String(f.name ?? ''), type: String(f.type ?? ''), data: String(f.data) })) : []
    json(res, 200, await w.attachMain(text, files, origin))
  }],
  ['POST', /^\/api\/import$/, (req, res) => receiveImport(req, res)],
  ['POST', /^\/api\/bring\/link$/, (_req, res) => json(res, 200, { code: bring.link() })],
  ['GET', /^\/api\/bring$/, async (_req, res) => json(res, 200, await bring.view())],
  ['POST', /^\/api\/bring$/, async (req, res) => {
    const body = await readBody(req)
    json(res, 200, bring.request(String(body.source ?? ''), String(body.key ?? '')))
  }],
  ['GET', /^\/api\/bring\/local$/, (_req, res) => json(res, 200, bring.local())],
  ['GET', /^\/api\/bring\/local\/file$/, (_req, res, url) => bring.sendLocal(url.searchParams.get('key') ?? '', res)],
  ['GET', /^\/api\/push$/, (_req, res) => json(res, 200, { enabled: w.push.enabled, publicKey: w.push.publicKey, devices: w.push.count })],
  ['POST', /^\/api\/push\/subscribe$/, async (req, res) => {
    w.push.subscribe((await readBody(req)) as any)
    json(res, 200, { ok: true, devices: w.push.count })
  }],
  ['POST', /^\/api\/push\/test$/, async (_req, res) => {
    await w.push.send({ title: 'weevboss', body: tr(P).testBody, url: '/', tag: 'test' })
    json(res, 200, { ok: true })
  }],
  ['GET', /^\/api\/conversations$/, (_req, res, url) =>
    json(res, 200, { conversations: w.conversationList({ projectId: url.searchParams.get('project') ?? undefined, q: url.searchParams.get('q') ?? undefined }) })],
  ['GET', /^\/api\/conversations\/([^/]+)$/, (_req, res, _u, [id]) => {
    const d = w.conversationDetail(decodeURIComponent(id))
    d ? json(res, 200, d) : json(res, 404, { error: tr(M).conversationNotFound })
  }],
  ['POST', /^\/api\/conversations\/([^/]+)\/classify$/, async (req, res, _u, [id]) => {
    const body = await readBody(req)
    w.classifyManually(decodeURIComponent(id), { projectId: body.projectId ? String(body.projectId) : undefined })
    json(res, 200, { ok: true })
  }],
  ['POST', /^\/api\/conversations\/([^/]+)\/continue$/, async (req, res, _u, [id]) => {
    const body = await readBody(req)
    json(res, 200, await w.continueConversation(decodeURIComponent(id), body.tool === 'codex' ? 'codex' : 'claude', String(body.text ?? '')))
  }],
  ['POST', /^\/api\/h24\/([^/]+)\/toggle$/, async (_req, res, _u, [id]) => {
    await w.toggleH24(decodeURIComponent(id))
    json(res, 200, { ok: true })
  }],
  ['GET', /^\/api\/repos$/, async (_req, res, url) => {
    const remote = w.remoteById(url.searchParams.get('machine') ?? undefined)
    json(res, 200, remote ? await remote.call('GET', '/api/repos') : { repos: w.allRepos() })
  }],
  ['GET', /^\/api\/repos\/([^/]+)\/files$/, async (_req, res, url, [repo]) => {
    const remote = w.remoteById(url.searchParams.get('machine') ?? undefined)
    json(res, 200, remote ? await remote.call('GET', `/api/repos/${repo}/files`) : { files: await w.files(decodeURIComponent(repo)) })
  }],
  ...markdownFileRoutes(w, json, readBody),
  ['GET', /^\/api\/repos\/([^/]+)\/grep$/, async (_req, res, url, [repo]) => json(res, 200, { hits: await grepRepo(w, decodeURIComponent(repo), url.searchParams.get('q') ?? '') })],
  // Vue d'un fichier : explique, où c'est utilisé, demande (haiku, avec le contexte de la page).
  ['POST', /^\/api\/explain$/, async (req, res) => json(res, 200, await explain(w, readExplain(await readBody(req))))],
  ['GET', /^\/api\/github\/repos$/, async (_req, res, url) => json(res, 200, { repos: await w.githubRepos(url.searchParams.has('fresh')) })],
  ['POST', /^\/api\/github\/repos$/, async (req, res) => {
    const body = await readBody(req)
    json(res, 200, await w.newRepo(String(body.name ?? '').trim(), String(body.description ?? '')))
  }],
  ['POST', /^\/api\/sessions\/([^/]+)\/archive$/, async (req, res, _u, [id]) => {
    const body = await readBody(req)
    json(res, 200, w.archive(decodeURIComponent(id), body.archived !== false))
  }],
  ['POST', /^\/api\/sessions\/([^/]+)\/close$/, async (_req, res, _u, [id]) => json(res, 200, await w.close(decodeURIComponent(id)))],
  // Session coupée en plein travail : la reprendre (--resume + message de reprise) ou la laisser.
  ['POST', /^\/api\/sessions\/([^/]+)\/resume$/, async (_req, res, _u, [id]) => json(res, 200, await w.resume(decodeURIComponent(id)))],
  ['POST', /^\/api\/sessions\/([^/]+)\/dismiss$/, async (_req, res, _u, [id]) => json(res, 200, await w.dismiss(decodeURIComponent(id)))],
  // ---- Relais Codex pendant la limite de Claude (server/relay.ts) : réglage, plan demandé pour une session, décision sur un plan.
  ['POST', /^\/api\/relay$/, async (req, res) => {
    const body = await readBody(req)
    relay.set({ mode: body.mode, switchAt: body.switchAt, tz: body.tz })
    // Les autres machines suivent le réglage (pas le fuseau : relayé seulement quand l'app parle, jamais en boucle).
    if (!isLocal(req) && (body.mode !== undefined || body.switchAt !== undefined)) for (const r of w.remotes) if (r.online) void r.call('POST', '/api/relay', { mode: body.mode, switchAt: body.switchAt }).catch(() => undefined)
    json(res, 200, { ok: true })
  }],
  ['POST', /^\/api\/sessions\/([^/]+)\/relay$/, async (_req, res, _u, [raw]) => {
    const id = decodeURIComponent(raw)
    const remote = w.remoteFor(id)
    json(res, 200, remote ? await remote.call('POST', `/api/sessions/${encodeURIComponent(id)}/relay`, {}) : relay.request(id))
  }],
  ['POST', /^\/api\/relay\/plans\/([^/]+)$/, async (req, res, _u, [raw]) => {
    const id = decodeURIComponent(raw)
    const body = await readBody(req)
    const call = { action: String(body.action ?? ''), text: typeof body.text === 'string' ? body.text : undefined }
    if (id === 'all') {
      // A successful reply means every participating machine accepted its decision.
      // Skip machines with no request; never disguise a real failure as success.
      const pending = (plans: ReturnType<typeof relay.view>['plans']) => plans.some((p) => !p.resolved && (p.state === 'ready' || p.state === 'failed' || p.state === 'preparing'))
      const decisions: Promise<unknown>[] = []
      if (pending(relay.view().plans)) decisions.push(relay.decide('all', call.action, call.text))
      if (!isLocal(req)) for (const r of w.remotes) if (r.online && pending(r.snap?.relay?.plans ?? [])) decisions.push(r.call('POST', '/api/relay/plans/all', call))
      if (!decisions.length) decisions.push(relay.decide('all', call.action, call.text))
      await Promise.all(decisions)
      return json(res, 200, { ok: true })
    }
    const remote = w.remoteFor(id)
    json(res, 200, remote ? await remote.call('POST', `/api/relay/plans/${encodeURIComponent(id)}`, call) : await relay.decide(id, call.action, call.text))
  }],
  // ---- Coin infrastructure : machines, système de fichiers complet, abonnements.
  ['GET', /^\/api\/infra\/brief$/, async (_req, res, url) => {
    const here = brief()
    if (url.searchParams.has('local')) return json(res, 200, { machines: [here] })
    const far = await Promise.all(
      w.remotes.map(async (r): Promise<MachineBrief> => {
        const id = r.snap?.machines[0]?.id ?? r.id
        const name = r.snap?.machines[0]?.name ?? r.id
        const off = { id, name, online: false, cpu: 0, mem: 0, level: 'ok' as const, weevboss: false }
        if (!r.online) return off
        try {
          const m = (await r.call<{ machines: MachineBrief[] }>('GET', '/api/infra/brief?local=1')).machines[0]
          return { ...m, id, name, online: true }
        } catch {
          // Un weevilsd plus ancien, sans /api/infra : en ligne, sans mesures.
          return { ...off, online: true }
        }
      }),
    )
    json(res, 200, { machines: [here, ...far] })
  }],
  ['GET', /^\/api\/infra\/facts$/, async (_req, res) => json(res, 200, await facts())],
  ['GET', /^\/api\/infra$/, async (_req, res, url) => {
    const remote = w.remoteById(url.searchParams.get('machine') ?? undefined)
    if (url.searchParams.has('local') || !remote) {
      const sessions = new Map(w.snapshot().sessions.map((s) => [s.id, s]))
      const d = await infraDetail((id) => sessions.get(id))
      if (url.searchParams.has('local')) return json(res, 200, d)
      return json(res, 200, { ...d, reach: await reachOf(d.facts, MACHINE.id) })
    }
    const d = await remote.call<InfraDetail>('GET', '/api/infra?local=1')
    json(res, 200, { ...d, reach: await reachOf(d.facts, d.id) })
  }],
  ['GET', /^\/api\/fs$/, async (_req, res, url) => {
    const remote = w.remoteById(url.searchParams.get('machine') ?? undefined)
    const p = url.searchParams.get('path') ?? '/'
    json(res, 200, remote ? await remote.call('GET', `/api/fs?path=${encodeURIComponent(p)}`) : listDir(p))
  }],
  ['GET', /^\/api\/fs\/file$/, async (_req, res, url) => {
    const remote = w.remoteById(url.searchParams.get('machine') ?? undefined)
    const p = url.searchParams.get('path') ?? ''
    json(res, 200, remote ? await remote.call('GET', `/api/fs/file?path=${encodeURIComponent(p)}`) : readAny(p))
  }],
  ['GET', /^\/api\/usage$/, async (_req, res) => json(res, 200, await quotas())],
  ['GET', /^\/api\/usage\/rate$/, async (_req, res, url) => {
    const r = tokenRate()
    if (url.searchParams.has('local')) return json(res, 200, r)
    // Les autres machines s'ajoutent tranche par tranche (alignées sur l'heure de fin).
    const far = await Promise.all(w.remotes.filter((x) => x.online).map((x) => x.call<TokenRate>('GET', '/api/usage/rate?local=1').catch(() => null)))
    for (const f of far) {
      if (!f || f.step !== r.step) continue
      if (f.available !== false) r.available = true
      const shift = Math.round((r.end - f.end) / r.step)
      f.buckets.forEach((v, i) => {
        const j = i - shift
        if (j >= 0 && j < r.buckets.length) r.buckets[j] += v
      })
    }
    json(res, 200, r)
  }],
  // Spend estimate (API-price dollars from the transcripts) matched with the real Claude quota: pace and forecast.
  ['GET', /^\/api\/usage\/spend$/, async (_req, res) => {
    const q = (await quotas()).claude
    const es = spendEntries()
    const first = summarize(es, q)
    const s = summarize(es, q, Date.now(), anchorFor(first.week.end) ?? undefined)
    logCalibration(s, es, q)
    json(res, 200, { ...s, week: { ...s.week, bySession: s.week.bySession.slice(0, 10) } })
  }],
  ['GET', /^\/api\/usage\/today$/, async (_req, res, url) => {
    const sessions = new Map(w.snapshot().sessions.map((s) => [s.id, s]))
    const { rows, models } = usageToday((id) => sessions.get(id))
    if (url.searchParams.has('local')) return json(res, 200, { rows, models })
    const far = await Promise.all(w.remotes.filter((r) => r.online).map((r) => r.call<UsageToday>('GET', '/api/usage/today?local=1').catch(() => ({ rows: [] }) as UsageToday)))
    json(res, 200, {
      rows: [...rows, ...far.flatMap((d) => d.rows)].sort((a, b) => b.weight - a.weight),
      models: [...models, ...far.flatMap((d) => d.models ?? [])],
    })
  }],
  // L'optimiseur de coûts : ce qu'il mesure, et l'audit du jour à la demande (publié dans « pour toi »).
  ...(ORCHESTRATOR ? ([
    ['GET', /^\/api\/cost$/, (_req, res) => json(res, 200, { week: cost.week(), internal: ledger.days(7) })],
    ['POST', /^\/api\/cost\/audit$/, async (_req, res) => json(res, 200, await cost.audit())],
    ['POST', /^\/api\/cost\/run$/, async (_req, res) => json(res, 200, await cost.run())],
  ] as [string, RegExp, Handler][]) : []),
  ...tipRoutes(w, json, readBody, () => !!openaiKey()),
  ...hintRoutes(hints, json, readBody),
  // La mémoire vit sur la machine principale seulement (404 ailleurs, comme weevils memory le dit).
  ...(ORCHESTRATOR ? memoryRoutes(memory, json, readBody) : []),
  // weevboss's requests, goals, work trace and knowledge (server/boss-ledger.ts), main machine only.
  ...(w.ledger ? ledgerRoutes(w.ledger, json, readBody, isLocal) : []),
  // The weevil's questions were removed: an old open app only ever hears « nothing » (server/weevil.ts).
  ...weevilRoutes(json),
  // The automation page reads the timers and jobs here too (GET /api/auto/timer:…, job:…).
  ...optimizerRoutes(optimizers, json, readBody, { detail: (id) => w.h24Detail(id), run: (id, at) => w.h24Run(id, at) }),
  // Le flux « pour toi » vit sur la machine principale seulement.
  ...(foryou ? foryouRoutes(foryou, json, readBody) : []),
  // ---- Mes logiciels : détectés sur chaque machine, aperçu vivant, lancés d'un tap (server/softwares.ts).
  ...softwareRoutes(w, json, readBody),
  ['POST', /^\/api\/github\/pin$/, async (req, res) => {
    const body = await readBody(req)
    w.pinRepo(String(body.repo ?? ''), !!body.pinned)
    json(res, 200, { ok: true })
  }],
]

/** Comment les autres machines joignent celle-ci : leurs alias SSH qui pointent vers son IP, son reverse DNS ou son nom. */
async function reachOf(f: MachineFacts, id: string): Promise<Reach[]> {
  const names = new Set([f.ip, f.rdns, f.hostname, id].filter(Boolean).map((x) => x!.toLowerCase()))
  const others: [string, MachineFacts | null][] = [
    ...(id === MACHINE.id ? [] : [[MACHINE.name, await facts()] as [string, MachineFacts]]),
    ...(await Promise.all(
      w.remotes
        .filter((r) => r.online && (r.snap?.machines[0]?.id ?? r.id) !== id)
        .map(async (r) => [r.snap?.machines[0]?.name ?? r.id, await r.call<MachineFacts>('GET', '/api/infra/facts').catch(() => null)] as [string, MachineFacts | null]),
    )),
  ]
  return others.flatMap(([from, o]) => (o?.ssh ?? []).filter((t) => names.has(t.host.toLowerCase()) || names.has(t.alias.toLowerCase())).map((t) => ({ from, alias: t.alias, user: t.user })))
}

const PUBLIC = new Set(['/api/login', '/api/me'])

/** Envoi d'un export (zip ou JSON, jusqu'à 1 Go) : écrit tel quel sur disque, puis importé. */
async function receiveImport(req: http.IncomingMessage, res: http.ServerResponse) {
  const dir = path.join(DATA_DIR, 'uploads')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `export-${Date.now()}`)
  const out = fs.createWriteStream(file)
  let size = 0
  await new Promise<void>((resolve, reject) => {
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > 1 << 30) {
        req.destroy()
        reject(new Error(tr(M).fileTooLarge))
      }
    })
    req.pipe(out)
    out.on('finish', resolve)
    req.on('error', reject)
  })
  try {
    json(res, 200, await w.importFile(file))
  } finally {
    fs.rmSync(file, { force: true })
  }
}

const outbox = new Outbox(path.join(DATA_DIR, 'outbox'), task => executeOutbox(task, routes))
outbox.start()

const server = http.createServer((req, res) => withLang(requestLang(req), async () => {
  const url = new URL(req.url ?? '/', 'http://local')
  try {
    // A page link: signed in, its keyed files; otherwise the app, which signs in and then opens it.
    const page = req.method === 'GET' || req.method === 'HEAD' ? pageLink(url.pathname) : undefined
    if (page) {
      if (!authed(req) || !pages.get(page.slug)) return serveStatic(res, '/')
      res.writeHead(302, { location: `/api/page/${pages.key(page.slug)}/${page.slug}/`, 'cache-control': 'no-store' })
      return void res.end()
    }
    if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname)
    const keyed = PAGE_KEY_RE.exec(url.pathname)
    if (keyed && (req.method === 'GET' || req.method === 'HEAD')) return pages.serve(req, res, keyed[1], keyed[2], keyed[3])
    // A computer bringing its conversations: its one-time code is its key, not the access code (server/bring.ts).
    if (url.pathname.startsWith('/api/bring') && (url.pathname === '/api/bring.sh' || url.pathname.startsWith('/api/bring/pc/')) && (await bring.pcRoute(req, res, url.pathname))) return
    const site = SITE_RE.exec(url.pathname)
    if (site && req.method === 'GET') return serveSite(res, site[1], site[2], site[3])
    // Le Raccourci Siri n'a pas de cookie : son jeton personnel n'ouvre que le tour de parole et le son qui va avec.
    const viaShortcut = /^\/api\/voice\/(turn|clip\/)/.test(url.pathname) && shortcutAuthed(req, url)
    if (!PUBLIC.has(url.pathname) && !viaShortcut && !authed(req)) {
      // From this machine without the local token (an old weevils command, or a program that does not read the user's
      // files): said plainly, with what to do.
      const problem = localTokenProblem(req)
      return json(res, 401, { error: problem === 'missing' ? tr(M).localTokenMissing : problem === 'wrong' ? tr(M).localTokenWrong : tr(M).signInRequired, ...(problem ? { code: `local_token_${problem}` } : {}) })
    }
    // An automation's jail calling on loopback: only its CLI profile's routes (server/jail-peer.ts).
    if (!hasDevice(req) && isLocal(req) && jailedPeer(req.socket) && !jailedAllowed(req.method, url.pathname)) return json(res, 403, { error: tr(M).signInRequired })
    if (!door.tapAllowed(req, req.method, url.pathname) || !door.voiceAllowed(req, url.pathname, viaShortcut)) return json(res, 403, { error: tr(M).bossUserOnly })
    if (req.method === 'GET' && url.pathname === '/api/outbox/capabilities') return json(res, 200, { enabled: true, version: 1 })
    const receipt = /^\/api\/outbox\/([a-zA-Z0-9_-]{16,120})$/.exec(url.pathname)
    if (req.method === 'GET' && receipt) {
      const found = outbox.get(receipt[1])
      return json(res, found ? 200 : 404, found ?? { error: tr(OM).missing })
    }
    if (req.method === 'POST' && outboxRoute(url.pathname) && req.headers['idempotency-key']) {
      const key = req.headers['idempotency-key']
      if (typeof key !== 'string') throw new OutboxError(400, tr(OM).invalid)
      const body = await readBody(req, /\/attach$/.test(url.pathname) ? 48 << 20 : 1 << 20)
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new OutboxError(400, tr(OM).invalid)
      if (!/\/act$/.test(url.pathname) && !String(body.text ?? '').trim() && !(Array.isArray(body.files) && body.files.length)) throw new OutboxError(400, tr(OM).invalid)
      door.guard(req, url.pathname, body) // checked here, on the request itself: the replay is this machine's
      const from = trustedFrom(req, body, sourceAuthor)
      const source = trustedSource(req,body,sourceAuthor)
      delete body.from
      delete body.sourceThread // Persist only source identity validated on the original request.
      if (from) body.from = from
      if (source) body.sourceThread = source
      const session = /^\/api\/sessions\/([^/]+)\//.exec(url.pathname)
      const id = session ? decodeURIComponent(session[1]) : url.pathname.startsWith('/api/main') ? w.bossConversation() ?? undefined : undefined
      const lane = id ?? (url.pathname.startsWith('/api/main') ? 'main' : url.pathname)
      return json(res, 202, outbox.accept(key, { url: url.pathname + url.search, body, lane, locale: lang() }, id))
    }
    for (const [method, re, handler] of routes) {
      const m = re.exec(url.pathname)
      if (m && req.method === method) return await handler(req, res, url, m.slice(1))
    }
    json(res, 404, { error: tr(M).unknownRoute })
  } catch (e) {
    json(res, e instanceof OutboxError ? e.status : 400, { error: (e as Error).message })
  }
}))

// Live voice mode (server/live.ts): the phone's websocket, proxied to Gemini Live. The key stays here.
const live = liveUpgrade({
  key: geminiKey,
  enabled: () => ORCHESTRATOR,
  sendMain: (text) => w.sendMain(text, undefined, 'live'),
  waitMainReply: (since, ms) => w.waitMainReply(since, ms),
  recent: () => w.recentMain(8),
  user,
})
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://local')
  // Live voice speaks as the user: a signed-in browser only, never a script on this machine (2026-11-14: a test played
  // recorded questions into it). A test copy opens it with WEEVILS_ALLOW_LOCAL_VOICE=1.
  if (url.pathname !== '/api/live' || !door.liveAllowed(req, authed(req)) || !sameOrigin(req)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    return
  }
  live(req, socket, head, requestLang(req))
})

server.listen(PORT, HOST, () => console.log(`weevilsd → http://${HOST}:${PORT}`))
// A Mac goes to sleep on its own: awake while weevilsd runs and the Mac is plugged in (WEEVILS_KEEP_AWAKE=0: no).
keepAwake()


// ---------------------------------------------------------------- « How weevils works » (server/pages.ts, docs/LINKS.md)
// An explainer, not a dashboard: the only live part is which pieces main touched in the last day, read from the
// git log of weevils' own checkout. Every install gets its own page at /p/report/how-weevils-works.
const SELF_DIR = path.resolve(import.meta.dirname, '..')
let touched: { at: number; changed: Record<string, number> } = { at: 0, changed: {} }
pages.live = {
  state: () => new Promise((resolve) => {
    if (Date.now() - touched.at < 60_000) return resolve({ changed: touched.changed })
    execFile('git', ['-C', SELF_DIR, 'log', '--since=1 day ago', '--no-merges', '--name-only', '--format=%x1e%ct'], { timeout: 5000, maxBuffer: 4 << 20 }, (err, out) => {
      const log = err ? [] : String(out).split('\x1e').filter((c) => c.trim()).map((c) => {
        const [ct, ...files] = c.split('\n').map((l) => l.trim()).filter(Boolean)
        return { at: Number(ct) * 1000, files }
      })
      touched = { at: Date.now(), changed: changedPieces(log) }
      resolve({ changed: touched.changed })
    })
  }),
}
try { pages.publishMachine() } catch (e) { console.error('[pages] machine', e) }

// Hooks Claude Code : port séparé, local uniquement. Une page web ouverte sur cette machine (Origin étrangère, DNS
// rebinding) ne peut pas y forger d'événements, ni un autre compte de la machine (server/jail-peer.ts sameUserPeer).
http
  .createServer(async (req, res) => {
    if (!browserSafe(req) || !sameUserPeer(req.socket)) return void res.writeHead(403).end()
    try {
      const body = await readBody(req, 256 << 10)
      w.hook(body, req.headers['x-pid'] as string | undefined)
      console.log(`[hook] ${body?.hook_event_name ?? '?'} ${String(body?.session_id ?? '').slice(0, 8)}`)
      res.writeHead(200).end('ok')
    } catch {
      res.writeHead(400).end()
    }
  })
  .listen(HOOK_PORT, '127.0.0.1', () => console.log(`hooks → http://127.0.0.1:${HOOK_PORT}`))

process.on('uncaughtException', (e) => console.error('[weevilsd]', e))
process.on('unhandledRejection', (e) => console.error('[weevilsd]', e))
