// Qui parle au serveur : une requête « locale » (outil de cette machine avec son jeton, tunnel de fédération avec le
// jeton de l'autre machine) est de confiance, sans code. Module sans effet de bord (aucune lecture de config ; le jeton
// lui est donné par configureLocalAuth) : testable seul (server/http.test.ts).
import type http from 'node:http'
import { normalizeFrom } from './authors.ts'

const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
const LOOPBACK_HOST_RE = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i
/** En-têtes qu'ajoute un proxy (Caddy, nginx, tunnel) : leur présence veut dire que la requête vient d'ailleurs. */
// tailscale-user-* : tailscale serve, même s'il ne posait pas X-Forwarded-For.
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'forwarded', 'x-real-ip', 'tailscale-user-login', 'tailscale-user-name']

const header = (req: http.IncomingMessage, name: string) => {
  const v = req.headers[name]
  return Array.isArray(v) ? v[0] : v
}

/** Host d'une adresse de bouclage, sur n'importe quel port (la fédération arrive par un tunnel sur un autre port). */
const loopbackHost = (host: string | undefined) => LOOPBACK_HOST_RE.test(host ?? '')

/** Port d'un Host « hôte:port » (vide si absent : le port par défaut du schéma). */
const hostPort = (host: string) => /:(\d{1,5})$/.exec(host)?.[1] ?? ''

/**
 * Origin de bouclage ET même port que le Host : la page vient de ce serveur-ci (ou du serveur de dev de Vite, qui
 * relaie avec son propre Host, changeOrigin: false). Une page d'un autre serveur local (le vite d'un projet sur 4173,
 * l'aperçu d'un repo cloné) a un autre port : refusée.
 */
const loopbackOrigin = (origin: string, host: string) => {
  try {
    const u = new URL(origin)
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK_HOSTS.has(u.hostname) && u.port === hostPort(host)
  } catch {
    return false // « null » (iframe isolée, file://) ou valeur illisible
  }
}

/**
 * Contrôles côté navigateur : Host de bouclage (bloque le DNS rebinding), pas d'Origin étrangère, et pas de requête
 * cross-site sans Origin de bouclage (bloque une page web ouverte sur cette machine qui viserait 127.0.0.1).
 * Le proxy de Vite en dev transmet l'Origin et le Host http://127.0.0.1:4178 : acceptée.
 */
export function browserSafe(req: http.IncomingMessage): boolean {
  const host = header(req, 'host') ?? ''
  if (!loopbackHost(host)) return false
  const origin = header(req, 'origin')
  if (origin !== undefined && !loopbackOrigin(origin, host)) return false
  const site = header(req, 'sec-fetch-site')
  if ((site === 'cross-site' || site === 'same-site') && origin === undefined) return false
  return true
}

/**
 * Requête née sur cette machine : pair de bouclage, aucun en-tête de proxy, et contrôles navigateur ci-dessus. Ça ne
 * suffit plus à faire confiance (n'importe quel programme de la machine peut ouvrir 127.0.0.1) : voir isLocal.
 */
export function fromThisMachine(req: http.IncomingMessage): boolean {
  if (!LOOPBACK_PEERS.has(req.socket.remoteAddress ?? '')) return false
  if (PROXY_HEADERS.some((h) => req.headers[h] !== undefined)) return false
  return browserSafe(req)
}

/** The header a local caller of weevils (weevils-cli, weevils-update, the main machine of a federation, Vite's dev
 *  proxy) sends: the line of weevils' per-machine token file (DATA_DIR/local-token, 0600, created by weevilsd). */
export const LOCAL_TOKEN_HEADER = 'x-weevils-local'
/** The token from the token file's line (« X-Weevils-Local: <hex> »), or the bare token. */
export const parseLocalToken = (text: string): string => /^(?:x-weevils-local:\s*)?([0-9a-f]{32,128})\s*$/i.exec(text.trim())?.[1]?.toLowerCase() ?? ''

const internal = new WeakSet<http.IncomingMessage>()
/** A request weevilsd builds itself (the outbox replaying an intent it accepted, server/outbox-http.ts): local. */
export function markInternal(req: http.IncomingMessage) {
  internal.add(req)
}

let localAuth: { token: string; jailed?: (socket: http.IncomingMessage['socket']) => boolean } | null = null
/** weevilsd, at start: the machine's token, and how to recognise an automation's jail (server/jail-peer.ts), which
 *  cannot read the token and is let in without it, restricted to its own routes. Without it nothing is local. */
export function configureLocalAuth(a: { token: string; jailed?: (socket: http.IncomingMessage['socket']) => boolean } | null) {
  localAuth = a && a.token ? a : null
}

const tokenMatches = (req: http.IncomingMessage) => {
  const want = localAuth?.token
  const got = parseLocalToken(String(header(req, LOCAL_TOKEN_HEADER) ?? ''))
  if (!want || !got || got.length !== want.length) return false
  let diff = 0
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i)
  return diff === 0
}

/**
 * Requête de confiance sans le code d'accès : née sur cette machine (fromThisMachine) ET portant le jeton de la machine
 * (LOCAL_TOKEN_HEADER), que seul un programme qui lit les fichiers de l'utilisateur connaît. Exception : la prison
 * d'une automatisation (pas de jeton, elle ne voit pas DATA_DIR), reconnue à son espace de processus, et limitée
 * ailleurs à ses routes (server/jail-peer.ts jailedAllowed). Tout le reste présente le code (cookie).
 */
export function isLocal(req: http.IncomingMessage): boolean {
  if (internal.has(req)) return true
  if (!localAuth || !fromThisMachine(req)) return false
  return tokenMatches(req) || !!localAuth.jailed?.(req.socket)
}

/** Why a request from this machine is not trusted: 'missing' (no token: an old command, or a program that does not
 *  read the user's files), 'wrong' (a token from another install), or null when it is trusted or not from here. */
export function localTokenProblem(req: http.IncomingMessage): 'missing' | 'wrong' | null {
  if (!localAuth || !fromThisMachine(req) || isLocal(req)) return null
  return header(req, LOCAL_TOKEN_HEADER) === undefined ? 'missing' : 'wrong'
}

/** « from » (weevboss, un auteur déclaré) n'est accepté que d'une requête locale, jamais du téléphone. */
export function trustedFrom(req: http.IncomingMessage, body: { from?: unknown; sourceThread?: unknown } | null | undefined, sourceAuthor?: (id:string)=>string|undefined): string | undefined {
  if (!isLocal(req)) return undefined
  // Runtime provenance wins over an inherited WEEVILS_FROM or a signature supplied in the body.
  if (typeof body?.sourceThread === 'string' && body.sourceThread) return normalizeFrom(sourceAuthor?.(body.sourceThread)) ?? 'agent'
  return normalizeFrom(body?.from)
}

/** Only local, known runtime identity can become the source metadata signed before dispatch. */
export function trustedSource(req:http.IncomingMessage, body:{sourceThread?:unknown}|null|undefined, sourceAuthor:(id:string)=>string|undefined):string|undefined {
  return isLocal(req) && typeof body?.sourceThread==='string' && !!sourceAuthor(body.sourceThread) ? body.sourceThread : undefined
}

/**
 * Driven by a script: the app sends « x-weevils-automated: 1 » (« ?automated=1 » on its websocket) when the browser
 * says it is automated (navigator.webdriver: Playwright, Puppeteer, Selenium). A headless browser says so in its user agent.
 */
export function automated(req: http.IncomingMessage): boolean {
  if (header(req, 'x-weevils-automated') === '1') return true
  if (/HeadlessChrome\//.test(header(req, 'user-agent') ?? '')) return true
  return /[?&]automated=1(?:&|$)/.test(req.url ?? '')
}

/**
 * The user's own voice (what he writes or says to weevboss, his taps that speak for him): a browser signed in with the
 * access code (its wv cookie names a known device) and not automated. A loopback request is trusted for everything
 * else, but never speaks as the user: on 2026-11-14 test scripts on this machine sent questions to weevboss as if
 * the user had asked them. Pure: the caller says whether the cookie names a known device.
 */
export function userVoice(req: http.IncomingMessage, device: boolean): boolean {
  return device && !automated(req)
}
