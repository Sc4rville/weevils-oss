// Accueil et branchements : weevboss accueille les nouveaux venus dans son fil, comme un collègue, et propose chaque
// brique (téléphone, machine, Claude Code, Codex, GitHub, voix, diable, e-mail, Siri, quota, sécurité) au moment où elle
// sert. Tout part de l'état réel, détecté ici : jamais une liste figée.
//
// - detect() : l'état de chaque brique (machine : type, OS, CPU, RAM, toujours allumée ou non ; outils installés,
//   connexions, clés présentes…). « weevils setup » l'imprime pour weevboss.
// - Les messages que weevilsd écrit au nom de weevboss (accueil, réponse à une puce, confirmation d'un branchement)
//   vivent dans DATA_DIR/setup.json et se mêlent à son fil, comme ceux du devil mode. Ils arrivent aussi chez weevboss :
//   le prochain message qu'on lui envoie porte un bloc ⟦weevils …⟧ (jamais affiché) qui les résume.
// - apply() reçoit les réponses d'un parcours (champ du bas, src/ui/setup.tsx), vérifie pour de vrai (le modèle répond,
//   GitHub accepte le jeton, Gmail accepte le mot de passe…), écrit ~/.config/weevils/env et répond dans le fil.
//   Les secrets ne passent ni par le modèle ni par les journaux : le fil n'en montre que les 4 derniers caractères.
// - Jamais de commande à taper pour l'utilisateur. Ce qui s'installe dans son dossier, weevilsd l'installe lui-même
//   (Claude Code, gh, la voix gratuite, Codex) ; Claude Code et Codex se connectent par un lien (et un code collé en
//   bas pour Claude) ; un VPS se branche avec son adresse et son mot de passe (weevilsd y pose sa clé SSH). Ce qui
//   demande un vrai travail (domaine, Tailscale, installer weevils sur la nouvelle machine) part chez weevboss :
//   une phrase visible dans son fil, la marche à suivre exacte dans le bloc ⟦weevils …⟧ qui l'accompagne.

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import dns from 'node:dns/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Message, Tool } from '../shared/api.ts'
import { preferredTool, providerStatus, providerReady, codexLogged } from './provider.ts'
import type { MachineFacts } from '../shared/infra.ts'
import { CONTEXT_BLOCK, FIELDS, isSecretName, type Brick, type Device } from '../shared/setup.ts'
import { BOSS, resetAuthors, authors } from './authors.ts'
import { CONFIG_FILE, DATA_DIR, HOME, HOST, MACHINE, PORT, PUBLIC_URL, USER_NAME } from './config.ts'
import { claudeLoggedIn } from './claude-credentials.ts'
import * as claudeLogin from './claude-login.ts'
import { accounts } from './claude-accounts.ts'
import AccountsM from './i18n/claude-accounts.ts'
import { servicePath, which as whichIn } from './platform.ts'
import { devilConfig } from './devil.ts'
import { facts, macFacts } from './discover.ts'
import { cartesia, edgeTts } from './fast.ts'
import { lang, tr } from './i18n.ts'
import M from './i18n/setup.ts'
import { Imap } from './imap.ts'
import { mailConfig } from './mailbridge.ts'
import type { Memory } from './memory.ts'
import { quotas } from './usage.ts'

const FILE = path.join(DATA_DIR, 'setup.json')
/** En deçà, un message automatique identique n'est pas reposté (voir Setup.add). */
const REPEAT_MS = 30 * 60_000
/** Le clone de weevils qui tourne (install.sh, changer l'interface en direct). */
const CLONE = path.resolve(import.meta.dirname, '..')

export type Kind = 'vps' | 'server' | 'container' | 'vm' | 'laptop' | 'desktop' | 'wsl'

export interface MachineInfo {
  kind: Kind
  mac: boolean
  os: string
  cpus: number
  ramGb: number
  uptimeDays: number
  /** Allumée en continu : oui (serveur), non (portable), null (on ne sait pas). */
  alwaysOn: boolean | null
  provider?: string
  host: string
  user: string
  /** Comment l'atteindre en SSH depuis un ordinateur : user@ip ou user@nom. */
  sshTarget: string
  /** Agents qui tiennent à la fois, à la louche (≈ 1 Go chacun, 1,5 Go gardés pour le reste ; 4 Go sur un Mac). */
  agents: number
  /** Les autres machines branchées (en ligne). */
  others: string[]
  /** Une des autres machines reste allumée (VPS, serveur). */
  othersAlwaysOn: boolean
}

export interface SetupState {
  machine: MachineInfo
  reach: 'public' | 'lan' | 'local'
  url: string
  https: boolean
  port: number
  clone: string
  claude: { installed: boolean; logged: boolean }
  codex: { installed: boolean; logged: boolean }
  github: { installed: boolean; logged: boolean; login?: string }
  voice: { spoken: 'cartesia' | 'edge' | null; openai: boolean; https: boolean }
  devil: { plugged: boolean; model?: string }
  /** pending : auteurs déclarés sans adresse e-mail (ils ne peuvent pas encore écrire). */
  mail: { on: boolean; address?: string; authors: number; pending: string[] }
  phone: { devices: number; push: number }
  shortcut: boolean
  security: { safe: boolean; https: boolean; exposedHttp: boolean }
  quota: string[]
  pkg: 'apt' | 'dnf' | 'pacman' | 'brew' | null
  sudo: 'yes' | 'password' | 'no'
  tools: { git: boolean; tmux: boolean; curl: boolean; python3: boolean; qrencode: boolean; pipx: boolean; uv: boolean; node: number }
  projects: number
}

export interface SetupDeps {
  bump: () => void
  /** Machines du fil (la première est celle-ci) et nombre de projets. */
  feed: () => { machines: { id: string; name: string; online?: boolean }[]; projects: number }
  /** Faits des autres machines (fédération), pour savoir si l'une reste allumée. */
  remoteFacts: () => Promise<MachineFacts[]>
  devices: () => number
  push: () => number
  shortcut: () => boolean
  /** Ids des bulles et gestes déjà vus (hints.json). */
  seen: () => string[]
  /** Le fil de weevboss a déjà servi (installation existante) : pas d'accueil. */
  hasHistory: () => boolean
  /** Le pont e-mail vient d'être configuré : le lancer. */
  startMail: () => void
  /** Confie un travail à weevboss : « text » s'affiche dans son fil comme venant de l'utilisateur, « brief » (la marche
   * à suivre exacte) l'accompagne dans le bloc ⟦weevils …⟧, jamais affiché. */
  handoff: (text: string, brief: string) => Promise<unknown>
  /** Ce que weevils retient de l'utilisateur (server/memory.ts) : null sur une machine secondaire. */
  memory?: () => Memory | null
  /** La conversation de weevboss où ira le prochain message (id de sa session Claude), null quand ce message en ouvrira
   * une nouvelle : une nouvelle conversation reçoit le résumé de la mémoire. */
  bossId?: () => string | null
}

interface Persisted {
  log: Message[]
  device?: Device
  /** Quand chaque brique, astuce ou geste a été proposé par weevboss (ou weevilsd en son nom). */
  marks: Record<string, number>
  /** Jusqu'où weevboss (le modèle) a reçu les messages écrits en son nom. */
  bossSeenAt: number
  welcomed?: boolean
  claudeLogged?: boolean
  /** A Codex device sign-in shown and not finished yet: confirmed by watch() even after a restart of weevilsd. */
  codexWaiting?: boolean
  githubLogged?: boolean
  /** Un travail pour weevboss qui attend que Claude Code soit connecté (un VPS branché avant la connexion). */
  pending?: { text: string; brief: string }
  /** La mémoire telle que weevboss l'a reçue en dernier (signature) et dans quelle conversation. */
  memorySeen?: { sig: string; boss: string | null }
}

// ---------------------------------------------------------------- détection

const read = (f: string) => {
  try {
    return fs.readFileSync(f, 'utf8')
  } catch {
    return ''
  }
}
/** L'environnement des installations et des connexions : ~/.local/bin d'abord, là où elles posent leurs outils sans
 * sudo. Sur un Mac, les dossiers de Homebrew en plus (launchd n'en donne aucun à un service). */
export function shellEnv(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = HOME): NodeJS.ProcessEnv {
  const PATH = [path.join(home, '.local', 'bin'), path.join(home, '.npm-global', 'bin'), env.PATH ?? ''].join(path.delimiter)
  return { ...env, PATH: servicePath(PATH, platform, home) }
}
/** Pour une commande d'installation : en plus, sur un Mac, brew ne pose jamais de question et ne donne pas de conseils. */
export const installEnv = (platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = HOME): NodeJS.ProcessEnv =>
  platform === 'darwin' ? { ...shellEnv(platform, env, home), NONINTERACTIVE: '1', HOMEBREW_NO_ENV_HINTS: '1' } : shellEnv(platform, env, home)
const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g
/** La dernière ligne utile d'une sortie (la raison d'un échec, en clair). */
const lastLine = (out: string) => out.replace(ANSI, '').split('\n').map((l) => l.trim()).filter(Boolean).pop()?.slice(0, 140) ?? ''
const sh = (cmd: string, timeout = 600_000) =>
  new Promise<{ ok: boolean; out: string }>((resolve) =>
    execFile('bash', ['-c', cmd], { timeout, env: installEnv(), maxBuffer: 8 << 20 }, (err, out, errOut) => resolve({ ok: !err, out: `${String(out ?? '')}\n${String(errOut ?? '')}`.trim() })),
  )
const run = (cmd: string, args: string[], timeout = 6000, env?: NodeJS.ProcessEnv) =>
  new Promise<{ ok: boolean; out: string }>((resolve) =>
    execFile(cmd, args, { timeout, env: env ?? process.env }, (err, out) => resolve({ ok: !err, out: String(out ?? '').trim() })),
  )

/** Une commande installée : dans le PATH, ou là où les installateurs la posent (server/platform.ts). */
export const which = (cmd: string): string | null => whichIn(cmd, process.platform, HOME)

/** Claude Code connecté : les identifiants de /login, une clé dans l'environnement, ou sur un Mac le trousseau (server/claude-credentials.ts). */
export const claudeLogged = (): boolean => claudeLoggedIn()

let ghCache: { at: number; v: { installed: boolean; logged: boolean; login?: string } } | null = null
async function github(force = false) {
  if (!force && ghCache && Date.now() - ghCache.at < 60_000) return ghCache.v
  const gh = which('gh')
  let v: { installed: boolean; logged: boolean; login?: string } = { installed: !!gh, logged: false }
  if (gh) {
    const r = await run(gh, ['api', 'user', '-q', '.login'], 8000)
    v = { installed: true, logged: r.ok && !!r.out, login: r.ok ? r.out : undefined }
  }
  ghCache = { at: Date.now(), v }
  return v
}

function osName(): string {
  // (Sur un Mac, machine() préfère « macOS 15.1 », lu par discover.ts.)
  if (process.platform === 'darwin') return 'macOS'
  const pretty = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(read('/etc/os-release'))?.[1]
  return pretty?.replace(/\s+LTS$/, '') || os.type()
}

/** Sur un Mac aussi : un compte administrateur donne « password », un compte standard « no ». Rien de ce que fait le
 * parcours n'y demande les droits administrateur (Homebrew, l'app Tailscale, un agent launchd). */
export async function sudo(uid = process.getuid?.(), has: (cmd: string) => boolean = (c) => !!which(c), exec: typeof run = run): Promise<SetupState['sudo']> {
  if (uid === 0) return 'yes'
  if (!has('sudo')) return 'no'
  if ((await exec('sudo', ['-n', 'true'], 3000)).ok) return 'yes'
  return /\b(sudo|wheel|admin)\b/.test((await exec('id', ['-nG'], 3000)).out) ? 'password' : 'no'
}

/** Le gestionnaire de paquets. Sur un Mac : Homebrew s'il est là (install.sh l'installe), sinon aucun. */
export function pkgManager(platform: NodeJS.Platform = process.platform, has: (cmd: string) => boolean = (c) => !!which(c)): SetupState['pkg'] {
  if (platform === 'darwin') return has('brew') ? 'brew' : null
  if (has('apt-get')) return 'apt'
  if (has('dnf')) return 'dnf'
  if (has('pacman')) return 'pacman'
  return null
}

const SERVER_VIRT = /^(kvm|qemu|vmware|xen|microsoft|amazon|google|oracle|bochs|parallels|bhyve|powervm|zvm|acrn|uml|apple|sre)$/
const CONTAINER_VIRT = /^(docker|podman|lxc|lxc-libvirt|systemd-nspawn|rkt|openvz|container-other|wsl)$/

/** Le type de machine, à partir de ce qui a été détecté. Un Mac est un portable s'il a une batterie (« laptop » vient
 * alors de `pmset -g batt`, server/discover.ts), sinon un fixe : sa virtualisation ne compte pas. */
export function machineKind(o: { wsl: boolean; mac: boolean; virt: string; laptop: boolean; publicIp: boolean; provider: boolean }): Kind {
  if (o.wsl) return 'wsl'
  if (o.mac) return o.laptop ? 'laptop' : 'desktop'
  if (CONTAINER_VIRT.test(o.virt)) return 'container'
  if (SERVER_VIRT.test(o.virt)) return o.publicIp || o.provider ? 'vps' : 'vm'
  if (o.laptop) return 'laptop'
  return o.publicIp ? 'server' : 'desktop'
}

/** Agents qui tiennent à la fois, à la louche : ≈ 1 Go chacun, 1,5 Go gardés pour le système ; 4 Go sur un Mac, où
 * macOS et les apps ouvertes de son propriétaire en prennent bien plus. */
export const agentRoom = (ramGb: number, mac: boolean) => Math.max(1, Math.floor(ramGb - (mac ? 4 : 1.5)))

async function machine(deps: SetupDeps): Promise<MachineInfo> {
  const f = await facts().catch(() => null)
  const virt = f?.virt ?? ''
  const mac = process.platform === 'darwin'
  const battery = (() => {
    try {
      return fs.readdirSync('/sys/class/power_supply').some((d) => d.startsWith('BAT'))
    } catch {
      return false
    }
  })()
  const wsl = virt === 'wsl' || /microsoft/i.test(read('/proc/version'))
  // (WEEVILS_DISCOVER=0 : discover.ts ne sonde rien ; la batterie d'un Mac se lit quand même, comme /sys ci-dessus.)
  const laptop = mac ? (f?.laptop ?? (await macFacts()).laptop) : !!f?.laptop || battery
  const kind = machineKind({ wsl, mac, virt, laptop, publicIp: !!f?.publicIp, provider: !!f?.provider })
  const uptimeDays = os.uptime() / 86400
  // Un Mac fixe reste éveillé tant que weevilsd tourne (caffeinate, server/platform.ts) ; sans ça (WEEVILS_KEEP_AWAKE=0),
  // sa durée d'allumage compte aussi la veille et ne dit rien.
  const dozes = mac && process.env.WEEVILS_KEEP_AWAKE?.trim() === '0'
  const alwaysOn = kind === 'laptop' || kind === 'wsl' ? false : kind === 'desktop' ? (uptimeDays > 3 && !dozes ? true : null) : true
  // Dans un conteneur, les limites qui comptent sont celles du cgroup (--cpus, --memory), pas celles de l'hôte.
  const quota = /^(\d+)\s+(\d+)/.exec(read('/sys/fs/cgroup/cpu.max'))
  const memMax = Number(read('/sys/fs/cgroup/memory.max').trim())
  const cpus = Math.min(os.cpus().length || 1, quota ? Math.max(1, Math.ceil(Number(quota[1]) / Number(quota[2]))) : Infinity)
  const ramGb = (Number.isFinite(memMax) && memMax > 0 && memMax < os.totalmem() ? memMax : os.totalmem()) / 2 ** 30
  const feed = deps.feed()
  const others = feed.machines.filter((m) => m.id !== MACHINE.id && m.online !== false).map((m) => m.name)
  const remote = others.length ? await deps.remoteFacts().catch(() => []) : []
  const user = f?.user || os.userInfo().username
  const publicHost = (() => {
    try {
      return PUBLIC_URL ? new URL(PUBLIC_URL).hostname : ''
    } catch {
      return ''
    }
  })()
  const host = MACHINE.name || os.hostname()
  return {
    kind,
    mac,
    os: (mac && f?.os) || osName(),
    cpus,
    ramGb,
    uptimeDays,
    alwaysOn,
    provider: f?.provider,
    host,
    user,
    sshTarget: `${user}@${(f?.publicIp && f.ip) || (kind === 'vps' || kind === 'server' ? publicHost : '') || os.hostname()}`,
    agents: agentRoom(ramGb, mac),
    others,
    othersAlwaysOn: remote.some((r) => (r.virt && SERVER_VIRT.test(r.virt) && r.publicIp) || !!r.provider || (r.virt && CONTAINER_VIRT.test(r.virt) && r.virt !== 'wsl')),
  }
}

/** Le quota des abonnements, en clair (« Claude max session 12 % · semaine 40 % »). */
async function quotaLines(): Promise<string[]> {
  const q = await quotas().catch(() => null)
  if (!q) return []
  const t = tr(M)
  const out: string[] = []
  for (const [tool, info] of [['Claude', q.claude], ['Codex', q.codex]] as const) {
    if (!info?.ok || !info.windows.length) continue
    out.push(t.quotaLine(tool, info.plan ?? '', info.windows.filter((w) => w.kind !== 'model').map((w) => t.quotaWindow(w.kind, Math.round(w.percent))).join(', ')))
  }
  return out
}

// ---------------------------------------------------------------- fichier de config

/** Écrit des clés dans ~/.config/weevils/env (remplace la ligne existante, sinon ajoute) et dans l'environnement du
 * serveur, pour que le changement prenne aussitôt. Valeur vide = clé vidée. Jamais journalisé. */
export function writeConfig(changes: Record<string, string>) {
  const lines = read(CONFIG_FILE).split('\n')
  if (lines.at(-1) === '') lines.pop()
  for (const [k, raw] of Object.entries(changes)) {
    // i18n-ignore : erreur de programmation, jamais montrée
    if (!/^[A-Z][A-Z0-9_]*$/.test(k)) throw new Error(`bad key ${k}`)
    const v = raw.replace(/[\r\n]+/g, ' ').trim()
    const live = lines.findIndex((l) => new RegExp(`^\\s*${k}\\s*=`).test(l))
    const example = lines.findIndex((l) => new RegExp(`^\\s*#\\s*${k}\\s*=`).test(l))
    const line = `${k}=${v}`
    if (live >= 0) lines[live] = line
    else if (example >= 0) lines.splice(example + 1, 0, line)
    else lines.push(line)
    if (v) process.env[k] = v
    else delete process.env[k]
  }
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, lines.join('\n') + '\n', { mode: 0o600 })
  fs.renameSync(tmp, CONFIG_FILE)
}

// ---------------------------------------------------------------- gestes et astuces (pour weevboss)

/** Chaque geste de l'app, et l'id (hints.json) qui dit qu'il a été vu ou fait. */
export const GESTURES: [id: string, seen: string, what: string][] = [
  ['voice', 'voice', 'tap the weevboss logo to talk, tap again to stop, once more to send'],
  ['live', 'g-live', 'hold the weevboss logo: a live spoken conversation (Gemini Live is only the voice, every real request comes to you as a normal message); needs GEMINI_API_KEY ([[setup:key:GEMINI_API_KEY]]), about 1-2 cents a minute, ends itself after 2 minutes of silence, a tap ends it'],
  ['repos', 'repos', 'swipe the feed left: every GitHub repo; + pins one to the feed'],
  ['calm', 'calm', 'pinch the feed: conversation mode (only the messages); pinch again to come back'],
  ['back', 'g-back', 'on a page, swipe right from the left edge: back'],
  ['collapse', 'g-collapse', 'pull the open weevboss thread down: it folds back'],
  ['copy', 'g-copy', 'long-press a message: copies it whole'],
  ['ask', 'g-ask', 'in an open thread, tap a word (or slide across several): ask about it, typed or by voice with the logo'],
  ['fold', 'g-fold', 'tap a project name: fold or unfold it'],
  ['newSession', 'newSession', 'the + of a project: a new claude or codex session there'],
  ['devil', 'devil', 'the little devil next to the logo: switch this thread to the other model'],
  ['h24', 'h24', 'the auto band at the bottom: what runs on its own, and background tasks to accept with one tap'],
]

/** Astuces d'usage, données une fois chacune au bon moment. */
export const TIPS: [id: string, what: string][] = [
  ['liveUi', `ask me to change this interface (colors, layout, a new button): I hand it to a session in the weevils clone (${CLONE}) and it updates live`],
  ['files', "explore any machine's files: bottom band, the machine, then /"],
  ['photo', 'the + in the composer: send me a photo, a screenshot or a file'],
  ['ultracode', 'say “ultracode” for a big job: the session deploys several agents in parallel'],
  ['model', 'ask me “opus”, “max effort”, “fast” or “compact” for a session: I type the right slash command'],
  ['newRepo', 'tell me an idea that fits no repo: I create the repo and open a session in it'],
  ['settings', 'bottom band: language, theme, tips'],
]

// ---------------------------------------------------------------- installer : la marche à suivre exacte

/** gh sans gestionnaire de paquets : l'archive officielle, dans ~/.local/bin. Sur un Mac c'est un zip (gh_x_macOS_arm64.zip). */
export function ghNoSudo(platform: NodeJS.Platform = process.platform, cpu: string = os.arch()): string {
  const arch = cpu === 'arm64' ? 'arm64' : 'amd64'
  const latest = (asset: string) => `"$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | grep -o 'https://[^"]*${asset}' | head -1)"`
  if (platform === 'darwin')
    return `mkdir -p ~/.local/bin && d=$(mktemp -d) && curl -fsSLo "$d/gh.zip" ${latest(`macOS_${arch}.zip`)} && unzip -qo "$d/gh.zip" -d "$d" && mv "$d"/gh_*_macOS_${arch}/bin/gh ~/.local/bin/ && rm -rf "$d"`
  return `mkdir -p ~/.local/bin && curl -fsSL ${latest(`linux_${arch}.tar.gz`)} | tar xz -C /tmp && mv /tmp/gh_*_linux_${arch}/bin/gh ~/.local/bin/`
}

export function ghInstall(s: SetupState): string {
  if (s.pkg === 'brew') return 'brew install gh'
  if (s.machine.mac) return ghNoSudo('darwin')
  if (s.sudo !== 'yes' || !s.pkg) return ghNoSudo()
  return { apt: 'sudo apt update && sudo apt install -y gh', dnf: 'sudo dnf install -y gh', pacman: 'sudo pacman -S --noconfirm github-cli' }[s.pkg]
}

export function edgeInstall(s: SetupState): string {
  if (s.tools.pipx) return 'pipx install edge-tts'
  if (s.pkg === 'brew') return 'brew install pipx && pipx install edge-tts'
  if (s.tools.uv) return 'uv tool install edge-tts'
  if (s.sudo === 'yes' && s.pkg === 'apt') return 'sudo apt install -y pipx && pipx ensurepath && pipx install edge-tts'
  if (s.sudo === 'yes' && s.pkg === 'dnf') return 'sudo dnf install -y pipx && pipx ensurepath && pipx install edge-tts'
  if (s.sudo === 'yes' && s.pkg === 'pacman') return 'sudo pacman -S --noconfirm python-pipx && pipx ensurepath && pipx install edge-tts'
  return 'curl -LsSf https://astral.sh/uv/install.sh | sh && ~/.local/bin/uv tool install edge-tts'
}

/** Ce que weevilsd installe lui-même, sans sudo interactif (rien à taper pour l'utilisateur). */
export function installCommand(what: 'claude' | 'gh' | 'edge' | 'codex', s: SetupState): string {
  if (what === 'claude') return 'curl -fsSL https://claude.ai/install.sh | bash'
  if (what === 'gh') return ghInstall(s)
  if (what === 'edge') return edgeInstall(s)
  // Toujours dans ~/.local/bin, là où weevils le cherche, quel que soit le Node installé (Homebrew, nvm, un paquet).
  return 'npm i -g --prefix ~/.local @openai/codex'
}

/** Ce qui est là et ce qui manque, en clair, avec un bouton par brique manquante (l'app, jamais de commande). */
export function installStatus(s: SetupState): string {
  const t = tr(M)
  const have: string[] = []
  const missing: [string, Brick][] = []
  const add = (ok: boolean, name: string, brick: Brick) => (ok ? have.push(name) : missing.push([name, brick]))
  add(s.claude.installed && s.claude.logged, 'Claude Code', 'claude')
  add(s.github.logged, 'GitHub', 'github')
  add(!!s.voice.spoken, t.voiceName, 'voice')
  add(s.codex.installed && s.codex.logged, 'Codex', 'codex')
  const parts = [have.length ? t.installHave(s.machine.os, have) : '']
  parts.push(missing.length ? `${t.installMissing(missing.map(([n]) => n))} ${missing.map(([, b]) => `[[setup:${b}]]`).join(' ')}` : t.installAll)
  return parts.filter(Boolean).join(' ')
}

/** Pour weevboss seul (« weevils setup install ») : tout ce qui manque, dans l'ordre, en commandes qu'il lance lui-même. */
export function installPlan(s: SetupState): string {
  const t = tr(M)
  const blocks: string[] = []
  const have: string[] = []
  // Homebrew installe sans sudo, avec le compte de l'utilisateur.
  const can = s.sudo !== 'no' || s.pkg === 'brew'
  const noBrew = s.machine.mac && !s.pkg
  const base = (['git', 'tmux', 'curl', 'python3', 'qrencode'] as const).filter((x) => !s.tools[x])
  for (const x of ['git', 'tmux', 'curl', 'python3'] as const) if (s.tools[x]) have.push(x)
  if (base.length && can && s.pkg) {
    const names = s.pkg === 'pacman' ? base.map((b) => (b === 'python3' ? 'python' : b)) : base
    blocks.push({ apt: `sudo apt update && sudo apt install -y ${names.join(' ')}`, dnf: `sudo dnf install -y ${names.join(' ')}`, pacman: `sudo pacman -S --noconfirm ${names.join(' ')}`, brew: `brew install ${names.join(' ')}` }[s.pkg])
  }
  if (s.tools.node < 22) {
    if (s.pkg === 'brew') blocks.push('brew install node')
    else if (can && s.pkg === 'apt') blocks.push('curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs')
    else if (can && s.pkg === 'dnf') blocks.push('sudo dnf install -y nodejs22')
    else if (can && s.pkg === 'pacman') blocks.push('sudo pacman -S --noconfirm nodejs npm')
    else if (!noBrew) blocks.push('curl -fsSL https://fnm.vercel.app/install | bash && ~/.local/share/fnm/fnm install 22')
  } else have.push(`node ${s.tools.node}`)
  if (!s.claude.installed) blocks.push('curl -fsSL https://claude.ai/install.sh | bash')
  else have.push('claude')
  if (!s.github.installed) blocks.push(ghInstall(s))
  else have.push('gh')
  if (s.voice.spoken !== 'edge' && s.voice.spoken !== 'cartesia') blocks.push(edgeInstall(s))
  else if (s.voice.spoken === 'edge') have.push('edge-tts')
  if (!s.codex.installed) blocks.push(installCommand('codex', s))
  else have.push('codex')
  const logins = [!s.claude.logged, !s.github.logged, !s.codex.logged].filter(Boolean)
  const fence = (c: string) => (c.includes('\n') ? '```sh\n' + c + '\n```' : '`' + c + '`')
  // Un Mac sans Homebrew : les outils de base et Node.js passent par l'installateur de weevils, qui l'apporte.
  const brewFirst = noBrew && (base.length > 0 || s.tools.node < 22)
  const parts = [t.installIntro(s.machine.os, blocks.length > 0 || brewFirst)]
  if (brewFirst) parts.push(t.installNoBrew(s.clone))
  if (!can && blocks.length) parts.push(t.installNoSudo)
  parts.push(...blocks.map(fence))
  if (have.length) parts.push(`${t.installDone} ${have.join(', ')}.`)
  if (logins.length) parts.push(t.installLogins)
  return parts.join('\n\n')
}

// ---------------------------------------------------------------- deviner la brique d'une question (sans modèle)

/** Mots qui désignent une brique, en français et en anglais ; le premier qui colle gagne. */
const GUESS: [Brick, RegExp][] = [
  ['history', /\b(conversations?|historique|history|old (chats|sessions)|anciennes? (sessions?|conversations?)|ramener|bring (over|my))\b/i],
  ['install', /\b(install|installer|installe|installation|setup|que dois|what do i need|dépendances?|dependencies)\b/i],
  ['devil', /\b(diable|devil|abliterat\w*|open.?weight|ollama|lm ?studio|vllm|openrouter)\b/i],
  ['github', /\b(github|gh|repos?|dépôts?)\b/i],
  ['voice', /\b(voix|voice|dict\w*|micro|cartesia|parler|speak|talk)\b/i],
  ['mail', /\b(e-?mails?|courriel|gmail|chatgpt|pont|bridge)\b/i],
  ['shortcut', /\b(siri|raccourcis?|shortcuts?|bouton action|action button)\b/i],
  ['machine', /\b(vps|serveur|server|machines?|pc|mac|ordi\w*|computer|laptop|portable|nuit|night)\b/i],
  ['push', /\b(notif\w*|prévenir|alertes?)\b/i],
  ['phone', /\b(téléphone|phone|iphone|android|qr|écran d.accueil|home screen)\b/i],
  ['reach', /\b(extérieur|dehors|outside|anywhere|partout|tailscale|domaine|domain|https)\b/i],
  ['codex', /\b(codex|openai agent)\b/i],
  ['quota', /\b(quota|abonnement|subscription|plan|limite?s?)\b/i],
  ['security', /\b(sécurité|security|code d.accès|access code|mot de passe|password)\b/i],
  ['claude', /\b(claude|connecter|login|sign in)\b/i],
]
export const guessBrick = (text: string): Brick | null => GUESS.find(([, re]) => re.test(text))?.[0] ?? null

// ---------------------------------------------------------------- le module

/** Le nom d'un hébergeur, tel qu'on le dit. */
const providerName = (p: string) => ({ hetzner: 'Hetzner', ovh: 'OVHcloud', hostinger: 'Hostinger', scaleway: 'Scaleway', digitalocean: 'DigitalOcean' })[p] ?? ''

/** La clé SSH de cette machine (créée si besoin), à poser sur la nouvelle : sa ligne publique. */
export async function sshKey(): Promise<string> {
  const key = path.join(HOME, '.ssh', 'id_ed25519')
  if (!fs.existsSync(`${key}.pub`)) {
    fs.mkdirSync(path.dirname(key), { recursive: true, mode: 0o700 })
    if (!fs.existsSync(key)) await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `weevils@${os.hostname()}`, '-f', key], 15_000)
    else await run('sh', ['-c', `ssh-keygen -y -f "${key}" > "${key}.pub"`], 15_000)
  }
  return read(`${key}.pub`).trim()
}

const SSH_OPTS = ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=12', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2']

/** Entrer sur la machine avec la clé, sans rien demander ; la réponse décrit la machine (OS, cœurs, mémoire). En cas
 * d'échec, « out » porte la raison donnée par ssh. */
export const sshProbe = (user: string, host: string, port: number) =>
  new Promise<{ ok: boolean; out: string }>((resolve) =>
    execFile(
      'ssh',
      [...SSH_OPTS, '-o', 'BatchMode=yes', '-i', path.join(HOME, '.ssh', 'id_ed25519'), '-p', String(port), `${user}@${host}`, '. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-$(uname -s)}"; nproc 2>/dev/null; free -m 2>/dev/null | awk \'/^Mem/{print $2}\''],
      { timeout: 25_000 },
      (err, out, errOut) => resolve(err ? { ok: false, out: String(errOut ?? '') || err.message } : { ok: true, out: String(out ?? '').trim() }),
    ),
  )

/** Poser la clé avec le mot de passe de l'hébergeur, une fois. Le mot de passe passe par l'environnement d'un petit
 * script SSH_ASKPASS (jamais sur la ligne de commande, jamais écrit sur disque ni gardé). */
export async function sshCopyKey(user: string, host: string, port: number, password: string, pub: string): Promise<{ ok: boolean; out: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weevils-askpass-'))
  const askpass = path.join(dir, 'askpass')
  fs.writeFileSync(askpass, `#!/bin/sh\nprintf '%s\\n' "$WEEVILS_ASKPASS"\n`, { mode: 0o700 })
  try {
    return await new Promise((resolve) => {
      const env = { ...process.env, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: process.env.DISPLAY || ':0', WEEVILS_ASKPASS: password }
      const cmd = `umask 077; mkdir -p ~/.ssh; k='${pub.replace(/'/g, '')}'; grep -qxF "$k" ~/.ssh/authorized_keys 2>/dev/null || echo "$k" >> ~/.ssh/authorized_keys`
      const p = spawn('ssh', [...SSH_OPTS, '-o', 'PubkeyAuthentication=no', '-o', 'PreferredAuthentications=password,keyboard-interactive', '-o', 'NumberOfPasswordPrompts=1', '-p', String(port), `${user}@${host}`, cmd], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
      let out = ''
      p.stdout.on('data', (d) => (out += d))
      p.stderr.on('data', (d) => (out += d))
      const timer = setTimeout(() => p.kill('SIGKILL'), 30_000)
      p.on('error', (e) => (clearTimeout(timer), resolve({ ok: false, out: e.message })))
      p.on('exit', (code) => (clearTimeout(timer), resolve({ ok: code === 0, out })))
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const PALETTE = ['#ff6b8a', '#3fc1f0', '#f5a524', '#7c5cff', '#22c55e', '#ff7a1a', '#e64980', '#14b8a6']
/** Un message suivi de la puce d'une brique (un bouton dessous, dans l'app). */
const chip = (text: string, brick: Brick) => `${text} [[setup:${brick}]]`
const tail = (s: string) => tr(M).masked(s.slice(-4))
const short = (e: unknown) => {
  const err = e as Error & { cause?: { code?: string } }
  return (err.cause?.code ?? err.message ?? String(e)).slice(0, 120)
}

// ---------------------------------------------------------------- ce que weevboss reçoit (jamais affiché)

/** Brancher une machine où weevilsd vient de poser sa clé. Pour weevboss, en anglais (comme le reste de son outillage). */
export function machineBrief(o: { target: string; user: string; host: string; port: number; provider: string; about: string; here: SetupState }): string {
  const ssh = `ssh${o.port !== 22 ? ` -p ${o.port}` : ''} ${o.user}@${o.host}`
  const m = o.here.machine
  const notReachable = ['laptop', 'desktop', 'wsl'].includes(m.kind) || o.here.reach === 'local'
  return [
    `Setup button: plug a machine into weevils${o.provider ? ` (a ${o.provider} VPS)` : ''}. Do every step yourself, never ask the user to type a command.`,
    which('ssh') ? `SSH from this machine already works without a password: \`${ssh}\` (key ~/.ssh/id_ed25519)${o.about ? `; it runs ${o.about}` : ''}.` : `This machine has no ssh client yet: install it first (openssh-client), then reach \`${ssh}\` (the user gave its address in the setup flow; if a password is needed, put the [[setup:machine]] chip so they type it in the masked field).`,
    notReachable
      ? `This machine (${m.host}, ${m.kind}) is not always on or not reachable from the internet, so the new machine should become the main one: install weevils there as the main machine (README / docs/install.md in ${o.here.clone}), make this machine its secondary, then give the user the new app address with its sign-in link.`
      : `Install weevils on it as a secondary machine of this one (${m.host}), following "Several machines" in ${o.here.clone}/docs/install.md: it needs to ssh back to this machine without a password, so authorize its key here. Check it shows up under \"other machines\" in \`weevils setup\`.`,
    // Un Mac : jamais systemctl, et personne n'y entre en SSH (« Session à distance » est coupée d'origine).
    m.mac ? 'This machine is a Mac: weevils runs here as a launchd agent, so use `weevils-service` (start, stop, restart, status, logs), never systemctl, and nothing on it needs admin rights. Do not count on anything reaching this Mac over ssh: Remote Login is off by default, and the user is not to be asked to turn it on.' : '',
    'Then tell the user in two short sentences what changed.',
  ].filter(Boolean).join(' ')
}

/** Rendre weevils joignable de partout : un domaine vérifié, ou Tailscale. Sur un Mac : Tailscale seulement (install.sh
 * y refuse --domain), par son app, sans sudo. */
export function reachBrief(s: SetupState, domain: string): string {
  const never = 'Do every step yourself, never ask the user to type a command.'
  if (s.machine.mac) return reachBriefMac(s)
  if (domain)
    return `Setup button: switch weevils to https on ${domain}, which already resolves to this machine. ${never} Run \`${s.clone}/install.sh --yes --domain ${domain}\` (it sets up Caddy and the certificate; sudo works here without a password), check that https://${domain}/api/me answers, then tell the user the new address and put the [[setup:phone]] chip so they get its sign-in code and link.`
  return `Setup button: make weevils reachable from anywhere with Tailscale. ${never} Install Tailscale on this machine (https://tailscale.com/install.sh; sudo works here without a password), run \`sudo tailscale up\` in the background and give the user the sign-in link it prints, as a link. Once it is signed in, run \`sudo tailscale serve --bg ${s.port}\`, set WEEVILS_PUBLIC_URL in ~/.config/weevils/env to the https://….ts.net address it serves, and restart weevils (weevils-service restart). Then tell the user to install the Tailscale app on their phone with the same account, and put the [[setup:phone]] chip for the sign-in link.`
}

/** Tailscale sur un Mac : l'app (App Store ou tailscale.com), dont la commande marche sans sudo. Elle ne s'installe pas
 * sans son propriétaire (une extension réseau à autoriser, un compte) : un lien pour lui, jamais une commande. */
function reachBriefMac(s: SetupState): string {
  const app = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
  return [
    'Setup button: make weevils reachable from anywhere with Tailscale, on this Mac. Run every command yourself, never ask the user to type one; nothing here needs admin rights or a password.',
    `Find the Tailscale command, written <tailscale> below: \`tailscale\` in the PATH, else \`${app}\` (the app carries it).`,
    'If neither exists, Tailscale is not installed and you cannot install it for them: give the user this link, as a link, https://tailscale.com/download/mac, ask them to install the app, open it and sign in, and to tell you when it is done. Stop there until they answer, then look again.',
    'Run `<tailscale> status --json`: when BackendState is not "Running", ask the user to open the Tailscale app on the Mac and sign in (no command), and wait for them.',
    `Once it is running, run \`<tailscale> serve --bg ${s.port}\`. If it prints a link to turn on HTTPS for their tailnet, give the user that link, wait until they say it is done, and run it again.`,
    `Read this Mac's name in \`<tailscale> status --json\` (Self.DNSName, without the final dot), then run \`${s.clone}/install.sh --agent --url https://<that name>\` the way step 4 of ${s.clone}/AGENTS.md says (in the background, until its summary): it records the address and restarts weevils, so the app may drop for a few seconds. Check that https://<that name>/api/me answers.`,
    'Then tell the user to install the Tailscale app on their phone with the same account, and put the [[setup:phone]] chip for the sign-in link.',
  ].join(' ')
}

export class Setup {
  private p: Persisted
  private cache: { at: number; v: SetupState } | null = null
  private deps: SetupDeps
  /** Les installations en cours (un double tap n'en lance pas deux). */
  private jobs = new Map<string, Promise<{ ok: boolean; why: string }>>()
  /** « claude auth login » qui attend le code de la page de connexion. */
  private codexLogin: ChildProcess | null = null
  private codexLoginStarting: Promise<boolean> | null = null
  private codexLoginShown = false
  /** Sur un Mac, « joignable de partout » part chez weevboss dès le tap : quand, pour qu'un double tap ne le confie pas deux fois. */
  private reachAt = 0
  /** La dernière explication postée par une puce : un second tap ne la répète pas. */
  private lastAsk: { brick: Brick; id: string; text: string } | null = null
  /** Le dernier message écrit (ou retrouvé) au nom de weevboss : l'app l'amène sous les yeux après une puce. */
  lastSaid: string | null = null
  /** The official sign-in page the tap that asked for it opens at once (Claude), handed out once. */
  private openUrl: string | undefined
  takeOpen(): string | undefined {
    const u = this.openUrl
    this.openUrl = undefined
    return u
  }
  /** « claude auth login » en train de démarrer : deux demandes coup sur coup partagent le même (une seule adresse). */
  private loginStarting: Promise<string> | null = null

  constructor(deps: SetupDeps) {
    this.deps = deps
    this.p = (() => {
      try {
        const raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Partial<Persisted>
        return { log: (raw.log ?? []).filter((m) => !m.id.startsWith('demo-')), marks: raw.marks ?? {}, bossSeenAt: raw.bossSeenAt ?? 0, device: raw.device, welcomed: raw.welcomed, claudeLogged: raw.claudeLogged, codexWaiting: raw.codexWaiting, githubLogged: raw.githubLogged, pending: raw.pending, memorySeen: raw.memorySeen }
      } catch {
        return { log: [], marks: {}, bossSeenAt: 0 }
      }
    })()
    void github()
    // Une connexion faite dans un terminal (claude, gh auth login) : weevboss le remarque et le dit.
    setInterval(() => void this.watch(), 5000).unref()
  }

  private save() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true })
      fs.writeFileSync(FILE, JSON.stringify({ ...this.p, log: this.p.log.slice(-120) }))
    } catch {
      /* disque plein : gardé en mémoire */
    }
  }

  /** Ce que l'app doit savoir pour ses bulles (renvoyer vers weevboss quand un réglage manque). Rapide : pas de sous-processus. */
  providers() {
    return { claude: providerStatus('claude').installed || !!which('curl'), codex: providerStatus('codex').installed || !!which('npm') }
  }

  async chooseProvider(tool: Tool, device?: Device) {
    if (!this.providers()[tool]) throw new Error(tr(M).providerUnavailable(tool === 'codex' ? 'Codex' : 'Claude Code'))
    writeConfig({ WEEVILS_PROVIDER: tool })
    this.cache = null
    this.deps.bump()
    return this.ask(tool, device)
  }

  flags() {
    return { provider: preferredTool(), ready: providerReady(), providers: this.providers(), codex: codexLogged(), claude: claudeLogged(), voice: !!(cartesia() || edgeTts()), dictation: !!process.env.OPENAI_API_KEY?.trim(), github: ghCache?.v.logged ?? true, welcomed: !!this.p.welcomed }
  }

  /** Les messages écrits au nom de weevboss (et les réponses des parcours), à mêler à son fil. */
  messages = () => this.p.log
  welcomed = () => !!this.p.welcomed

  /** Le seul passage des messages automatiques de weevboss (parcours, confirmations, coupures) et de leurs réponses.
   * `once` (les explications d'une brique, ask()) : un texte identique posté il y a peu n'est pas répété ; on renvoie l'id
   * du message existant, que l'app ramène sous les yeux (une brique relancée). Jamais pour le reste : un nouvel essai, une
   * nouvelle coupure, ce que dit l'utilisateur ont leur bulle, en bas du fil (les détections ont leur propre garde). */
  private add(role: 'user' | 'assistant', text: string, once = false) {
    const id = `setup-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const same = once ? this.p.log.slice(-12).findLast((m) => m.role === role && m.text === text && Date.now() - m.at < REPEAT_MS) : undefined
    if (same) {
      this.deps.bump()
      return (this.lastSaid = same.id)
    }
    const last = this.p.log.at(-1)?.at ?? 0
    this.p.log.push({ id, role, text, at: Math.max(Date.now(), last + 1) })
    this.save()
    this.deps.bump()
    return (this.lastSaid = id)
  }
  say = (text: string, once = false) => this.add('assistant', text, once)
  userSays = (text: string) => this.add('user', text)

  /** Un secret demandé par un agent ([[setup:key:NOM]]) : écrit dans la config, jamais montré (pas même la fin) ni
   * journalisé ; le fil dit seulement qu'il est enregistré. */
  saveKey(name: string, value: string) {
    const v = value.trim()
    if (!isSecretName(name) || !v || v.length > 4096 || /[\r\n]/.test(v)) throw new Error(tr(M).badSecret)
    writeConfig({ [name]: v })
    this.userSays(tr(M).keyTyped(name))
    this.say(tr(M).keySaved(name))
    console.log(`[setup] secret enregistré : ${name}`)
    this.deps.bump()
  }



  async detect(force = false): Promise<SetupState> {
    if (!force && this.cache && Date.now() - this.cache.at < 15_000) return this.cache.v
    const [m, gh, sd, quota] = await Promise.all([machine(this.deps), github(force), sudo(), quotaLines()])
    const https = PUBLIC_URL.startsWith('https://')
    const reach: SetupState['reach'] = PUBLIC_URL ? 'public' : HOST !== '127.0.0.1' && HOST !== 'localhost' ? 'lan' : 'local'
    const nodeMajor = Number(/^v?(\d+)/.exec(process.version)?.[1] ?? 0)
    const mail = mailConfig()
    const dv = devilConfig()
    const v: SetupState = {
      machine: m,
      reach,
      url: PUBLIC_URL || `http://127.0.0.1:${PORT}`,
      https,
      port: PORT,
      clone: CLONE.startsWith(HOME + path.sep) ? '~' + CLONE.slice(HOME.length) : CLONE,
      claude: { installed: !!which('claude'), logged: claudeLogged() },
      codex: providerStatus('codex'),
      github: gh,
      voice: { spoken: cartesia() ? 'cartesia' : edgeTts() ? 'edge' : null, openai: !!process.env.OPENAI_API_KEY?.trim(), https: https || reach === 'local' },
      devil: { plugged: !!dv, model: dv?.model },
      mail: { on: !!mail, address: mail?.address, authors: authors().filter((a) => a.emails.length).length, pending: authors().filter((a) => a.id !== BOSS && !a.emails.length).map((a) => a.name) },
      phone: { devices: this.deps.devices(), push: this.deps.push() },
      shortcut: this.deps.shortcut(),
      security: { safe: process.env.WEEVILS_SAFE === '1', https, exposedHttp: (reach === 'lan' || (reach === 'public' && !https)) && m.kind !== 'container' },
      quota,
      pkg: pkgManager(),
      sudo: sd,
      tools: { git: !!which('git'), tmux: !!which('tmux'), curl: !!which('curl'), python3: !!which('python3'), qrencode: !!which('qrencode'), pipx: !!which('pipx'), uv: !!which('uv'), node: nodeMajor },
      projects: this.deps.feed().projects,
    }
    this.cache = { at: Date.now(), v }
    return v
  }

  // ---------------------------------------------------------------- accueil

  /** Premier lancement : l'appareil est noté et weevboss accueille dans son fil, d'après l'état réel. C'est tout
   * l'onboarding : une brique à la fois, avec sa puce ; la suite, weevboss la mène lui-même (weevils setup). Une
   * installation qui a déjà parlé à weevboss n'est pas accueillie. */
  async welcome(device: Device): Promise<string | undefined> {
    if (this.p.welcomed) return
    this.p.welcomed = true
    this.p.device = device
    const s = await this.detect(true)
    this.p.claudeLogged = s.claude.logged
    this.p.githubLogged = s.github.logged
    let mid: string | undefined
    if (!this.deps.hasHistory()) {
      const { text, brick } = greeting(s, device, this.providers())
      if (brick) this.p.marks[brick] = Date.now()
      mid = this.say(text)
    }
    this.save()
    this.deps.bump()
    return mid
  }

  /** Claude Code vient d'être connecté : weevboss le dit, propose GitHub s'il manque, et reprend le travail en attente. */
  private async claudeReady() {
    const s = await this.detect(true)
    const t = tr(M)
    this.say(s.github.logged ? t.claudeReady : `${t.claudeReady} ${t.githubPitch} [[setup:github]]`)
    const job = this.p.pending
    if (job && providerReady()) {
      this.p.pending = undefined
      this.save()
      await this.deps.handoff(job.text, job.brief).catch((e) => console.log(`[setup] travail confié à weevboss : échec (${short(e)})`))
    }
  }

  /** Un travail qui demande un terminal : confié à weevboss, ou gardé jusqu'à ce que Claude Code soit connecté. */
  private async handoff(text: string, brief: string) {
    if (providerReady()) {
      await this.deps.handoff(text, brief)
      return
    }
    this.p.pending = { text, brief }
    this.save()
    this.say(chip(tr(M).providerLater(preferredTool() === 'codex' ? 'Codex' : 'Claude Code'), preferredTool()))
  }

  /** Installe un outil dans le dossier de l'utilisateur (ou par le gestionnaire de paquets si sudo marche sans mot de
   * passe). Une seule fois à la fois ; la raison d'un échec en une ligne. */
  private install(what: 'claude' | 'gh' | 'edge' | 'codex', s: SetupState) {
    const running = this.jobs.get(what)
    if (running) return running
    const job = (async () => {
      const r = await sh(installCommand(what, s))
      const bin = { claude: 'claude', gh: 'gh', edge: 'edge-tts', codex: 'codex' }[what]
      const ok = !!which(bin)
      console.log(`[setup] installation de ${what} : ${ok ? 'ok' : `échec (${lastLine(r.out)})`}`)
      this.cache = null
      ghCache = null
      return { ok, why: ok ? '' : lastLine(r.out) || tr(M).noAnswer }
    })().finally(() => this.jobs.delete(what))
    this.jobs.set(what, job)
    return job
  }

  /** Lance « claude auth login » (ou reprend celui qui attend encore) : l'adresse de la page de connexion. Deux demandes
   * pendant le démarrage (double tap) attendent le même processus : sinon deux liens, et le code du premier part au second. */
  private startClaudeLogin(): Promise<string> {
    return (this.loginStarting ??= this.spawnClaudeLogin().finally(() => (this.loginStarting = null)))
  }

  private spawnClaudeLogin(): Promise<string> {
    return claudeLogin.start(this.loginDeps())
  }

  /** The pending « claude auth login » lives in its own folder: it outlives a restart of weevilsd (server/claude-login.ts). */
  private loginDeps(): claudeLogin.LoginDeps {
    // The main account: never the folder of another Claude account that may be the active one (server/claude-accounts.ts).
    const env = shellEnv()
    if (accounts()?.dirOf(accounts()!.active) === env.CLAUDE_CONFIG_DIR) delete env.CLAUDE_CONFIG_DIR
    return { dir: path.join(DATA_DIR, 'claude-login'), bin: which('claude') ?? 'claude', env, logged: claudeLogged }
  }

  /** Codex : connexion par code (une page OpenAI, un code à y taper) ; weevboss confirme quand c'est fait. */
  private startCodexLogin(): Promise<boolean> {
    if (this.codexLogin && this.codexLogin.exitCode === null && this.codexLoginShown) return Promise.resolve(true)
    if (this.codexLoginStarting) return this.codexLoginStarting
    const job = this.launchCodexLogin()
    this.codexLoginStarting = job
    return job.finally(() => { if (this.codexLoginStarting === job) this.codexLoginStarting = null })
  }

  private async launchCodexLogin(): Promise<boolean> {
    const t = tr(M)
    if (this.codexLogin && this.codexLogin.exitCode === null) this.codexLogin.kill()
    const bin = which('codex') ?? 'codex'
    return new Promise((resolve) => {
      const proc = spawn(bin, ['login', '--device-auth'], { env: shellEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
      this.codexLogin = proc
      this.codexLoginShown = false
      let out = ''
      let shown = false
      const timer = setTimeout(() => resolve(false), 25_000)
      const onData = (d: Buffer) => {
        out += d.toString()
        const clean = out.replace(ANSI, '')
        const url = /https:\/\/\S+/.exec(clean)?.[0]
        const code = /\b([A-Z0-9]{4}-[A-Z0-9]{4,})\b/.exec(clean)?.[1]
        if (url && code && !shown) {
          shown = true
          clearTimeout(timer)
          this.codexLoginShown = true
          this.p.codexWaiting = true
          this.save()
          this.say(t.codexCode(url, code))
          resolve(true)
        }
      }
      proc.stdout.on('data', onData)
      proc.stderr.on('data', onData)
      proc.on('error', () => (clearTimeout(timer), resolve(false)))
      proc.on('exit', (code) => {
        clearTimeout(timer)
        if (this.codexLogin === proc) this.codexLogin = null
        this.cache = null
        if (!shown) return resolve(false)
        if (code === 0 && codexLogged()) { if (this.p.codexWaiting) void this.codexReady() }
        else if (code !== null) this.say(chip(t.codexFail(lastLine(out) || t.noAnswer), 'codex'))
      })
    })
  }

  /** Ce qui a changé tout seul (une connexion faite dans un terminal) : dit une fois. */
  private async watch() {
    if (!this.p.welcomed) return
    let changed = false
    if (!this.p.claudeLogged && claudeLogged()) {
      this.p.claudeLogged = true
      changed = true
      await this.claudeReady()
    }
    if (this.p.codexWaiting && codexLogged()) {
      changed = true
      await this.codexReady()
    }
    if (!this.p.githubLogged && which('gh')) {
      const gh = await github()
      if (gh.logged) {
        this.p.githubLogged = true
        changed = true
        this.say(tr(M).githubOk(gh.login ?? ''))
      }
    }
    if (changed) this.save()
  }

  // ---------------------------------------------------------------- briques

  /** Une puce tapée (ou weevboss qui propose) : weevboss dit ce que la brique apporte, à partir de l'état réel, et fait
   * ce qui se fait sans rien demander (installer, lancer une connexion). Vrai : le champ du bas pose maintenant les
   * questions de la brique. again (claude, codex) : une session lue « déconnectée » à l'écran, on se reconnecte même si
   * une connexion est enregistrée (elle a expiré). */
  async ask(brick: Brick, device?: Device, again = false): Promise<boolean> {
    const s = await this.detect(true)
    const t = tr(M)
    const d = device ?? this.p.device
    this.mark(brick)
    // Un second tap sur la même puce : l'explication est déjà là, juste au-dessus.
    const post = (text: string) => {
      const last = this.lastAsk
      // (La machine : même si le texte a changé, son statut n'étant plus répété.) L'app remet l'explication en avant.
      const tail = this.p.log.at(-1)
      if (last && last.brick === brick && (last.text === text || brick === 'machine') && tail?.id === last.id && Date.now() - tail.at < REPEAT_MS) {
        this.lastSaid = last.id
        return this.deps.bump()
      }
      this.lastAsk = { brick, id: this.say(text, true), text }
    }
    switch (brick) {
      case 'phone':
        post(`${t.phoneAsk(s)} [[setup:phone]]`)
        return false
      case 'push':
        post(`${t.pushAsk(d?.os === 'ios', !!d?.standalone)}${d?.os === 'ios' && !d.standalone ? '' : ' [[setup:push]]'}`)
        return false
      case 'reach': {
        if (s.reach === 'public' && s.https) return post(t.reachAsk(s)), false
        const http = s.reach === 'public'
        if (!providerReady()) return post(`${t.reachAsk(s)} ${chip(t.providerLater(preferredTool() === 'codex' ? 'Codex' : 'Claude Code'), preferredTool())}`), false
        // Un Mac : rien ne demande les droits administrateur, et pas de domaine (install.sh y refuse --domain). Une seule
        // voie, Tailscale : pas de question à poser, weevboss s'y met tout de suite.
        if (s.machine.mac) {
          post(`${t.reachAsk(s)} ${t.reachMacGo}`)
          if (Date.now() - this.reachAt > 60_000) {
            this.reachAt = Date.now()
            await this.handoff(t.reachTailscaleDo, reachBrief(s, '')).catch((e: unknown) => {
              this.reachAt = 0
              throw e
            })
          }
          return false
        }
        if (s.sudo !== 'yes') return post(`${t.reachAsk(s)} ${chip(t.needSudo, 'machine')}`), false
        post(`${t.reachAsk(s)} ${t.reachPrompt(http)}`)
        return true
      }
      case 'machine': {
        // L'état de la machine vient d'être dit (accueil) : pas deux fois de suite.
        const status = t.machine(s.machine).replace(/\s*\[\[setup:machine\]\]/, '')
        const said = this.p.log.slice(-8).some((m) => m.text.replace(/\s*\[\[setup:machine\]\]/, '').includes(status))
        post(said ? t.machineAsk(s) : `${status}\n\n${t.machineAsk(s)}`)
        return true
      }
      case 'claude':
        return this.askClaude(s, again)
      case 'account':
        return this.askAccount(post)
      case 'codex':
        await this.askCodex(s, again)
        return false
      case 'github':
        post(t.githubAsk(s))
        return !s.github.logged
      case 'voice':
        post(t.voiceAsk(s))
        if (!s.voice.spoken)
          void this.install('edge', s).then((r) => {
            if (r.ok) this.say(t.voiceFreeOk)
            else if (!cartesia()) this.say(chip(t.voiceFreeFail(r.why), 'voice'))
          })
        return true
      case 'devil':
        post(t.devilAsk(s.devil.plugged, s.devil.model ?? ''))
        return true
      case 'mail':
        if (s.mail.on) return post(`${t.mailOk(s.mail.address ?? '').replace(/:$/, '.')} [[setup:author]]`), false
        post(`${t.mailPitch}\n\n${t.mailAsk}`)
        return true
      case 'author':
        post(s.mail.pending.length ? `${t.authorPending(s.mail.pending)} ${t.authorAsk}` : t.authorAsk)
        return true
      case 'quota':
        post(t.quotaAsk(s.quota))
        return false
      case 'security':
        post(t.securityAsk(s))
        return false
      case 'shortcut':
        post(`${t.shortcutAsk} [[setup:shortcut]]`)
        return false
      case 'install':
        post(installStatus(s))
        return false
      case 'history':
        post(t.historyAsk)
        return false
    }
  }

  /** Claude Code : installé s'il manque, puis « claude auth login » ; le lien arrive dans le fil, le code se colle en bas. */
  private async askClaude(s: SetupState, again = false): Promise<boolean> {
    const t = tr(M)
    if (s.claude.logged && !again) return this.say(t.claudeOk), false
    if (!s.claude.installed) {
      this.say(t.claudeInstalling(s.machine.host))
      const r = await this.install('claude', s)
      if (!r.ok) return this.say(chip(t.claudeInstallFail(r.why), 'claude')), false
    }
    const url = await this.startClaudeLogin()
    if (!url) return this.say(chip(t.claudeInstallFail(lastLine(claudeLogin.output(this.loginDeps())) || t.noAnswer), 'claude')), false
    if (this.p.log.at(-1)?.text !== t.claudeLink(url)) this.say(t.claudeLink(url))
    this.openUrl = url
    return true
  }

  /** Another Claude account of the user's own: the official sign-in for a folder of its own; the code is pasted below. */
  private async askAccount(post: (text: string) => void): Promise<boolean> {
    const a = accounts()
    const t = tr(AccountsM)
    if (!a?.on()) return post(t.off), false
    const url = await a.startAdd().catch(() => '')
    if (!url) return this.say(chip(t.failed(tr(M).noAnswer), 'account')), false
    post(t.ask)
    this.openUrl = url
    return true
  }

  private async applyAccount(v: Record<string, string>) {
    const a = accounts()
    const t = tr(AccountsM)
    if (!a?.on()) return void this.say(t.off)
    const r = await a.submitAdd(v.code ?? '')
    this.say(r.ok ? t.added(r.n, r.who) : chip(t.failed(r.why || tr(M).noAnswer), 'account'))
  }

  /** Codex : installé s'il manque, puis la connexion par code. */
  private async askCodex(s: SetupState, again = false) {
    const t = tr(M)
    if (s.codex.installed && s.codex.logged && !again) return this.codexReady()
    if (!s.codex.installed) {
      this.say(t.codexInstalling(s.machine.host))
      const r = await this.install('codex', s)
      if (!r.ok) return this.say(chip(t.codexInstallFail(r.why), 'codex'))
    }
    if (!(await this.startCodexLogin())) this.say(chip(t.codexFail(t.noAnswer), 'codex'))
  }

  private async codexReady() {
    this.p.codexWaiting = false
    this.save()
    const primary = preferredTool() === 'codex'
    this.say(primary ? tr(M).codexPrimaryReady : tr(M).codexReady)
    const job = this.p.pending
    if (primary && providerReady() && job) {
      this.p.pending = undefined
      this.save()
      await this.deps.handoff(job.text, job.brief).catch((e) => console.log(`[setup] ${short(e)}`))
    }
  }

  /** Claude Code pas encore connecté : weevboss ne peut pas réfléchir, mais il sait déjà répondre aux questions de
   * branchement (« qu'est-ce que je dois installer ? », « comment je branche github ? ») à partir de l'état réel. Le
   * reste reçoit la marche à suivre pour connecter Claude Code. */
  async offline(text: string) {
    await this.offlineReply(text)
  }

  private async offlineReply(text: string) {
    this.userSays(text)
    const brick = guessBrick(text)
    const t = tr(M)
    if (brick && brick !== preferredTool()) {
      // La réponse de la brique, avec son bouton (le champ du bas s'ouvre au tap), puis ce qui manque pour le reste.
      if ((await this.ask(brick)) && this.lastAsk && this.p.log.at(-1)?.id === this.lastAsk.id) {
        const last = this.p.log.at(-1)!
        last.text = chip(last.text, brick)
        this.save()
      }
      this.say(chip(t.providerLater(preferredTool() === 'codex' ? 'Codex' : 'Claude Code'), preferredTool()))
    } else {
      const s = await this.detect()
      this.say(preferredTool() === 'codex'
        ? chip(t.providerLater('Codex'), 'codex')
        : chip(s.claude.installed ? t.claudeLogin : t.claudeMissing(s.machine), 'claude'))
    }
  }

  mark(id: string) {
    this.p.marks[id] = Date.now()
    this.save()
  }

  /** Une action faite côté app (notifications activées, adresse Siri copiée) : weevboss le confirme. */
  done(brick: Brick) {
    const t = tr(M)
    if (brick === 'push') this.say(t.pushOk)
    if (brick === 'shortcut') this.say(t.shortcutOk)
    this.cache = null
  }

  /** Les réponses d'un parcours (champ du bas) : vérifiées, écrites dans la config, confirmées dans le fil. */
  async apply(brick: Brick, values: Record<string, string>) {
    const fields = FIELDS[brick]
    if (!fields) throw new Error(tr(M).badBrick)
    const t = tr(M)
    const v: Record<string, string> = {}
    // Un choix qui termine le parcours (« j'en ai pas ») : les questions suivantes n'ont pas été posées.
    const stop = fields.findIndex((f) => f.stop?.includes(String(values[f.name] ?? '')))
    for (const f of stop >= 0 ? fields.slice(0, stop + 1) : fields) {
      const x = String(values[f.name] ?? '').trim()
      if (!x && !f.optional) throw new Error(t.badValue(t[`field_${f.name}` as keyof typeof t] as string))
      if (f.options && x && !f.options.includes(x)) throw new Error(t.badValue(t[`field_${f.name}` as keyof typeof t] as string))
      v[f.name] = x
    }
    const shown = (name: string, x: string) => (name === 'provider' ? providerName(x) || (x === 'none' ? t.prov_none : t.prov_other) : x)
    // La bulle de l'utilisateur : ce qu'il a répondu, les secrets réduits à leurs 4 derniers caractères.
    this.userSays(
      fields
        .filter((f) => v[f.name])
        .map((f) => `${t[`field_${f.name}` as keyof typeof t] as string} : ${f.secret ? tail(v[f.name]) : shown(f.name, v[f.name])}`)
        .join(' · ') || '—',
    )
    const before = this.p.log.length
    try {
      if (brick === 'devil') await this.applyDevil(v)
      else if (brick === 'voice') await this.applyVoice(v)
      else if (brick === 'github') await this.applyGithub(v)
      else if (brick === 'mail') await this.applyMail(v)
      else if (brick === 'author') this.applyAuthor(v)
      else if (brick === 'claude') await this.applyClaude(v)
      else if (brick === 'account') await this.applyAccount(v)
      else if (brick === 'machine') await this.applyMachine(v)
      else if (brick === 'reach') await this.applyReach(v)
    } finally {
      // Branché (la réponse ne repropose pas la puce) : les anciens boutons de cette brique disparaissent du fil.
      const reply = this.p.log.slice(before).at(-1)
      if (reply && !reply.text.includes(`[[setup:${brick}]]`)) {
        for (const m of this.p.log.slice(0, before)) m.text = m.text.replaceAll(`[[setup:${brick}]]`, '').trimEnd()
        this.save()
      }
      this.cache = null
      this.deps.bump()
    }
  }

  /** Le code de la page de connexion de Claude : donné à « claude auth login », qui enregistre la connexion. */
  private async applyClaude(v: Record<string, string>) {
    const t = tr(M)
    const r = await claudeLogin.submit(this.loginDeps(), v.code ?? '')
    this.cache = null
    if (r.ok) {
      if (this.p.claudeLogged) return // watch() saw it first and said so
      this.p.claudeLogged = true
      this.save()
      console.log('[setup] Claude Code connecté')
      return this.claudeReady()
    }
    this.say(chip(t.claudeFail(r.why || t.noAnswer), 'claude'))
  }

  /** Un VPS (ou toute machine joignable en SSH) : weevilsd y entre avec le mot de passe de l'hébergeur, une fois, y pose
   * sa clé, puis confie l'installation de weevils à weevboss. Pas encore de VPS : de quoi en choisir un. */
  private async applyMachine(v: Record<string, string>) {
    const t = tr(M)
    if (v.provider === 'none') return this.say(chip(t.machineNone, 'machine'))
    const pname = providerName(v.provider)
    const m = /^(?:([^@\s/]+)@)?(\[[0-9a-f:.]+\]|[a-z0-9][a-z0-9.-]*)(?::(\d{1,5}))?$/i.exec(v.host.trim().replace(/^ssh\s+/, '').replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, ''))
    if (!m) return this.say(chip(t.machineBadHost(v.host), 'machine'))
    const user = v.user || m[1] || 'root'
    const host = m[2].replace(/^\[|\]$/g, '')
    const port = Number(m[3] ?? 22)
    const target = `${user}@${host}${port !== 22 ? `:${port}` : ''}`
    const s = await this.detect()
    const brief = (about: string) => machineBrief({ target, user, host, port, provider: pname, about, here: s })
    if (!which('ssh')) {
      this.say(t.machineNoSsh)
      return this.handoff(t.machineDo(target, pname), brief(''))
    }
    this.say(t.machineTrying(target))
    const pub = await sshKey().catch(() => '')
    let r = await sshProbe(user, host, port)
    let why = lastLine(r.out)
    if (!r.ok && v.password && pub) {
      const c = await sshCopyKey(user, host, port, v.password, pub)
      if (!c.ok) why = lastLine(c.out) || why
      r = await sshProbe(user, host, port)
      if (!r.ok) why = lastLine(r.out) || why
    }
    if (!r.ok) {
      console.log(`[setup] machine ${target} : accès refusé (${why})`)
      return this.say(chip(t.machineRefused(target, t.sshWhy(why), pname || t.otherHost, pub), 'machine'))
    }
    const [osName = '', cores = '', mem = ''] = r.out.split('\n').map((l) => l.trim())
    const about = [osName, cores && `${cores} CPU`, mem && t.gb(Math.round(Number(mem) / 1024))].filter(Boolean).join(', ')
    console.log(`[setup] machine ${target} : clé posée (${about})`)
    this.say(t.machineIn(target, about))
    await this.handoff(t.machineDo(target, pname), brief(about))
  }

  /** Joignable de partout : un domaine (vérifié : il pointe bien ici) ou Tailscale. weevboss fait le travail. */
  private async applyReach(v: Record<string, string>) {
    const t = tr(M)
    const s = await this.detect()
    const domain = v.domain.toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '').trim()
    // Un domaine tapé sur un Mac (le champ n'y est pas proposé) : dit clairement, avec le bouton de la seule voie.
    if (domain && s.machine.mac) return this.say(chip(t.reachMacDomain(domain), 'reach'))
    if (!domain) return this.handoff(t.reachTailscaleDo, reachBrief(s, ''))
    const f = await facts().catch(() => null)
    const ip = f?.publicIp ? (f.ip ?? '') : ''
    const seen = await dns
      .lookup(domain, { all: true })
      .then((a) => a.map((x) => x.address))
      .catch(() => [] as string[])
    if (ip && !seen.includes(ip)) return this.say(chip(t.reachDns(domain, ip, seen.join(', ')), 'reach'))
    await this.handoff(t.reachDomainDo(domain), reachBrief(s, domain))
  }

  private async applyDevil(v: Record<string, string>) {
    const t = tr(M)
    let url = v.url.replace(/\/+$/, '').replace(/\/chat\/completions$/, '')
    if (!/^https?:\/\//.test(url)) url = `${/^(localhost|127\.|10\.|192\.168\.|[\w-]+:\d+$)/.test(url) ? 'http' : 'https'}://${url}`
    const headers = v.key ? { authorization: `Bearer ${v.key}` } : undefined
    const list = async (base: string) => {
      const res = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(8000) })
      if (!res.ok) throw new Error(`${res.status}`)
      const j = (await res.json().catch(() => ({}))) as { data?: { id: string }[]; models?: { id?: string; name?: string }[] }
      return (j.data ?? j.models ?? []).map((m) => ('id' in m && m.id) || ('name' in m && m.name) || '').filter(Boolean) as string[]
    }
    let models: string[] | null = null
    let why = ''
    for (const base of /\/v1$/.test(url) ? [url] : [url, `${url}/v1`]) {
      try {
        models = await list(base)
        url = base
        break
      } catch (e) {
        why ||= short(e)
      }
    }
    if (models && models.length && !models.includes(v.model)) {
      const close = models.find((m) => m.toLowerCase() === v.model.toLowerCase()) ?? models.find((m) => m.toLowerCase().includes(v.model.toLowerCase()))
      if (!close) return this.say(chip(t.devilNoModel(v.model, models.slice(0, 8).join(', ')), 'devil'))
      v.model = close
    }
    // Un vrai message, le plus court possible : le modèle répond, et en combien de temps.
    const t0 = Date.now()
    try {
      const res = await fetch(`${url}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ model: v.model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
        signal: AbortSignal.timeout(60_000),
      })
      if (!res.ok) throw new Error(`${res.status} ${(await res.text().catch(() => '')).slice(0, 80)}`)
      await res.text()
    } catch (e) {
      return this.say(chip(t.devilFail(why && !models ? why : short(e)), 'devil'))
    }
    writeConfig({ DEVIL_API_URL: url, DEVIL_MODEL: v.model, DEVIL_API_KEY: v.key })
    console.log(`[setup] diable branché (${v.model})`)
    this.say(t.devilOk(v.model, Date.now() - t0))
  }

  private async applyVoice(v: Record<string, string>) {
    const t = tr(M)
    const ok: string[] = []
    const changes: Record<string, string> = {}
    if (v.cartesia) {
      try {
        const res = await fetch('https://api.cartesia.ai/voices?limit=1', { headers: { 'X-API-Key': v.cartesia, 'Cartesia-Version': '2025-04-16' }, signal: AbortSignal.timeout(10_000) })
        if (!res.ok) throw new Error(`${res.status}`)
        changes.CARTESIA_API_KEY = v.cartesia
        ok.push('Cartesia')
      } catch (e) {
        return this.say(chip(t.voiceFail('Cartesia', short(e)), 'voice'))
      }
    }
    if (v.openai) {
      try {
        const res = await fetch('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${v.openai}` }, signal: AbortSignal.timeout(10_000) })
        if (!res.ok) throw new Error(`${res.status}`)
        changes.OPENAI_API_KEY = v.openai
        ok.push('OpenAI')
      } catch (e) {
        return this.say(chip(t.voiceFail('OpenAI', short(e)), 'voice'))
      }
    }
    if (!ok.length) return this.say(t.voiceNothing)
    writeConfig(changes)
    console.log(`[setup] voix : ${ok.join(', ')}`)
    this.say(t.voiceOk(ok))
  }

  private async applyGithub(v: Record<string, string>) {
    const t = tr(M)
    let login = ''
    try {
      const res = await fetch('https://api.github.com/user', { headers: { authorization: `Bearer ${v.token}`, 'user-agent': 'weevils' }, signal: AbortSignal.timeout(10_000) })
      if (!res.ok) throw new Error(`${res.status}`)
      login = ((await res.json()) as { login?: string }).login ?? ''
    } catch (e) {
      return this.say(chip(t.githubFail(short(e)), 'github'))
    }
    let gh = which('gh')
    let why = ''
    if (!gh) {
      const r = await this.install('gh', await this.detect())
      gh = which('gh')
      why = r.why
    }
    if (gh) {
      // gh garde le jeton dans sa propre config (~/.config/gh), comme après « gh auth login ».
      const ok = await new Promise<boolean>((resolve) => {
        const env = { ...process.env }
        delete env.GH_TOKEN
        delete env.GITHUB_TOKEN
        const p = spawn(gh, ['auth', 'login', '--with-token', '--hostname', 'github.com'], { env, stdio: ['pipe', 'ignore', 'ignore'] })
        p.on('error', () => resolve(false))
        p.on('exit', (code) => resolve(code === 0))
        p.stdin.end(v.token + '\n')
      })
      if (!ok) writeConfig({ GH_TOKEN: v.token })
      void run(gh, ['auth', 'setup-git'], 6000)
    } else writeConfig({ GH_TOKEN: v.token })
    if (!process.env.WEEVILS_GH_OWNER && login) writeConfig({ WEEVILS_GH_OWNER: login })
    ghCache = null
    this.p.githubLogged = true
    console.log(`[setup] GitHub branché (${login})`)
    this.say(gh ? t.githubOk(login) : `${t.githubOk(login)} ${t.githubNoCli(why)}`)
  }

  private async applyMail(v: Record<string, string>) {
    const t = tr(M)
    const addr = v.gmail.toLowerCase()
    const m = /^([^@+\s]+)(\+[^@\s]+)?@([^@\s]+\.[a-z]+)$/.exec(addr)
    if (!m) return this.say(chip(t.mailFail(addr), 'mail'))
    const login = `${m[1]}@${m[3]}`
    const alias = `${m[1]}${m[2] ?? '+weevils'}@${m[3]}`
    const pass = v.password.replace(/\s+/g, '')
    const imap = new Imap({ host: process.env.WEEVILS_MAIL_IMAP?.split(':')[0] || 'imap.gmail.com', port: Number(process.env.WEEVILS_MAIL_IMAP?.split(':')[1]) || 993, user: login, pass })
    try {
      await imap.connect(15_000)
      await imap.login()
    } catch (e) {
      imap.close()
      return this.say(chip(t.mailFail(short(e).replace(/^IMAP:\s*/, '')), 'mail'))
    }
    imap.close()
    writeConfig({ WEEVILS_MAIL_ADDRESS: alias, WEEVILS_MAIL_PASSWORD: pass })
    console.log('[setup] pont e-mail branché')
    this.deps.startMail()
    const pending = authors().filter((a) => a.id !== BOSS && !a.emails.length).map((a) => a.name)
    this.say(chip(pending.length ? `${t.mailOk(alias)} ${t.authorPending(pending)}` : t.mailOk(alias), 'author'))
  }

  private applyAuthor(v: Record<string, string>) {
    const t = tr(M)
    const email = v.email.toLowerCase()
    const id = v.name.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32)
    if (!id || !/^[^@\s]+@[^@\s]+\.[a-z]+$/i.test(email)) return this.say(chip(t.authorBad, 'author'))
    const n = authors().length
    // Un auteur déjà déclaré (sans adresse, ou qui en change) garde sa couleur, ses autres adresses et son secret.
    const prev = authors().find((a) => a.id === id.toLowerCase())
    const color = /^#[0-9a-f]{3,8}$/i.test(v.color) ? v.color : /^[0-9a-f]{6}$/i.test(v.color) ? `#${v.color}` : prev?.color || PALETTE[n % PALETTE.length]
    const emails = [...new Set([...(prev?.emails ?? []), email])].join(', ')
    writeConfig({ [`WEEVILS_AUTHOR_${id}`]: `${v.name.replace(/\|/g, ' ')} | ${color} | ${emails}${prev?.secret ? ` | ${prev.secret}` : ''}` })
    resetAuthors()
    console.log(`[setup] auteur ajouté (${id.toLowerCase()})`)
    const cfg = mailConfig()
    const alias = cfg?.address ?? ''
    // Il écrit depuis le compte du pont (ChatGPT avec le connecteur Gmail, un agent sur ce compte) : rien à régler de
    // plus, il signe en se nommant ; le pont le distingue de l'utilisateur et des autres auteurs à cette étiquette.
    const shared = !!cfg && (email === cfg.login || email === cfg.address)
    const ok = t.authorOk(v.name, email, alias)
    this.say(chip(shared ? `${ok} ${t.authorShared(id.toLowerCase())}` : ok, alias ? 'author' : 'mail'))
  }

  // ---------------------------------------------------------------- vers weevboss

  /** Ce que weevilsd a écrit au nom de weevboss depuis sa dernière réponse : un bloc à joindre au message (jamais affiché). */
  contextFor(brief?: string): string {
    const fresh = this.p.log.filter((m) => m.at > this.p.bossSeenAt)
    this.p.bossSeenAt = Date.now()
    const memory = this.memoryNote()
    this.save()
    const parts: string[] = []
    if (fresh.length) {
      const lines = fresh.map((m) => `${m.role === 'user' ? 'user' : 'you'}: ${m.text.replace(/```[a-z]*\n?/g, '`').replace(/\s+/g, ' ').slice(0, 400)}`)
      parts.push(`shown in your thread since your last reply (written by weevils in your name, or the user's answers to a setup flow; secrets never shown): ${lines.join(' | ').slice(0, 2400)}`)
    }
    if (brief) parts.push(`the user tapped a setup button, here is exactly what to do: ${brief}`)
    if (memory) parts.push(memory)
    return parts.length ? ` ⟦weevils — ${parts.join(' — ').replace(/⟧/g, ']')}⟧` : ''
  }

  /** weevboss repart d'une conversation vide dans la même pane (/clear, /new) : son prochain message reçoit la mémoire. */
  bossReset() {
    if (!this.p.memorySeen) return
    this.p.memorySeen = undefined
    this.save()
  }

  /**
   * Le résumé de la mémoire, au début d'une conversation de weevboss et quand elle a changé depuis qu'il l'a reçue ;
   * rien sinon (pas à chaque message). La liste complète reste à portée : `weevils memory`.
   */
  private memoryNote(): string {
    const m = this.deps.memory?.()
    if (!m) return ''
    const sig = m.signature()
    const boss = this.deps.bossId?.() ?? null
    const seen = this.p.memorySeen
    // Une conversation dont on connaît l'id remplacée par une autre : il repart sans rien savoir.
    // Pas de conversation (null) : ce message en ouvre une nouvelle, qui repart elle aussi sans rien savoir.
    const newConversation = !boss || !!(seen?.boss && seen.boss !== boss)
    this.p.memorySeen = { sig, boss }
    if (!newConversation && seen && seen.sig === sig) return ''
    const digest = m.digest()
    if (!digest) return seen?.sig && !newConversation ? 'what weevils remembers about the user: nothing anymore (they cleared it)' : ''
    return `what weevils remembers about the user (newest first; use it naturally when it helps, never recite it; full list with ids: weevils memory): ${digest.replace(/\n/g, ' ')}`
  }

  /** « weevils setup » : l'état de chaque brique, les gestes pas encore découverts, les astuces pas encore données. */
  async report(): Promise<string> {
    const s = await this.detect(true)
    const m = s.machine
    const seen = new Set(this.deps.seen())
    const yes = (b: boolean) => (b ? 'yes' : 'no')
    const ago = (id: string) => (this.p.marks[id] ? `${Math.round((Date.now() - this.p.marks[id]) / 3600_000)}h ago` : '')
    const l: string[] = [
      `lang: ${lang()}`,
      `machine: ${m.kind}${m.mac ? ' (mac)' : ''}${m.provider ? ` ${m.provider}` : ''} · ${m.os} · ${m.cpus} cores · ${Math.round(m.ramGb * 10) / 10} GB · room for ~${m.agents} agents · always on: ${m.alwaysOn ?? 'unknown'} · up ${Math.round(m.uptimeDays)} d · host ${m.host} · ssh ${m.sshTarget}`,
      `other machines: ${m.others.join(', ') || 'none'}${m.others.length ? ` (one always on: ${yes(m.othersAlwaysOn)})` : ''}`,
      `access: ${s.reach} ${s.url} · https ${yes(s.https)}`,
      `phone: ${s.phone.devices} device(s) signed in · push on ${s.phone.push} · siri shortcut token: ${yes(s.shortcut)}`,
      `claude code: installed ${yes(s.claude.installed)} · signed in ${yes(s.claude.logged)}`,
      `codex: installed ${yes(s.codex.installed)} · signed in ${yes(s.codex.logged)}`,
      `github: gh installed ${yes(s.github.installed)} · signed in ${yes(s.github.logged)}${s.github.login ? ` (${s.github.login})` : ''}`,
      `voice: spoken ${s.voice.spoken ?? 'none'} · dictation (OpenAI key) ${yes(s.voice.openai)} · https for the mic ${yes(s.voice.https)}`,
      `devil: plugged ${yes(s.devil.plugged)}${s.devil.model ? ` (${s.devil.model})` : ''}`,
      `e-mail bridge: ${s.mail.on ? s.mail.address : 'off'} · allowed authors ${s.mail.authors}${s.mail.pending.length ? ` · declared without an e-mail address, cannot write yet: ${s.mail.pending.join(', ')}` : ''}`,
      `quota: ${s.quota.join(' · ') || 'unknown'}`,
      `security: agents ask permission ${yes(s.security.safe)} · exposed over plain http ${yes(s.security.exposedHttp)}`,
      `tools: ${Object.entries(s.tools).map(([k, x]) => (k === 'node' ? `node ${x}` : `${k} ${yes(!!x)}`)).join(', ')} · package manager ${s.pkg ?? 'none'} · sudo ${s.sudo}`,
      `projects in the feed: ${s.projects} · weevils clone: ${s.clone}`,
      `proposed already: ${Object.keys(this.p.marks).filter((k) => !k.startsWith('tip:') && !k.startsWith('gesture:')).map((k) => `${k} (${ago(k)})`).join(', ') || 'nothing'}`,
      `gestures not discovered yet: ${GESTURES.filter(([id, h]) => !seen.has(h) && !this.p.marks[`gesture:${id}`]).map(([id, , w]) => `${id} = ${w}`).join(' | ') || 'none'}`,
      `tips not given yet: ${TIPS.filter(([id]) => !this.p.marks[`tip:${id}`]).map(([id, w]) => `${id} = ${w}`).join(' | ') || 'none'}`,
      `welcomed in the thread: ${yes(!!this.p.welcomed)}${this.p.device ? ` (first opened on ${this.p.device.mobile ? 'a phone' : 'a computer'}, ${this.p.device.os})` : ''}`,
      installedBy(),
    ]
    return l.filter(Boolean).join('\n')
  }
}

/** L'accueil de weevboss : bonjour, puis une seule brique, la plus utile d'après l'état réel — l'agent s'il n'est pas
 * connecté (sans lui rien ne répond), sinon le téléphone vu d'un ordinateur, sinon GitHub. Pure (testée). */
export function greeting(s: SetupState, device: Device, providers: { claude: boolean; codex: boolean }): { text: string; brick?: Brick } {
  const t = tr(M)
  const hello = t.welcomeHello(USER_NAME)
  if (!providerReady()) {
    const tool: 'claude' | 'codex' = preferredTool() === 'codex' || (!providers.claude && providers.codex) ? 'codex' : 'claude'
    return { text: chip(`${hello} ${t.welcomeProvider(tool === 'codex' ? 'Codex' : 'Claude Code')}`, tool), brick: tool }
  }
  const ready = `${hello} ${t.welcomeReady(s.projects)}`
  if (!device.mobile && s.phone.devices < 2) return { text: chip(`${ready} ${t.welcomePhone}`, 'phone'), brick: 'phone' }
  if (!s.github.logged) return { text: chip(`${ready} ${t.githubPitch}`, 'github'), brick: 'github' }
  return { text: ready }
}

/** Ce que l'installation a laissé (install.json, écrit par install.sh) : qui l'a faite, il y a combien de temps. */
function installedBy(): string {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'install.json'), 'utf8')) as { by?: string; agent?: string; at?: number }
    if (typeof j.at !== 'number') return ''
    return `installed by: ${j.by === 'agent' || j.by === 'script' ? j.by : 'terminal'}${typeof j.agent === 'string' && j.agent ? ` (${j.agent.slice(0, 20)})` : ''}, ${Math.round((Date.now() - j.at) / 60_000)} min ago`
  } catch {
    return ''
  }
}

/** Le texte tel que l'utilisateur l'a tapé, sans le bloc de contexte joint pour weevboss. */
export const withoutContext = (text: string) => text.replace(CONTEXT_BLOCK, '')
