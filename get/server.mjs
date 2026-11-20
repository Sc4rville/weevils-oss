// get — the public way in to weevils (https://get.scarville.tech). Someone opens the link on a phone or a computer,
// plugs in a machine (a VPS created for them at Hetzner, their own VPS, or this computer), watches it install, then
// lands on THEIR OWN weevils, where the existing onboarding (Claude Code or Codex sign-in, first steps) takes over.
//
// Security model (see get/README.md):
// - Nothing is stored: jobs live in memory and expire (7 days after the end at most); no database, no file, no log of
//   a request body. A restart hands them to the next run through a file in RAM.
// - A Hetzner API token never reaches this service: the page calls Hetzner's API from the person's browser
//   (get/hetzner.js) and tells this service only the new server's id, address and size.
// - No password, key or token ever reaches this service, and no route takes one: a VPS (or a Hetzner server whose
//   setup was lost) runs the same one-line install command as a computer, pasted by the person in its own terminal.
// - After the install this service has no access to the machine: it never had an SSH key, a token or a tunnel. The
//   new weevils is served by the user's machine itself (its own HTTPS), not proxied here.
// - The access code never reaches this service: the page generates an RSA key pair, the install encrypts the login
//   link with the public half, and this service only relays the ciphertext. To come back from another browser, the
//   page also leaves its private half here, encrypted with a key derived from a secret that only its resume link
//   (#job=<sid>.<secret>, never sent to a server) holds.
// - No code from visitors runs here, and this service starts no program at all.
// - Rate limits per client address and per job.
//
// Run: node get/server.mjs (env below). Zero dependencies beyond Node 22.

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SIZES } from './hetzner.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export function config(env = process.env) {
  return {
    port: Number(env.GET_PORT || 4182),
    host: env.GET_HOST || '127.0.0.1',
    base: (env.GET_BASE || 'https://get.scarville.tech').replace(/\/$/, ''),
    /** Until the public launch: every page and API call needs this key once (?k=…, then a cookie). */
    previewKey: env.GET_PREVIEW_KEY || '',
    /** Where get keeps its anonymous stats (<data>/stats, one file a day, kept 90 days). */
    data: env.GET_DATA || path.join(os.homedir(), '.local', 'share', 'weevils-get'),
    /** The weevils on this machine (http://127.0.0.1:4179): a word in its « for you » at each install, and each day. */
    notify: (env.GET_NOTIFY || '').replace(/\/$/, ''),
    /** Tests only: count visits from this machine and private addresses too (real visits come through Caddy). */
    statsLocal: env.GET_STATS_LOCAL === '1',
    /** The private stats page, /stats/<key> (off without a key). */
    statsKey: env.GET_STATS_KEY || '',
    /** « N people already run weevils » on the page: off unless GET_PUBLIC_COUNT=1. */
    publicCount: env.GET_PUBLIC_COUNT === '1',
    repo: env.GET_REPO || 'https://github.com/Sc4rville/weevils-oss.git',
    /** The public repository the page links to, once GitHub says it is public (the API asked without credentials). */
    codeUrl: (env.GET_CODE_URL || 'https://github.com/Sc4rville/weevils-oss').replace(/\/$/, ''),
    githubApi: (env.GET_GITHUB_API || 'https://api.github.com').replace(/\/$/, ''),
    /** A git bundle served to the installs while the repository is private (see get/make-bundle.sh). */
    bundle: env.GET_BUNDLE || '',
    /** Tests only: private addresses accepted as machine addresses, and the URL their weevils will have (ip=url,…). */
    allowTargets: (env.GET_ALLOW_TARGETS || '').split(',').map((s) => s.trim()).filter(Boolean),
    targetUrls: Object.fromEntries((env.GET_TARGET_URLS || '').split(',').filter((s) => s.includes('=')).map((s) => s.split('=').map((x) => x.trim()))),
    installer: env.GET_INSTALLER || path.join(HERE, '..', 'install.sh'),
    trustProxy: env.GET_TRUST_PROXY !== '0',
    /** Where a stopping service hands its setups in progress to the next one: a RAM file ('' : none). */
    handoff: env.GET_HANDOFF ?? (fs.existsSync('/dev/shm') ? path.join('/dev/shm', `weevils-get-${process.getuid?.() ?? 'user'}.jobs`) : ''),
  }
}

// ---------------------------------------------------------------- small helpers

const id = (n = 18) => crypto.randomBytes(n).toString('base64url')
/** Short, typeable, unambiguous: the PC command carries it. */
const sidOf = () => Array.from(crypto.randomBytes(10), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('')
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

export function publicAddress(ip) {
  if (net.isIP(ip) === 4) {
    const [a, b, c] = ip.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113))
  }
  if (net.isIP(ip) === 6) {
    if (ip.includes('.') || ip.includes('%')) return false
    const halves = ip.toLowerCase().split('::')
    const left = halves[0] ? halves[0].split(':') : []
    const right = halves[1] ? halves[1].split(':') : []
    const parts = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left
    const [a, b] = parts.map((x) => parseInt(x, 16))
    return a >= 0x2000 && a <= 0x3fff && !(a === 0x2001 && (b <= 0x1ff || b === 0xdb8)) && a !== 0x2002 && !(a === 0x3fff && b < 0x1000)
  }
  return false
}

/** 1.2.3.4 → 1-2-3-4.sslip.io: a name that resolves to the machine, so Caddy gets it a real certificate. */
export const sslip = (ip) => (net.isIP(ip) === 4 ? ip.replace(/\./g, '-') : ip.replace(/:/g, '-')) + '.sslip.io'

/** The installer's step titles (English and French), read from install.sh: the only lines an install reports. */
export function stepTitles(installer) {
  const src = fs.readFileSync(installer, 'utf8')
  const titles = {}
  // Two spellings of the same table: EN[s_source]="…" (bash 4 arrays) and EN_s_source="…" (the installer that also
  // runs under macOS's bash 3.2).
  for (const m of src.matchAll(/^(?:EN|FR)(?:_|\[)(s_[a-z]+|waiting|ready|almost_login|almost_install)\]?="([^"]+)"$/gm)) titles[m[2]] = m[1]
  return titles
}

class Limiter {
  constructor() { this.hits = new Map() }
  /** true when key may act again: at most n times per window (ms). */
  ok(key, n, windowMs) {
    const now = Date.now()
    const list = (this.hits.get(key) || []).filter((t) => now - t < windowMs)
    if (list.length >= n) return this.hits.set(key, list), false
    list.push(now)
    this.hits.set(key, list)
    if (this.hits.size > 20000) for (const [k, v] of this.hits) if (!v.some((t) => now - t < 3600_000)) this.hits.delete(k)
    return true
  }
}

// ---------------------------------------------------------------- jobs (memory only)

// How long a setup is kept after its last sign of life: one that never started, a few hours; one creating or
// installing a server, a day; a finished one, 7 days, so its page (or its resume link) still shows the new weevils'
// link. After the first login on that weevils (it says so once, see /r/), its link stays an hour more, then goes.
const TTL = { waiting: 6 * 3600_000, running: 24 * 3600_000, ended: 7 * 24 * 3600_000 }
const CLAIM_GRACE = 3600_000
const MAX_JOBS = 5000
const STEPS = ['created', 'start', 's_system', 's_source', 's_config', 's_build', 's_service', 's_https', 'tunnel', 'waiting', 'done']
/** The bootstrap this service hands out asks for the page's current key before sealing the link (see /k/). */
const BOOTSTRAP_V = 2

export function createStore() {
  const jobs = new Map()
  const ttl = (j) => (j.state === 'done' || j.state === 'failed' ? TTL.ended : j.server || j.creating ? TTL.running : TTL.waiting)
  const alive = (j, now = Date.now()) => now - j.touched < ttl(j)
  const sweep = () => {
    const now = Date.now()
    for (const [k, j] of jobs) {
      if (!alive(j, now)) jobs.delete(k)
      else if (j.claimed && now - j.claimed > CLAIM_GRACE && (j.result?.sealed || j.wrapped)) {
        if (j.result) j.result.sealed = ''
        j.wrapped = ''
      }
    }
  }
  return {
    jobs,
    alive,
    /** Pairs a visit with the setups it started (same address and browser), without keeping either: see nearOf. */
    salt: id(16),
    create(kind, lang, pub, extra = {}) {
      sweep()
      if (jobs.size >= MAX_JOBS) {
        // Full: the setups that never started go first, oldest first.
        const idle = [...jobs.values()].filter((j) => j.state === 'waiting' && !j.server && !j.creating).sort((a, b) => a.touched - b.touched)
        for (const j of idle.slice(0, jobs.size - MAX_JOBS + 1)) jobs.delete(j.sid)
        if (jobs.size >= MAX_JOBS) return null
      }
      const j = {
        sid: sidOf(), view: extra.view || id(), wrapped: extra.wrapped || '', near: extra.near || '', kind, lang, pub, reach: '', mode: kind === 'pc' ? 'pc' : 'vps',
        state: 'waiting', step: 'created', steps: [], error: '', result: null, server: null, created: Date.now(), touched: Date.now(), scriptFetches: 0, reports: 0,
        creating: false, createError: '', claimed: 0, bv: 0,
      }
      jobs.set(j.sid, j)
      return j
    },
    get: (sid) => (typeof sid === 'string' ? jobs.get(sid) : undefined),
    sweep,
  }
}

/** A restart (main moved: get/follow-main.sh) keeps the setups: the stopping service hands them to the next one
 * through a file in RAM (/dev/shm, mode 600), read once and deleted at start; never the disk. No secret is in a setup
 * (tokens and passwords are never kept), only its state, the page's public key, the sealed link and the page's sealed
 * key (neither opens without what only the page holds). */
export function saveJobs(store, file) {
  if (!file) return 0
  const live = [...store.jobs.values()].filter((j) => store.alive(j))
  fs.writeFileSync(file, JSON.stringify({ v: 2, salt: store.salt, jobs: live }), { mode: 0o600 })
  return live.length
}
export function loadJobs(store, file) {
  if (!file) return 0
  try {
    const fresh = Date.now() - fs.statSync(file).mtimeMs < 10 * 60_000
    const data = fresh ? JSON.parse(fs.readFileSync(file, 'utf8')) : []
    // Before v2: a plain list of setups.
    const jobs = Array.isArray(data) ? data : Array.isArray(data?.jobs) ? data.jobs : []
    if (typeof data?.salt === 'string' && data.salt.length >= 16) store.salt = data.salt
    let n = 0
    for (const j of jobs) {
      if (typeof j?.sid !== 'string' || store.jobs.has(j.sid)) continue
      const k = { createError: '', claimed: 0, bv: 0, wrapped: '', near: '', ...j }
      // Cut short by the restart (a call to the host still running): the page says so, and its next try finds the
      // server if the host made it (see `existing`).
      if (k.creating && !k.server) k.createError ||= 'interrupted'
      k.creating = false
      store.jobs.set(k.sid, k)
      n++
    }
    return n
  } catch {
    return 0
  } finally {
    fs.rmSync(file, { force: true })
  }
}

/** Is the public repository open yet (GET_CODE_URL, default github.com/Sc4rville/weevils-oss)? GitHub's API, asked
 * without credentials at most every 5 minutes and never waited for: until it says so, the page claims nothing (« Open
 * source soon »), and the install works the same either way. */
export function watchCode(cfg) {
  let known = { at: 0, open: false, asking: false }
  const slug = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)\/?$/.exec(cfg.codeUrl)?.[1]
  return () => {
    if (slug && !known.asking && Date.now() - known.at > 5 * 60_000) {
      known.asking = true
      fetch(`${cfg.githubApi}/repos/${slug}`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'weevils-get' }, signal: AbortSignal.timeout(5000) })
        .then(async (r) => (r.ok ? (await r.json())?.private === false : r.status === 404 ? false : known.open))
        .catch(() => known.open)
        .then((open) => (known = { at: Date.now(), open: !!open, asking: false }))
    }
    return known.open
  }
}

/** What the page sees: never the view token, the public key or anything sent by the user. */
const view = (j) => ({
  sid: j.sid, kind: j.kind, state: j.state, step: j.step, steps: j.steps, error: j.error, result: j.result, server: j.server, reach: j.reach,
  creating: !!j.creating, createError: j.createError || '', created: j.created, claimed: !!j.claimed,
})
/** Seen from another visit of the same browser (same address and browser, nothing else to prove it): how far it is,
 * nothing that identifies the machine, opens it, or links to it. */
const glimpse = (j) => ({ kind: j.kind, state: j.state, step: j.step, steps: j.steps, created: j.created, creating: !!j.creating })

// ---------------------------------------------------------------- anonymous stats (counters only, kept 90 days)

const KINDS = ['hetzner', 'ssh', 'pc']
const STAT_KEEP_DAYS = 90
const dayOf = (t = Date.now()) => new Date(t).toISOString().slice(0, 10)
const KEY_SHA = (k) => crypto.createHash('sha256').update(String(k)).digest()

/** Who fetches a page to draw a link's preview: the link was pasted there (counted apart, never as a visit). */
const PREVIEWERS = [
  ['imessage', /facebookexternalhit\/1\.1 Facebot Twitterbot\/1\.0/],
  ['whatsapp', /WhatsApp\//],
  ['twitter', /Twitterbot/],
  ['facebook', /facebookexternalhit|Facebot|meta-externalagent/],
  ['telegram', /TelegramBot/],
  ['slack', /Slackbot/],
  ['discord', /Discordbot/],
  ['linkedin', /LinkedInBot/],
  ['bluesky', /Bluesky|cardyb/],
  ['mastodon', /Mastodon/],
]
export const previewerOf = (ua) => PREVIEWERS.find(([, re]) => re.test(String(ua || '')))?.[0] || ''
export const BOT = /bot\b|crawl|spider|slurp|headless|lighthouse|preview|fetch|curl|wget|python|node-fetch|go-http/i

/** Where a visit comes from: the app it was opened in, else the referring site. iMessage and WhatsApp send none: they
 * count as « direct » (their link previews say where the link was pasted). */
export function sourceOf(ref, ua) {
  ua = String(ua || '')
  if (/Twitter for i(Phone|Pad)|TwitterAndroid/.test(ua)) return 'twitter'
  if (/Instagram/.test(ua)) return 'instagram'
  if (/FBAN|FBAV|FB_IAB|FBIOS/.test(ua)) return 'facebook'
  if (/LinkedInApp/.test(ua)) return 'linkedin'
  let h = ''
  try {
    h = new URL(String(ref || '')).hostname.toLowerCase()
  } catch {
    /* no referrer */
  }
  if (!h || /(^|\.)scarville\.tech$/.test(h)) return 'direct'
  const sites = [
    ['twitter', /(^|\.)(t\.co|twitter\.com|x\.com)$/], ['whatsapp', /whatsapp/], ['instagram', /(^|\.)instagram\.com$/],
    ['facebook', /(^|\.)(facebook\.com|fb\.com|fb\.me)$/], ['linkedin', /(^|\.)(linkedin\.com|lnkd\.in)$/], ['reddit', /(^|\.)reddit\.com$/],
    ['hackernews', /(^|\.)news\.ycombinator\.com$/], ['telegram', /(^|\.)(t\.me|telegram\.org)$/], ['github', /(^|\.)github\.com$/],
    ['bluesky', /(^|\.)bsky\.app$/], ['search', /(^|\.)(google|bing|duckduckgo|qwant|ecosia|yahoo|brave|startpage)\./],
  ]
  return sites.find(([, re]) => re.test(h))?.[0] || 'other'
}

export function deviceOf(ua, touch) {
  ua = String(ua || '')
  if (/iPad|Tablet|Silk/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua)) || (/Macintosh/.test(ua) && touch)) return 'tablet'
  if (/iPhone|iPod/.test(ua)) return 'iphone'
  if (/Android/.test(ua)) return 'android'
  if (/Macintosh|Mac OS X/.test(ua)) return 'mac'
  if (/Windows/.test(ua)) return 'windows'
  if (/CrOS|Linux|X11/.test(ua)) return 'linux'
  return 'other'
}

/** Roughly which country, from the page's time zone and the system's tz database: no address, no outside service. */
let ZONES
export function countryOf(tz) {
  ZONES ??= (() => {
    const zones = new Map()
    try {
      for (const l of fs.readFileSync('/usr/share/zoneinfo/zone.tab', 'utf8').split('\n')) {
        const [cc, , zone] = l.split('\t')
        if (cc && zone && cc[0] !== '#') zones.set(zone.trim(), cc)
      }
      // Old names a browser may still give (Asia/Calcutta → Asia/Kolkata).
      for (const l of fs.readFileSync('/usr/share/zoneinfo/tzdata.zi', 'utf8').split('\n')) {
        const [k, target, name] = l.split(' ')
        if (k === 'L' && zones.has(target) && !zones.has(name)) zones.set(name, zones.get(target))
      }
    } catch {
      /* no tz database: every country is unknown */
    }
    return zones
  })()
  return (typeof tz === 'string' && ZONES.get(tz)) || '??'
}

export const total = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0)
export const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch {
    return null
  }
}
export function writeJson(f, data) {
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 })
  const tmp = `${f}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, f)
}

/** The install register (<data>/installs.csv): time, host, rough country, installed version, an anonymous id drawn
 * at random (tied to nothing), and where the line comes from (live, or rebuilt from Caddy's log). */
export const REGISTER_HEAD = 'time,host,country,version,id,origin'
const REGISTER_HOSTS = { hostinger: 'Hostinger', hetzner: 'Hetzner', ssh: 'own VPS', pc: 'computer' }
export function appendInstall(file, { time, kind, country, version, origin }) {
  const id = Array.from(crypto.randomBytes(8), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('')
  const row = [time, REGISTER_HOSTS[kind] || '?', /^[A-Z]{2}$/.test(country || '') ? country : '??', /^[0-9a-f]{7,12}$/.test(version || '') ? version : '', id, origin === 'log' ? 'log' : 'live']
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.appendFileSync(file, (fs.existsSync(file) ? '' : REGISTER_HEAD + '\n') + row.join(',') + '\n', { mode: 0o600 })
}
let INSTALLS = { at: -1, n: 0 }
function countInstalls(file) {
  try {
    const st = fs.statSync(file)
    if (st.mtimeMs !== INSTALLS.at) INSTALLS = { at: st.mtimeMs, n: fs.readFileSync(file, 'utf8').split('\n').filter((l) => l && l !== REGISTER_HEAD).length }
    return INSTALLS.n
  } catch {
    return 0
  }
}

/** Anonymous counters, one file a day in <data>/stats, kept 90 days: visits, visitors, where they came from, what
 * device, roughly which country, link previews, the funnel (option picked → install started → installed → phone
 * switched to its weevils) and code downloads. A visitor is told apart by a hash of their address and browser with a
 * salt that only lives in memory and changes every day: neither the hashes nor the salt are ever written, so nothing
 * stored leads back to anyone. */
export function createStats(cfg, { onInstalled, onDay } = {}) {
  const dir = path.join(cfg.data, 'stats')
  const fileOf = (d) => path.join(dir, `${d}.json`)
  const blank = (day) => ({ day, visits: 0, visitors: 0, sources: {}, devices: {}, countries: {}, previews: {}, chose: {}, started: {}, succeeded: {}, switched: {}, bundles: 0, updates: 0 })
  const read = (d) => {
    try {
      return { ...blank(d), ...JSON.parse(fs.readFileSync(fileOf(d), 'utf8')), day: d }
    } catch {
      return blank(d)
    }
  }
  const regFile = path.join(cfg.data, 'installs.csv')
  const recFile = path.join(cfg.data, 'records.json')
  let records = readJson(recFile) || {}
  let cur = read(dayOf())
  let salt = crypto.randomBytes(32)
  let seen = new Set()
  let dirty = false
  const bump = (o, k) => (o[k] = (o[k] || 0) + 1)
  const flush = () => {
    if (!dirty) return
    try {
      writeJson(fileOf(cur.day), cur)
      // The records: the best day for visits and for installs, kept for good.
      let better = false
      for (const [k, n] of [['visits', cur.visits], ['installs', total(cur.succeeded)]]) if (n > (records[k]?.n || 0)) (records[k] = { day: cur.day, n }), (better = true)
      if (better) writeJson(recFile, records)
      dirty = false
    } catch (e) {
      console.error(`[get] stats: ${e.code || e.name}`)
    }
  }
  const prune = () => {
    const limit = dayOf(Date.now() - STAT_KEEP_DAYS * 86400_000)
    try {
      for (const f of fs.readdirSync(dir)) if (/^\d{4}-\d\d-\d\d\.json$/.test(f) && f.slice(0, 10) < limit) fs.rmSync(path.join(dir, f), { force: true })
    } catch {
      /* no stats yet */
    }
  }
  /** A new day: the last one is written for good; its salt and its visitors' hashes are forgotten. */
  const roll = () => {
    const d = dayOf()
    if (d === cur.day) return
    flush()
    const done = cur
    cur = read(d)
    salt = crypto.randomBytes(32)
    seen = new Set()
    prune()
    onDay?.(done)
  }
  prune()
  const timer = setInterval(() => (roll(), flush()), 60_000)
  timer.unref?.()
  const count = (f) => (roll(), f(), (dirty = true))
  return {
    visit({ ip, ua, ref, tz, touch }) {
      count(() => {
        cur.visits++
        const h = crypto.createHash('sha256').update(salt).update(String(ip)).update('\0').update(String(ua || '')).digest('base64url').slice(0, 16)
        if (!seen.has(h) && seen.size < 200_000) seen.add(h), cur.visitors++
        bump(cur.sources, sourceOf(ref, ua))
        bump(cur.devices, deviceOf(ua, touch))
        bump(cur.countries, countryOf(tz))
      })
    },
    preview: (who) => count(() => bump(cur.previews, who)),
    step(name, kind) {
      if (!['chose', 'started', 'switched'].includes(name) || !KINDS.includes(kind)) return
      count(() => bump(cur[name], kind))
    },
    /** A successful install: counted, and a line in the register (appended, never rewritten, backed up daily). */
    succeeded(kind, { country, version } = {}) {
      if (!KINDS.includes(kind)) return
      count(() => bump(cur.succeeded, kind))
      try {
        appendInstall(regFile, { time: new Date().toISOString(), kind, country, version, origin: 'live' })
      } catch (e) {
        console.error(`[get] register: ${e.code || e.name}`)
      }
      flush()
      onInstalled?.(kind, cur)
    },
    /** The code downloaded: by an install (its setup), or by an installed weevils updating itself. */
    bundle: (update = false) => count(() => (update ? cur.updates++ : cur.bundles++)),
    flush,
    today: () => cur,
    records: () => records,
    installs: () => countInstalls(regFile),
    stop: () => clearInterval(timer),
  }
}

/** The last `days` days of stats, oldest first (today included), from the files. */
export function readStats(cfg, days = 7) {
  const out = []
  for (let i = days - 1; i >= 0; i--) {
    const d = dayOf(Date.now() - i * 86400_000)
    try {
      out.push({ day: d, ...JSON.parse(fs.readFileSync(path.join(cfg.data, 'stats', `${d}.json`), 'utf8')) })
    } catch {
      /* nothing that day */
    }
  }
  return out
}

const STAT_WORDS = {
  en: {
    kinds: { hostinger: 'Hostinger', hetzner: 'Hetzner', ssh: 'own VPS', pc: 'computer' },
    sources: { direct: 'direct or messages', twitter: 'Twitter/X', whatsapp: 'WhatsApp', instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn', reddit: 'Reddit', hackernews: 'Hacker News', telegram: 'Telegram', github: 'GitHub', bluesky: 'Bluesky', search: 'search', other: 'other sites' },
    devices: { iphone: 'iPhone', android: 'Android', tablet: 'tablet', mac: 'Mac', windows: 'Windows', linux: 'Linux', other: 'other' },
    previews: { imessage: 'iMessage', whatsapp: 'WhatsApp or Signal', twitter: 'Twitter/X', facebook: 'Facebook', telegram: 'Telegram', slack: 'Slack', discord: 'Discord', linkedin: 'LinkedIn', bluesky: 'Bluesky', mastodon: 'Mastodon' },
    installed: { hostinger: 'Someone just installed weevils via Hostinger.', hetzner: 'Someone just installed weevils via Hetzner.', ssh: 'Someone just installed weevils on their own VPS.', pc: 'Someone just installed weevils on their computer.' },
    today: (n) => `${n} installs today.`,
    head: (when, v, u) => `tryweevils ${when}: ${v} visit${v === 1 ? '' : 's'}, about ${u} visitor${u === 1 ? '' : 's'}.`,
    from: 'From', devicesWord: 'On', countries: 'Countries (by time zone)',
    funnel: (c, s, i, w) => `Funnel: ${c} picked an option → ${s} started an install → ${i} installed → ${w} opened their weevils.`,
    bundles: (n, u) => `${n} code download${n === 1 ? '' : 's'} by installs${u ? `, ${u} by updates` : ''}.`, shared: 'Link previews', none: 'nobody yet',
  },
  fr: {
    kinds: { hostinger: 'Hostinger', hetzner: 'Hetzner', ssh: 'son VPS', pc: 'ordinateur' },
    sources: { direct: 'direct ou messagerie', twitter: 'Twitter/X', whatsapp: 'WhatsApp', instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn', reddit: 'Reddit', hackernews: 'Hacker News', telegram: 'Telegram', github: 'GitHub', bluesky: 'Bluesky', search: 'recherche', other: 'autres sites' },
    devices: { iphone: 'iPhone', android: 'Android', tablet: 'tablette', mac: 'Mac', windows: 'Windows', linux: 'Linux', other: 'autre' },
    previews: { imessage: 'iMessage', whatsapp: 'WhatsApp ou Signal', twitter: 'Twitter/X', facebook: 'Facebook', telegram: 'Telegram', slack: 'Slack', discord: 'Discord', linkedin: 'LinkedIn', bluesky: 'Bluesky', mastodon: 'Mastodon' },
    installed: { hostinger: 'Quelqu’un vient d’installer weevils via Hostinger.', hetzner: 'Quelqu’un vient d’installer weevils via Hetzner.', ssh: 'Quelqu’un vient d’installer weevils sur son propre VPS.', pc: 'Quelqu’un vient d’installer weevils sur son ordinateur.' },
    today: (n) => `${n} installations aujourd’hui.`,
    head: (when, v, u) => `tryweevils ${when} : ${v} visite${v > 1 ? 's' : ''}, environ ${u} visiteur${u > 1 ? 's' : ''}.`,
    from: 'Provenance', devicesWord: 'Appareils', countries: 'Pays (par fuseau horaire)',
    funnel: (c, s, i, w) => `Entonnoir : ${c} ont choisi une option → ${s} ont lancé l’installation → ${i} l’ont réussie → ${w} ont ouvert leur weevils.`,
    bundles: (n, u) => `${n} téléchargement${n > 1 ? 's' : ''} du code par des installations${u ? `, ${u} par des mises à jour` : ''}.`, shared: 'Aperçus du lien', none: 'personne encore',
  },
}

/** Stats in a few sentences (one day for the daily word, or several summed). Visitors of several days are summed: a
 * returning visitor counts once a day. */
export function describeStats(list, lang = 'en', when = '') {
  const W = STAT_WORDS[lang] || STAT_WORDS.en
  const sum = (k) => list.reduce((n, d) => n + (d[k] || 0), 0)
  const merge = (k) => list.reduce((o, d) => (Object.entries(d[k] || {}).forEach(([x, n]) => (o[x] = (o[x] || 0) + n)), o), {})
  const total = (o) => Object.values(o).reduce((a, b) => a + b, 0)
  const top = (o, names = {}, n = 4) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${names[k] || k} ${v}`).join(' · ')
  const [chose, started, succeeded, switched, previews] = ['chose', 'started', 'succeeded', 'switched', 'previews'].map(merge)
  const byKind = (o) => (total(o) ? ` (${top(o, W.kinds)})` : '')
  const lines = [W.head(when || (list.length === 1 ? list[0].day : `${list[0]?.day ?? ''} → ${list.at(-1)?.day ?? ''}`), sum('visits'), sum('visitors'))]
  if (sum('visits')) lines.push(`${W.from}: ${top(merge('sources'), W.sources)}. ${W.devicesWord}: ${top(merge('devices'), W.devices)}. ${W.countries}: ${top(merge('countries'), {}, 5)}.`)
  lines.push(W.funnel(`${total(chose)}${byKind(chose)}`, `${total(started)}${byKind(started)}`, `${total(succeeded)}${byKind(succeeded)}`, total(switched)))
  lines.push(W.bundles(sum('bundles'), sum('updates')) + (total(previews) ? ` ${W.shared}: ${top(previews, W.previews)}.` : ''))
  return lines.join('\n')
}

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const fmtDay = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—')

/** The private stats page (/stats/<key>): records first, then 90 days of funnel, sources, devices, countries, link
 * previews, the install register and the days. Numbers only: nothing about anyone. */
export function statsPage(cfg, stats, key) {
  stats.flush()
  const W = STAT_WORDS.en
  const days = readStats(cfg, STAT_KEEP_DAYS)
  const sum = (k) => days.reduce((n, d) => n + (d[k] || 0), 0)
  const merge = (k) => days.reduce((o, d) => (Object.entries(d[k] || {}).forEach(([x, n]) => (o[x] = (o[x] || 0) + n)), o), {})
  const rec = stats.records()
  const rows = (() => {
    try {
      return fs.readFileSync(path.join(cfg.data, 'installs.csv'), 'utf8').split('\n').filter((l) => l && l !== REGISTER_HEAD).map((l) => l.split(','))
    } catch {
      return []
    }
  })()
  const visits = sum('visits')
  const funnel = [['opened the page', visits], ['picked an option', total(merge('chose'))], ['started an install', total(merge('started'))], ['installed weevils', total(merge('succeeded'))], ['opened their weevils', total(merge('switched'))]]
  const bars = (o, names = {}) => {
    const list = Object.entries(o).sort((a, b) => b[1] - a[1])
    const max = Math.max(1, ...list.map(([, n]) => n))
    return list.length ? list.map(([k, n]) => `<div class="bar"><span>${esc(names[k] || k)}</span><i style="width:${Math.max(2, Math.round((n / max) * 100))}%"></i><b>${n}</b></div>`).join('') : '<p class="note">nothing yet</p>'
  }
  const byKind = (k) => Object.entries(merge(k)).map(([x, n]) => `${esc(W.kinds[x] || x)} ${n}`).join(' · ')
  const card = (label, n, sub = '') => `<div><b>${n}</b>${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ''}</div>`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>weevils · stats</title><style>
:root{--a:oklch(.8 .14 297.5);--b:oklch(.8 .14 162.5);--c:oklch(.8 .14 72.5);--d:oklch(.8 .14 230);--e:oklch(.8 .14 27.5);--soft:oklch(.96 .02 297.5)}
body{margin:0;font:16px/1.4 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:#000}section{padding:22px 20px}.wrap{max-width:760px;margin:0 auto}
h1{font-size:38px;letter-spacing:-.04em;line-height:1;margin:0 0 6px}h2{font-size:21px;letter-spacing:-.02em;margin:0 0 12px}
.cards{display:flex;gap:10px;flex-wrap:wrap}.cards div{flex:1 1 150px;border:3px solid #000;border-radius:14px;padding:10px 12px;background:#fff}
.cards b{display:block;font-size:32px;letter-spacing:-.03em;line-height:1.1}.cards small{display:block;opacity:.7}.rec div{background:#000;color:#fff}
.bar{display:grid;grid-template-columns:150px 1fr 48px;align-items:center;gap:8px;margin:5px 0;font-size:15px}.bar i{display:block;height:14px;background:#000;border-radius:7px}.bar b{text-align:right}
table{border-collapse:collapse;width:100%;font-size:14px}td,th{text-align:left;padding:5px 6px;border-bottom:1px solid #0003}.note{font-size:13px;opacity:.75}a{color:#000}
</style></head><body>
<section style="background:var(--a)"><div class="wrap"><h1>tryweevils</h1><p>Anonymous stats, last 90 days · ${esc(new Date().toISOString().slice(0, 16).replace('T', ' '))} UTC</p>
<div class="cards rec">${card('visits, the record day', rec.visits?.n || 0, fmtDay(rec.visits?.day))}${card('installs, the record day', rec.installs?.n || 0, fmtDay(rec.installs?.day))}</div></div></section>
<section style="background:var(--soft)"><div class="wrap"><div class="cards">${card('visits', visits)}${card('visitors (per day, summed)', sum('visitors'))}${card('installs, ever', rows.length)}${card('code downloads', sum('bundles'), sum('updates') ? `${sum('updates')} more by updates` : '')}</div></div></section>
<section style="background:var(--b)"><div class="wrap"><h2>Funnel</h2>${funnel.map(([label, n]) => `<div class="bar"><span>${label}</span><i style="width:${Math.max(2, Math.round((n / Math.max(1, visits)) * 100))}%"></i><b>${n}</b></div>`).join('')}
<p class="note">Options: ${byKind('chose') || '—'}. Started: ${byKind('started') || '—'}. Installed: ${byKind('succeeded') || '—'}.</p></div></section>
<section style="background:var(--c)"><div class="wrap"><h2>Where visits come from</h2>${bars(merge('sources'), W.sources)}<h2 style="margin-top:18px">Where the link was pasted</h2>${bars(merge('previews'), W.previews)}</div></section>
<section style="background:var(--d)"><div class="wrap"><h2>Devices</h2>${bars(merge('devices'), W.devices)}<h2 style="margin-top:18px">Countries (from the time zone)</h2>${bars(merge('countries'))}</div></section>
<section style="background:var(--e)"><div class="wrap"><h2>Installs</h2><table><tr><th>when (UTC)</th><th>how</th><th>country</th><th>version</th></tr>${rows.slice(-30).reverse().map((r) => `<tr><td>${esc(r[0].slice(0, 16).replace('T', ' '))}</td><td>${esc(r[1])}</td><td>${esc(r[2])}</td><td>${esc(r[3] || '—')}${r[5] === 'log' ? ' <span class="note">(from the log)</span>' : ''}</td></tr>`).join('') || '<tr><td colspan="4">none yet</td></tr>'}</table>
<p><a href="/stats/${esc(key)}/installs.csv">The whole register (CSV)</a></p></div></section>
<section><div class="wrap"><h2>By day</h2><table><tr><th>day</th><th>visits</th><th>visitors</th><th>installs</th></tr>${days.slice().reverse().slice(0, 30).map((d) => `<tr><td>${esc(d.day)}</td><td>${d.visits || 0}</td><td>${d.visitors || 0}</td><td>${total(d.succeeded)}</td></tr>`).join('') || '<tr><td colspan="4">nothing yet</td></tr>'}</table>
<p class="note">Counters only: no IP address, e-mail or identifier is stored or shown. A visitor is told apart for one day by a hash with a salt that is never written. Kept 90 days; the install register is kept for good and backed up every day in a private repository.</p></div></section>
</body></html>`
}

/** The weevils on this machine's language (its settings, else WEEVILS_LANG), for the words posted in « for you ». */
function hostLang() {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.local', 'share', 'weevils', 'prefs.json'), 'utf8'))
    if (p.from === 'choice' && (p.lang === 'fr' || p.lang === 'en')) return p.lang
  } catch {
    /* no choice made */
  }
  try {
    const m = /^\s*WEEVILS_LANG\s*=\s*["']?(fr|en)/m.exec(fs.readFileSync(path.join(os.homedir(), '.config', 'weevils', 'env'), 'utf8'))
    if (m) return m[1]
  } catch {
    /* no config */
  }
  return 'en'
}

/** A word in the « for you » stream of the weevils on this machine (what `weevils post` does, through its local API):
 * each successful install, and the day's numbers once it is over. Off unless GET_NOTIFY gives that weevils' address. */
export function createNotifier(cfg) {
  if (!cfg.notify) return null
  const post = (text) =>
    fetch(`${cfg.notify}/api/foryou/post`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, actions: [], from: 'weevils' }), signal: AbortSignal.timeout(10_000) })
      .then((r) => r.ok || console.error(`[get] for you: HTTP ${r.status}`))
      .catch((e) => console.error(`[get] for you: ${e.name}`))
  return {
    post,
    installed(kind, today) {
      const W = STAT_WORDS[hostLang()]
      const n = Object.values(today?.succeeded || {}).reduce((a, b) => a + b, 0)
      return post(W.installed[kind] + (n > 1 ? ` ${W.today(n)}` : ''))
    },
    day(d) {
      const quiet = !d.visits && !d.bundles && !Object.keys(d.previews || {}).length && !Object.keys(d.started || {}).length
      return quiet ? Promise.resolve() : post(describeStats([d], hostLang()))
    },
  }
}

// ---------------------------------------------------------------- Hetzner (the page calls its API: see get/hetzner.js)

/** What a server created from the page runs at its first boot: the install script of its setup, nothing else. */
export function cloudInit(cfg, sid) {
  return `#cloud-config\nruncmd:\n  - [bash, -c, "curl -fsSL --retry 5 --retry-delay 3 ${cfg.base}/install.sh | bash -s ${sid} > /var/log/weevils-get.log 2>&1"]\n`
}

let OWN = null
const ownAddresses = () => (OWN ??= Object.values(os.networkInterfaces()).flat().map((a) => a.address))

// ---------------------------------------------------------------- HTTP

const PAGE_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' }
const STATIC = { '/': 'index.html', '/logo.svg': '../public/branding/weevboss.svg', '/qrcode.js': 'qrcode.js', '/hetzner.js': 'hetzner.js', '/icon-192.png': '../public/icon-192.png', '/icon-180.png': '../public/icon-180.png', '/favicon-32.png': '../public/favicon-32.png', '/og.png': 'og.png' }
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://api.hetzner.cloud; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'strict-transport-security': 'max-age=31536000',
  'cache-control': 'no-store',
}

export function createServer(cfg = config(), deps = {}) {
  const store = deps.store || createStore()
  const codeOpen = watchCode(cfg)
  const notifier = deps.notifier !== undefined ? deps.notifier : createNotifier(cfg)
  const stats = deps.stats || createStats(cfg, { onInstalled: (kind, today) => notifier?.installed(kind, today), onDay: (d) => notifier?.day(d) })
  const limit = new Limiter()
  const titles = stepTitles(cfg.installer)
  const titleList = '|' + Object.keys(titles).filter((t) => !t.includes('|')).join('|') + '|'
  const bootstrap = fs.readFileSync(path.join(HERE, 'bootstrap.sh'), 'utf8')
  /** The release key's public half: pinned in the script it serves, which checks the code's signature with it. */
  const releaseKey = fs.readFileSync(path.join(HERE, 'release-key.pub'), 'utf8').trim()
  const securityNotes = fs.readFileSync(path.join(HERE, '..', 'SECURITY.md'), 'utf8').replaceAll('https://get.scarville.tech', cfg.base)

  const clientIp = (req) => {
    const direct = req.socket.remoteAddress || ''
    const fwd = cfg.trustProxy && /^(::ffff:)?127\.0\.0\.1$|^::1$/.test(direct) ? String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() : ''
    return fwd || direct
  }
  const send = (res, status, body, type = 'application/json; charset=utf-8', extra = {}) => {
    res.writeHead(status, { 'content-type': type, ...SECURITY_HEADERS, ...extra })
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
  }
  const fail = (res, status, error) => send(res, status, { error })
  const readBody = (req, max = 16_384) =>
    new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (c) => {
        size += c.length
        if (size > max) reject(Object.assign(new Error('too_big'), { status: 413 })), req.destroy()
        else chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  const json = async (req) => {
    try {
      return JSON.parse(await readBody(req))
    } catch (e) {
      if (e.status) throw e
      throw Object.assign(new Error('bad_json'), { status: 400 })
    }
  }
  const keyOk = (k) => !!k && crypto.timingSafeEqual(crypto.createHash('sha256').update(String(k)).digest(), crypto.createHash('sha256').update(cfg.previewKey).digest())
  /** Preview gate: the key in the URL (?k=), in a header the page adds to its API calls, or in a cookie. No redirect:
   * some iOS contexts (in-app browsers, private tabs) drop a cookie set on a redirect. */
  const gated = (req, url) => {
    if (!cfg.previewKey) return false
    const cookie = /(?:^|;\s*)gk=([^;]+)/.exec(req.headers.cookie || '')?.[1]
    return !(keyOk(url.searchParams.get('k')) || keyOk(req.headers['x-get-key']) || keyOk(cookie && decodeURIComponent(cookie)))
  }
  /** The same browser at the same address, as a keyed hash (the key is random, lives in memory and goes with the
   * setups to the next run): a visit that lost its page finds the setup it started; neither is kept. */
  const nearOf = (req, ip) => crypto.createHmac('sha256', store.salt).update(`${ip}\n${req.headers['user-agent'] || ''}`).digest('base64url').slice(0, 22)
  /** The job a page asks about: its sid and its view token must match. */
  const owned = (body) => {
    const j = store.get(body?.sid)
    if (!j || typeof body.view !== 'string' || body.view.length !== j.view.length || !crypto.timingSafeEqual(Buffer.from(body.view), Buffer.from(j.view))) return null
    j.touched = Date.now()
    return j
  }

  const script = (j) => {
    const vals = {
      BASE: cfg.base, SID: j.sid, LANG: j.lang, MODE: j.mode, REACH: j.reach, REPO: cfg.repo, BUNDLE: cfg.bundle ? '1' : '0', PUB: j.pub, TITLES: titleList, RELEASEKEY: releaseKey,
    }
    return bootstrap.replace(/@([A-Z]+)@/g, (m, k) => (k in vals ? sq(vals[k]) : m)).replaceAll('https://get.scarville.tech', cfg.base)
  }
  // The same script for everyone (a computer's command): readable at a stable address, with its checksum. The setup
  // id comes as its argument; its settings are read from /i/<sid>.env as plain values.
  const shared = script({ sid: '', lang: '', mode: '', reach: '', pub: '' })
  const sharedSum = crypto.createHash('sha256').update(shared).digest('hex')

  // A computer's command: bash on Linux, a Mac or inside WSL; PowerShell on Windows (any of its terminals: cmd and Git
  // Bash run it too), which hands the same install to Ubuntu in WSL.
  const commands = (j) => ({ command: `curl -fsSL ${cfg.base}/install.sh | bash -s ${j.sid}`, win: `powershell -c "irm ${cfg.base}/w/${j.sid} | iex"` })
  /** What the page needs to start a setup: a computer's commands; a VPS's command to paste on it; the cloud-init of a
   * Hetzner server (the page creates it from the browser, with the person's own token). */
  const forPage = (j) => (j.kind === 'pc' ? commands(j) : j.kind === 'ssh' ? { command: commands(j).command } : { command: commands(j).command, userData: cloudInit(cfg, j.sid) })
  const NEEDS_WSL = {
    en: 'weevils runs in Linux, and this Windows has no Linux (WSL) yet. Simplest: go back to the page and pick a server. Or open PowerShell as administrator, type wsl --install, restart the computer, open Ubuntu once, then paste the command again.',
    fr: 'weevils tourne sous Linux, et ce Windows n’a pas encore Linux (WSL). Le plus simple : reviens sur la page et choisis un serveur. Sinon ouvre PowerShell en administrateur, tape wsl --install, redémarre l’ordinateur, ouvre Ubuntu une fois, puis colle à nouveau la commande.',
  }
  /** Windows: the same install, run by bash in the first Linux distribution of WSL (Docker Desktop's own excepted). */
  const winScript = (j) => {
    const ps = (v) => `'${String(v).replace(/'/g, "''")}'`
    return `$ErrorActionPreference = 'SilentlyContinue'
& {
  $base = ${ps(cfg.base)}; $sid = ${ps(j.sid)}
  $d = $null
  if (Get-Command wsl.exe) { $d = (wsl.exe -l -q) -replace [char]0, '' | ForEach-Object { $_.Trim() } | Where-Object { $_ -and $_ -notlike 'docker-desktop*' } | Select-Object -First 1 }
  if (-not $d) {
    $m = ${ps(NEEDS_WSL[j.lang] || NEEDS_WSL.en)}
    try { Invoke-RestMethod -Method Post -Uri "$base/r/$sid" -Body @{ event = 'failed'; error = $m } | Out-Null } catch {}
    Write-Host ''; Write-Host "  weevils · $m" -ForegroundColor Yellow; Write-Host ''
    return
  }
  Write-Host "  weevils · installing in $d (WSL)"
  wsl.exe -d $d -- bash -lc "curl -fsSL '$base/install.sh' | bash -s $sid"
}
`
  }

  const handlers = {
    // A new setup: kind is hetzner, ssh or pc; pub is the page's RSA-OAEP public key (base64 DER, SPKI).
    'POST /api/job': async (req, res, ip) => {
      if (!limit.ok(`job:${ip}`, 12, 3600_000)) return fail(res, 429, 'slow_down')
      const b = await json(req)
      if (!['hetzner', 'ssh', 'pc'].includes(b.kind)) return fail(res, 400, 'bad_kind')
      if (typeof b.pub !== 'string' || !/^[A-Za-z0-9+/=]{200,800}$/.test(b.pub)) return fail(res, 400, 'bad_key')
      try {
        const k = crypto.createPublicKey({ key: Buffer.from(b.pub, 'base64'), format: 'der', type: 'spki' })
        if (k.asymmetricKeyType !== 'rsa' || k.asymmetricKeyDetails.modulusLength < 2048) throw new Error()
      } catch {
        return fail(res, 400, 'bad_key')
      }
      // A page from before resume links lets this service pick the view token; a newer one derives it from its secret,
      // and leaves its private key here sealed with another key derived from the same secret (see the header).
      const view = typeof b.view === 'string' && /^[A-Za-z0-9_-]{43}$/.test(b.view) ? b.view : ''
      const wrapped = typeof b.wrapped === 'string' && /^[A-Za-z0-9+/=]{100,8000}$/.test(b.wrapped) ? b.wrapped : ''
      const j = store.create(b.kind, b.lang === 'fr' ? 'fr' : 'en', b.pub, { view, wrapped, near: nearOf(req, ip) })
      if (!j) return fail(res, 503, 'busy')
      // Roughly where the person is, for the install register: their time zone's country, never their address.
      j.country = countryOf(b.tz)
      if (b.kind === 'pc') j.state = 'waiting'
      send(res, 200, { sid: j.sid, view: j.view, ...forPage(j) })
    },
    // Anonymous counters from the page: it was opened, an option was picked, the phone switched to its weevils. Only
    // real visits through Caddy count (not this machine, not bots, not link previews).
    'POST /api/hit': async (req, res, ip) => {
      if (!limit.ok(`hit:${ip}`, 120, 3600_000)) return fail(res, 429, 'slow_down')
      const b = await json(req)
      const ua = String(req.headers['user-agent'] || '')
      if ((cfg.statsLocal || (publicAddress(ip) && !ownAddresses().includes(ip) && !ip.startsWith('172.'))) && !BOT.test(ua) && !previewerOf(ua)) {
        if (b.e === 'open') stats.visit({ ip, ua, ref: b.ref, tz: b.tz, touch: b.touch === true })
        else if (b.e === 'chose') stats.step('chose', b.kind)
        else if (b.e === 'switch') stats.step('switched', b.kind)
      }
      send(res, 200, { ok: true })
    },
    'POST /api/status': async (req, res, ip) => {
      if (!limit.ok(`status:${ip}`, 2400, 3600_000)) return fail(res, 429, 'slow_down')
      const b = await json(req)
      const j = owned(b)
      if (!j) return fail(res, 404, 'no_job')
      // full: a page opened from a resume link also gets its sealed key back.
      send(res, 200, b.full ? { ...view(j), wrapped: j.wrapped || '', command: '', ...forPage(j) } : view(j))
    },
    // A visit without its setup (its page was closed, the in-app browser forgot it): the setups this same browser
    // started from this same address, and how far they are. Nothing more: the rest needs the resume link or the token.
    'POST /api/nearby': async (req, res, ip) => {
      if (!limit.ok(`near:${ip}`, 1500, 3600_000)) return fail(res, 429, 'slow_down')
      await json(req)
      const me = nearOf(req, ip)
      const now = Date.now()
      const mine = [...store.jobs.values()].filter((j) => j.near === me && (j.server || j.creating) && !j.claimed && now - j.created < 24 * 3600_000)
      send(res, 200, { jobs: mine.sort((a, b) => b.created - a.created).slice(0, 3).map(glimpse) })
    },
    // A server created for the person, at Hetzner. The page made it with its own token, from the browser (get/hetzner.js):
    // this service is told only what it needs to follow the install. Never a token here.
    'POST /api/hetzner/created': async (req, res, ip) => {
      if (!limit.ok(`hzc:${ip}`, 10, 3600_000)) return fail(res, 429, 'slow_down')
      const b = await json(req)
      const j = owned(b)
      if (!j || j.kind !== 'hetzner') return fail(res, 404, 'no_job')
      if (j.server) return send(res, 200, view(j))
      const s = b.server || {}
      const text = (v, re) => (typeof v === 'string' && re.test(v) ? v : '')
      const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e6 ? v : 0)
      if (!/^\d{1,15}$/.test(String(s.id ?? ''))) return fail(res, 400, 'bad_server')
      if (net.isIP(String(s.ip || '')) !== 4 || (!cfg.allowTargets.includes(s.ip) && !publicAddress(s.ip))) return fail(res, 400, 'bad_server')
      // The size, when the page made it just now (a server found again on the account comes without).
      if (s.size !== undefined && !SIZES.some((z) => z.size === s.size)) return fail(res, 400, 'bad_size')
      const z = SIZES.find((x) => x.size === s.size) || { size: '', agents: '' }
      j.server = {
        id: Number(s.id), name: text(s.name, /^[a-z0-9-]{1,63}$/) || `weevils-${j.sid.slice(0, 6)}`, ip: s.ip, type: text(s.type, /^[a-z0-9-]{1,20}$/),
        size: z.size, agents: z.agents, location: text(s.location, /^[a-z0-9-]{1,20}$/), hourly: num(s.hourly), monthly: num(s.monthly), currency: 'EUR',
      }
      j.reach = cfg.targetUrls[s.ip] || sslip(s.ip)
      j.mode = cfg.targetUrls[s.ip] ? 'url' : 'vps'
      j.state = 'running'
      j.step = 'created'
      j.steps.push('created')
      j.createError = ''
      stats.step('started', 'hetzner')
      send(res, 200, view(j))
    },
    // The page could not create the server (read from Hetzner, in the browser): kept for a page that comes back.
    'POST /api/hetzner/failed': async (req, res, ip) => {
      if (!limit.ok(`hzc:${ip}`, 20, 3600_000)) return fail(res, 429, 'slow_down')
      const b = await json(req)
      const j = owned(b)
      if (!j || j.kind !== 'hetzner') return fail(res, 404, 'no_job')
      if (!j.server) j.createError = typeof b.error === 'string' && /^[a-z0-9_]{1,40}$/.test(b.error) ? b.error : 'host_down'
      send(res, 200, view(j))
    },
    // How far the setups of the servers the page found on its account are (their « weevils-sid » labels): nothing more.
    'POST /api/hetzner/setups': async (req, res, ip) => {
      if (!limit.ok(`hz:${ip}`, 40, 3600_000)) return fail(res, 429, 'slow_down')
      const b = await json(req)
      const j = owned(b)
      if (!j || j.kind !== 'hetzner') return fail(res, 404, 'no_job')
      const sids = Array.isArray(b.sids) ? b.sids.filter((x) => typeof x === 'string' && /^[a-z2-9]{10}$/.test(x)).slice(0, 10) : []
      const out = {}
      for (const sid of sids) {
        const o = store.get(sid)
        if (o && o.kind === 'hetzner') out[sid] = { state: o.state, step: o.step, steps: o.steps }
      }
      send(res, 200, { setups: out })
    },
    // « Continue on this one », a setup still installing: this page takes it over (the install asks for the page's key
    // at the end). The server's « weevils-sid » label, read by the page with its token, is the proof: only the account's
    // owner can read it. A finished or forgotten one: the page shows a fresh root password from Hetzner and this setup's
    // command, pasted by the person in the server's console (the password never comes here).
    'POST /api/hetzner/attach': async (req, res, ip) => {
      if (!limit.ok(`hzk:${ip}`, 8, 3600_000)) return fail(res, 429, 'slow_down')
      const b = await json(req)
      const j = owned(b)
      if (!j || j.kind !== 'hetzner') return fail(res, 404, 'no_job')
      if (j.server) return send(res, 200, view(j))
      const old = typeof b.label === 'string' && /^[a-z2-9]{10}$/.test(b.label) ? store.get(b.label) : null
      // Two things only the account's owner reads at Hetzner: the server's sid label and its id.
      const live = old && old !== j && old.kind === 'hetzner' && old.server && String(old.server.id) === String(b.server ?? '') && old.state !== 'done' && old.state !== 'failed' && (old.creating || Date.now() - old.touched < 15 * 60_000)
      if (!live) return fail(res, 404, 'not_live')
      Object.assign(old, { view: j.view, wrapped: j.wrapped, pub: j.pub, near: j.near || old.near, touched: Date.now() })
      store.jobs.delete(j.sid)
      send(res, 200, { ...view(old), attached: true })
    },
  }

  let busy = 0
  const server = http.createServer(async (req, res) => {
    busy++
    res.once('close', () => busy--)
    const ip = clientIp(req)
    const url = new URL(req.url || '/', 'http://x')
    try {
      // The install script for one setup. Gated by its unguessable sid, not by the preview cookie.
      let m = /^\/i\/([a-z2-9]{10})$/.exec(url.pathname)
      if (m && req.method === 'GET') {
        if (!limit.ok(`i:${ip}`, 60, 3600_000)) return fail(res, 429, 'slow_down')
        const j = store.get(m[1])
        // A computer's command pasted again after a failure (in the wrong terminal, a password mistyped) starts over.
        if (j?.kind === 'pc' && j.state === 'failed') (j.state = 'running'), (j.error = '')
        if (!j || j.state === 'done' || j.state === 'failed' || ++j.scriptFetches > 12) return send(res, 404, 'echo "weevils: this setup link has expired: open the setup page again." >&2; exit 1\n', 'text/x-shellscript; charset=utf-8')
        j.touched = Date.now()
        j.bv = BOOTSTRAP_V
        if (j.kind === 'pc' && j.state === 'waiting') (j.state = 'running'), stats.step('started', 'pc')
        if (!j.reach && j.server && publicAddress(ip)) {
          j.reach = sslip(ip)
          j.server.ip ||= ip
        }
        return send(res, 200, script(j), 'text/x-shellscript; charset=utf-8')
      }
      if ((url.pathname === '/install.sh' || url.pathname === '/install.sh.sha256') && req.method === 'GET') {
        return url.pathname === '/install.sh' ? send(res, 200, shared, 'text/x-shellscript; charset=utf-8') : send(res, 200, `${sharedSum}  install.sh\n`, 'text/plain; charset=utf-8')
      }
      // The shared script's settings for one setup, as key=value lines (counted like a fetch of its own script).
      m = /^\/i\/([a-z2-9]{10})\.env$/.exec(url.pathname)
      if (m && req.method === 'GET') {
        if (!limit.ok(`i:${ip}`, 60, 3600_000)) return fail(res, 429, 'slow_down')
        const j = store.get(m[1])
        if (j?.kind === 'pc' && j.state === 'failed') (j.state = 'running'), (j.error = '')
        if (!j || j.state === 'done' || j.state === 'failed' || ++j.scriptFetches > 12) return send(res, 404, 'expired\n', 'text/plain; charset=utf-8')
        j.touched = Date.now()
        j.bv = BOOTSTRAP_V
        if (j.kind === 'pc' && j.state === 'waiting') (j.state = 'running'), stats.step('started', 'pc')
        // A VPS (or a Hetzner server whose setup was lost) whose command was pasted there by hand: it starts now, and
        // its address is where it asks from.
        if ((j.kind === 'ssh' || j.kind === 'hetzner') && j.state === 'waiting' && !j.server) {
          if (publicAddress(ip) || cfg.allowTargets.includes(ip)) {
            j.reach = cfg.targetUrls[ip] || sslip(ip)
            j.mode = cfg.targetUrls[ip] ? 'url' : 'vps'
            j.server = { ip, name: ip }
          } else j.mode = 'pc' // not reachable from the Internet: like a computer, a link of its own for the phone
          j.state = 'running'
          j.step = 'created'
          j.steps.push('created')
          if (j.kind === 'ssh') stats.step('started', 'ssh')
        }
        if (!j.reach && j.server && publicAddress(ip)) {
          j.reach = sslip(ip)
          j.server.ip ||= ip
        }
        const clean = (v) => String(v ?? '').replace(/[\r\n=]/g, '')
        return send(res, 200, `lang=${clean(j.lang)}\nmode=${clean(j.mode)}\nreach=${clean(j.reach)}\npub=${String(j.pub).replace(/[\r\n]/g, '')}\n`, 'text/plain; charset=utf-8')
      }
      // Windows: the PowerShell step before the same install, in WSL. A failed one can be pasted again.
      m = /^\/w\/([a-z2-9]{10})$/.exec(url.pathname)
      if (m && req.method === 'GET') {
        if (!limit.ok(`i:${ip}`, 60, 3600_000)) return fail(res, 429, 'slow_down')
        const j = store.get(m[1])
        if (!j || j.kind !== 'pc' || j.state === 'done' || ++j.scriptFetches > 12) return send(res, 404, 'Write-Host "weevils: this setup link has expired: open the setup page again."\n', 'text/plain; charset=utf-8')
        j.touched = Date.now()
        if (j.state === 'waiting' || j.state === 'failed') (j.state === 'waiting' && stats.step('started', 'pc')), (j.state = 'running'), (j.error = '')
        return send(res, 200, winScript(j), 'text/plain; charset=utf-8')
      }
      // Progress from an install: an event, a step title from the allowlist, and the sealed link at the end.
      m = /^\/r\/([a-z2-9]{10})$/.exec(url.pathname)
      if (m && req.method === 'POST') {
        const j = store.get(m[1])
        if (!j || ++j.reports > 300) return fail(res, 404, 'no_job')
        const f = new URLSearchParams(await readBody(req, 8192))
        // The new weevils, at its first login (server/index.ts): its link no longer needs to wait here (an hour more,
        // for a login made in a browser that is then lost).
        if (f.get('event') === 'claimed') {
          if (j.state === 'done') j.claimed ||= Date.now()
          return send(res, 200, { ok: true })
        }
        if (j.state === 'done') return fail(res, 404, 'no_job')
        // One machine per setup: the first report pins its address, a report from elsewhere (someone who saw the
        // setup id in a pasted command) cannot move it on, fail it or hand the page a link of its own.
        j.reporter ||= ip
        if (j.reporter !== ip) return fail(res, 404, 'no_job')
        j.touched = Date.now()
        const ev = f.get('event')
        let step = ''
        if (ev === 'start') step = 'start'
        // A title from the installer's log, or a step the bootstrap does itself: the phone's link, and on a Mac
        // without Homebrew the system tools it installs before the installer runs.
        else if (ev === 'step') step = f.get('title') ? titles[f.get('title')] || '' : ['tunnel', 's_system'].includes(f.get('step')) ? f.get('step') : ''
        if (step && STEPS.includes(step)) {
          j.state = 'running'
          j.step = step
          if (!j.steps.includes(step)) j.steps.push(step)
        }
        if (ev === 'failed') {
          j.state = 'failed'
          j.error = String(f.get('error') || '').replace(/#k=\S*/g, '').slice(0, 300)
        }
        if (ev === 'done') {
          const u = String(f.get('url') || '')
          j.result = {
            url: /^https?:\/\/[A-Za-z0-9.:\[\]-]+$/.test(u) ? u : '',
            mode: ['public', 'lan', 'local'].includes(f.get('mode')) ? f.get('mode') : 'local',
            ready: f.get('ready') === 'yes',
            sealed: /^[A-Za-z0-9+/=]{100,1200}$/.test(f.get('sealed') || '') ? f.get('sealed') : '',
          }
          j.state = 'done'
          j.step = 'done'
          j.steps.push('done')
          stats.succeeded(j.kind, { country: j.country, version: /^[0-9a-f]{7,40}$/.test(f.get('version') || '') ? f.get('version').slice(0, 12) : '' })
        }
        return send(res, 200, { ok: true })
      }
      // The page's public key, asked by the install just before it seals the link: a page that took the setup over
      // (« continue on this one ») gets a link it can open. Public by nature; only while the setup runs.
      m = /^\/k\/([a-z2-9]{10})$/.exec(url.pathname)
      if (m && req.method === 'GET') {
        const j = store.get(m[1])
        if (!j || j.state === 'done' || j.state === 'failed' || !limit.ok(`k:${m[1]}`, 20, 3600_000)) return fail(res, 404, 'no_job')
        return send(res, 200, j.pub, 'text/plain; charset=utf-8')
      }
      // The private stats page and its install register (CSV), behind their own key in the address.
      m = /^\/stats\/([A-Za-z0-9_-]{16,128})(\/installs\.csv)?$/.exec(url.pathname)
      if (m && req.method === 'GET') {
        const keyOk = cfg.statsKey && crypto.timingSafeEqual(KEY_SHA(m[1]), KEY_SHA(cfg.statsKey))
        if (!keyOk || !limit.ok(`stats:${ip}`, 240, 3600_000)) return fail(res, 404, 'not_found')
        if (!m[2]) return send(res, 200, statsPage(cfg, stats, m[1]), PAGE_TYPES['.html'], { 'x-robots-tag': 'noindex' })
        let csv = REGISTER_HEAD + '\n'
        try {
          csv = fs.readFileSync(path.join(cfg.data, 'installs.csv'), 'utf8')
        } catch {
          /* none yet */
        }
        return send(res, 200, csv, 'text/csv; charset=utf-8', { 'content-disposition': 'attachment; filename="weevils-installs.csv"' })
      }
      // Installed weevils updating themselves (server/weevils-update): the version of the snapshot new installs get,
      // then the snapshot itself; and that script, for a weevils installed before it existed (curl …/update | bash).
      if (url.pathname === '/version' && req.method === 'GET') {
        let rev = ''
        try {
          rev = fs.readFileSync(`${cfg.bundle}.rev`, 'utf8').trim()
        } catch {
          /* no snapshot */
        }
        if (!cfg.bundle || !/^[0-9a-f]{40}$/.test(rev)) return fail(res, 404, 'no_version')
        return send(res, 200, { rev, short: rev.slice(0, 7) })
      }
      if (url.pathname === '/update' && req.method === 'GET') {
        if (!limit.ok(`up:${ip}`, 30, 3600_000)) return fail(res, 429, 'slow_down')
        return send(res, 200, fs.readFileSync(path.join(HERE, '..', 'server', 'weevils-update')), 'text/x-shellscript; charset=utf-8')
      }
      // The code, while the repository is private: for a live setup (its sid), or an installed weevils updating.
      if (url.pathname === '/weevils.bundle' && req.method === 'GET') {
        const sid = url.searchParams.get('sid')
        const j = sid ? store.get(sid) : null
        const allowed = sid ? j && j.state !== 'done' && limit.ok(`b:${j.sid}`, 6, 3600_000) : limit.ok(`bu:${ip}`, 6, 3600_000)
        if (!cfg.bundle || !allowed) return fail(res, 404, 'no_bundle')
        res.writeHead(200, { 'content-type': 'application/octet-stream', ...SECURITY_HEADERS })
        stats.bundle(!sid)
        return fs.createReadStream(cfg.bundle).pipe(res)
      }
      // The bundle's signature (release key, get/release-key.pub) and checksum, and the public key itself: small, public.
      if (['/weevils.bundle.sig', '/weevils.bundle.sha256'].includes(url.pathname) && req.method === 'GET') {
        const f = cfg.bundle + url.pathname.slice('/weevils.bundle'.length)
        if (!cfg.bundle || !fs.existsSync(f)) return fail(res, 404, 'no_signature')
        return send(res, 200, fs.readFileSync(f), 'text/plain; charset=utf-8')
      }
      // What the install does and never does, what leaves the machine, how to remove it (SECURITY.md).
      if ((url.pathname === '/security' || url.pathname === '/SECURITY.md') && req.method === 'GET') return send(res, 200, securityNotes, 'text/plain; charset=utf-8')
      if (url.pathname === '/release-key.pub' && req.method === 'GET') return send(res, 200, releaseKey + '\n', 'text/plain; charset=utf-8')
      if (url.pathname === '/health') return send(res, 200, { ok: true })
      // Preview gate: until the launch, the page and its API need the key once.
      // Public assets (the page's own script, logo, icons) are served to anyone: they are in the open repository.
      const file = STATIC[url.pathname]
      if (file && url.pathname !== '/' && req.method === 'GET') {
        const p = path.join(HERE, file)
        return send(res, 200, fs.readFileSync(p), PAGE_TYPES[path.extname(p)] || 'application/octet-stream', { 'cache-control': 'public, max-age=3600' })
      }
      if (gated(req, url)) {
        // A key in the fragment (#k=…) never reaches a server: this page moves it to the query.
        return send(res, 404, '<!doctype html><meta name="viewport" content="width=device-width"><title>weevils</title><p style="font:17px system-ui;padding:24px">Not here yet.</p><script>var m=/[#&]k=([^&]+)/.exec(location.hash);if(m)location.replace("/?k="+m[1])</script>', 'text/html; charset=utf-8')
      }
      if (cfg.previewKey && keyOk(url.searchParams.get('k'))) res.setHeader('set-cookie', `gk=${encodeURIComponent(url.searchParams.get('k'))}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`)
      const h = handlers[`${req.method} ${url.pathname}`]
      if (h) {
        if (req.headers['content-type'] && !String(req.headers['content-type']).startsWith('application/json')) return fail(res, 415, 'json_only')
        return await h(req, res, ip)
      }
      if (url.pathname === '/' && req.method === 'GET') {
        // A link preview being drawn (WhatsApp, iMessage, Twitter…): where the link was pasted, never a visit.
        const who = previewerOf(req.headers['user-agent'])
        if (who) stats.preview(who)
        let html = fs.readFileSync(path.join(HERE, 'index.html'), 'utf8')
        // The code's link once the public repository is open; « N people already run weevils » with GET_PUBLIC_COUNT=1.
        const attrs = (codeOpen() ? ` data-code="${cfg.codeUrl}"` : '') + (cfg.publicCount ? ` data-count="${stats.installs()}"` : '')
        if (attrs) html = html.replace('<html lang="en">', `<html lang="en"${attrs}>`)
        return send(res, 200, html, PAGE_TYPES['.html'])
      }
      fail(res, 404, 'not_found')
    } catch (e) {
      if (!res.headersSent) fail(res, e.status || 500, e.status ? e.message : 'internal')
      // Never the request: only the path and the error name.
      if (!e.status) console.error(`[get] ${req.method} ${url.pathname}: ${e.name}`)
    }
  })
  /** Stops without cutting anyone: no new connection, the requests in flight finish, then the setups go to the next
   * run. */
  const drain = async (limitMs = 20_000) => {
    server.close()
    server.closeIdleConnections?.()
    for (const end = Date.now() + limitMs; busy > 0 && Date.now() < end; ) await new Promise((r) => setTimeout(r, 100))
    stats.flush()
    return saveJobs(store, cfg.handoff)
  }
  return { server, store, drain, stats }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const cfg = config()
  const { server, store, drain } = createServer(cfg)
  const kept = loadJobs(store, cfg.handoff)
  let stopping = false
  for (const sig of ['SIGTERM', 'SIGINT'])
    process.on(sig, async () => {
      if (stopping) return
      stopping = true
      const n = await drain().catch(() => 0)
      console.log(`[get] stopped, ${n} setups handed to the next run`)
      process.exit(0)
    })
  server.listen(cfg.port, cfg.host, () => console.log(`[get] ${cfg.base} on ${cfg.host}:${cfg.port}${cfg.previewKey ? ' (preview key on)' : ''}${cfg.bundle ? ' (bundle)' : ''}${kept ? ` (${kept} setups kept from the last run)` : ''}`))
}
