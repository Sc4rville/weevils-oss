// Coin infrastructure, côté machine : mesures toutes les 15 s, une minute d'historique par ligne (DATA_DIR/infra/<jour>.jsonl),
// saturations, serveurs à l'écoute, conseils tirés des vraies mesures. Linux d'abord (/proc) ; ailleurs, ce que donne os.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Consumer, DaySummary, Episode, FsListing, InfraDetail, InfraPoint, Level, Offer, ServerProc } from '../shared/infra.ts'
import { facts, offer } from './discover.ts'
import { DATA_DIR, EXPOSE_DOMAIN, EXPOSE_SITES_DIR, HOME, MACHINE, ORCH_DIR, ORCHESTRATOR } from './config.ts'
import { tr } from './i18n.ts'
import M from './i18n/infra.ts'

const DIR = path.join(DATA_DIR, 'infra')
const TICK = 15_000
const PAGE = 4096
const HZ = 100

export const levelOf = (cpu: number, mem: number): Level => (cpu >= 90 || mem >= 92 ? 'crit' : cpu >= 70 || mem >= 80 ? 'warn' : 'ok')
const saturated = (p: { cpu: number; mem: number }) => p.cpu >= 90 || p.mem >= 92
const day = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const read = (f: string) => {
  try {
    return fs.readFileSync(f, 'utf8')
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------- mesures

/** Le cgroup de ce processus (v2) : un conteneur ou un service limité y porte ses vraies limites. */
const CG = (() => {
  const rel = /^0::(.*)$/m.exec(read('/proc/self/cgroup'))?.[1]
  return rel != null ? path.join('/sys/fs/cgroup', rel) : null
})()
const cgNum = (f: string) => {
  const v = CG ? read(path.join(CG, f)).trim() : ''
  return /^\d+$/.test(v) ? Number(v) : null
}

/** vCPU réellement disponibles : la limite du cgroup (cpu.max) quand il y en a une, sinon les cœurs vus. */
export function effectiveCores(): number {
  const [q, per] = (CG ? read(path.join(CG, 'cpu.max')).trim() : '').split(' ')
  const lim = /^\d+$/.test(q) && Number(per) > 0 ? Number(q) / Number(per) : Infinity
  return Math.max(1, Math.min(os.cpus().length, Math.round(lim * 10) / 10))
}

function meminfo() {
  const txt = read('/proc/meminfo')
  const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(txt)?.[1] ?? NaN) * 1024
  let total = txt ? kb('MemTotal') : os.totalmem()
  let used = total - (txt ? kb('MemAvailable') : os.freemem())
  // Limite de mémoire du cgroup (conteneur) : c'est elle, la vraie machine.
  const max = cgNum('memory.max')
  if (max != null && max < total) {
    total = max
    const inactive = Number(/^inactive_file (\d+)/m.exec(CG ? read(path.join(CG, 'memory.stat')) : '')?.[1] ?? 0)
    used = Math.max(0, (cgNum('memory.current') ?? used) - inactive)
  }
  const swapTotal = txt ? kb('SwapTotal') : 0
  const swapUsed = txt ? swapTotal - kb('SwapFree') : 0
  return { total, used, swapTotal, swapUsed }
}

function disk() {
  try {
    const s = fs.statfsSync(HOME)
    const total = s.blocks * s.bsize
    return { total, used: total - s.bavail * s.bsize }
  } catch {
    return { total: 0, used: 0 }
  }
}

let lastCpu = os.cpus().map((c) => c.times)
let lastCg: { usage: number; at: number } | null = null
function cpuPercent() {
  // Conteneur limité : son propre temps CPU rapporté à sa limite.
  const cores = effectiveCores()
  const usage = Number(/^usage_usec (\d+)/m.exec(CG ? read(path.join(CG, 'cpu.stat')) : '')?.[1] ?? NaN)
  if (cores < os.cpus().length && Number.isFinite(usage)) {
    const at = Date.now()
    const prev = lastCg
    lastCg = { usage, at }
    if (prev && at > prev.at) return Math.min(100, Math.round(((usage - prev.usage) / 1000 / (at - prev.at) / cores) * 100))
    return 0
  }
  const now = os.cpus().map((c) => c.times)
  let busy = 0
  let all = 0
  now.forEach((t, i) => {
    const p = lastCpu[i] ?? { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 }
    const b = t.user - p.user + t.nice - p.nice + t.sys - p.sys + t.irq - p.irq
    busy += b
    all += b + t.idle - p.idle
  })
  lastCpu = now
  return all > 0 ? Math.round((busy / all) * 100) : 0
}

interface Proc {
  pid: number
  ppid: number
  comm: string
  ticks: number
  rss: number
}

function procs(): Proc[] {
  let pids: string[]
  try {
    pids = fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p))
  } catch {
    return []
  }
  const out: Proc[] = []
  for (const pid of pids) {
    const s = read(`/proc/${pid}/stat`)
    const close = s.lastIndexOf(')')
    if (close < 0) continue
    const f = s.slice(close + 2).split(' ')
    out.push({ pid: Number(pid), ppid: Number(f[1]), comm: s.slice(s.indexOf('(') + 1, close), ticks: Number(f[11]) + Number(f[12]), rss: Number(f[21]) * PAGE })
  }
  return out
}

/** Une famille lisible pour un processus : docker, vitest, chrome, claude… (pour dire ce qui a fait saturer). */
function family(p: Proc): string {
  if (/^(dockerd|containerd|containerd-shim.*|docker.*|runc)$/.test(p.comm)) return 'docker'
  if (read(`/proc/${p.pid}/cgroup`).includes('docker')) return 'docker'
  if (/^(node|bun|deno|python3?|npm|npx)$/.test(p.comm)) {
    const args = read(`/proc/${p.pid}/cmdline`).split('\0').join(' ')
    const m = /\b(vitest|vite|tsc|next|jest|playwright|esbuild|webpack|tsx|eslint|pytest|ffmpeg|weevils?)\b/.exec(args)
    if (m) return m[1]
    const script = args.split(' ').find((a, i) => i > 0 && !a.startsWith('-'))
    return script ? `${p.comm} ${path.basename(script)}` : p.comm
  }
  if (/^(chrome|chromium|headless_shell)/.test(p.comm)) return 'chrome'
  return p.comm
}

const isAgent = (p: Proc) => p.comm === 'claude' || (p.comm === 'codex' && !read(`/proc/${p.pid}/cmdline`).includes('app-server'))

interface Live {
  at: number
  cpu: number
  mem: number
  swap: number | null
  load: number
  agents: number
  agentMem: number
  agentCpu: number
  fams: Map<string, number>
}

let prevTicks = new Map<number, number>()
let prevAt = Date.now()
let current: Live | null = null
let minute: Live[] = []
let today: InfraPoint[] = []
let todayKey = ''

function measure(): Live {
  const at = Date.now()
  const m = meminfo()
  const list = procs()
  const dt = (at - prevAt) / 1000
  const ticks = new Map<number, number>()
  const cpuOf = new Map<number, number>()
  for (const p of list) {
    ticks.set(p.pid, p.ticks)
    const before = prevTicks.get(p.pid)
    if (before != null && dt > 0) cpuOf.set(p.pid, ((p.ticks - before) / HZ / dt) * 100)
  }
  prevTicks = ticks
  prevAt = at
  // Chaque processus compte pour la session claude / codex dont il descend (tests, builds, serveurs lancés par l'agent).
  const byPid = new Map(list.map((p) => [p.pid, p]))
  const agentOf = new Map<number, number | null>()
  const owner = (p: Proc): number | null => {
    if (agentOf.has(p.pid)) return agentOf.get(p.pid)!
    agentOf.set(p.pid, null)
    const parent = byPid.get(p.ppid)
    const r = isAgent(p) ? p.pid : parent && p.ppid > 1 ? owner(parent) : null
    agentOf.set(p.pid, r)
    return r
  }
  let agentMem = 0
  let agentCpu = 0
  const agents = new Set<number>()
  for (const p of list) {
    const a = owner(p)
    if (a == null) continue
    agents.add(a)
    agentMem += p.rss
    agentCpu += cpuOf.get(p.pid) ?? 0
  }
  const cpu = cpuPercent()
  const mem = m.total ? Math.round((m.used / m.total) * 100) : 0
  // Les familles ne sont calculées que quand ça chauffe (lecture de cmdline / cgroup des plus gros seulement).
  const fams = new Map<string, number>()
  if (cpu >= 70 || mem >= 80) {
    const key = cpu >= 70 ? (p: Proc) => cpuOf.get(p.pid) ?? 0 : (p: Proc) => p.rss
    for (const p of [...list].sort((a, b) => key(b) - key(a)).slice(0, 12)) {
      const v = cpu >= 70 ? Math.round(cpuOf.get(p.pid) ?? 0) : Math.round((p.rss / m.total) * 100)
      if (v > 0) fams.set(family(p), (fams.get(family(p)) ?? 0) + v)
    }
  }
  return {
    at,
    cpu,
    mem,
    swap: m.swapTotal ? Math.round((m.swapUsed / m.swapTotal) * 100) : null,
    load: os.loadavg()[0],
    agents: agents.size,
    agentMem: Math.round(agentMem / 1048576),
    agentCpu: Math.round(agentCpu),
    fams,
  }
}

function load(key: string): InfraPoint[] {
  return read(path.join(DIR, `${key}.jsonl`))
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as InfraPoint]
      } catch {
        return []
      }
    })
}

function flush() {
  if (!minute.length) return
  const avg = (f: (l: Live) => number) => Math.round(minute.reduce((s, l) => s + f(l), 0) / minute.length)
  const fams = new Map<string, number>()
  for (const l of minute) for (const [k, v] of l.fams) fams.set(k, (fams.get(k) ?? 0) + v / minute.length)
  const last = minute[minute.length - 1]
  const p: InfraPoint = {
    at: last.at,
    cpu: avg((l) => l.cpu),
    cpuMax: Math.max(...minute.map((l) => l.cpu)),
    mem: Math.max(...minute.map((l) => l.mem)),
    swap: last.swap,
    load: Math.round(last.load * 100) / 100,
    agents: Math.max(...minute.map((l) => l.agents)),
    agentMem: avg((l) => l.agentMem),
    agentCpu: avg((l) => l.agentCpu),
  }
  const dk = disk()
  if (dk.total) p.disk = Math.round((dk.used / dk.total) * 100)
  if (fams.size) p.top = [...fams].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => [k, Math.round(v)])
  minute = []
  const key = day(p.at)
  if (key !== todayKey) {
    todayKey = key
    today = []
  }
  today.push(p)
  try {
    fs.mkdirSync(DIR, { recursive: true })
    fs.appendFileSync(path.join(DIR, `${key}.jsonl`), JSON.stringify(p) + '\n')
  } catch {
    /* disque plein ou lecture seule : l'historique reste en mémoire */
  }
}

let started = false
export function startInfra() {
  if (started) return
  started = true
  todayKey = day(Date.now())
  today = load(todayKey)
  // Les jours de plus de 30 jours partent.
  try {
    for (const f of fs.readdirSync(DIR)) if (f.endsWith('.jsonl') && Date.now() - fs.statSync(path.join(DIR, f)).mtimeMs > 30 * 86400_000) fs.rmSync(path.join(DIR, f))
  } catch {
    /* pas encore d'historique */
  }
  let lastMinute = Math.floor(Date.now() / 60_000)
  const tick = () => {
    current = measure()
    minute.push(current)
    const m = Math.floor(current.at / 60_000)
    if (m !== lastMinute) {
      lastMinute = m
      flush()
    }
  }
  tick()
  setInterval(tick, TICK).unref()
}

// ---------------------------------------------------------------- ce qu'on montre

export function brief() {
  const c = current ?? measure()
  return { id: MACHINE.id, name: MACHINE.name, online: true, cpu: c.cpu, mem: c.mem, level: levelOf(c.cpu, c.mem), weevboss: ORCHESTRATOR }
}

/** Les minutes saturées, regroupées en épisodes (deux minutes d'accalmie au plus entre deux). */
export function episodes(points: InfraPoint[]): Episode[] {
  const out: (Episode & { fams: Map<string, number> })[] = []
  for (const p of points) {
    if (!saturated(p)) continue
    const last = out[out.length - 1]
    const e = last && p.at - last.to <= 3 * 60_000 ? last : (out.push({ from: p.at - 60_000, to: p.at, cpu: 0, mem: 0, fams: new Map() }), out[out.length - 1])
    e.to = p.at
    e.cpu = Math.max(e.cpu, p.cpuMax)
    e.mem = Math.max(e.mem, p.mem)
    for (const [k, v] of p.top ?? []) e.fams.set(k, (e.fams.get(k) ?? 0) + v)
  }
  return out.map(({ fams, ...e }) => ({ ...e, culprit: [...fams].sort((a, b) => b[1] - a[1])[0]?.[0] }))
}

/** Tranches de 5 minutes : la valeur la plus haute de chaque tranche (un pic ne disparaît pas dans une moyenne). */
function buckets(points: InfraPoint[]): InfraPoint[] {
  const map = new Map<number, InfraPoint>()
  for (const p of points) {
    const k = Math.floor(p.at / 300_000) * 300_000
    const b = map.get(k)
    if (!b) map.set(k, { ...p, at: k, top: undefined })
    else {
      b.cpu = Math.max(b.cpu, p.cpu)
      b.cpuMax = Math.max(b.cpuMax, p.cpuMax)
      b.mem = Math.max(b.mem, p.mem)
      b.agents = Math.max(b.agents, p.agents)
      b.load = Math.max(b.load, p.load)
    }
  }
  return [...map.values()]
}

const median = (xs: number[]) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}
const tier = (x: number, tiers: number[]) => tiers.find((t) => t >= x) ?? tiers[tiers.length - 1]
const VCPU = [2, 4, 8, 12, 16, 24, 32, 48, 64]
const RAM = [4, 8, 16, 32, 64, 128, 256]
const GB = 1024 ** 3

/** Ce qu'il faudrait pour n sessions, d'après ce qu'une session a vraiment pris aujourd'hui ici. */
export function sizing(points: InfraPoint[], memTotal: number, cores: number) {
  const withAgents = points.filter((p) => p.agents > 0)
  if (withAgents.length < 10) return null
  const perMem = median(withAgents.map((p) => p.agentMem / p.agents)) // Mo
  // CPU : les minutes où les sessions travaillent vraiment (le 3e quartile), pas leurs heures d'attente.
  const perCpuList = withAgents.map((p) => p.agentCpu / p.agents).sort((a, b) => a - b)
  const perCpu = Math.max(3, perCpuList[Math.floor(perCpuList.length * 0.75)] ?? 0) // % d'un cœur
  const baseMem = median(points.map((p) => (p.mem / 100) * (memTotal / 1048576) - p.agentMem)) // Mo hors sessions
  const baseCpu = median(points.map((p) => Math.max(0, (p.cpu / 100) * cores * 100 - p.agentCpu)))
  const capMem = Math.floor(((memTotal / 1048576) * 0.85 - baseMem) / perMem)
  const capCpu = Math.floor((cores * 100 * 0.8 - baseCpu) / perCpu)
  const capacity = Math.max(0, Math.min(capMem, capCpu))
  const peak = Math.max(...points.map((p) => p.agents))
  const target = [10, 20, 40, 80, 160].find((n) => n > Math.max(capacity, peak)) ?? 160
  const needMem = ((baseMem + target * perMem) / 0.85) * 1048576
  const needCpu = (baseCpu + target * perCpu) / 80
  // Jamais moins que ce que la machine a déjà : la marche suivante part d'ici.
  return { perMem, perCpu, capacity, peak, target, vcpu: Math.max(cores, tier(needCpu, VCPU)), ram: Math.max(tier(memTotal / GB - 0.5, RAM), tier(needMem / GB, RAM)) }
}

const hhmm = (t: number) => {
  const d = new Date(t)
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Pente (par jour) d'une série de points (jour, valeur) : moindres carrés. */
export function slope(xs: [number, number][]): number {
  if (xs.length < 2) return 0
  const mx = xs.reduce((s, [x]) => s + x, 0) / xs.length
  const my = xs.reduce((s, [, y]) => s + y, 0) / xs.length
  const num = xs.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0)
  const den = xs.reduce((s, [x]) => s + (x - mx) ** 2, 0)
  return den ? num / den : 0
}

interface AdviceInput {
  points: InfraPoint[]
  eps: Episode[]
  days: DaySummary[]
  mem: ReturnType<typeof meminfo>
  disk: ReturnType<typeof disk>
  cores: number
  offer: Offer | null
}

/** Chaque conseil vient d'une mesure qui franchit un seuil ou d'une tendance ; sans mesure, pas de conseil. */
export function advice({ points, eps, days, mem: m, disk: d, cores, offer: o }: AdviceInput): string[] {
  const t = tr(M)
  const out: string[] = []
  if (eps.length) {
    const culprits = [...new Set(eps.map((e) => e.culprit).filter(Boolean))] as string[]
    const worst = [...eps].sort((a, b) => Math.max(b.cpu, b.mem) - Math.max(a.cpu, a.mem))[0]
    out.push(t.saturated(eps.length, culprits.slice(0, 2), worst.cpu >= worst.mem ? `${worst.cpu} % CPU` : t.memPct(worst.mem), hhmm(worst.from)))
  }
  if (fs.existsSync('/proc/meminfo') && m.swapTotal === 0) out.push(t.noSwap(m.total >= 8 * GB ? 4 : 2))
  else if (m.swapTotal && m.swapUsed / m.swapTotal > 0.5) out.push(t.swapHigh(Math.round((m.swapUsed / m.swapTotal) * 100)))
  const highMem = points.filter((p) => p.mem >= 85).length
  if (highMem >= 30) out.push(t.memHigh(highMem))
  const avgCpu = points.length ? points.reduce((s, p) => s + p.cpu, 0) / points.length : 0
  if (points.length >= 60 && avgCpu >= 60) out.push(t.cpuHigh(Math.round(avgCpu)))
  // Tendances sur les jours mesurés (au moins 3) : mémoire moyenne qui monte, disque qui se remplit.
  if (days.length >= 3) {
    const idx = (k: string) => Math.round((Date.parse(k) - Date.parse(days[0].day)) / 86400_000)
    const memSlope = slope(days.map((x) => [idx(x.day), x.mem]))
    if (memSlope >= 2) out.push(t.memTrend(Math.round(memSlope * (days.length - 1)), days.length))
    const withDisk = days.filter((x) => x.disk != null)
    const diskSlope = slope(withDisk.map((x) => [idx(x.day), x.disk!]))
    const last = withDisk[withDisk.length - 1]?.disk
    if (withDisk.length >= 3 && diskSlope > 0.05 && last != null) {
      const left = Math.round((100 - last) / diskSlope)
      if (left <= 120) out.push(t.diskFull(left))
    }
  }
  if (d.total && d.used / d.total >= 0.85) out.push(t.diskHigh(Math.round((d.used / d.total) * 100), Math.round((d.total - d.used) / GB)))
  const s = sizing(points, m.total, cores)
  if (s) {
    out.push(t.perSession(Math.round(s.perMem), Math.round(s.perCpu), s.capacity))
    out.push(t.forN(s.target, s.vcpu, s.ram))
  }
  // Le palier au-dessus chez le même fournisseur, quand la machine est à l'étroit et que le prix est vérifié.
  const tight = eps.length > 0 || highMem >= 30 || (s != null && s.peak >= s.capacity)
  if (tight && o?.nextPlan && o.nextPrice != null) {
    const delta = o.price != null ? o.nextPrice - o.price : null
    out.push(t.upgrade(o.nextPlan, o.nextVcpu, o.nextRamGb, o.nextPrice, delta, o.currency ?? ''))
  }
  return out
}

// ---------------------------------------------------------------- serveurs à l'écoute

/** Ports exposés en https://<nom>.<EXPOSE_DOMAIN> : un <nom>.caddy par site dans EXPOSE_SITES_DIR (localhost ou 127.0.0.1). */
export function exposed(): Map<number, string> {
  const out = new Map<number, string>()
  const dir = EXPOSE_SITES_DIR
  if (!EXPOSE_DOMAIN || !dir) return out
  try {
    for (const f of fs.readdirSync(dir)) {
      const port = /(?:localhost|127\.0\.0\.1):(\d+)/.exec(read(path.join(dir, f)))?.[1]
      if (port && f.endsWith('.caddy')) out.set(Number(port), `https://${f.slice(0, -6)}.${EXPOSE_DOMAIN}`)
    }
  } catch {
    /* pas de Caddy */
  }
  return out
}

/** Ports à l'écoute (ss -ltnpH), avec le processus et son dossier quand il est à cet utilisateur. */
export function servers(): Promise<ServerProc[]> {
  return new Promise((resolve) => {
    execFile('ss', ['-ltnpH'], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve([])
      const urls = exposed()
      const seen = new Set<number>()
      const out: ServerProc[] = []
      for (const line of stdout.split('\n')) {
        const m = /\s(\S+):(\d+)\s+\S+\s*(?:users:\(\("([^"]+)",pid=(\d+))?/.exec(line)
        if (!m) continue
        const port = Number(m[2])
        // Ports d’autres utilisateurs (root : Caddy, systemd) : bruit, sauf s’ils sont exposés.
        if (seen.has(port) || (!m[3] && !urls.has(port))) continue
        seen.add(port)
        let dir: string | undefined
        if (m[4]) {
          try {
            dir = fs.readlinkSync(`/proc/${m[4]}/cwd`).replace(HOME, '~')
          } catch {
            /* processus d'un autre utilisateur */
          }
        }
        out.push({ port, name: m[3] ?? '?', dir, url: urls.get(port) })
      }
      resolve(out.sort((a, b) => a.port - b.port))
    })
  })
}

/** Les jours d'historique déjà écrits (jusqu'à 7, aujourd'hui compris), résumés. */
function lastDays(): DaySummary[] {
  let files: string[] = []
  try {
    files = fs.readdirSync(DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().slice(-7)
  } catch {
    return []
  }
  return files.flatMap((f) => {
    const key = f.slice(0, 10)
    const pts = key === todayKey ? today : load(key)
    if (pts.length < 30) return []
    const avg = (g: (p: InfraPoint) => number) => Math.round(pts.reduce((s, p) => s + g(p), 0) / pts.length)
    const disks = pts.filter((p) => p.disk != null)
    return [{ day: key, cpu: avg((p) => p.cpu), cpuMax: Math.max(...pts.map((p) => p.cpuMax)), mem: avg((p) => p.mem), memMax: Math.max(...pts.map((p) => p.mem)), ...(disks.length ? { disk: disks[disks.length - 1].disk } : {}) }]
  })
}

/** Le conteneur docker d'un processus (id court), lu dans son cgroup. */
const containerOf = (pid: number) => /(?:docker[-/]|containers\/)([0-9a-f]{12})/.exec(read(`/proc/${pid}/cgroup`))?.[1]

/** Une session claude / codex : son id (argument --session-id / --resume, ou le dossier de travail). */
function agentSession(pid: number): { id?: string; cwd?: string } {
  const args = read(`/proc/${pid}/cmdline`).split('\0')
  const i = args.findIndex((a) => a === '--session-id' || a === '--resume' || a === '-r')
  let cwd: string | undefined
  try {
    cwd = fs.readlinkSync(`/proc/${pid}/cwd`)
  } catch {
    /* disparu */
  }
  return { id: i >= 0 ? args[i + 1] : undefined, cwd }
}

/**
 * Ce qui consomme en ce moment, regroupé par ce qui l'explique : une session (avec tout ce qu'elle a lancé : tests,
 * navigateurs, serveurs), un conteneur docker, sinon une famille de processus. CPU mesuré depuis la dernière mesure.
 */
async function consumers(lookup: (id: string) => { title: string; projectId: string } | undefined): Promise<Consumer[]> {
  const list = procs()
  if (!list.length) return []
  const dt = (Date.now() - prevAt) / 1000
  const cpuOf = (p: Proc) => {
    const b = prevTicks.get(p.pid)
    return b != null && dt > 0 ? ((p.ticks - b) / HZ / dt) * 100 : 0
  }
  const byPid = new Map(list.map((p) => [p.pid, p]))
  const owner = new Map<number, number | null>()
  const agentOf = (p: Proc): number | null => {
    if (owner.has(p.pid)) return owner.get(p.pid)!
    owner.set(p.pid, null)
    const parent = byPid.get(p.ppid)
    const r = isAgent(p) ? p.pid : parent && p.ppid > 1 ? agentOf(parent) : null
    owner.set(p.pid, r)
    return r
  }
  const groups = new Map<string, { c: Consumer; parts: Map<string, number> }>()
  const names = new Map<string, string>()
  const docker = list.some((p) => p.comm === 'dockerd' || p.comm.startsWith('containerd'))
  if (docker) {
    const out = await new Promise<string>((r) => execFile('docker', ['ps', '--format', '{{.ID}} {{.Names}}'], { timeout: 3000 }, (e, o) => r(e ? '' : String(o))))
    for (const l of out.split('\n')) {
      const [id, name] = l.split(' ')
      if (id && name) names.set(id.slice(0, 12), name)
    }
  }
  for (const p of list) {
    const a = agentOf(p)
    const cid = a == null && docker ? containerOf(p.pid) : undefined
    let key: string
    let make: () => Consumer
    if (a != null) {
      key = `s:${a}`
      make = () => {
        const s = agentSession(a)
        const known = s.id ? lookup(s.id) : undefined
        const repo = s.cwd === ORCH_DIR ? 'weevboss' : s.cwd ? path.basename(s.cwd) : byPid.get(a)!.comm
        return { kind: 'session', label: known?.title ?? repo, sessionId: known ? s.id : undefined, projectId: known?.projectId, mem: 0, cpu: 0, count: 0, parts: [] }
      }
    } else if (cid) {
      key = `d:${cid}`
      make = () => ({ kind: 'container', label: names.get(cid) ?? cid, mem: 0, cpu: 0, count: 0, parts: [] })
    } else {
      // Les petits processus système ne sont pas lus en détail : seuls ceux qui pèsent reçoivent une famille.
      const heavy = p.rss > 30 * 1048576 || cpuOf(p) > 2
      const fam = heavy ? family(p) : p.comm
      key = `f:${fam}`
      make = () => ({ kind: 'process', label: fam, mem: 0, cpu: 0, count: 0, parts: [] })
    }
    let g = groups.get(key)
    if (!g) groups.set(key, (g = { c: make(), parts: new Map() }))
    const cpu = cpuOf(p)
    g.c.mem += p.rss
    g.c.cpu += cpu
    g.c.count++
    if (a != null && p.pid !== a && (p.rss > 30 * 1048576 || cpu > 2)) {
      const f = family(p)
      g.parts.set(f, (g.parts.get(f) ?? 0) + p.rss + cpu * 1048576 * 10)
    } else if (a == null && !cid && (p.rss > 30 * 1048576 || cpu > 2)) {
      // Un processus hors session : le dossier d'où il tourne dit à quel projet il sert.
      let dir = ''
      try {
        dir = fs.readlinkSync(`/proc/${p.pid}/cwd`)
      } catch {
        /* autre utilisateur */
      }
      if (dir.startsWith(HOME + path.sep)) g.parts.set(path.basename(dir), (g.parts.get(path.basename(dir)) ?? 0) + p.rss + cpu * 1048576 * 10)
    }
  }
  const total = meminfo().total
  return [...groups.values()]
    .map(({ c, parts }) => ({ ...c, cpu: Math.round(c.cpu), parts: [...parts].sort((x, y) => y[1] - x[1]).map(([k]) => k).slice(0, 4) }))
    // Ce qui compte : au moins 1 % de la mémoire ou 5 % d'un cœur.
    .filter((c) => c.mem >= total * 0.01 || c.cpu >= 5)
    .sort((a, b) => b.mem / total + b.cpu / 100 / effectiveCores() - (a.mem / total + a.cpu / 100 / effectiveCores()))
    .slice(0, 10)
}

export async function detail(lookup: (id: string) => { title: string; projectId: string } | undefined = () => undefined): Promise<InfraDetail> {
  const m = meminfo()
  const d = disk()
  const cores = effectiveCores()
  const c = current ?? measure()
  const pts = [...today]
  const eps = episodes(pts)
  const f = await facts()
  const o = offer(f, cores, m.total, d.total)
  const days = lastDays()
  return {
    id: MACHINE.id,
    name: MACHINE.name,
    weevboss: ORCHESTRATOR,
    facts: f,
    offer: o,
    reach: [],
    cores,
    memTotal: m.total,
    memUsed: m.used,
    swapTotal: m.swapTotal,
    swapUsed: m.swapUsed,
    diskTotal: d.total,
    diskUsed: d.used,
    cpu: c.cpu,
    load: os.loadavg().map((x) => Math.round(x * 100) / 100) as [number, number, number],
    uptime: os.uptime() * 1000,
    day: buckets(pts),
    episodes: eps,
    days,
    servers: await servers(),
    consumers: await consumers(lookup),
    advice: advice({ points: pts, eps, days, mem: m, disk: d, cores, offer: o }),
  }
}

// ---------------------------------------------------------------- système de fichiers (tout, pas seulement les repos)

export function listDir(p: string): FsListing {
  const dir = path.resolve(p.replace(/^~(?=\/|$)/, HOME) || '/')
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).map((e) => {
      const full = path.join(dir, e.name)
      let isDir = e.isDirectory()
      let size = 0
      try {
        const st = fs.statSync(full)
        isDir = st.isDirectory()
        size = isDir ? 0 : st.size
      } catch {
        /* lien cassé, droits */
      }
      return { name: e.name, dir: isDir, size, ...(e.isSymbolicLink() ? { link: true } : {}) }
    })
    entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
    return { path: dir, home: HOME, entries: entries.slice(0, 3000) }
  } catch (e) {
    return { path: dir, home: HOME, entries: [], error: (e as NodeJS.ErrnoException).code ?? (e as Error).message }
  }
}

export function readAny(p: string): { path: string; size: number; binary: boolean; content: string; truncated: boolean } {
  const full = path.resolve(p.replace(/^~(?=\/|$)/, HOME))
  const st = fs.statSync(full)
  if (!st.isFile()) throw new Error(`${full}: not a file`) // i18n-ignore : chemin technique
  const max = 400_000
  const fd = fs.openSync(full, 'r')
  const buf = Buffer.alloc(Math.min(st.size, max))
  fs.readSync(fd, buf, 0, buf.length, 0)
  fs.closeSync(fd)
  const binary = buf.subarray(0, 8000).includes(0)
  return { path: full, size: st.size, binary, content: binary ? '' : buf.toString('utf8'), truncated: st.size > max }
}
