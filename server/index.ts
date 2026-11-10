// weevilsd : API + flux temps réel pour l'app, et récepteur local des hooks Claude Code.
// Lancer : node server/index.ts (Node 22, TypeScript natif).

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { CONFIG_DIR, DATA_DIR, DIST_DIR, HOOK_PORT, HOST, MACHINE, ORCHESTRATOR, PORT } from './config.ts'
import { openaiKey, transcribe } from './transcribe.ts'
import { addChunk, clip, cue, finishUpload, logMarks, newShortcutToken, shortcutAuthed, shortcutToken, speakStream, voiceTurn } from './voicepipe.ts'
import { cartesia, cartesiaVoices } from './fast.ts'
import { Weevils } from './core.ts'
import { setLang, tr } from './i18n.ts'
import M from './i18n/api.ts'
import P from './i18n/push.ts'
import V from './i18n/voice.ts'
import { tipRoutes } from './tips.ts'
import { Hints, hintRoutes } from './hints.ts'
import { browserSafe, isLocal, trustedFrom } from './http.ts'
import { startMailBridge } from './mailbridge.ts'
import { explain, grepRepo, readExplain } from './explain.ts'
import { brief, detail as infraDetail, listDir, readAny, startInfra } from './infra.ts'
import { quotas, today as usageToday } from './usage.ts'
import type { InfraDetail, MachineBrief, MachineFacts, Reach, UsageRow } from '../shared/infra.ts'
import { facts } from './discover.ts'

const w = new Weevils()
w.start()
startInfra()
// Pont e-mail (agents externes) : sur la machine de l'orchestrateur, seulement si WEEVILS_MAIL_ADDRESS / _PASSWORD sont remplis.
if (ORCHESTRATOR) startMailBridge(w, DATA_DIR)

// ---------------------------------------------------------------- secret partagé (ce soir) → passkey (demain)

fs.mkdirSync(CONFIG_DIR, { recursive: true })
fs.mkdirSync(DATA_DIR, { recursive: true })
const SECRET_FILE = path.join(CONFIG_DIR, 'secret')
if (!fs.existsSync(SECRET_FILE)) fs.writeFileSync(SECRET_FILE, crypto.randomBytes(9).toString('base64url'), { mode: 0o600 })
const SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim()
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

const cookieToken = (req: http.IncomingMessage) => /(?:^|;\s*)wv=([\w-]+)/.exec(req.headers.cookie ?? '')?.[1]
const authed = (req: http.IncomingMessage) => {
  if (isLocal(req)) return true
  const t = cookieToken(req)
  return !!t && tokens.has(t)
}

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

const routes: [string, RegExp, Handler][] = [
  ['POST', /^\/api\/login$/, async (req, res) => {
    const body = await readBody(req)
    if (typeof body.secret !== 'string' || !sameCode(body.secret, SECRET)) {
      await new Promise((r) => setTimeout(r, 800))
      return json(res, 401, { error: tr(M).wrongCode })
    }
    const t = crypto.randomBytes(24).toString('base64url')
    tokens.add(t)
    saveTokens()
    // Secure seulement derrière HTTPS (Caddy envoie x-forwarded-proto) : sinon le navigateur jetterait le cookie en http simple.
    const secure = req.headers['x-forwarded-proto'] === 'https' ? ' Secure;' : ''
    res.setHeader('set-cookie', `wv=${t}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=31536000`)
    json(res, 200, { ok: true })
  }],
  ['GET', /^\/api\/me$/, (req, res) => json(res, 200, { authed: authed(req) })],
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
    const changed = setLang(body.lang)
    if (changed || !isLocal(req)) for (const r of w.remotes) if (r.online) void r.call('POST', '/api/prefs', { lang: body.lang }).catch(() => undefined)
    json(res, 200, { ok: true })
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
  ['GET', /^\/api\/sessions\/([^/]+)\/screen$/, async (_req, res, _u, [id]) => json(res, 200, { screen: await w.screen(decodeURIComponent(id)) })],
  ['POST', /^\/api\/sessions\/([^/]+)\/send$/, async (req, res, _u, [id]) => {
    const body = await readBody(req)
    // « from » (weevils, ou un auteur déclaré) n'est accepté que d'une requête locale (l'orchestrateur, la commande weevils), jamais du téléphone.
    json(res, 200, await w.send(decodeURIComponent(id), String(body.text ?? ''), trustedFrom(req, body)))
  }],
  ['POST', /^\/api\/sessions\/([^/]+)\/attach$/, async (req, res, _u, [id]) => {
    const body = await readBody(req, 24 << 20)
    const files = Array.isArray(body.files) ? body.files.filter((f: any) => typeof f?.data === 'string').map((f: any) => ({ name: String(f.name ?? 'photo'), type: String(f.type ?? 'image/jpeg'), data: String(f.data) })) : []
    json(res, 200, await w.attach(decodeURIComponent(id), String(body.text ?? ''), files))
  }],
  ['GET', /^\/api\/voices$/, async (_req, res) => json(res, 200, cartesia() ? { enabled: true, voices: await cartesiaVoices(), current: w.voiceId } : { enabled: false, voices: [] })],
  ['POST', /^\/api\/voices$/, async (req, res) => {
    w.setVoice(String((await readBody(req)).id ?? '') || undefined)
    json(res, 200, { ok: true })
  }],
  ['POST', /^\/api\/devil$/, async (req, res) => json(res, 200, await w.devil(String((await readBody(req)).text ?? '')))],
  // ---- Voix rapide : son en flux, accroches en cache, enregistrement envoyé en morceaux, mesures.
  ['GET', /^\/api\/speak\/stream$/, async (_req, res, url) => speakStream(res, url.searchParams.get('text') ?? '', url.searchParams.get('oral') === '1', url.searchParams.get('voice') || undefined)],
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
    json(res, 200, { text: await finishUpload(String(b.id), b.lang) })
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
        from: trustedFrom(req, body),
      }),
    )
  }],
  ['POST', /^\/api\/main$/, async (req, res) => {
    const body = await readBody(req)
    json(res, 200, await w.sendMain(String(body.text ?? '').trim()))
  }],
  ['POST', /^\/api\/sessions\/([^/]+)\/command$/, async (req, res, _u, [id]) => {
    const body = await readBody(req)
    json(res, 200, await w.command(decodeURIComponent(id), String(body.command ?? '')))
  }],
  ['POST', /^\/api\/main\/command$/, async (req, res) => {
    const body = await readBody(req)
    json(res, 200, await w.commandMain(String(body.command ?? '')))
  }],
  ['POST', /^\/api\/main\/attach$/, async (req, res) => {
    const body = await readBody(req, 48 << 20)
    const files = Array.isArray(body.files) ? body.files.filter((f: any) => typeof f?.data === 'string').map((f: any) => ({ name: String(f.name ?? ''), type: String(f.type ?? ''), data: String(f.data) })) : []
    json(res, 200, await w.attachMain(String(body.text ?? '').trim(), files))
  }],
  ['POST', /^\/api\/import$/, (req, res) => receiveImport(req, res)],
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
  ['GET', /^\/api\/repos\/([^/]+)\/file$/, async (_req, res, url, [repo]) => {
    const remote = w.remoteById(url.searchParams.get('machine') ?? undefined)
    const p = url.searchParams.get('path') ?? ''
    json(res, 200, remote ? await remote.call('GET', `/api/repos/${repo}/file?path=${encodeURIComponent(p)}`) : await w.file(decodeURIComponent(repo), p))
  }],
  ['GET', /^\/api\/repos\/([^/]+)\/grep$/, async (_req, res, url, [repo]) => json(res, 200, { hits: await grepRepo(w, decodeURIComponent(repo), url.searchParams.get('q') ?? '') })],
  // Vue d'un fichier : explique, où c'est utilisé, demande (haiku, avec le contexte de la page).
  ['POST', /^\/api\/explain$/, async (req, res) => json(res, 200, await explain(w, readExplain(await readBody(req))))],
  ['GET', /^\/api\/github\/repos$/, async (_req, res, url) => json(res, 200, { repos: await w.githubRepos(url.searchParams.has('fresh')) })],
  ['POST', /^\/api\/github\/repos$/, async (req, res) => {
    const body = await readBody(req)
    json(res, 200, await w.newRepo(String(body.name ?? '').trim(), String(body.description ?? '')))
  }],
  ['POST', /^\/api\/sessions\/([^/]+)\/close$/, async (_req, res, _u, [id]) => json(res, 200, await w.close(decodeURIComponent(id)))],
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
  ['GET', /^\/api\/usage\/today$/, async (_req, res, url) => {
    const sessions = new Map(w.snapshot().sessions.map((s) => [s.id, s]))
    const rows = usageToday((id) => sessions.get(id))
    if (url.searchParams.has('local')) return json(res, 200, { rows })
    const far = await Promise.all(w.remotes.filter((r) => r.online).map((r) => r.call<{ rows: UsageRow[] }>('GET', '/api/usage/today?local=1').then((d) => d.rows).catch(() => [])))
    json(res, 200, { rows: [...rows, ...far.flat()].sort((a, b) => b.weight - a.weight) })
  }],
  ...tipRoutes(w, json, readBody, () => !!openaiKey()),
  ...hintRoutes(new Hints(DATA_DIR), json, readBody),
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://local')
  try {
    if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname)
    // Le Raccourci Siri n'a pas de cookie : son jeton personnel n'ouvre que le tour de parole et le son qui va avec.
    const viaShortcut = /^\/api\/voice\/(turn|clip\/)/.test(url.pathname) && shortcutAuthed(req, url)
    if (!PUBLIC.has(url.pathname) && !viaShortcut && !authed(req)) return json(res, 401, { error: tr(M).signInRequired })
    for (const [method, re, handler] of routes) {
      const m = re.exec(url.pathname)
      if (m && req.method === method) return await handler(req, res, url, m.slice(1))
    }
    json(res, 404, { error: tr(M).unknownRoute })
  } catch (e) {
    json(res, 400, { error: (e as Error).message })
  }
})

server.listen(PORT, HOST, () => console.log(`weevilsd → http://${HOST}:${PORT}`))

// Hooks Claude Code : port séparé, local uniquement, pas d'authentification nécessaire. Une page web ouverte sur
// cette machine (Origin étrangère, DNS rebinding) ne peut pas y forger d'événements.
http
  .createServer(async (req, res) => {
    if (!browserSafe(req)) return void res.writeHead(403).end()
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
