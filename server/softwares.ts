// Page « mes logiciels » : tout ce que l'utilisateur construit ou fait tourner sur cette machine, détecté sans rien saisir.
// Repos des racines de projets (regroupés par famille et par origine git), services systemd --user écrits par lui,
// conteneurs Docker, sites Caddy publiés, ports à l'écoute, journaux de LOGS_DIR. Pour chacun : un aperçu vivant (capture
// de l'interface, ou vraies dernières lignes de sortie), l'avancement estimé à partir des vrais signaux, et un tap qui le
// lance (serveur sur le port du projet, 127.0.0.1, publié avec expose) ou montre son état.
// Rien ne tourne avant la première ouverture de la page : une installation neuve ne paie rien.

import { execFile, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import type http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { Phase, Progress, ProgressFix, RunState, Software, SoftwareKind, SoftwareList, TailSource } from '../shared/softwares.ts'
import type { ServerProc } from '../shared/infra.ts'
import { DATA_DIR, EXPOSE_DOMAIN, EXPOSE_SITES_DIR, HOME, HOOK_PORT, LOGS_DIRS, MACHINE, PORT, PROJECT_ROOTS, PUBLIC_URL } from './config.ts'
import type { Weevils } from './core.ts'
import { haiku } from './fast.ts'
import { loadBlurbs } from './github.ts'
import { lang, tr, user } from './i18n.ts'
import { servers } from './infra.ts'
import { familyOf } from './projects.ts'
import type { Remote } from './remotes.ts'
import M from './i18n/softwares.ts'

const DIR = path.join(DATA_DIR, 'softwares')
const SHOTS = path.join(DIR, 'shots')
const RUNS = path.join(DIR, 'runs')
const MIN = 60_000

// ================================================================ parties pures (testées dans softwares.test.ts)

/** Codes ANSI (couleurs, curseur, titres OSC) retirés. */
export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g, '')

/** Ce qui ressemble à un secret dans une ligne de journal, masqué : clés d'API connues, jetons Bearer, paramètres et
 *  variables au nom sensible (token, secret, password, key, uuid, code…), liens d'appairage (sgnl://, otpauth://). */
export function redact(line: string): string {
  return line
    .replace(/\b(sgnl|otpauth|tg|wc):\/\/\S+/gi, '$1://•••')
    .replace(/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 •••')
    .replace(/\b(sk|pk|rk)-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abposr]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g, '•••')
    .replace(/([?&;\s"']|^)([\w-]*(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|auth|session|cookie|uuid|pub_key|code|sig(?:nature)?)[\w-]*)(\s*[=:]\s*["']?)([^\s&"',;]{4,})/gi, '$1$2$3•••')
}

/** Les vraies dernières lignes d'une sortie : sans ANSI, sans retours chariot de barres de progression, secrets masqués,
 *  40 au plus, ~160 caractères. */
export function tailLines(text: string, max = 40): string[] {
  return stripAnsi(text)
    .split(/\r?\n/)
    .map((l) => (l.split('\r').filter((x) => x.trim()).pop() ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trimEnd())
    .filter((l) => l.trim())
    .slice(-max)
    .map(redact)
    .map((l) => (l.length > 160 ? `${l.slice(0, 159)}…` : l))
}

/** https://github.com/example-owner/mygame.git, git@github.com:example-owner/mygame → github.com/example-owner/mygame. */
export function normOrigin(url?: string): string | undefined {
  const s = url?.trim().replace(/\/+$/, '').replace(/\.git$/, '')
  if (!s) return undefined
  const m = /^(?:[a-z][\w+.-]*:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/](.+)$/i.exec(s)
  return (m ? `${m[1]}/${m[2]}` : s).toLowerCase()
}

export interface RepoFacts {
  name: string
  dir: string
  origin?: string
  branch?: string
  defaultBranch?: string
  lastCommitAt: number
  git: boolean
}

export interface RepoGroup {
  /** Clé stable du logiciel : la famille pour le groupe principal, sinon le nom du checkout principal. */
  key: string
  name: string
  main: RepoFacts
  repos: RepoFacts[]
}

const onDefault = (r: RepoFacts) => !!r.branch && (r.defaultBranch ? r.branch === r.defaultBranch : r.branch === 'main' || r.branch === 'master')

/** Checkout principal : celui qui porte le nom de la famille (avec git de préférence), sinon celui de l'origine, sinon une
 *  copie git qui porte l'origine, sur la branche par défaut, la plus récente. Une copie sans origine ne devient jamais la
 *  principale à cause d'un commit récent quand une autre porte l'origine du logiciel. */
export function mainOf(rs: RepoFacts[]): RepoFacts {
  const fam = (r: RepoFacts) => r.name.toLowerCase() === familyOf(r.name)
  const byFamily = rs.find((r) => fam(r) && r.git) ?? (rs.some((r) => r.git) ? undefined : rs.find(fam))
  if (byFamily) return byFamily
  const byOrigin = rs.find((r) => r.origin && r.name.toLowerCase() === r.origin.split('/').pop())
  if (byOrigin) return byOrigin
  return [...rs].sort(
    (a, b) =>
      Number(b.git) - Number(a.git) || Number(!!b.origin) - Number(!!a.origin) || Number(onDefault(b)) - Number(onDefault(a)) || b.lastCommitAt - a.lastCommitAt || a.name.length - b.name.length || a.name.localeCompare(b.name),
  )[0]
}

/**
 * Repos → logiciels. Même famille (shop-api, shop-web → shop) et même origine : un seul logiciel (variantes, worktrees).
 * Un repo de la famille dont l'origine diffère de l'origine dominante en est séparé (weevils-content ≠ weevils). Les
 * copies sans origine rejoignent l'origine dominante de leur famille.
 */
export function groupRepos(list: RepoFacts[]): RepoGroup[] {
  const fams = new Map<string, RepoFacts[]>()
  for (const r of list) fams.set(familyOf(r.name), [...(fams.get(familyOf(r.name)) ?? []), r])
  const dominant = new Map<string, string | undefined>()
  for (const [f, rs] of fams) {
    const own = rs.find((r) => r.name.toLowerCase() === f && r.origin)
    if (own) {
      dominant.set(f, own.origin)
      continue
    }
    const count = new Map<string, { n: number; last: number }>()
    for (const r of rs) {
      if (!r.origin) continue
      const c = count.get(r.origin) ?? { n: 0, last: 0 }
      c.n++
      c.last = Math.max(c.last, r.lastCommitAt)
      count.set(r.origin, c)
    }
    // Le nombre de copies, puis l'ordre des origines : jamais la date du dernier commit (la clé du logiciel en dépend,
    // et avec elle ce qui est retenu à son nom : lancement, port, correction, estimation).
    dominant.set(f, [...count].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))[0]?.[0])
  }
  const groups = new Map<string, RepoFacts[]>()
  for (const r of list) {
    const d = dominant.get(familyOf(r.name))
    const k = r.origin ? `o:${r.origin}` : d ? `o:${d}` : `f:${familyOf(r.name)}`
    groups.set(k, [...(groups.get(k) ?? []), r])
  }
  const out: RepoGroup[] = []
  const used = new Set<string>()
  // Les groupes principaux d'abord : ils prennent le nom de la famille.
  const ordered = [...groups].map(([k, rs]) => ({ k, rs, main: mainOf(rs) }))
  const isDominant = (g: { k: string; main: RepoFacts }) => g.k === `f:${familyOf(g.main.name)}` || g.k === `o:${dominant.get(familyOf(g.main.name))}`
  ordered.sort((a, b) => Number(isDominant(b)) - Number(isDominant(a)))
  for (const g of ordered) {
    const fam = familyOf(g.main.name)
    const dom = isDominant(g)
    let key = dom ? fam : g.main.name.toLowerCase()
    if (used.has(key)) key = g.main.name.toLowerCase()
    for (let i = 2; used.has(key); i++) key = `${g.main.name.toLowerCase()}-${i}`
    used.add(key)
    const rest = g.rs.filter((r) => r !== g.main).sort((a, b) => b.lastCommitAt - a.lastCommitAt || a.name.localeCompare(b.name))
    out.push({ key, name: dom && g.rs.length > 1 ? fam : g.main.name, main: g.main, repos: [g.main, ...rest] })
  }
  return out.sort((a, b) => a.key.localeCompare(b.key))
}

/** Un bloc { … } qui suit `name:` dans une config JS (accolades équilibrées), sinon ''. */
function block(src: string, name: string): string {
  const m = new RegExp(`\\b${name}\\s*:\\s*\\{`).exec(src)
  if (!m) return ''
  let depth = 0
  for (let i = m.index + m[0].length - 1; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(m.index + m[0].length, i)
  }
  return ''
}

export interface PortSources {
  name: string
  vite?: string
  scripts?: Record<string, string>
  env?: string
  /** Le fichier lancé par le script dev / start (process.env.PORT || 5174). */
  code?: string
  /** README, CLAUDE.md, AGENTS.md. */
  docs?: string
}

const okPort = (n?: string) => {
  const p = Number(n)
  return Number.isInteger(p) && p >= 1024 && p <= 65535 ? p : undefined
}

/** Le port que le projet déclare lui-même : config vite, scripts, .env, défaut du code, puis sa doc (près de son nom). */
export function declaredPort(s: PortSources): number | undefined {
  if (s.vite) {
    for (const b of ['server', 'preview']) {
      const p = okPort(/(?:^|[^\w.])port\s*:\s*(\d{2,5})/.exec(block(s.vite, b))?.[1])
      if (p) return p
    }
  }
  for (const k of ['dev', 'start', 'serve', 'preview']) {
    const p = okPort(/(?:--port[= ]|\s-p\s+|\bPORT=)(\d{2,5})\b/.exec(s.scripts?.[k] ?? '')?.[1])
    if (p) return p
  }
  const env = okPort(/^\s*(?:export\s+)?PORT\s*=\s*["']?(\d{2,5})/m.exec(s.env ?? '')?.[1])
  if (env) return env
  const code = portInCode(s.code ?? '')
  if (code) return code.port
  const docs = s.docs ?? ''
  const name = s.name.toLowerCase()
  for (const m of docs.matchAll(/\b(?:port\s*:?\s*|localhost:|127\.0\.0\.1:)(\d{4,5})\b/gi)) {
    const around = docs.slice(Math.max(0, m.index - 160), m.index + 160).toLowerCase()
    if (around.includes(name)) {
      const p = okPort(m[1])
      if (p) return p
    }
  }
  return undefined
}

/** process.env.GESTE_PORT || 7790, os.environ.get("PORT", 8000) : le port par défaut du code et la variable qui le change. */
export function portInCode(code: string): { port: number; env: string } | undefined {
  const js = /\benv\.([A-Z_]*PORT[A-Z_]*)\s*(?:\|\||\?\?)\s*['"]?(\d{2,5})\b/.exec(code)
  const py = /environ\.get\(\s*['"]([A-Z_]*PORT[A-Z_]*)['"]\s*,\s*['"]?(\d{2,5})/.exec(code)
  const m = js ?? py
  const port = okPort(m?.[2])
  return m && port ? { port, env: m[1] } : undefined
}

/**
 * Port stable d'un logiciel qui n'en déclare pas : celui déjà retenu s'il est encore libre, sinon le premier libre à
 * partir de 4174 qui n'écoute pas, n'est pas retenu par un autre logiciel ni pris par weevilsd.
 */
export function allocatePort(key: string, saved: Record<string, number>, busy: Set<number>, start = 4174): number | undefined {
  const claimed = new Set(Object.entries(saved).filter(([k]) => k !== key).map(([, p]) => p))
  const mine = saved[key]
  if (mine && !busy.has(mine) && !claimed.has(mine)) return mine
  for (let p = start; p < 65535; p++) if (!busy.has(p) && !claimed.has(p)) return p
  return undefined
}

export interface KindFacts {
  name: string
  deps: string[]
  scripts: Record<string, string>
  /** package.json bin, scripts de pyproject, exécutable principal. */
  bin: boolean
  /** index.html à la racine ou dans public/, web/, src/, site/, static/. */
  html: boolean
  staticSite: boolean
  url: boolean
  unit: boolean
  container: boolean
  listening: boolean
}

const UI_DEPS = /^(vite|next|nuxt|astro|react-dom|vue|svelte|@sveltejs\/kit|solid-js|preact|@angular\/core|gatsby|@remix-run\/react|phaser|pixi\.js|lit|webpack-dev-server|parcel|react-scripts|expo)$/i
const BOT_DEPS = /^(telegraf|node-telegram-bot-api|grammy|discord\.js|@slack\/bolt|whatsapp-web\.js|@whiskeysockets\/baileys|baileys|python-telegram-bot|aiogram|discord\.py|py-cord|slack[-_]bolt|tmi\.js|botbuilder)$/i
const HTTP_DEPS = /^(express|fastify|koa|hono|@hapi\/hapi|restify|@nestjs\/core|polka|h3|elysia|flask|fastapi|django|starlette|aiohttp|uvicorn|gunicorn|sanic|tornado|bottle|actix-web|axum|rocket|warp|github\.com\/gin-gonic\/gin|github\.com\/labstack\/echo|github\.com\/gofiber\/fiber)$/i

/** web : une interface html ; bot ; api : serveur http sans interface ; service : tourne en permanence ; cli ; lib. */
export function detectKind(f: KindFacts): SoftwareKind {
  const has = (re: RegExp) => f.deps.some((d) => re.test(d))
  if (f.url || f.staticSite || f.html || has(UI_DEPS) || /\b(vite|next|nuxt|astro|webpack|parcel)\b/.test(f.scripts.dev ?? '')) return 'web'
  if (has(BOT_DEPS) || /(^|[-_])bot([-_]|$)/i.test(f.name)) return 'bot'
  if (has(HTTP_DEPS)) return 'api'
  if (f.unit || f.container) return 'service'
  if (f.listening) return 'api'
  if (f.bin) return 'cli'
  return 'lib'
}

export interface CaddySite {
  name: string
  host: string
  /** Amonts proxifiés (localhost:4173, 127.0.0.1:4179, 172.30.99.10:8080). */
  proxies: { host: string; port: number }[]
  root?: string
  log?: string
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0'])
export const isLocalUpstream = (h: string) => LOCAL_HOSTS.has(h.toLowerCase())

/** Un <nom>.caddy (format de la commande expose, et sites écrits à la main) : hôte, amonts, racine statique, journal. */
export function parseCaddySite(file: string, text: string): CaddySite | null {
  const clean = text
    .split('\n')
    .map((l) => l.replace(/(^|\s)#.*$/, ''))
    .join('\n')
  const head = /^\s*([^\s{][^{]*?)\s*\{/m.exec(clean)?.[1]
  if (!head) return null
  const host = head.split(/[\s,]+/)[0].replace(/^https?:\/\//, '')
  const proxies: CaddySite['proxies'] = []
  for (const line of clean.matchAll(/^\s*reverse_proxy\b([^\n{]*)/gm)) {
    for (const tok of line[1].trim().split(/\s+/)) {
      const m = /^(?:https?:\/\/)?(\[[^\]]+\]|[\w.-]+):(\d{1,5})$/.exec(tok)
      if (m) proxies.push({ host: m[1], port: Number(m[2]) })
    }
  }
  const root = /^\s*root\s+(?:\S+\s+)?(\/\S+)\s*$/m.exec(clean)?.[1]
  const log = /\boutput\s+file\s+(\S+)/.exec(clean)?.[1]
  return { name: path.basename(file).replace(/\.caddy$/, ''), host, proxies, ...(root ? { root } : {}), ...(log ? { log } : {}) }
}

const originOf = (u: string) => {
  try {
    return new URL(u).origin
  } catch {
    return ''
  }
}

/**
 * L'interface accepte-t-elle d'être montrée dans un cadre de l'app ? X-Frame-Options DENY / SAMEORIGIN et
 * CSP frame-ancestors ('none', 'self', liste d'origines) comparés à l'origine de l'app (embedder).
 */
export function frameEmbeddable(h: { xfo?: string | null; csp?: string | null }, target: string, embedder?: string): boolean {
  const eo = embedder ? originOf(embedder) : ''
  const same = !!eo && eo === originOf(target)
  const fa = /(?:^|;)\s*frame-ancestors\s+([^;]*)/i.exec(h.csp ?? '')?.[1]?.trim()
  if (fa != null) {
    // frame-ancestors l'emporte sur X-Frame-Options dans les navigateurs actuels.
    const srcs = fa.split(/\s+/).filter(Boolean).map((s) => s.toLowerCase())
    if (srcs.includes("'none'")) return false
    if (srcs.includes('*')) return true
    return srcs.some((s) => {
      if (s === "'self'") return same
      if (!eo) return false
      if (/^[a-z][\w+.-]*:$/.test(s)) return eo.startsWith(s)
      const m = /^(?:([a-z][\w+.-]*):\/\/)?(\*\.)?([^/:]+)(?::(\d+|\*))?/.exec(s)
      if (!m) return false
      const u = new URL(eo)
      if (m[1] && `${m[1]}:` !== u.protocol) return false
      if (m[4] && m[4] !== '*' && m[4] !== (u.port || (u.protocol === 'https:' ? '443' : '80'))) return false
      return m[2] ? u.hostname.endsWith(`.${m[3]}`) : u.hostname === m[3]
    })
  }
  const xfo = (h.xfo ?? '').trim().toLowerCase()
  if (xfo === 'deny') return false
  if (xfo === 'sameorigin') return same
  if (xfo.startsWith('allow-from')) return !!eo && originOf(xfo.slice(10).trim()) === eo
  return true
}

export interface Signals {
  commits: number
  firstAt: number
  lastAt: number
  /** Commits des 14 derniers jours. */
  recent: number
  authors: number
  tests: number
  /** Taille du README (caractères) et s'il explique l'installation ou l'usage. */
  readme: number
  usage: boolean
  todoDone: number
  todoTotal: number
  version: string
  tags: number
  deployed: boolean
  running: boolean
  stars: number
  forks: number
  /** Tickets et PR ouverts par d'autres que le propriétaire. */
  issues: number
  /** Adresses distinctes (hors celles de l'utilisateur) dans le journal d'accès des 7 derniers jours. */
  visitors: number
  /** Mots des échanges avec les sessions : « ça marche », « en prod », clients / utilisateurs, bugs. */
  works: number
  prod: number
  users: number
  bugs: number
}

export const emptySignals = (): Signals => ({
  commits: 0, firstAt: 0, lastAt: 0, recent: 0, authors: 0, tests: 0, readme: 0, usage: false, todoDone: 0, todoTotal: 0,
  version: '', tags: 0, deployed: false, running: false, stars: 0, forks: 0, issues: 0, visitors: 0, works: 0, prod: 0, users: 0, bugs: 0,
})

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(x)))
const major = (v: string) => Number(/^v?(\d+)\./.exec(v)?.[1] ?? 0)

/** Avancement sans modèle, à partir des signaux : immédiat, et repli quand le modèle ne répond pas. */
export function heuristic(s: Signals, now = Date.now()): Progress {
  const t = tr(M)
  const reason = (parts: (string | false | undefined)[]) => {
    let out = ''
    for (const p of parts) if (p && (out + ' · ' + p).length <= 60) out = out ? `${out} · ${p}` : p
    return out
  }
  const traction = s.visitors + s.stars * 3 + s.forks * 2 + s.issues * 3
  if (s.visitors >= 5 || s.stars >= 3 || s.issues >= 2 || s.forks >= 2) {
    return {
      phase: 3,
      percent: clamp(Math.log10(Math.max(traction, 2)) * 33, 5, 100),
      reason: reason([s.visitors >= 5 && t.visitors(s.visitors), s.stars > 0 && t.stars(s.stars), s.issues > 0 && t.issues(s.issues), s.forks > 0 && t.forks(s.forks)]),
      source: 'heuristic',
      at: now,
    }
  }
  // « 1.0.0 » sans étiquette git, c'est la version que npm init écrit d'office : pas une sortie.
  const released = major(s.version) >= 1 && (s.tags > 0 || s.version.replace(/^v/, '') !== '1.0.0')
  const tags = s.tags > 0 || released
  const usable = s.deployed || s.prod > 0 || ((tags || s.works >= 2) && s.commits >= 5)
  if (usable) {
    const pct =
      20 +
      Math.min(25, s.tests * 2) +
      (s.usage ? 10 : 0) +
      Math.min(20, Math.log10(s.commits + 1) * 9) +
      Math.min(10, s.recent) +
      (s.todoTotal ? (s.todoDone / s.todoTotal) * 15 : 0) +
      (released ? 10 : 0) +
      (s.authors > 1 ? 5 : 0) -
      Math.min(10, s.bugs * 2)
    return {
      phase: 2,
      percent: clamp(pct, 5, 95),
      reason: reason([s.deployed && t.online, !s.deployed && s.works >= 2 && t.works, tags && s.version && t.version(s.version), s.commits > 0 && (s.tests ? t.tests(s.tests) : t.noTests), s.commits > 0 && t.commits(s.commits)]),
      source: 'heuristic',
      at: now,
    }
  }
  const pct =
    Math.min(35, Math.log10(s.commits + 1) * 17) +
    (s.readme > 400 ? 10 : 0) +
    (s.usage ? 10 : 0) +
    Math.min(15, s.tests * 3) +
    (s.todoTotal ? (s.todoDone / s.todoTotal) * 20 : 0) +
    (s.running ? 10 : 0) +
    Math.min(5, s.recent)
  return {
    phase: 1,
    percent: clamp(pct, 3, 95),
    reason: reason([s.commits > 0 && t.commits(s.commits), s.commits > 0 && (s.tests ? t.tests(s.tests) : t.noTests), s.todoTotal > 0 && t.todo(s.todoDone, s.todoTotal), s.running && t.running]),
    source: 'heuristic',
    at: now,
  }
}

/** Empreinte des signaux qui comptent (arrondis) : le modèle n'est rappelé que quand elle change. */
export function signalsHash(s: Signals): string {
  const bucket = (n: number) => (n <= 0 ? 0 : n < 5 ? 1 : n < 20 ? 2 : n < 100 ? 3 : n < 1000 ? 4 : 5)
  const compact = [
    Math.round(Math.log2(s.commits + 1) * 2), bucket(s.recent), Math.min(s.tests, 30), Math.round(s.readme / 800), s.usage,
    s.todoTotal ? Math.round((s.todoDone / s.todoTotal) * 10) : -1, s.version, Math.min(s.tags, 5), s.deployed,
    bucket(s.stars), bucket(s.forks), bucket(s.issues), bucket(s.visitors), Math.min(s.works, 3), Math.min(s.prod, 3), Math.min(s.users, 3), Math.min(s.bugs, 3),
  ]
  return crypto.createHash('sha1').update(JSON.stringify(compact)).digest('hex').slice(0, 12)
}

/** Robots et outils : jamais des visiteurs. */
const BOT_UA = /bot|crawl|spider|slurp|curl|wget|python|go-http|headless|monitor|preview|scan|http-client|okhttp|axios|node-fetch|undici|let's encrypt|facebookexternalhit|whatsapp|telegram|discord|slack|skype|embedly|validator/i
/** Chemins que seuls les scanners demandent : une adresse qui en demande un n'est plus comptée du tout. */
const PROBE = /^\/(\.well-known\/acme-challenge|\.env|\.git|wp-|xmlrpc|phpmyadmin|cgi-bin|actuator|vendor\/|boaform|HNAP1|owa\/|autodiscover)|\.(php|asp|aspx|jsp|cgi|env|ini|sql|bak|zip|tar|gz)(\?|$)/i
/** Ce qu'un vrai navigateur charge après la page (une adresse qui ne fait que « GET / » n'est qu'un sondage). */
const ASSET = /\.(js|mjs|css|png|jpe?g|webp|avif|gif|svg|ico|woff2?|ttf|json|webmanifest|mp3|ogg|wav|mp4|webm|wasm|glb|gltf)(\?|$)|^\/api\//i

/** Clé du cache d'estimation : les signaux et la langue (la raison est écrite dans la langue de l'app). */
const estimateHash = (s: Signals) => `${signalsHash(s)}.${lang()}`

/** Lignes d'un journal d'accès Caddy (JSON) : adresses distinctes depuis `since` qui se comportent en vraie personne derrière
 *  un navigateur — agent Mozilla avec une langue, au moins un fichier de la page chargé avec succès, aucun chemin de scanner,
 *  et resté au moins 2 minutes ou revenu un autre jour (robots et aperçus de liens passent en une rafale) — hors adresses exclues. */
export function visitorsIn(text: string, since: number, exclude: Set<string> = new Set()): Set<string> {
  const seen = new Map<string, { asset: boolean; first: number; last: number; days: Set<number> }>()
  const bad = new Set<string>()
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue
    try {
      const j = JSON.parse(line) as { ts?: number; status?: number; request?: { client_ip?: string; remote_ip?: string; uri?: string; headers?: Record<string, string[]> } }
      if (!j.ts || j.ts * 1000 < since) continue
      const ip = j.request?.client_ip || j.request?.remote_ip
      if (!ip || exclude.has(ip) || bad.has(ip)) continue
      const h = j.request?.headers ?? {}
      const ua = h['User-Agent']?.[0] ?? ''
      const uri = j.request?.uri ?? ''
      if (!/^Mozilla\//.test(ua) || BOT_UA.test(ua) || PROBE.test(uri) || !h['Accept-Language']?.[0]) {
        bad.add(ip)
        continue
      }
      const v = seen.get(ip) ?? { asset: false, first: j.ts, last: j.ts, days: new Set<number>() }
      const status = j.status ?? 0
      if (status >= 200 && status < 400 && ASSET.test(uri)) v.asset = true
      v.first = Math.min(v.first, j.ts)
      v.last = Math.max(v.last, j.ts)
      v.days.add(Math.floor(j.ts / 86400))
      seen.set(ip, v)
    } catch {
      /* ligne tronquée */
    }
  }
  const out = new Set<string>()
  for (const [ip, v] of seen) if (!bad.has(ip) && v.asset && (v.last - v.first >= 120 || v.days.size >= 2)) out.add(ip)
  return out
}

/** Mots des échanges avec les sessions qui disent où en est le logiciel. */
export function talkSignals(texts: string[]): { works: number; prod: number; users: number; bugs: number } {
  const n = (re: RegExp) => texts.filter((x) => re.test(x)).length
  return {
    works: n(/(ça|ca) (marche|fonctionne)|\bit works\b|works (now|great|fine)|nickel|parfait\b|\bperfect\b/i),
    prod: n(/\ben prod\b|\bin prod(uction)?\b|mis en ligne|\bdéployé|\bdeployed\b|\bgo live\b/i),
    users: n(/\b(mes|nos|des|premiers?|vrais?) (clients?|utilisateurs?|abonnés|joueurs)\b|\b(my|our|first|real|paying) (customers?|users?|players|clients?)\b|\bpayants?\b|\bventes?\b/i),
    bugs: n(/\bbugs?\b|\bcrash|\bcassé|\bbroken\b|\bplante\b|marche (pas|plus)|doesn'?t work/i),
  }
}

/** Nom DNS sûr : minuscules, [a-z0-9-], 40 caractères. */
export const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'app'

// ================================================================ outils

interface Out {
  ok: boolean
  out: string
  err: string
}

function sh(cmd: string, args: string[], opts: { cwd?: string; timeout?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv } = {}): Promise<Out> {
  return new Promise((resolve) => {
    try {
      const c = execFile(cmd, args, { timeout: opts.timeout ?? 5000, maxBuffer: opts.maxBuffer ?? 8 << 20, cwd: opts.cwd, env: opts.env }, (err, stdout, stderr) =>
        resolve({ ok: !err, out: String(stdout ?? ''), err: String(stderr ?? '') || (err?.message ?? '') }),
      )
      c.stdin?.end()
    } catch (e) {
      resolve({ ok: false, out: '', err: (e as Error).message })
    }
  })
}

const read = (f: string, max = 200_000) => {
  try {
    const fd = fs.openSync(f, 'r')
    try {
      const buf = Buffer.alloc(Math.min(max, fs.fstatSync(fd).size))
      fs.readSync(fd, buf, 0, buf.length, 0)
      return buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return ''
  }
}

/** La fin d'un fichier (les journaux grossissent : seules les dernières lignes comptent). */
function readEnd(f: string, bytes: number): string {
  const fd = fs.openSync(f, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const len = Math.min(bytes, size)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, size - len)
    return buf.toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

const exists = (f: string) => {
  try {
    fs.accessSync(f)
    return true
  } catch {
    return false
  }
}
const mtime = (f: string) => {
  try {
    return fs.statSync(f).mtimeMs
  } catch {
    return 0
  }
}
const inside = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith('/') ? dir : dir + '/')
/** Chemin réel (racines de projets ou dossiers liés par symlink : /proc donne toujours le chemin réel). */
const real = (p: string) => {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}
const expandHome = (p: string) => p.replace(/^~(?=\/|$)/, HOME).replace(/%h/g, HOME)

const pathCache = new Map<string, string | null>()
/** Exécutable du PATH (et ~/.local/bin), null s'il n'y est pas. */
function which(bin: string): string | null {
  if (pathCache.has(bin)) return pathCache.get(bin)!
  let found: string | null = null
  for (const d of [...(process.env.PATH ?? '').split(path.delimiter), path.join(HOME, '.local', 'bin')]) {
    if (!d) continue
    try {
      fs.accessSync(path.join(d, bin), fs.constants.X_OK)
      found = path.join(d, bin)
      break
    } catch {
      /* pas ici */
    }
  }
  pathCache.set(bin, found)
  return found
}

function readJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8')) as T
  } catch {
    return fallback
  }
}
function writeJson(name: string, v: unknown) {
  try {
    fs.mkdirSync(DIR, { recursive: true })
    const f = path.join(DIR, name)
    fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 1))
    fs.renameSync(f + '.tmp', f)
  } catch (e) {
    console.error(`[logiciels] ${name} : ${(e as Error).message}`)
  }
}

/** Le port répond-il en local ? */
/** Tout ce qui écoute en TCP, même ce qui appartient à un autre utilisateur ou à root (docker-proxy) : adresse locale et,
 *  quand ss la donne, le pid. */
export function parseListeners(out: string): { port: number; addr: string; pids: number[] }[] {
  const res: { port: number; addr: string; pids: number[] }[] = []
  for (const line of out.split('\n')) {
    const cols = line.trim().split(/\s+/)
    const local = cols[3]
    const m = local ? /^(.*):(\d+)$/.exec(local) : null
    if (!m) continue
    res.push({ port: Number(m[2]), addr: m[1].replace(/^\[|\]$/g, '').replace(/%.*$/, ''), pids: [...line.matchAll(/pid=(\d+)/g)].map((x) => Number(x[1])) })
  }
  return res
}
const listeners = async () => parseListeners((await sh('ss', ['-ltnpH'], { timeout: 3000 })).out)
/** Écoute sur toutes les interfaces (0.0.0.0, ::, *) : joignable de l'extérieur sans passer par Caddy. */
export const wildcard = (addr: string) => addr === '0.0.0.0' || addr === '::' || addr === '*' || addr === '::0'
/** Groupe de processus d'un pid (/proc/<pid>/stat, 5e champ). */
const pgidOf = (pid: number) => {
  try {
    const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    return Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[2])
  } catch {
    return -1
  }
}
/** Un processus du groupe vit encore (le meneur peut être parti avant ses enfants). */
const groupAlive = (pgid: number) => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    return false
  }
}
/** Arrête un groupe : SIGTERM, puis SIGKILL s'il en reste au bout de 5 s. */
async function killGroup(pgid: number) {
  try {
    process.kill(-pgid, 'SIGTERM')
  } catch {
    return
  }
  for (let i = 0; i < 20 && groupAlive(pgid); i++) await new Promise((r) => setTimeout(r, 250))
  try {
    if (groupAlive(pgid)) process.kill(-pgid, 'SIGKILL')
  } catch {
    /* parti */
  }
}

function listening(port: number, timeout = 600): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' })
    const done = (ok: boolean) => {
      s.destroy()
      resolve(ok)
    }
    s.setTimeout(timeout, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

/** Lance des tâches avec au plus n en parallèle. */
async function pool<T, R>(items: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++
        out[k] = await f(items[k])
      }
    }),
  )
  return out
}

/** Démarrage d'un processus (champ 22 de /proc/<pid>/stat) : distingue un pid réutilisé. */
const startTicks = (pid: number) => {
  const s = read(`/proc/${pid}/stat`, 4096)
  return s ? s.slice(s.lastIndexOf(')') + 2).split(' ')[19] ?? '' : ''
}
const alive = (pid: number, ticks: string) => {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  return !ticks || startTicks(pid) === ticks || !exists('/proc')
}

/** L'environnement d'un logiciel lancé d'un tap : celui de l'utilisateur, sans les secrets ni les réglages de weevilsd. */
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!/^(WEEVILS_|CARTESIA_|DEVIL_|OPENAI_API_KEY$|ANTHROPIC_|NODE_ENV$|PORT$|HOST$|INVOCATION_ID$|JOURNAL_STREAM$)/.test(k)) env[k] = v
  return { ...env, ...extra }
}

// ================================================================ détection

interface Pkg {
  name?: string
  version?: string
  bin?: string | Record<string, string>
  main?: string
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

/** Ce qu'on lit d'un checkout pour le décrire (fichiers seulement, pas d'appel réseau). */
interface Project {
  dir: string
  pkg: Pkg | null
  deps: string[]
  scripts: Record<string, string>
  html: boolean
  bin: { name: string; cmd: string[] } | null
  /** Build statique prêt à servir (dist/, build/, out/ avec index.html). */
  dist?: string
  declared?: number
  portEnv?: string
  pm: 'npm' | 'pnpm' | 'yarn' | 'bun'
  python: boolean
}

const SOFTWARE_FILES = ['package.json', 'pyproject.toml', 'setup.py', 'requirements.txt', 'Cargo.toml', 'go.mod', 'Dockerfile', 'docker-compose.yml', 'compose.yaml', 'index.html', 'main.py', 'deno.json', 'Makefile']

function project(dir: string, name: string): Project {
  let pkg: Pkg | null = null
  try {
    pkg = JSON.parse(read(path.join(dir, 'package.json'))) as Pkg
  } catch {
    /* pas un projet node */
  }
  const scripts = pkg?.scripts ?? {}
  const deps = Object.keys({ ...pkg?.dependencies, ...pkg?.devDependencies })
  const py = read(path.join(dir, 'pyproject.toml'), 60_000) + read(path.join(dir, 'requirements.txt'), 20_000)
  for (const m of py.matchAll(/^\s*["']?([A-Za-z][\w.-]*)\s*(?:[<>=~!;[\]"',]|$)/gm)) deps.push(m[1].toLowerCase())
  const gomod = read(path.join(dir, 'go.mod'), 20_000)
  for (const m of gomod.matchAll(/^\s*(github\.com\/[\w.-]+\/[\w.-]+)/gm)) deps.push(m[1])
  const cargo = read(path.join(dir, 'Cargo.toml'), 20_000)
  for (const m of /\[dependencies\]([\s\S]*?)(?:\n\[|$)/.exec(cargo)?.[1]?.matchAll(/^\s*([\w-]+)\s*=/gm) ?? []) deps.push(m[1])
  const html = ['', 'public', 'web', 'src', 'site', 'static', 'www', 'app'].some((d) => exists(path.join(dir, d, 'index.html')))
  // Commande d'aide d'un outil en ligne de commande (seulement --help, jamais autre chose).
  let bin: Project['bin'] = null
  if (pkg?.bin) {
    const [bname, file] = typeof pkg.bin === 'string' ? [pkg.name ?? name, pkg.bin] : (Object.entries(pkg.bin)[0] ?? [])
    if (bname && file) bin = { name: bname, cmd: /\.(c|m)?js$/.test(file) || /^#!.*\bnode\b/.test(read(path.join(dir, file), 200)) ? [process.execPath, file] : [path.join(dir, file)] }
  }
  if (!bin) {
    const pyScript = /\[project\.scripts\]\s*\n\s*["']?([\w-]+)["']?\s*=/.exec(py)?.[1] ?? /\[tool\.poetry\.scripts\]\s*\n\s*["']?([\w-]+)["']?\s*=/.exec(py)?.[1]
    const exe = pyScript ?? (cargo || gomod ? name : undefined)
    // Seulement un exécutable construit depuis ce dossier : jamais un homonyme trouvé ailleurs dans le PATH.
    const onPath = exe ? which(exe) : null
    const local = exe
      ? [onPath && inside(real(onPath), real(dir)) ? onPath : '', ...['.venv/bin', 'venv/bin', 'bin', ''].map((d) => path.join(dir, d, exe))].find((f) => f && exists(f) && fs.statSync(f).isFile() && (fs.statSync(f).mode & 0o111) !== 0)
      : undefined
    if (exe && local) bin = { name: exe, cmd: [local] }
    else if (cargo) {
      const built = ['release', 'debug'].map((m) => path.join(dir, 'target', m, name)).find(exists)
      if (built) bin = { name, cmd: [built] }
    }
  }
  const dist = ['dist', 'build', 'out'].map((d) => path.join(dir, d)).find((d) => exists(path.join(d, 'index.html')))
  // Le fichier que lance le script dev / start (pour son port par défaut).
  const script = scripts.dev ?? scripts.start ?? scripts.serve ?? ''
  const entry = /\b(?:node|tsx|bun|deno run|ts-node|python3?)\s+(?:--?[\w-]+(?:=\S+)?\s+)*([\w./-]+\.(?:m?[jt]s|cjs|py))\b/.exec(script)?.[1] ?? pkg?.main ?? ['server.mjs', 'server.js', 'server.ts', 'index.js', 'app.py', 'main.py'].find((f) => exists(path.join(dir, f)))
  const code = entry ? read(path.join(dir, entry), 80_000) : ''
  const viteFile = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts'].map((f) => path.join(dir, f)).find(exists)
  const docs = ['README.md', 'CLAUDE.md', 'AGENTS.md'].map((f) => read(path.join(dir, f), 60_000)).join('\n')
  const declared = declaredPort({
    name,
    vite: viteFile ? read(viteFile, 40_000) : undefined,
    scripts,
    env: read(path.join(dir, '.env'), 20_000) + '\n' + read(path.join(dir, '.env.example'), 20_000),
    code,
    docs,
  })
  const pm = exists(path.join(dir, 'pnpm-lock.yaml')) && which('pnpm') ? 'pnpm' : exists(path.join(dir, 'yarn.lock')) && which('yarn') ? 'yarn' : (exists(path.join(dir, 'bun.lockb')) || exists(path.join(dir, 'bun.lock'))) && which('bun') ? 'bun' : 'npm'
  return { dir, pkg, deps, scripts, html, bin, dist, declared, portEnv: portInCode(code)?.env, pm, python: !!py }
}

/** Faits git d'un dossier (rien si ce n'est pas un repo). */
async function gitFacts(name: string, dir: string): Promise<RepoFacts> {
  const git = (...a: string[]) => sh('git', ['-C', dir, ...a], { timeout: 4000 })
  const top = await git('rev-parse', '--show-toplevel')
  if (!top.ok || path.resolve(top.out.trim()) !== path.resolve(fs.realpathSync(dir))) return { name, dir, lastCommitAt: mtime(dir), git: false }
  const [origin, branch, head, last] = await Promise.all([git('remote', 'get-url', 'origin'), git('rev-parse', '--abbrev-ref', 'HEAD'), git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD'), git('log', '-1', '--format=%ct')])
  return {
    name,
    dir,
    origin: origin.ok ? normOrigin(origin.out) : undefined,
    branch: branch.ok ? branch.out.trim() : undefined,
    defaultBranch: head.ok ? head.out.trim().replace(/^origin\//, '') : undefined,
    lastCommitAt: Number(last.out.trim()) * 1000 || mtime(dir),
    git: true,
  }
}

interface RepoSignals {
  head: string
  commits: number
  firstAt: number
  lastAt: number
  recent: number
  authors: number
  tests: number
  readme: number
  usage: boolean
  todoDone: number
  todoTotal: number
  version: string
  tags: number
  subjects: string[]
  readmeText: string
}

const TEST_FILE = /(^|\/)(tests?|__tests__|spec|e2e)\/.+\.\w+$|\.(test|spec)\.\w+$|_test\.(go|py|rs)$|(^|\/)test_[^/]+\.py$/

/** Signaux d'avancement tirés du repo (recalculés seulement quand HEAD bouge). */
async function repoSignals(dir: string, git: boolean, pkg: Pkg | null): Promise<RepoSignals> {
  const g = (...a: string[]) => sh('git', ['-C', dir, ...a], { timeout: 8000, maxBuffer: 32 << 20 })
  const readmeFile = ['README.md', 'readme.md', 'README', 'README.rst'].map((f) => path.join(dir, f)).find(exists)
  const readmeText = readmeFile ? read(readmeFile, 60_000) : ''
  const todo = [readmeText, ...['TODO.md', 'ROADMAP.md', 'todo.md', 'roadmap.md'].map((f) => read(path.join(dir, f), 60_000))].join('\n')
  const done = (todo.match(/^\s*[-*] \[[xX]\]/gm) ?? []).length
  const open = (todo.match(/^\s*[-*] \[ \]/gm) ?? []).length
  const pyVersion = /^\s*version\s*=\s*["']([^"']+)/m.exec(read(path.join(dir, 'pyproject.toml'), 20_000) || read(path.join(dir, 'Cargo.toml'), 20_000))?.[1]
  const base = {
    readme: readmeText.length,
    usage: /\b(install|usage|getting started|quick ?start|utilisation|installation|lancer|démarrer|npm (run|i|install|start)|pip install|cargo (run|install)|docker (run|compose)|npx )/i.test(readmeText),
    todoDone: done,
    todoTotal: done + open,
    version: pkg?.version ?? pyVersion ?? '',
    readmeText,
  }
  if (!git) return { head: '', commits: 0, firstAt: 0, lastAt: 0, recent: 0, authors: 0, tests: 0, tags: 0, subjects: [], ...base }
  const [head, count, roots, last, recent, authors, files, tags, subjects] = await Promise.all([
    g('rev-parse', 'HEAD'),
    g('rev-list', '--count', 'HEAD'),
    g('log', '--max-parents=0', '--format=%ct', 'HEAD'),
    g('log', '-1', '--format=%ct'),
    g('rev-list', '--count', '--since=14.days', 'HEAD'),
    g('log', '--format=%ae', '-n', '3000'),
    g('ls-files'),
    g('tag'),
    g('log', '-n', '8', '--format=%s'),
  ])
  const firsts = roots.out.split('\n').map(Number).filter(Boolean)
  return {
    head: head.out.trim(),
    commits: Number(count.out.trim()) || 0,
    firstAt: firsts.length ? Math.min(...firsts) * 1000 : 0,
    lastAt: Number(last.out.trim()) * 1000 || 0,
    recent: Number(recent.out.trim()) || 0,
    authors: new Set(authors.out.split('\n').filter(Boolean)).size,
    tests: files.out.split('\n').filter((f) => TEST_FILE.test(f) && !f.includes('node_modules/')).length,
    tags: tags.out.split('\n').filter(Boolean).length,
    subjects: subjects.out.split('\n').filter(Boolean).map((s) => s.slice(0, 120)),
    ...base,
  }
}

interface Unit {
  name: string
  file: string
  workdir?: string
  paths: string[]
  active: boolean
  since: number
}

/** WorkingDirectory et chemins de ExecStart d'un fichier .service. */
export function parseUnit(text: string): { workdir?: string; paths: string[] } {
  const wd = /^\s*WorkingDirectory\s*=\s*-?(\S+)/m.exec(text)?.[1]
  const exec = [...text.matchAll(/^\s*ExecStart\s*=\s*[-@:+!]*(.*)$/gm)].map((m) => m[1]).join(' ')
  const paths = exec
    .split(/\s+/)
    .map((t) => t.replace(/^["']|["']$/g, ''))
    .filter((t) => /^(\/|~\/|%h\/)/.test(t) && !/^\/(usr|bin|sbin|lib|etc)\//.test(t))
    .map(expandHome)
  return { workdir: wd ? expandHome(wd) : undefined, paths }
}

/** Services systemd --user écrits par l'utilisateur (~/.config/systemd/user), avec leur état. */
async function userUnits(): Promise<Unit[]> {
  const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'systemd', 'user')
  let files: string[] = []
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.service') && !f.includes('@'))
  } catch {
    return []
  }
  if (!files.length) return []
  const units: Unit[] = files.map((f) => ({ name: f.replace(/\.service$/, ''), file: path.join(dir, f), ...parseUnit(read(path.join(dir, f), 40_000)), active: false, since: 0 }))
  const show = await sh('systemctl', ['--user', 'show', '--timestamp=unix', '--property=Id,ActiveState,ActiveEnterTimestamp', ...files], { timeout: 4000 })
  for (const blockText of show.out.split(/\n\s*\n/)) {
    const id = /^Id=(.+)$/m.exec(blockText)?.[1]?.replace(/\.service$/, '')
    const u = units.find((x) => x.name === id)
    if (!u) continue
    u.active = /^ActiveState=(active|activating|reloading)$/m.test(blockText)
    const ts = /^ActiveEnterTimestamp=(.+)$/m.exec(blockText)?.[1]
    u.since = ts && /^@\d+$/.test(ts) ? Number(ts.slice(1)) * 1000 : ts ? Date.parse(ts) || 0 : 0
  }
  return units
}

interface Container {
  name: string
  image: string
  running: boolean
  at: number
  workdir?: string
  mounts: string[]
  ips: string[]
  /** Ports publiés sur l'hôte. */
  ports: number[]
}

let dockerOk: boolean | null = null
async function containers(): Promise<Container[]> {
  if (dockerOk === false || !which('docker')) return []
  const ids = await sh('docker', ['ps', '-aq'], { timeout: 4000 })
  if (!ids.ok) {
    dockerOk = false
    return []
  }
  dockerOk = true
  const list = ids.out.split('\n').filter(Boolean).slice(0, 60)
  if (!list.length) return []
  const ins = await sh('docker', ['inspect', ...list], { timeout: 6000, maxBuffer: 32 << 20 })
  try {
    return (JSON.parse(ins.out) as any[]).map((c) => ({
      name: String(c.Name ?? '').replace(/^\//, ''),
      image: String(c.Config?.Image ?? ''),
      running: !!c.State?.Running,
      at: Date.parse(c.State?.Running ? c.State?.StartedAt : c.State?.FinishedAt) || 0,
      workdir: c.Config?.Labels?.['com.docker.compose.project.working_dir'],
      mounts: ((c.Mounts ?? []) as any[]).filter((m) => m.Type === 'bind').map((m) => String(m.Source)),
      ips: Object.values((c.NetworkSettings?.Networks ?? {}) as Record<string, any>).map((n) => String(n.IPAddress ?? '')).filter(Boolean),
      ports: Object.values((c.NetworkSettings?.Ports ?? {}) as Record<string, any[] | null>).flatMap((b) => (b ?? []).map((x) => Number(x.HostPort)).filter(Boolean)),
    }))
  } catch {
    return []
  }
}

function caddySites(): CaddySite[] {
  if (!EXPOSE_SITES_DIR) return []
  try {
    return fs
      .readdirSync(EXPOSE_SITES_DIR)
      .filter((f) => f.endsWith('.caddy'))
      .flatMap((f) => {
        const s = parseCaddySite(f, read(path.join(EXPOSE_SITES_DIR, f), 40_000))
        return s ? [s] : []
      })
  } catch {
    return []
  }
}

const siteUrl = (s: CaddySite) => `https://${s.host.includes('.') ? s.host : `${s.name}.${EXPOSE_DOMAIN}`}`

// ================================================================ état persistant

interface RunRecord {
  key: string
  how: NonNullable<Software['launch']>['how']
  pid?: number
  ticks?: string
  port?: number
  log?: string
  at: number
  /** Atteint le port (au moins une fois). */
  up?: boolean
  /** Au-delà, un lancement qui n'écoute toujours pas est arrêté (retenu sur disque : survit à un redémarrage de weevilsd). */
  deadline?: number
  endedAt?: number
  exit?: number | null
  /** Sous-domaine publié par weevils (à retirer à l'arrêt), et comment. */
  published?: { slug: string; via: 'expose' | 'file' }
  unit?: string
  container?: string
}

interface Estimate {
  hash: string
  phase: Phase
  percent: number
  reason: string
  at: number
}

interface Fix {
  phase: Phase
  percent: number
  at: number
  signalsHash: string
}

interface Entry {
  sw: Software
  key: string
  slug: string
  mainDir?: string
  dirs: string[]
  proj?: Project
  units: Unit[]
  containers: Container[]
  sites: CaddySite[]
  logs: { file: string; at: number }[]
  signals: Signals
  repoSig?: RepoSignals
  originRepo?: string
  sessions: { title: string; texts: string[] }[]
  /** Commande npm/pnpm… réellement lancée, avec ses variables. */
  plan?: { argv: string[]; env: Record<string, string>; install: boolean }
}

type Host = Pick<Weevils, 'store' | 'siteKey'>

/** L'adresse est celle de l'app weevils qui tourne ici (son domaine public, ou un site Caddy qui renvoie vers son port). */
function ownApp(url: string, e: Pick<Entry, 'sites'>): boolean {
  const o = originOf(url)
  if (PUBLIC_URL && o && o === originOf(PUBLIC_URL)) return true
  return e.sites.some((s) => siteUrl(s) === url && s.proxies.some((p) => isLocalUpstream(p.host) && (p.port === PORT || p.port === HOOK_PORT)))
}

/** Une page HTML répond sur ce port local (une interface), pas une API ni un autre service. */
async function servesHtml(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2500), redirect: 'follow' })
    void r.body?.cancel()
    return /text\/html/i.test(r.headers.get('content-type') ?? '')
  } catch {
    return false
  }
}

/** Une capture vide (page blanche, 404 sans contenu) pèse quelques Ko : elle ne vaut pas la vraie sortie en terminal. */
export const BLANK_SHOT_BYTES = 6000

/**
 * Capture d'une page par le protocole de débogage de Chrome : navigation, attente réelle de `waitMs`, capture.
 * Pas de « --screenshot --virtual-time-budget » : le temps virtuel n'avance jamais sur une page qui anime en continu
 * (un jeu WebGL, une boucle requestAnimationFrame) et Chrome ne rend jamais la main. WebGL en logiciel (SwiftShader) :
 * pas de carte graphique sur un serveur, et une page en Three.js afficherait sinon son erreur de contexte.
 */
export async function captureCdp(argv: string[], url: string, out: string, profile: string, waitMs = 5000, timeoutMs = 40_000): Promise<boolean> {
  const port = await new Promise<number>((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port
      s.close(() => resolve(p))
    })
  })
  const flags = ['--headless=new', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--disable-sync', `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`, 'about:blank']
  const child = spawn(argv[0], [...argv.slice(1), ...flags], { stdio: 'ignore' })
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const deadline = Date.now() + timeoutMs
  let ws: WebSocket | undefined
  try {
    while (!ws && Date.now() < deadline && child.exitCode == null) {
      try {
        const list = (await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1000) })).json()) as { type: string; webSocketDebuggerUrl: string }[]
        const page = list.find((t) => t.type === 'page')
        if (page) ws = new WebSocket(page.webSocketDebuggerUrl)
      } catch {
        await sleep(250)
      }
    }
    if (!ws) return false
    const sock = ws
    await new Promise<void>((resolve, reject) => {
      sock.addEventListener('open', () => resolve(), { once: true })
      sock.addEventListener('error', () => reject(new Error('cdp')), { once: true })
    })
    let n = 0
    const waiting = new Map<number, (v: { result?: { data?: string } }) => void>()
    sock.addEventListener('message', (m) => {
      try {
        const d = JSON.parse(String(m.data)) as { id?: number; result?: { data?: string } }
        if (d.id && waiting.has(d.id)) {
          waiting.get(d.id)!(d)
          waiting.delete(d.id)
        }
      } catch {
        /* message illisible */
      }
    })
    const cdp = (method: string, params: Record<string, unknown> = {}) =>
      Promise.race([
        new Promise<{ result?: { data?: string } }>((resolve) => {
          const i = ++n
          waiting.set(i, resolve)
          sock.send(JSON.stringify({ id: i, method, params }))
        }),
        sleep(Math.max(0, deadline - Date.now())).then(() => ({}) as { result?: { data?: string } }),
      ])
    await cdp('Emulation.setDeviceMetricsOverride', { width: 400, height: 500, deviceScaleFactor: 2, mobile: true })
    await cdp('Page.enable')
    await cdp('Page.navigate', { url })
    await sleep(Math.min(waitMs, Math.max(0, deadline - Date.now())))
    const shot = await cdp('Page.captureScreenshot', { format: 'png' })
    if (!shot.result?.data) return false
    fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'))
    return true
  } catch {
    return false
  } finally {
    try {
      ws?.close()
    } catch {
      /* déjà fermé */
    }
    child.kill('SIGKILL')
  }
}

// ================================================================ le service

export class Softwares {
  private host: Host
  private entries = new Map<string, Entry>()
  private at = 0
  private refreshing: Promise<void> | null = null
  /** Lancements en cours (un seul à la fois par logiciel) et lancements dont l'attente du port tourne dans ce processus. */
  private launching = new Map<string, Promise<Software>>()
  private watching = new Set<string>()
  private staticAt = 0
  private groups: RepoGroup[] = []
  private projects = new Map<string, Project>()
  private sigCache = new Map<string, RepoSignals>()
  private sigStamp = new Map<string, string>()
  private listAt = 0
  private runs: Record<string, RunRecord> = readJson('runs.json', {})
  private ports: Record<string, number> = readJson('ports.json', {})
  private estimates: Record<string, Estimate> = readJson('progress.json', {})
  private fixes: Record<string, Fix> = readJson('fixes.json', {})
  private github: Record<string, { at: number; stars: number; forks: number; issues: number }> = readJson('github.json', {})
  private help: Record<string, { at: number; lines: string[] }> = readJson('help.json', {})
  private visitors = new Map<string, { at: number; ips: Set<string> }>()
  private sudoFailedAt = 0
  private frames = new Map<string, { at: number; ok: boolean }>()
  private shooting = false
  private enriching = false
  private estimating = false
  private estimatedAt = 0
  private chromeBin: string | null | undefined

  constructor(host: Host) {
    this.host = host
  }

  // ---------------------------------------------------------------- lecture

  /** Tous les logiciels de cette machine (après le premier balayage, jamais d'attente : rafraîchi en fond toutes les 20 s). */
  async list(): Promise<Software[]> {
    this.listAt = Date.now()
    if (!this.at || Date.now() - this.at > 20_000) {
      const p = this.refresh()
      if (!this.at) await p
    }
    return this.sorted()
  }

  private sorted(): Software[] {
    return [...this.entries.values()].map((e) => e.sw).sort((a, b) => Number(b.run === 'running' || b.run === 'starting') - Number(a.run === 'running' || a.run === 'starting') || b.lastActivityAt - a.lastActivityAt)
  }

  has(id: string) {
    return this.entries.has(id)
  }

  /** Un logiciel à jour (état, port, adresse, dernières lignes) : l'app le relit toutes les ~1,5 s quand sa page est ouverte. */
  async get(id: string): Promise<Software | undefined> {
    if (!this.at) await this.refresh()
    const e = this.entries.get(id)
    if (!e) return undefined
    await this.runtime([e], true)
    return e.sw
  }

  shotFile(id: string): string | null {
    const e = this.entries.get(id)
    if (!e?.sw.shot) return null
    const f = this.shotPath(e)
    return exists(f) ? f : null
  }

  // ---------------------------------------------------------------- balayage

  private refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing
    this.refreshing = (async () => {
      try {
        const t0 = Date.now()
        if (Date.now() - this.staticAt > 60_000) await this.scanRepos()
        await this.assemble()
        this.at = Date.now()
        if (Date.now() - t0 > 1500) console.log(`[logiciels] balayage ${Date.now() - t0} ms, ${this.entries.size} logiciels`)
        void this.enrich()
      } catch (e) {
        console.error(`[logiciels] balayage : ${(e as Error).stack}`)
      } finally {
        this.refreshing = null
      }
    })()
    return this.refreshing
  }

  /** Repos des racines de projets, regroupés ; projets et signaux relus seulement quand HEAD bouge. */
  private async scanRepos() {
    const dirs: { name: string; dir: string }[] = []
    const seen = new Set<string>()
    for (const root of PROJECT_ROOTS) {
      try {
        for (const e of fs.readdirSync(root, { withFileTypes: true })) {
          if (!e.isDirectory() || e.name.startsWith('.') || seen.has(e.name) || e.name === 'node_modules') continue
          seen.add(e.name)
          dirs.push({ name: e.name, dir: path.join(root, e.name) })
        }
      } catch {
        /* racine absente */
      }
    }
    const facts = (await pool(dirs, 8, (d) => gitFacts(d.name, d.dir))).filter((f) => f.git || SOFTWARE_FILES.some((x) => exists(path.join(f.dir, x))))
    this.groups = groupRepos(facts)
    await pool(this.groups, 4, async (g) => {
      const proj = project(g.main.dir, g.main.name)
      this.projects.set(g.key, proj)
      // Les signaux viennent de la copie la plus fournie (le checkout principal peut être une copie neuve d'un travail mené ailleurs).
      const gits = g.repos.filter((r) => r.git)
      const counts = gits.length > 1 ? await Promise.all(gits.map(async (r) => Number((await sh('git', ['-C', r.dir, 'rev-list', '--count', 'HEAD'])).out.trim()) || 0)) : []
      const best = counts.length && Math.max(...counts) > (counts[gits.indexOf(g.main)] ?? 0) * 2 ? gits[counts.indexOf(Math.max(...counts))] : g.main
      const head = best.git ? (await sh('git', ['-C', best.dir, 'rev-parse', 'HEAD'])).out.trim() : ''
      const stamp = `${best.dir}:${head}:${mtime(path.join(best.dir, 'README.md'))}:${mtime(path.join(best.dir, 'TODO.md'))}:${mtime(path.join(best.dir, 'package.json'))}`
      if (this.sigStamp.get(g.key) !== stamp) {
        this.sigCache.set(g.key, await repoSignals(best.dir, best.git, best === g.main ? proj.pkg : project(best.dir, best.name).pkg))
        this.sigStamp.set(g.key, stamp)
      }
    })
    this.staticAt = Date.now()
  }

  /** Assemble les logiciels : repos + services + conteneurs + sites + ports + journaux, puis l'état de chacun. */
  private async assemble() {
    const [units, ctrs] = await Promise.all([userUnits(), containers()])
    const sites = caddySites()
    const logs = this.logFiles()
    const next = new Map<string, Entry>()
    const prefix = `${MACHINE.id}:`
    const blurbs = loadBlurbs(DATA_DIR)
    for (const g of this.groups) {
      const id = prefix + g.key
      const old = this.entries.get(id)
      const originRepo = (g.main.origin ?? g.repos.find((r) => r.origin)?.origin)?.split('/').pop()
      const e: Entry = {
        key: g.key,
        slug: slugify(g.name),
        mainDir: g.main.dir,
        dirs: g.repos.map((r) => real(r.dir)),
        proj: this.projects.get(g.key),
        units: [],
        containers: [],
        sites: [],
        logs: [],
        signals: emptySignals(),
        repoSig: this.sigCache.get(g.key),
        originRepo,
        sessions: [],
        sw: {
          id,
          name: g.name,
          blurb: blurbs[originRepo ?? ''] ?? blurbs[g.main.name],
          machine: MACHINE.id,
          repo: g.main.name,
          repos: g.repos.map((r) => r.name),
          kind: 'lib',
          run: 'idle',
          tail: old?.sw.tail ?? [],
          tailSource: old?.sw.tailSource ?? 'git',
          progress: old?.sw.progress ?? heuristic(emptySignals()),
          hosts: [],
          lastCommitAt: Math.max(...g.repos.map((r) => (r.git ? r.lastCommitAt : 0))),
          lastActivityAt: 0,
        },
      }
      next.set(id, e)
    }
    const all = [...next.values()]
    const ownerOf = (p?: string) => {
      if (!p) return undefined
      const r = real(p)
      return all.filter((e) => e.dirs.some((d) => inside(r, d))).sort((a, b) => longest(b, r) - longest(a, r))[0]
    }
    const byName = (n: string) => {
      const s = slugify(n)
      return all.find((e) => e.key === s || e.slug === s || e.sw.repos.includes(n)) ?? all.find((e) => e.key === familyOf(n) && !e.key.includes('-'))
    }
    const standalone = (key: string, name: string, kind: SoftwareKind): Entry => {
      const id = prefix + key
      const have = next.get(id)
      if (have) return have
      const old = this.entries.get(id)
      const e: Entry = {
        key,
        slug: slugify(name),
        dirs: [],
        units: [],
        containers: [],
        sites: [],
        logs: [],
        signals: emptySignals(),
        sessions: [],
        sw: { id, name, machine: MACHINE.id, repo: '', repos: [], kind, run: 'idle', tail: old?.sw.tail ?? [], tailSource: old?.sw.tailSource ?? 'log', progress: old?.sw.progress ?? heuristic(emptySignals()), hosts: [], lastCommitAt: 0, lastActivityAt: 0 },
      }
      next.set(id, e)
      all.push(e)
      return e
    }
    for (const u of units) {
      const e = ownerOf(u.workdir) ?? u.paths.map(ownerOf).find(Boolean) ?? standalone(`unit:${u.name}`, u.name, 'service')
      e.units.push(u)
      e.sw.hosts.push(`unit:${u.name}`)
      // Service sans repo : son dossier de travail dit quels ports et quels sites sont à lui (jamais le dossier personnel entier).
      if (!e.sw.repos.length && u.workdir && u.workdir !== HOME && u.workdir !== '/' && !PROJECT_ROOTS.some((r) => inside(r, u.workdir!))) {
        e.mainDir ??= u.workdir
        if (!e.dirs.includes(real(u.workdir))) e.dirs.push(real(u.workdir))
      }
    }
    for (const c of ctrs) {
      const img = c.image.split('/').pop()!.split(':')[0]
      const e = ownerOf(c.workdir) ?? c.mounts.map(ownerOf).find(Boolean) ?? byName(c.name) ?? byName(img) ?? standalone(`docker:${c.name}`, c.name, 'service')
      e.containers.push(c)
      e.sw.hosts.push(`docker:${c.name}`)
    }
    const procs = await servers()
    const dirOf = (s: ServerProc) => (s.dir ? expandHome(s.dir) : undefined)
    for (const s of sites) {
      const local = s.proxies.filter((p) => isLocalUpstream(p.host)).map((p) => p.port)
      const viaPort = local.map((port) => procs.find((x) => x.port === port)).map((x) => (x ? ownerOf(dirOf(x)) : undefined)).find(Boolean)
      const viaCtr = all.find((e) => e.containers.some((c) => c.ports.some((p) => local.includes(p)) || c.ips.some((ip) => s.proxies.some((p) => p.host === ip))))
      const viaRoot = ownerOf(s.root)
      const e = viaPort ?? viaRoot ?? viaCtr ?? byName(s.name) ?? standalone(`site:${s.name}`, s.name, 'web')
      e.sites.push(s)
      e.sw.hosts.push(`site:${s.name}`)
    }
    for (const l of logs) {
      const n = l.name
      const e = all.find((x) => x.slug === slugify(n) || x.sw.repos.some((r) => n === r || n.startsWith(`${r}-`))) ?? all.find((x) => familyOf(n) === familyOf(x.key.replace(/^(unit|docker|site):/, '')) && familyOf(n).length >= 3)
      if (e) e.logs.push({ file: l.file, at: l.at })
    }
    // Échanges avec les sessions : titres et derniers messages de l'utilisateur, par dossier de travail.
    for (const t of this.host.store.all()) {
      const e = ownerOf(t.cwd)
      if (!e) continue
      const texts = t.messages.filter((m) => m.role === 'user').slice(-12).map((m) => m.text.slice(0, 400))
      e.sessions.push({ title: t.customTitle ?? t.title ?? t.firstPrompt?.slice(0, 80) ?? '', texts })
      e.sw.lastActivityAt = Math.max(e.sw.lastActivityAt, t.lastActivityAt)
    }
    this.entries = next
    await this.runtime([...next.values()], false, procs)
  }

  /** Journaux des jobs (LOGS_DIRS, comme le rail 24/7 : le premier dossier gagne pour un même nom), lus seulement. */
  private logFiles(): { file: string; name: string; at: number }[] {
    const out = new Map<string, { file: string; name: string; at: number }>()
    for (const dir of LOGS_DIRS) {
      try {
        for (const f of fs.readdirSync(dir)) if (f.endsWith('.log') && !out.has(f)) out.set(f, { file: path.join(dir, f), name: f.slice(0, -4), at: mtime(path.join(dir, f)) })
      } catch {
        /* dossier absent */
      }
    }
    return [...out.values()].sort((a, b) => b.at - a.at)
  }

  // ---------------------------------------------------------------- état vivant

  /** État, port, adresse, plan de lancement, dernières lignes et avancement (fresh : une page ouverte, relue souvent). */
  private async runtime(list: Entry[], fresh: boolean, procs?: ServerProc[]) {
    procs ??= await servers()
    if (fresh) {
      const [u, c] = await Promise.all([list.some((e) => e.units.length) ? userUnits() : Promise.resolve([]), list.some((e) => e.containers.length) ? containers() : Promise.resolve([])])
      for (const e of list) {
        e.units = e.units.map((x) => u.find((y) => y.name === x.name) ?? x)
        e.containers = e.containers.map((x) => c.find((y) => y.name === x.name) ?? x)
        // Une sortie écrite depuis : le journal du lancement en fait partie.
        for (const l of e.logs) l.at = mtime(l.file)
      }
    }
    // Pris : tout ce qui écoute (même à un autre utilisateur, même un conteneur arrêté qui réserve son port) et weevilsd.
    const all = await listeners()
    const busy = new Set<number>([PORT, HOOK_PORT, ...procs.map((p) => p.port), ...all.map((l) => l.port)])
    for (const x of this.entries.values()) for (const c of x.containers) for (const p of c.ports) busy.add(p)
    const listen = new Set([...procs.map((p) => p.port), ...all.map((l) => l.port)])
    const claimed = new Set<number>()
    for (const e of this.entries.values()) if (e.proj?.declared) claimed.add(e.proj.declared)
    let changedPorts = false
    for (const e of list) {
      const sw = e.sw
      const rec = this.runs[e.key]
      // Ce qui écoute depuis ses dossiers ; jamais weevilsd lui-même (son app n'est pas un aperçu, ni à publier, ni à capturer).
      const mine = procs.filter((p) => {
        const d = p.dir ? real(expandHome(p.dir)) : ''
        return p.port !== PORT && p.port !== HOOK_PORT && d && e.dirs.some((x) => inside(d, x))
      })
      // Lancé d'un tap : vivant, en route, ou tombé.
      let own: RunState | null = null
      if (rec?.pid) {
        const live = alive(rec.pid, rec.ticks ?? '')
        // Après un redémarrage de weevilsd, la surveillance du lancement n'existe plus : on la refait ici.
        if (live && !rec.up && rec.port && !this.watching.has(e.key)) {
          const l = all.filter((x) => x.port === rec.port)
          if (l.some((x) => x.pids.some((pid) => pgidOf(pid) === rec.pid))) {
            rec.up = true
            writeJson('runs.json', this.runs)
            void this.publish(e, rec.port)
          } else if (Date.now() > (rec.deadline ?? rec.at + 600_000)) {
            this.note(rec, tr(M).tooLong)
            void killGroup(rec.pid)
          }
        }
        if (live) own = rec.up || (rec.port && listen.has(rec.port)) ? 'running' : 'starting'
        // Tombé avant d'écouter, ou planté : montré en échec (avec sa sortie) pendant 30 min.
        else if ((!rec.up || (rec.exit != null && rec.exit !== 0)) && Date.now() - (rec.endedAt ?? rec.at) < 30 * MIN) own = 'failed'
        else {
          if (rec.published) await this.unpublish(rec.published)
          delete this.runs[e.key]
          writeJson('runs.json', this.runs)
        }
      }
      const unitUp = e.units.some((u) => u.active)
      const ctrUp = e.containers.some((c) => c.running)
      const ctrPorts = e.containers.filter((c) => c.running).flatMap((c) => c.ports)
      // Port : celui qui écoute (lancé par weevils, du projet, d'un conteneur), sinon celui du projet, sinon un port retenu.
      const proj = e.proj
      const livePort = (rec?.port && procs.some((p) => p.port === rec.port) ? rec.port : undefined) ?? (proj?.declared && mine.some((p) => p.port === proj.declared) ? proj.declared : undefined) ?? mine[0]?.port ?? ctrPorts[0]
      // Adresse : un site statique, ou un site dont l'amont répond.
      const liveSites = e.sites.filter((s) => s.root || s.proxies.some((p) => (isLocalUpstream(p.host) ? listen.has(p.port) : e.containers.some((c) => c.running && c.ips.includes(p.host)))))
      const rank = (s: CaddySite) =>
        (rec?.published?.slug === s.name ? 0 : 10) + (livePort && s.proxies.some((p) => p.port === livePort) ? 0 : 4) + (s.name === e.slug || s.name === e.key ? 0 : 2) + (s.root && e.mainDir && inside(real(s.root), real(e.mainDir)) ? 0 : 1)
      const site = [...liveSites].sort((a, b) => rank(a) - rank(b))[0]
      sw.url = site && (EXPOSE_DOMAIN || site.host.includes('.')) ? siteUrl(site) : undefined
      // Une petite appli statique (index.html à la racine, rien à lancer) : servie par weevils lui-même, en bac à sable,
      // sans rien publier (jamais la racine d'un repo sur Internet : .git, .env…).
      const pageOnly = !sw.url && !!proj && !!e.mainDir && this.host.siteKey && exists(path.join(e.mainDir, 'index.html')) && !proj.scripts.dev && !proj.scripts.start && !proj.scripts.serve
      if (pageOnly) sw.url = `/api/site/${this.host.siteKey}/${path.basename(e.mainDir!)}/`
      sw.owned = !!own && own !== 'failed' && !!(rec?.pid || rec?.unit || rec?.container)
      sw.run = own ?? (unitUp || ctrUp || mine.length || pageOnly || (site?.root && !e.dirs.length) ? 'running' : site && sw.url ? 'running' : 'idle')
      if (own === 'running' && rec?.port) sw.port = rec.port
      else if (livePort) sw.port = livePort
      else if (proj?.declared && !(busy.has(proj.declared) && !mine.some((p) => p.port === proj.declared))) sw.port = proj.declared
      else sw.port = undefined
      // Genre (une fois le reste connu).
      sw.kind = proj
        ? detectKind({ name: sw.name, deps: proj.deps, scripts: proj.scripts, bin: !!proj.bin, html: proj.html, staticSite: e.sites.some((s) => !!s.root), url: !!sw.url, unit: e.units.length > 0, container: e.containers.length > 0, listening: mine.length > 0 })
        : e.sites.length && !e.units.length && !e.containers.length ? 'web' : sw.url ? 'web' : sw.kind
      // Ce qu'un tap lance quand rien ne tourne.
      sw.launch = this.launchOf(e)
      if (sw.launch && ['dev', 'start', 'preview', 'static'].includes(sw.launch.how) && !sw.port) {
        const taken = new Set([...busy, ...[...claimed].filter((p) => p !== proj?.declared)])
        for (const p of mine) taken.delete(p.port)
        const p = allocatePort(e.key, this.ports, taken)
        if (p) {
          if (this.ports[e.key] !== p) changedPorts = true
          this.ports[e.key] = p
          sw.port = p
        }
      }
      if (sw.launch) sw.launch = this.launchOf(e)
      // Peut-on l'afficher dans un cadre ?
      sw.embeddable = sw.url ? (pageOnly ? true : ownApp(sw.url, e) ? false : this.frames.get(sw.url)?.ok) : undefined
      if (sw.url && !pageOnly && (!this.frames.has(sw.url) || Date.now() - this.frames.get(sw.url)!.at > 60 * MIN)) void this.checkFrame(sw.url)
      sw.shot = this.shotAt(e)
      // Dernières lignes : toujours une vraie sortie.
      await this.tail(e)
      // Avancement.
      e.signals = this.signalsOf(e)
      sw.progress = this.progressOf(e)
      sw.lastActivityAt = Math.max(sw.lastActivityAt, sw.lastCommitAt, e.logs[0]?.at ?? 0, rec?.at ?? 0, ...e.units.filter((u) => u.active).map((u) => u.since), ...e.containers.filter((c) => c.running).map((c) => c.at))
    }
    if (changedPorts) writeJson('ports.json', this.ports)
  }

  /** Le plan d'un tap (unit, conteneur, serveur dev, build statique, start, preview, --help). */
  private launchOf(e: Entry): Software['launch'] {
    e.plan = undefined
    const u = e.units.find((x) => !x.active) ?? e.units[0]
    if (u) return { how: 'unit', cmd: `systemctl --user start ${u.name}` }
    const c = e.containers.find((x) => !x.running) ?? e.containers[0]
    if (c && !e.proj) return { how: 'docker', cmd: `docker start ${c.name}` }
    const p = e.proj
    if (!p || !e.mainDir) return c ? { how: 'docker', cmd: `docker start ${c.name}` } : undefined
    const kind = e.sw.kind
    const port = e.sw.port
    const node = !!p.pkg
    const runArgs = (script: string, extra: string[]) => (p.pm === 'npm' ? ['npm', 'run', script, ...(extra.length ? ['--', ...extra] : [])] : [p.pm, 'run', script, ...extra])
    const host = EXPOSE_DOMAIN ? `${this.slugFor(e, port)}.${EXPOSE_DOMAIN}` : ''
    const plan = (how: 'dev' | 'start' | 'preview', script: string) => {
      const s = p.scripts[script]
      const fixed = /(--port|\s-p\s|PORT=)/.test(s)
      const flags: string[] = []
      if (port && !fixed) {
        if (/\bvite\b/.test(s)) flags.push(...(/--host\b/.test(s) ? [] : ['--host', '127.0.0.1']), '--port', String(port), '--strictPort')
        else if (/\bnext\b/.test(s)) flags.push(...(/(-H|--hostname)\b/.test(s) ? [] : ['-H', '127.0.0.1']), '-p', String(port))
        else if (/\b(astro|nuxt|nuxi|webpack(-dev-server)?|svelte-kit)\b/.test(s)) flags.push(...(/--host\b/.test(s) ? [] : ['--host', '127.0.0.1']), '--port', String(port))
      }
      const env: Record<string, string> = { HOST: '127.0.0.1', BROWSER: 'none', FORCE_COLOR: '0' }
      if (port) env.PORT = String(port)
      if (port && p.portEnv) env[p.portEnv] = String(port)
      if (host) env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS = host
      const argv = runArgs(script, flags)
      e.plan = { argv, env, install: node && !exists(path.join(p.dir, 'node_modules')) }
      const shown = [...(port && !flags.length && !fixed ? [`PORT=${port}`] : []), ...argv].join(' ')
      return { how, cmd: shown }
    }
    if (kind === 'web' && p.scripts.dev) return plan('dev', 'dev')
    if (kind === 'web' && p.dist && !p.scripts.start) return { how: 'static', cmd: which('expose') ? `expose --static ${this.slugFor(e)} ${path.relative(p.dir, p.dist)}` : `python3 -m http.server ${port ?? ''} --bind 127.0.0.1 --directory ${path.relative(p.dir, p.dist)}`.replace(/\s+/g, ' ') }
    if (['web', 'api', 'bot', 'service'].includes(kind) && p.scripts.start) return plan('start', 'start')
    if (['web', 'api', 'bot', 'service'].includes(kind) && p.scripts.serve) return plan('start', 'serve')
    if (kind === 'web' && p.scripts.preview && p.dist) return plan('preview', 'preview')
    if (c) return { how: 'docker', cmd: `docker start ${c.name}` }
    if (p.bin) return { how: 'help', cmd: `${p.bin.cmd.map((x) => (x === process.execPath ? 'node' : path.relative(p.dir, x) || x)).join(' ')} --help` }
    return undefined
  }

  /** Les vraies dernières lignes : lancement en cours, service, conteneur, journal de job, aide, sinon l'historique git. */
  private async tail(e: Entry) {
    const sw = e.sw
    const rec = this.runs[e.key]
    const set = (lines: string[], src: TailSource) => {
      if (!lines.length) return false
      sw.tail = lines
      sw.tailSource = src
      return true
    }
    if (rec?.log && exists(rec.log) && set(this.logTail(rec.log), 'log')) return
    const u = e.units.find((x) => x.active)
    if (u && set(tailLines((await sh('journalctl', ['--user', '-u', u.name, '-n', '40', '-o', 'cat', '--no-pager'], { timeout: 4000 })).out), 'journal')) return
    const c = e.containers.find((x) => x.running)
    if (c) {
      const r = await sh('docker', ['logs', '--tail', '40', c.name], { timeout: 4000 })
      if (set(tailLines(r.out + '\n' + r.err), 'docker')) return
    }
    // Rien ne tourne : la sortie la plus fraîche.
    const help = this.help[e.key]
    const cands: { at: number; get: () => Promise<[string[], TailSource]> }[] = []
    const log = e.logs[0]
    if (log) cands.push({ at: log.at, get: async () => [this.logTail(log.file), 'log'] })
    if (help) cands.push({ at: help.at, get: async () => [help.lines, 'run'] })
    const stopped = e.containers[0]
    if (stopped) cands.push({ at: stopped.at, get: async () => {
      const r = await sh('docker', ['logs', '--tail', '40', stopped.name], { timeout: 4000 })
      return [tailLines(r.out + '\n' + r.err), 'docker']
    } })
    if (e.units[0]) cands.push({ at: e.units[0].since || 1, get: async () => [tailLines((await sh('journalctl', ['--user', '-u', e.units[0].name, '-n', '40', '-o', 'cat', '--no-pager'], { timeout: 4000 })).out), 'journal'] })
    if (e.mainDir && e.repoSig?.head) cands.push({ at: sw.lastCommitAt, get: async () => [tailLines((await sh('git', ['-C', e.mainDir!, 'log', '--oneline', '--no-decorate', '-n', '12'])).out), 'git'] })
    for (const c2 of cands.sort((a, b) => b.at - a.at)) {
      const [lines, src] = await c2.get()
      if (set(lines, src)) return
    }
  }

  private logTail(file: string): string[] {
    try {
      return tailLines(readEnd(file, 16_000))
    } catch {
      return []
    }
  }

  // ---------------------------------------------------------------- avancement

  private signalsOf(e: Entry): Signals {
    const r = e.repoSig
    const gh = this.github[e.key]
    const vis = e.sites.map((s) => (s.log ? this.visitors.get(s.log) : undefined)).filter(Boolean) as { ips: Set<string> }[]
    const ips = new Set(vis.flatMap((v) => [...v.ips]))
    const talk = talkSignals(e.sessions.flatMap((s) => [s.title, ...s.texts]))
    return {
      ...emptySignals(),
      ...(r ? { commits: r.commits, firstAt: r.firstAt, lastAt: r.lastAt, recent: r.recent, authors: r.authors, tests: r.tests, readme: r.readme, usage: r.usage, todoDone: r.todoDone, todoTotal: r.todoTotal, version: r.tags > 0 || r.version.replace(/^v/, '') !== '1.0.0' ? r.version : '', tags: r.tags } : {}),
      // En ligne pour de vrai : un service actif, un conteneur qui tourne, ou une adresse que weevils n'a pas publiée lui-même
      // pour un essai lancé d'un tap.
      deployed: (!!e.sw.url && /^https?:/.test(e.sw.url) && e.sw.url !== this.selfUrl(e)) || e.units.some((u) => u.active) || e.containers.some((c) => c.running),
      running: e.sw.run === 'running',
      stars: gh?.stars ?? 0,
      forks: gh?.forks ?? 0,
      issues: gh?.issues ?? 0,
      visitors: ips.size,
      ...talk,
    }
  }

  /** L'adresse que weevils a publiée lui-même pour ce logiciel (un tap), s'il y en a une. */
  private selfUrl(e: Entry): string | undefined {
    const pub = this.runs[e.key]?.published
    return pub && EXPOSE_DOMAIN ? `https://${pub.slug}.${EXPOSE_DOMAIN}` : undefined
  }

  private progressOf(e: Entry): Progress {
    const fix = this.fixes[e.key]
    if (fix) return { phase: fix.phase, percent: fix.percent, reason: '', source: 'user', at: fix.at }
    const est = this.estimates[e.key]
    if (est) return { phase: est.phase, percent: est.percent, reason: est.reason, source: 'estimate', at: est.at }
    return heuristic(e.signals)
  }

  /** Correction d'un tap (phase, pourcentage), ou retour à l'estimation (reset). */
  async fix(id: string, body: ProgressFix): Promise<Software> {
    const e = this.entries.get(id)
    if (!e) throw new Error(tr(M).notFound)
    if (body.reset) delete this.fixes[e.key]
    else {
      const cur = e.sw.progress
      const phase = body.phase ?? cur.phase
      if (![1, 2, 3].includes(phase) || (body.percent != null && !(Number.isFinite(body.percent) && body.percent >= 0 && body.percent <= 100))) throw new Error(tr(M).badFix)
      const percent = body.percent != null ? Math.round(body.percent) : phase !== cur.phase ? 50 : cur.percent
      this.fixes[e.key] = { phase: phase as Phase, percent, at: Date.now(), signalsHash: signalsHash(e.signals) }
    }
    writeJson('fixes.json', this.fixes)
    e.sw.progress = this.progressOf(e)
    return e.sw
  }

  /** En fond, après un balayage : captures, GitHub, visiteurs, puis estimation par le modèle. */
  private async enrich() {
    if (this.enriching) return
    this.enriching = true
    try {
      void this.shots()
      await this.githubSignals()
      await this.visitorSignals()
      for (const e of this.entries.values()) {
        e.signals = this.signalsOf(e)
        e.sw.progress = this.progressOf(e)
      }
      void this.estimate()
    } catch (err) {
      console.error(`[logiciels] signaux : ${(err as Error).message}`)
    } finally {
      this.enriching = false
    }
  }

  /** Étoiles, forks, tickets d'autres personnes (gh, quand il est connecté), en cache 6 h. */
  private async githubSignals() {
    if (!which('gh')) return
    let changed = false
    for (const e of this.entries.values()) {
      const g = this.groups.find((x) => x.key === e.key)
      const origin = g?.main.origin ?? g?.repos.find((r) => r.origin)?.origin
      const m = origin ? /^github\.com\/([\w.-]+)\/([\w.-]+)$/.exec(origin) : null
      if (!m || (this.github[e.key] && Date.now() - this.github[e.key].at < 6 * 60 * MIN)) continue
      const repo = await sh('gh', ['api', `repos/${m[1]}/${m[2]}`, '--jq', '[.stargazers_count, .forks_count, .owner.login] | @tsv'], { timeout: 15_000 })
      const [stars, forks, owner] = repo.out.trim().split('\t')
      let issues = 0
      if (repo.ok && owner) {
        const r = await sh('gh', ['api', `repos/${m[1]}/${m[2]}/issues?state=all&per_page=100`, '--jq', `[.[] | select(.user.login != "${owner.replace(/"/g, '')}" and (.user.type // "User") != "Bot")] | length`], { timeout: 15_000 })
        issues = Number(r.out.trim()) || 0
      }
      this.github[e.key] = { at: Date.now(), stars: Number(stars) || 0, forks: Number(forks) || 0, issues }
      changed = true
    }
    if (changed) writeJson('github.json', this.github)
  }

  /** Visiteurs distincts des 7 derniers jours dans les journaux Caddy, sans les adresses de l'utilisateur (celles du site de weevils). */
  private async visitorSignals() {
    const all = [...this.entries.values()].flatMap((e) => e.sites)
    const files = [...new Set(all.map((s) => s.log).filter((f): f is string => !!f))]
    if (!files.length) return
    const since = Date.now() - 7 * 24 * 60 * MIN
    const appSite = all.find((s) => s.proxies.some((p) => isLocalUpstream(p.host) && p.port === PORT)) ?? (PUBLIC_URL ? all.find((s) => PUBLIC_URL.includes(s.host)) : undefined)
    const ownText = appSite?.log ? await this.readAccessLog(appSite.log) : ''
    const own = ownText ? visitorsIn(ownText, since) : new Set<string>()
    for (const f of files) {
      if (f === appSite?.log) continue
      const have = this.visitors.get(f)
      if (have && Date.now() - have.at < 60 * MIN) continue
      const text = await this.readAccessLog(f)
      this.visitors.set(f, { at: Date.now(), ips: text ? visitorsIn(text, since, own) : new Set() })
    }
  }

  /** La fin d'un journal d'accès : lu directement, sinon avec sudo -n (jamais de mot de passe demandé), sinon rien. */
  private async readAccessLog(file: string): Promise<string> {
    try {
      return readEnd(file, 2_000_000)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EACCES' || Date.now() - this.sudoFailedAt < 6 * 60 * MIN || !which('sudo')) return ''
    }
    const r = await sh('sudo', ['-n', 'tail', '-c', '2000000', file], { timeout: 8000, maxBuffer: 4 << 20 })
    if (!r.ok) {
      this.sudoFailedAt = Date.now()
      return ''
    }
    return r.out
  }

  /** Estimation par le modèle, en un seul appel pour tous les logiciels dont les signaux ont changé (au plus toutes les 30 min). */
  private async estimate() {
    if (this.estimating || Date.now() - this.estimatedAt < 30 * MIN) return
    const todo = [...this.entries.values()].filter((e) => !this.fixes[e.key] && this.estimates[e.key]?.hash !== estimateHash(e.signals))
    if (!todo.length) return
    this.estimating = true
    this.estimatedAt = Date.now()
    try {
      const examples = Object.entries(this.fixes).map(([k, f]) => ({ id: k, phase: f.phase, percent: f.percent }))
      for (let i = 0; i < todo.length; i += 12) {
        const batch = todo.slice(i, i + 12)
        const items = batch.map((e) => ({
          id: e.key,
          name: e.sw.name,
          kind: e.sw.kind,
          blurb: e.sw.blurb ?? '',
          signals: { ...e.signals, firstAt: e.signals.firstAt ? new Date(e.signals.firstAt).toISOString().slice(0, 10) : '', lastAt: e.signals.lastAt ? new Date(e.signals.lastAt).toISOString().slice(0, 10) : '' },
          url: e.sw.url ?? '',
          hosts: e.sw.hosts,
          readme: (e.repoSig?.readmeText ?? '').replace(/\s+/g, ' ').slice(0, 800),
          commits: e.repoSig?.subjects ?? [],
          sessions: e.sessions.slice(-4).map((s) => ({ title: s.title.slice(0, 80), said: s.texts.slice(-3).map((x) => x.replace(/\s+/g, ' ').slice(0, 160)) })),
        }))
        const prompt = tr(M).estimatePrompt(user(), JSON.stringify(items), examples.length ? JSON.stringify(examples) : '')
        const raw = await askModel(prompt)
        const parsed = parseEstimates(raw, new Set(batch.map((e) => e.key)))
        for (const e of batch) {
          const x = parsed.get(e.key)
          if (!x) continue
          this.estimates[e.key] = { hash: estimateHash(e.signals), ...x, at: Date.now() }
          e.sw.progress = this.progressOf(e)
        }
        writeJson('progress.json', this.estimates)
      }
      console.log(`[logiciels] avancement estimé pour ${todo.length} logiciels`)
    } catch (err) {
      console.error(`[logiciels] estimation : ${(err as Error).message}`)
    } finally {
      this.estimating = false
    }
  }

  // ---------------------------------------------------------------- cadres et captures

  private async checkFrame(url: string) {
    this.frames.set(url, { at: Date.now(), ok: this.frames.get(url)?.ok ?? false })
    try {
      const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(3000) })
      void res.body?.cancel()
      this.frames.set(url, { at: Date.now(), ok: frameEmbeddable({ xfo: res.headers.get('x-frame-options'), csp: res.headers.get('content-security-policy') }, res.url || url, PUBLIC_URL || undefined) })
    } catch {
      // Pas de réponse (certificat d'un sous-domaine tout neuf, serveur qui démarre) : on réessaie dans 20 s, pas dans 1 h.
      this.frames.set(url, { at: Date.now() - 60 * MIN + 20_000, ok: false })
    }
    for (const e of this.entries.values()) if (e.sw.url === url) e.sw.embeddable = this.frames.get(url)!.ok
  }

  private shotTarget(e: Entry): string | undefined {
    // Jamais l'app weevils elle-même : par la boucle locale elle s'ouvrirait connectée (et réglerait la langue du serveur).
    if (e.sw.url && ownApp(e.sw.url, e)) return undefined
    if (e.sw.url?.startsWith('/')) return `http://127.0.0.1:${PORT}${e.sw.url}`
    if (e.sw.url) return e.sw.url
    if (e.sw.kind === 'web' && e.sw.run === 'running' && e.sw.port) return `http://127.0.0.1:${e.sw.port}`
    return undefined
  }
  private shotPath(e: Entry) {
    return path.join(SHOTS, `${crypto.createHash('sha1').update(e.sw.id + '\n' + (this.shotTarget(e) ?? '')).digest('hex').slice(0, 16)}.png`)
  }
  private shotAt(e: Entry): number | undefined {
    if (!this.shotTarget(e)) return undefined
    return mtime(this.shotPath(e)) || undefined
  }

  /** Chromium sans écran : PATH, puis le cache de Playwright. */
  private chrome(): string | null {
    if (this.chromeBin !== undefined) return this.chromeBin
    let found: string | null = null
    for (const b of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome-headless-shell', 'chrome']) if (!found) found = which(b)
    if (!found) {
      const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(HOME, '.cache', 'ms-playwright')
      try {
        const dirs = fs.readdirSync(cache).sort().reverse()
        for (const [prefix, bin] of [['chromium_headless_shell-', 'chrome-headless-shell'], ['chromium-', 'chrome']] as const) {
          for (const d of dirs.filter((x) => x.startsWith(prefix))) {
            for (const sub of fs.readdirSync(path.join(cache, d)).filter((x) => x.startsWith('chrome-'))) {
              const f = path.join(cache, d, sub, bin)
              if (!found && exists(f)) found = f
            }
          }
        }
      } catch {
        /* pas de Playwright */
      }
    }
    return (this.chromeBin = found)
  }

  /** Une capture à la fois, en fond, renouvelée après 15 min tant que la page a été ouverte récemment. */
  private async shots() {
    if (this.shooting || Date.now() - this.listAt > 5 * MIN) return
    const bin = this.chrome()
    if (!bin) return
    this.shooting = true
    try {
      const todo = [...this.entries.values()].filter((e) => this.shotTarget(e) && Date.now() - Math.max(mtime(this.shotPath(e)), mtime(this.shotPath(e) + '.none')) > 15 * MIN)
      for (const e of todo) {
        if (Date.now() - this.listAt > 5 * MIN) break
        const target = this.shotTarget(e)!
        const file = this.shotPath(e)
        fs.mkdirSync(SHOTS, { recursive: true })
        const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-shot-'))
        const out = path.join(profile, 'shot.png')
        const ok = await captureCdp(which('nice') ? ['nice', '-n', '10', bin] : [bin], target, out, profile)
        try {
          if (ok && exists(out) && fs.statSync(out).size > BLANK_SHOT_BYTES) {
            fs.copyFileSync(out, file + '.tmp')
            fs.renameSync(file + '.tmp', file)
            e.sw.shot = mtime(file)
          } else {
            // Rien de montrable (page blanche, erreur) : l'aperçu repasse en terminal, et on ne réessaie qu'au prochain tour.
            fs.rmSync(file, { force: true })
            fs.writeFileSync(file + '.none', '')
            e.sw.shot = undefined
            if (!ok) console.error(`[logiciels] capture de ${e.sw.name} impossible`)
          }
        } finally {
          fs.rmSync(profile, { recursive: true, force: true })
        }
      }
    } finally {
      this.shooting = false
    }
  }

  // ---------------------------------------------------------------- lancement

  /** Nom publié, unique : le nom du logiciel, sans écraser un site existant qui sert autre chose. */
  private slugFor(e: Entry, port?: number): string {
    const rec = this.runs[e.key]
    if (rec?.published) return rec.published.slug
    const taken = new Map(caddySites().map((s) => [s.name, s]))
    for (let i = 0; i < 50; i++) {
      const s = i === 0 ? e.slug : i === 1 ? `${e.slug}-dev` : `${e.slug}-${i}`
      const have = taken.get(s)
      if (!have || (port && have.proxies.some((p) => isLocalUpstream(p.host) && p.port === port))) return s
    }
    return `${e.slug}-${Date.now().toString(36)}`
  }

  /** Un tap : ouvre ce qui tourne, publie ce qui écoute sans adresse, sinon lance (en fond pour ce qui est lent).
   *  Deux taps rapprochés (double tap, téléphone et ordinateur) ne lancent qu'une fois : le second attend le premier. */
  async open(id: string): Promise<Software> {
    const cur = this.launching.get(id)
    if (cur) return cur
    const p = this.doOpen(id)
    this.launching.set(id, p)
    try {
      return await p
    } finally {
      this.launching.delete(id)
    }
  }

  private async doOpen(id: string): Promise<Software> {
    if (!this.at) await this.refresh()
    const e = this.entries.get(id)
    if (!e) throw new Error(tr(M).notFound)
    await this.runtime([e], true)
    const sw = e.sw
    if (sw.run === 'starting' || (sw.run === 'running' && sw.url)) return sw
    // Ce qui écoute sans adresse n'est publié que si c'est bien son interface : son port à lui, ou une page HTML.
    if (sw.run === 'running' && sw.port && !sw.url && sw.kind !== 'cli' && (sw.port === this.runs[e.key]?.port || sw.port === e.proj?.declared || (await servesHtml(sw.port)))) {
      await this.publish(e, sw.port)
      await this.runtime([e], true)
      return sw
    }
    if (sw.run === 'running' && (e.units.some((u) => u.active) || e.containers.some((c) => c.running))) return sw
    const l = sw.launch
    if (!l) throw new Error(tr(M).nothingToLaunch)
    const dir = e.mainDir
    if (l.how === 'unit') {
      const u = e.units.find((x) => !x.active) ?? e.units[0]
      await sh('systemctl', ['--user', 'start', u.name], { timeout: 15_000 })
      this.record(e, { key: e.key, how: 'unit', at: Date.now(), unit: u.name })
    } else if (l.how === 'docker') {
      const c = e.containers.find((x) => !x.running) ?? e.containers[0]
      await sh('docker', ['start', c.name], { timeout: 20_000 })
      this.record(e, { key: e.key, how: 'docker', at: Date.now(), container: c.name })
    } else if (l.how === 'help' && dir && e.proj?.bin) {
      const [cmd, ...args] = e.proj.bin.cmd
      const r = await sh(cmd, [...args, '--help'], { cwd: dir, timeout: 15_000, env: cleanEnv({ FORCE_COLOR: '0', NO_COLOR: '1' }) })
      const lines = tailLines(r.out + '\n' + r.err)
      if (lines.length) {
        this.help[e.key] = { at: Date.now(), lines }
        writeJson('help.json', this.help)
      }
    } else if (l.how === 'static' && dir && e.proj?.dist) {
      const slug = this.slugFor(e)
      if (which('expose')) {
        const r = await sh('expose', ['--static', slug, e.proj.dist], { timeout: 30_000 })
        if (r.ok) this.record(e, { key: e.key, how: 'static', at: Date.now(), published: { slug, via: 'expose' } })
      } else if (which('python3') && sw.port) {
        await this.spawnServer(e, ['python3', '-m', 'http.server', String(sw.port), '--bind', '127.0.0.1', '--directory', e.proj.dist], {}, false)
      }
    } else if ((l.how === 'dev' || l.how === 'start' || l.how === 'preview') && dir && e.plan) {
      if (!sw.port) throw new Error(tr(M).noPort)
      await this.spawnServer(e, e.plan.argv, e.plan.env, e.plan.install)
    } else throw new Error(tr(M).nothingToLaunch)
    await this.runtime([e], true)
    return sw
  }

  /** Une ligne de weevils à la fin du journal d'un lancement (le terminal de la page la montre). */
  private note(r: RunRecord, line: string) {
    if (!r.log) return
    try {
      fs.appendFileSync(r.log, `\n${line}\n`)
    } catch {
      /* journal parti */
    }
  }

  private record(e: Entry, r: RunRecord) {
    const prev = this.runs[e.key]
    this.runs[e.key] = { ...r, published: r.published ?? prev?.published }
    writeJson('runs.json', this.runs)
  }

  /** Serveur lancé dans son propre groupe de processus, sortie dans DATA_DIR/softwares/runs/<nom>.log (jamais dans les journaux
   *  des jobs de l'utilisateur : rien d'écrasé, pas de faux job 24/7) ; attend le port en fond, puis publie. */
  private async spawnServer(e: Entry, argv: string[], env: Record<string, string>, install: boolean) {
    const dir = e.mainDir!
    const port = e.sw.port!
    // Le port doit être libre : sinon on publierait ce qui l'occupe sous le nom de ce logiciel.
    if ((await listeners()).some((l) => l.port === port) || (await listening(port))) throw new Error(tr(M).portBusy(port))
    fs.mkdirSync(RUNS, { recursive: true })
    const log = path.join(RUNS, `${e.slug}.log`)
    const fd = fs.openSync(log, 'w')
    const q = (s: string) => (/^[\w./:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)
    const pm = e.proj?.pm ?? 'npm'
    const heavy = which('heavy') ? 'heavy ' : ''
    const installCmd = pm === 'npm' ? (exists(path.join(dir, 'package-lock.json')) ? 'npm ci --no-audit --no-fund || npm install --no-audit --no-fund' : 'npm install --no-audit --no-fund') : `${pm} install`
    const script = `${install ? `echo '$ ${installCmd.split(' ||')[0]}'; ${heavy}${installCmd.replace('|| ', `|| ${heavy}`)} || exit 1; ` : ''}echo '$ ${argv.map(q).join(' ').replace(/'/g, '')}'; exec ${argv.map(q).join(' ')}`
    // Un serveur node qui n'indique pas d'adresse n'écoute que sur 127.0.0.1 (préchargé, sans toucher au projet).
    const preload = this.bindLocal()
    const extra: Record<string, string> = { ...env }
    if (preload && argv[0] !== 'python3') extra.NODE_OPTIONS = `${process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + ' ' : ''}--require ${preload}`
    const child = spawn('sh', ['-c', script], { cwd: dir, detached: true, stdio: ['ignore', fd, fd], env: cleanEnv(extra) })
    fs.closeSync(fd)
    child.unref()
    const pid = child.pid
    const limit = install ? 600_000 : 120_000
    const rec: RunRecord = { key: e.key, how: e.sw.launch?.how ?? 'start', pid, ticks: pid ? startTicks(pid) : '', port, log, at: Date.now(), deadline: Date.now() + limit }
    this.record(e, rec)
    child.on('error', () => undefined)
    child.on('exit', (code) => {
      const r = this.runs[e.key]
      if (r?.pid !== pid) return
      r.endedAt = Date.now()
      r.exit = code
      writeJson('runs.json', this.runs)
    })
    e.logs.unshift({ file: log, at: Date.now() })
    this.watching.add(e.key)
    void (async () => {
      try {
        while (Date.now() < rec.deadline!) {
          const r = this.runs[e.key]
          if (r?.pid !== pid || r.endedAt || !pid) return
          // Il écoute quand le port est tenu par son groupe à lui, et seulement sur la boucle locale.
          const l = (await listeners()).filter((x) => x.port === port)
          if (l.some((x) => x.pids.some((p) => pgidOf(p) === pid))) {
            if (l.some((x) => wildcard(x.addr))) {
              this.note(r, tr(M).allInterfaces(port))
              await killGroup(pid)
              return
            }
            r.up = true
            writeJson('runs.json', this.runs)
            await this.publish(e, port)
            void this.refresh()
            return
          }
          await new Promise((res) => setTimeout(res, 1000))
        }
        // Trop long : on arrête ce qu'on a lancé, le terminal montre pourquoi.
        if (pid && this.runs[e.key]?.pid === pid) {
          this.note(rec, tr(M).tooLong)
          await killGroup(pid)
        }
      } finally {
        this.watching.delete(e.key)
      }
    })()
  }

  /** Le préchargement node qui lie les serveurs à 127.0.0.1 (écrit une fois dans DATA_DIR/softwares). */
  private bindLocal(): string | null {
    const f = path.join(DIR, 'bind-local.cjs')
    const src = [
      '// weevils : a server launched from the app listens on 127.0.0.1 only, whatever address it asks for.',
      "const net = require('net')",
      'const listen = net.Server.prototype.listen',
      "const any = (h) => h == null || h === '' || h === '0.0.0.0' || h === '::' || h === '::0'",
      'net.Server.prototype.listen = function (...a) {',
      "  if (typeof a[0] === 'number' || (typeof a[0] === 'string' && /^\\d+$/.test(a[0]))) {",
      "    if (typeof a[1] === 'string') { if (any(a[1])) a[1] = '127.0.0.1' } else a.splice(1, 0, '127.0.0.1')",
      "  } else if (a[0] && typeof a[0] === 'object' && a[0].port != null && a[0].path == null && any(a[0].host)) a[0] = { ...a[0], host: '127.0.0.1' }",
      '  return listen.apply(this, a)',
      '}',
      '',
    ].join('\n')
    try {
      if (read(f) !== src) {
        fs.mkdirSync(DIR, { recursive: true })
        fs.writeFileSync(f, src)
      }
      return /\s/.test(f) ? null : f
    } catch {
      return null
    }
  }

  /** Publie un port en https://<nom>.<domaine> : la commande expose, sinon un <nom>.caddy dans le dossier des sites (rechargé plus tard). */
  private async publish(e: Entry, port: number): Promise<void> {
    const slug = this.slugFor(e, port)
    // Déjà publié sur ce port (par l'utilisateur ou un lancement précédent) : rien à faire, et rien à retirer plus tard.
    if (caddySites().some((s) => s.name === slug && s.proxies.some((p) => isLocalUpstream(p.host) && p.port === port))) return
    if (which('expose')) {
      const r = await sh('expose', [slug, String(port)], { timeout: 30_000 })
      if (!r.ok) return void console.error(`[logiciels] expose ${slug} : ${r.err.slice(0, 200)}`)
      this.markPublished(e, { slug, via: 'expose' })
    } else if (EXPOSE_SITES_DIR && EXPOSE_DOMAIN) {
      try {
        fs.writeFileSync(path.join(EXPOSE_SITES_DIR, `${slug}.caddy`), `${slug}.${EXPOSE_DOMAIN} {\n\treverse_proxy localhost:${port}\n\tlog {\n\t\toutput file /var/log/caddy/${slug}.log\n\t}\n}\n`)
        this.markPublished(e, { slug, via: 'file' })
      } catch {
        /* dossier en lecture seule : pas d'adresse, le terminal et le port local suffisent */
      }
    }
  }

  /** Retient ce que weevils a publié (même pour un serveur qu'il n'a pas lancé) : l'arrêt le retirera. */
  private markPublished(e: Entry, p: NonNullable<RunRecord['published']>) {
    const rec = this.runs[e.key]
    if (rec) rec.published = p
    else this.runs[e.key] = { key: e.key, how: e.sw.launch?.how ?? 'start', at: Date.now(), published: p }
    writeJson('runs.json', this.runs)
  }

  private async unpublish(p: NonNullable<RunRecord['published']>) {
    if (p.via === 'expose' && which('expose')) await sh('expose', ['--rm', p.slug], { timeout: 30_000 })
    else if (p.via === 'file' && EXPOSE_SITES_DIR) fs.rmSync(path.join(EXPOSE_SITES_DIR, `${p.slug}.caddy`), { force: true })
  }

  /** Arrête seulement ce que weevils a lancé (son groupe de processus, son service, son conteneur), et retire ce qu'il a publié. */
  async stop(id: string): Promise<Software> {
    if (!this.at) await this.refresh()
    const e = this.entries.get(id)
    if (!e) throw new Error(tr(M).notFound)
    const rec = this.runs[e.key]
    if (!rec) throw new Error(tr(M).notOurs)
    // Le meneur vérifié (pid et date de départ), puis tout son groupe, enfants restés seuls compris.
    if (rec.pid && (alive(rec.pid, rec.ticks ?? '') || (!rec.endedAt && groupAlive(rec.pid)))) await killGroup(rec.pid)
    if (rec.unit) await sh('systemctl', ['--user', 'stop', rec.unit], { timeout: 15_000 })
    if (rec.container) await sh('docker', ['stop', rec.container], { timeout: 30_000 })
    if (rec.published) await this.unpublish(rec.published)
    delete this.runs[e.key]
    writeJson('runs.json', this.runs)
    await this.runtime([e], true)
    return e.sw
  }
}

const longest = (e: Entry, p: string) => Math.max(0, ...e.dirs.filter((d) => inside(p, d)).map((d) => d.length))

/** haiku (abonnement Claude), sinon codex exec avec un schéma de sortie. */
async function askModel(prompt: string): Promise<string> {
  if (which('claude')) {
    try {
      return await haiku(prompt, 120_000)
    } catch (e) {
      if (!which('codex')) throw e
    }
  }
  if (!which('codex')) throw new Error('no model') // i18n-ignore : journal seulement
  const work = path.join(DIR, 'estimate')
  fs.mkdirSync(work, { recursive: true })
  const schema = path.join(work, 'schema.json')
  const out = path.join(work, `out-${Date.now()}.json`)
  fs.writeFileSync(
    schema,
    JSON.stringify({
      type: 'object',
      additionalProperties: false,
      required: ['items'],
      properties: { items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'phase', 'percent', 'reason'], properties: { id: { type: 'string' }, phase: { type: 'integer' }, percent: { type: 'integer' }, reason: { type: 'string' } } } } },
    }),
  )
  const r = await sh('codex', ['exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '--output-schema', schema, '-o', out, '-c', 'model_reasoning_effort="low"', prompt], { cwd: work, timeout: 240_000, maxBuffer: 16 << 20 })
  try {
    if (!r.ok) throw new Error(r.err.slice(-300))
    return fs.readFileSync(out, 'utf8')
  } finally {
    fs.rmSync(out, { force: true })
  }
}

/** Réponse du modèle lue avec méfiance : JSON trouvé dans le texte, ids connus, phase 1-3, pourcentage 0-100, raison courte. */
export function parseEstimates(raw: string, ids: Set<string>): Map<string, { phase: Phase; percent: number; reason: string }> {
  const out = new Map<string, { phase: Phase; percent: number; reason: string }>()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return out
  let j: { items?: unknown }
  try {
    j = JSON.parse(raw.slice(start, end + 1)) as { items?: unknown }
  } catch {
    return out
  }
  if (!Array.isArray(j.items)) return out
  for (const x of j.items as Record<string, unknown>[]) {
    const id = String(x?.id ?? '')
    const phase = Number(x?.phase)
    const percent = Number(x?.percent)
    if (!ids.has(id) || ![1, 2, 3].includes(phase) || !Number.isFinite(percent)) continue
    out.set(id, { phase: phase as Phase, percent: clamp(percent, 0, 100), reason: String(x?.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) })
  }
  return out
}

// ================================================================ routes

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL, params: string[]) => Promise<void> | void
type Json = (res: http.ServerResponse, status: number, body: unknown) => void
type ReadBody = (req: http.IncomingMessage) => Promise<any>

/**
 * /api/softwares : la liste de toutes les machines (les autres via la fédération ; un weevilsd plus ancien, sans la route,
 * est sauté), puis par logiciel : capture, ouverture, arrêt, relecture, correction d'avancement. Le préfixe « <machine>: »
 * de l'id dit quelle machine répond.
 */
export function softwareRoutes(w: Weevils, json: Json, readBody: ReadBody): [string, RegExp, Handler][] {
  const sw = new Softwares(w)
  const machineOf = (r: Remote) => r.snap?.machines[0]?.id ?? r.id
  const remoteFor = (id: string) => {
    const m = id.slice(0, id.indexOf(':'))
    if (!m || m === MACHINE.id) return undefined
    return w.remotes.find((r) => machineOf(r) === m || r.id === m) ?? null
  }
  /** Id d'un logiciel de cette machine, seulement s'il est dans la liste actuelle. */
  const localId = async (id: string) => {
    if (!sw.has(id)) await sw.list()
    return sw.has(id)
  }
  const sort = (xs: Software[]) => xs.sort((a, b) => Number(b.run === 'running' || b.run === 'starting') - Number(a.run === 'running' || a.run === 'starting') || b.lastActivityAt - a.lastActivityAt)
  const forward = async (id: string, method: string, sub: string, body?: unknown): Promise<Software | undefined> => {
    const r = remoteFor(id)
    if (r === undefined) return undefined
    if (!r) throw new Error(tr(M).notFound)
    return r.call<Software>(method, `/api/softwares/${encodeURIComponent(id)}${sub}`, body)
  }
  const one = (method: string, sub: string, local: (id: string) => Promise<Software | undefined>): Handler => async (_req, res, _u, [raw]) => {
    const id = decodeURIComponent(raw)
    const far = await forward(id, method, sub)
    if (far) return json(res, 200, far)
    if (!(await localId(id))) return json(res, 404, { error: tr(M).notFound })
    const s = await local(id)
    s ? json(res, 200, s) : json(res, 404, { error: tr(M).notFound })
  }
  return [
    ['GET', /^\/api\/softwares$/, async (_req, res, url) => {
      const here = await sw.list()
      if (url.searchParams.has('local')) return json(res, 200, { softwares: here } satisfies SoftwareList)
      const far = await Promise.all(w.remotes.filter((r) => r.online).map((r) => r.call<SoftwareList>('GET', '/api/softwares?local=1').then((d) => d.softwares ?? []).catch(() => [] as Software[])))
      json(res, 200, { softwares: sort([...here, ...far.flat()]) } satisfies SoftwareList)
    }],
    ['GET', /^\/api\/softwares\/([^/]+)\/shot$/, async (_req, res, _u, [raw]) => {
      const id = decodeURIComponent(raw)
      const r = remoteFor(id)
      if (r) {
        try {
          const far = await fetch(`${r.url}/api/softwares/${encodeURIComponent(id)}/shot`, { signal: AbortSignal.timeout(10_000) })
          if (!far.ok) return json(res, 404, { error: tr(M).noShot })
          res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=60' })
          return void res.end(Buffer.from(await far.arrayBuffer()))
        } catch {
          return json(res, 404, { error: tr(M).noShot })
        }
      }
      if (r === null) return json(res, 404, { error: tr(M).noShot })
      const f = sw.has(id) ? sw.shotFile(id) : null
      if (!f) return json(res, 404, { error: tr(M).noShot })
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=60' })
      fs.createReadStream(f).pipe(res)
    }],
    ['POST', /^\/api\/softwares\/([^/]+)\/open$/, one('POST', '/open', (id) => sw.open(id))],
    ['POST', /^\/api\/softwares\/([^/]+)\/stop$/, one('POST', '/stop', (id) => sw.stop(id))],
    ['POST', /^\/api\/softwares\/([^/]+)\/progress$/, async (req, res, _u, [raw]) => {
      const id = decodeURIComponent(raw)
      const body = (await readBody(req)) as ProgressFix
      const fix: ProgressFix = { ...(body.reset ? { reset: true } : {}), ...(body.phase != null ? { phase: Number(body.phase) as Phase } : {}), ...(body.percent != null ? { percent: Number(body.percent) } : {}) }
      const far = await forward(id, 'POST', '/progress', fix)
      if (far) return json(res, 200, far)
      if (!(await localId(id))) return json(res, 404, { error: tr(M).notFound })
      json(res, 200, await sw.fix(id, fix))
    }],
    ['GET', /^\/api\/softwares\/([^/]+)$/, one('GET', '', (id) => sw.get(id))],
  ]
}
