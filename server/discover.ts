// La machine se découvre toute seule : matériel ou virtualisation (DMI, systemd-detect-virt ; sur un Mac, son modèle
// et sa batterie), OS, IP publique,
// fournisseur et région (ASN de l'IP via ipinfo.io, reverse DNS), comment s'y connecter (utilisateur, port sshd,
// alias SSH vus par les autres machines), l'offre probable chez le fournisseur et le palier au-dessus (recherche web
// de claude sur le site du fournisseur, null pour tout ce qui n'y est pas vérifié). Rien n'est supposé : un fait
// introuvable reste absent.
// WEEVILS_DISCOVER (config.ts) : 1 = tout, appels sortants compris (ipinfo.io, reverse DNS, recherche web) ;
// facts (défaut) = faits locaux seulement, aucun appel sortant ; 0 = l'essentiel (nom, OS, CPU, alias SSH), rien de sondé.

import { execFile } from 'node:child_process'
import dns from 'node:dns/promises'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { MachineFacts, Offer, SshTarget } from '../shared/infra.ts'
import { CONFIG_DIR, DATA_DIR, DISCOVER, HOME } from './config.ts'
import { macHasBattery } from './platform.ts'

const DIR = path.join(DATA_DIR, 'infra')
const read = (f: string) => {
  try {
    return fs.readFileSync(f, 'utf8').trim()
  } catch {
    return ''
  }
}
const run = (cmd: string, args: string[], timeout = 4000) =>
  new Promise<string>((resolve) => execFile(cmd, args, { timeout }, (err, out) => resolve(err ? '' : String(out).trim())))
const cacheFile = (name: string) => path.join(DIR, name)
function cached<T>(name: string, maxAge: number): T | null {
  try {
    const f = cacheFile(name)
    if (Date.now() - fs.statSync(f).mtimeMs > maxAge) return null
    return JSON.parse(fs.readFileSync(f, 'utf8')) as T
  } catch {
    return null
  }
}
function save(name: string, v: unknown) {
  try {
    fs.mkdirSync(DIR, { recursive: true })
    fs.writeFileSync(cacheFile(name), JSON.stringify(v))
  } catch {
    /* lecture seule */
  }
}

/** Valeurs DMI de remplissage (« To be filled by O.E.M. », « Default string ») : pas une information. */
const meaningful = (s: string) => !!s && !/^(to be filled|default|system (product|manufacturer)|not specified|none|o\.e\.m|0+$)/i.test(s)
/** « Hostinger International Limited » → « Hostinger International » : les formes juridiques ne disent rien. */
const company = (s: string) => s.replace(/^AS\d+\s+/, '').replace(/[,.]?\s+(limited|ltd\.?|inc\.?|llc|gmbh|s\.?a\.?s?\.?|b\.?v\.?|plc|corp(oration)?\.?|co\.?)$/i, '').trim()

/** Le premier IPv4 public d'une interface (une machine derrière une box n'en a pas : l'IP vient alors d'ipinfo). */
function interfaceIp(): string | undefined {
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal && !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|169\.254\.)/.test(a.address)) return a.address
  return undefined
}

interface IpInfo {
  ip?: string
  hostname?: string
  city?: string
  region?: string
  country?: string
  org?: string
  timezone?: string
}

async function ipinfo(): Promise<IpInfo | null> {
  const hit = cached<IpInfo>('ipinfo.json', 24 * 3600_000)
  if (hit) return hit
  try {
    const res = await fetch('https://ipinfo.io/json', { headers: { accept: 'application/json', 'user-agent': 'weevils' }, signal: AbortSignal.timeout(5000) })
    if (!res.ok) return null
    const j = (await res.json()) as IpInfo
    save('ipinfo.json', j)
    return j
  } catch {
    return null
  }
}

/** Les hôtes de ~/.ssh/config (sans les motifs) : ce par quoi cette machine joint les autres. */
export function sshTargets(): SshTarget[] {
  const out: SshTarget[] = []
  let cur: SshTarget[] = []
  for (const raw of read(path.join(HOME, '.ssh', 'config')).split('\n')) {
    const m = /^\s*(\w+)\s*=?\s*(.+?)\s*$/.exec(raw)
    if (!m || raw.trim().startsWith('#')) continue
    const [k, v] = [m[1].toLowerCase(), m[2]]
    if (k === 'host' || k === 'match') {
      cur = k === 'host' ? v.split(/\s+/).filter((a) => !/[*?!]/.test(a)).map((alias) => ({ alias, host: alias })) : []
      out.push(...cur)
    } else if (k === 'hostname') for (const t of cur) t.host = v
    else if (k === 'user') for (const t of cur) t.user = v
    else if (k === 'port') for (const t of cur) t.port = Number(v)
  }
  // Une machine secondaire joint la principale par l'hôte SSH donné à l'installation.
  const main = /^WEEVILS_MAIN_HOST=['"]?([^'"\s]+)/m.exec(read(path.join(CONFIG_DIR, 'service.conf')))?.[1]
  if (main && !out.some((t) => t.alias === main)) out.push({ alias: main, host: main })
  return out
}

/** Quelque chose écoute sur ce port de la machine (300 ms au plus). */
const listening = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port })
    const done = (ok: boolean) => (s.destroy(), resolve(ok))
    s.setTimeout(300, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })

/** Le port de sshd. Un Mac a toujours /usr/sbin/sshd, mais « Session à distance » y est coupée d'origine : le port n'est
 * dit que si quelque chose y écoute. */
export async function sshdPort(platform: NodeJS.Platform = process.platform, probe: (port: number) => Promise<boolean> = listening, exists: (f: string) => boolean = fs.existsSync): Promise<number | undefined> {
  if (!exists('/usr/sbin/sshd') && !exists('/usr/bin/sshd')) return undefined
  const conf = [read('/etc/ssh/sshd_config'), ...(() => {
    try {
      return fs.readdirSync('/etc/ssh/sshd_config.d').map((f) => read(path.join('/etc/ssh/sshd_config.d', f)))
    } catch {
      return []
    }
  })()].join('\n')
  const p = /^\s*Port\s+(\d+)/im.exec(conf)?.[1]
  const port = p ? Number(p) : 22
  if (platform === 'darwin' && !(await probe(port))) return undefined
  return port
}

/** Un Mac portable : une batterie interne (`pmset -g batt`), ou à défaut un nom de modèle en « Book » (ceux d'avant
 * 2022 ; depuis, un MacBook Air s'appelle « Mac14,2 »). */
export const macLaptop = (model: string, pmsetBatt: string) => macHasBattery(pmsetBatt) || /book/i.test(model)

let macCache: { hardware?: string; laptop: boolean } | null = null
/** Sur un Mac, ce que /sys dit ailleurs : le modèle (« Apple Mac14,2 ») et s'il a une batterie. Sondé une fois : ça ne
 * change pas. */
export async function macFacts(exec: typeof run = run): Promise<{ hardware?: string; laptop: boolean }> {
  if (macCache && exec === run) return macCache
  const [model, batt] = await Promise.all([exec('sysctl', ['-n', 'hw.model'], 2000), exec('pmset', ['-g', 'batt'], 2000)])
  const v = { hardware: model ? `Apple ${model}` : undefined, laptop: macLaptop(model, batt) }
  if (model && exec === run) macCache = v
  return v
}

let factsCache: { at: number; v: MachineFacts } | null = null

export async function facts(): Promise<MachineFacts> {
  if (factsCache && Date.now() - factsCache.at < 3600_000) return factsCache.v
  const local = DISCOVER !== '0'
  const online = DISCOVER === '1'
  const dmi = (k: string) => (local ? read(`/sys/class/dmi/id/${k}`) : '')
  const virtRaw = local ? (process.platform === 'darwin' ? '' : await run('systemd-detect-virt', [])) || (fs.existsSync('/.dockerenv') ? 'docker' : '') : ''
  const virt = virtRaw && virtRaw !== 'none' ? virtRaw : undefined
  const vendor = dmi('sys_vendor')
  const product = dmi('product_name')
  // Une VM montre l'émulateur (QEMU, « Standard PC ») : seul le matériel d'une machine physique est dit.
  const mac = local && process.platform === 'darwin' ? await macFacts() : null
  const hardware = !virt && meaningful(vendor) ? [vendor, meaningful(product) ? product : ''].filter(Boolean).join(' ') : mac?.hardware
  const chassis = Number(dmi('chassis_type')) || undefined
  const osName = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(read('/etc/os-release'))?.[1] ?? (process.platform === 'darwin' ? `macOS ${await run('sw_vers', ['-productVersion'])}`.trim() : undefined) // i18n-ignore : nom de commande
  const info = online ? await ipinfo() : null
  const ifIp = local ? interfaceIp() : undefined
  const ip = ifIp ?? info?.ip
  let rdns: string | undefined
  if (ip && online) rdns = (await dns.reverse(ip).catch(() => []))[0] ?? info?.hostname
  const org = info?.org ? company(info.org) : undefined
  const v: MachineFacts = {
    hostname: os.hostname(),
    user: os.userInfo().username,
    os: osName,
    kernel: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    cpuModel: os.cpus()[0]?.model.replace(/\s+/g, ' ').trim() || undefined,
    virt,
    hardware,
    laptop: chassis ? [8, 9, 10, 14, 31, 32].includes(chassis) : mac?.laptop,
    ip,
    publicIp: !!ifIp,
    rdns,
    asn: /^AS\d+/.exec(info?.org ?? '')?.[0],
    // Hébergée (virtualisée, IP publique sur l'interface) : l'ASN est l'hébergeur. Sinon c'est le réseau (box, FAI).
    provider: virt && ifIp ? org : undefined,
    network: virt && ifIp ? undefined : org,
    city: info?.city,
    region: info?.region,
    country: info?.country,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    sshPort: local ? await sshdPort() : undefined,
    ssh: sshTargets(),
  }
  factsCache = { at: Date.now(), v }
  return v
}

// ---------------------------------------------------------------- offre chez le fournisseur

let offerRunning = false

/**
 * L'offre qui correspond à la machine et le palier au-dessus, cherchés sur le site du fournisseur par claude (recherche
 * web, une fois par semaine et par configuration). Tout ce qui n'y est pas vérifié revient null ; sans fournisseur connu,
 * rien n'est cherché.
 */
export function offer(f: MachineFacts, cores: number, memTotal: number, diskTotal: number): Offer | null {
  if (DISCOVER !== '1' || !f.provider) return null
  const key = `offer-${[f.provider, cores, Math.round(memTotal / 1024 ** 3), Math.round(diskTotal / 1024 ** 3)].join('-').replace(/[^\w.-]+/g, '_')}.json`
  const hit = cached<Offer>(key, 7 * 86400_000)
  if (hit || offerRunning) return hit
  offerRunning = true
  const prompt =
    `A server is hosted by "${f.provider}"${f.asn ? ` (${f.asn})` : ''}${f.rdns ? `, reverse DNS ${f.rdns}` : ''}${f.country ? `, country ${f.country}` : ''}. ` +
    `It is a ${f.virt ?? 'virtual'} machine with ${cores} vCPU, ${(memTotal / 1024 ** 3).toFixed(1)} GiB RAM, ${Math.round(diskTotal / 1024 ** 3)} GiB disk. ` +
    `Using web search on the provider's own website, find the current public plan that matches these specs, and the next plan up. ` +
    `Reply with JSON only: {"plan": string|null, "price": number|null, "nextPlan": string|null, "nextVcpu": number|null, "nextRamGb": number|null, "nextPrice": number|null, "currency": string|null, "url": string|null}. ` +
    `Prices are the regular monthly price shown on the site. Use null for anything you did not verify on the provider's site. No prose.`
  execFile(
    'claude',
    ['-p', '--model', 'sonnet', '--tools', 'WebSearch,WebFetch', '--allowedTools', 'WebSearch,WebFetch', '--no-session-persistence', prompt],
    { timeout: 240_000, maxBuffer: 1 << 20, cwd: os.tmpdir() },
    (err, out) => {
      offerRunning = false
      if (err) return console.error(`[infra] offre : ${err.message.split('\n')[0]}`)
      const m = /\{[\s\S]*\}/.exec(String(out))
      try {
        const j = JSON.parse(m?.[0] ?? '') as Offer
        const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : null)
        const str = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim() : null)
        save(key, { plan: str(j.plan), price: num(j.price), nextPlan: str(j.nextPlan), nextVcpu: num(j.nextVcpu), nextRamGb: num(j.nextRamGb), nextPrice: num(j.nextPrice), currency: str(j.currency), url: str(j.url) })
      } catch {
        console.error('[infra] offre : réponse illisible')
      }
    },
  ).stdin?.end()
  return null
}
