import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { servicePath } from './platform.ts'

export const HOME = os.homedir()
export const CONFIG_DIR = path.join(HOME, '.config', 'weevils')
/** Le seul fichier de config de l'utilisateur, hors du repo (modèle : .env.example). NOM=valeur, une par ligne. */
export const CONFIG_FILE = process.env.WEEVILS_CONFIG ?? path.join(CONFIG_DIR, 'env')
try {
  for (const line of fs.readFileSync(CONFIG_FILE, 'utf8').split('\n')) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch {
  /* pas de config : valeurs par défaut */
}
// A Mac: launchd starts a service with a bare PATH. tmux, claude, gh… are found (by us and by the agents we start)
// only once ~/.local/bin and Homebrew's folders are in it. Linux: untouched (an unset PATH must stay unset: an empty
// one finds nothing, where an unset one still finds /usr/bin).
if (process.platform === 'darwin') process.env.PATH = servicePath(process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin')

/** Prénom de l'utilisateur, pour que les agents s'adressent à lui. Vide : user() (server/i18n.ts) dit « l'utilisateur » / « the user ». */
export const USER_NAME = process.env.WEEVILS_USER_NAME?.trim() ?? ''
/** Adresse publique de l'app (notifications push, QR de connexion). */
export const PUBLIC_URL = process.env.WEEVILS_PUBLIC_URL?.trim() || ''
/** Domaine où les serveurs de preview sont exposés en <nom>.<domaine> (navigateur intégré). */
export const EXPOSE_DOMAIN = process.env.WEEVILS_EXPOSE_DOMAIN?.trim() || ''
/** Dossier des sites Caddy, un <nom>.caddy par port exposé (reverse_proxy localhost:<port>) : avec EXPOSE_DOMAIN, la page
 * infra relie chaque port à https://<nom>.<domaine>. Vide : pas de lien. */
export const EXPOSE_SITES_DIR = process.env.WEEVILS_EXPOSE_SITES_DIR?.trim() || ''
export const PORT = Number(process.env.WEEVILS_PORT || 4179)
/** Adresse d'écoute de l'app : 127.0.0.1 (derrière Caddy ou un tunnel SSH) ; 0.0.0.0 pour l'ouvrir au réseau local en http. */
export const HOST = process.env.WEEVILS_HOST?.trim() || '127.0.0.1'
/** Hooks Claude Code : écoute locale uniquement, jamais exposée par Caddy. */
export const HOOK_PORT = Number(process.env.WEEVILS_HOOK_PORT || 4180)
/** Racines des projets de cette machine, séparées par « : » (ex. ~/projects:~/Documents/projects). */
export const PROJECT_ROOTS = (process.env.WEEVILS_PROJECTS || path.join(HOME, 'projects')).split(':').filter(Boolean)
export const PROJECTS_DIR = PROJECT_ROOTS[0]
/** Autres weevilsd à fédérer : « pc=http://127.0.0.1:4192 ». */
export const REMOTES = process.env.WEEVILS_REMOTES
export const CLAUDE_DIR = path.join(HOME, '.claude', 'projects')
export const CODEX_DIR = path.join(process.env.CODEX_HOME ?? path.join(HOME, '.codex'), 'sessions')
export const DATA_DIR = path.join(HOME, '.local', 'share', 'weevils')
/** Journaux des jobs longs (<nom>.log) : chacun s'affiche comme une activité 24/7 tant qu'il s'écrit. LOGS_DIR est celui
 * où weevils écrit (job de démo) ; sans WEEVILS_LOGS_DIR, le rail lit aussi ~/logs, où les agents lancent leurs jobs
 * (nohup … > ~/logs/<nom>.log). */
export const LOGS_DIR = process.env.WEEVILS_LOGS_DIR?.trim() || path.join(DATA_DIR, 'jobs')
export const LOGS_DIRS = process.env.WEEVILS_LOGS_DIR?.trim() ? [LOGS_DIR] : [path.join(HOME, 'logs'), LOGS_DIR]
/** Fichiers joints à weevboss (photos, PDF…), déposés en <date>-<nom>. Même dossier par défaut que ceux des sessions. */
export const INBOX_DIR = process.env.WEEVILS_INBOX_DIR?.trim() || path.join(DATA_DIR, 'inbox')
export const DIST_DIR = path.resolve(import.meta.dirname, '..', 'dist')

/** Nom d'hôte réduit comme le fait install.sh (slug) : minuscules, [a-z0-9-], 20 caractères. */
export const hostSlug = (host: string) =>
  host.split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'main'

/**
 * Identifiant de cette machine : WEEVILS_MACHINE (install.sh l'écrit), sinon le nom d'hôte, retenu au premier lancement
 * (DATA_DIR/machine-id) pour rester stable.
 */
function machineId(): string {
  const env = process.env.WEEVILS_MACHINE?.trim()
  if (env) return env
  const file = path.join(DATA_DIR, 'machine-id')
  try {
    const saved = fs.readFileSync(file, 'utf8').trim()
    if (saved) return saved
  } catch {
    /* pas encore choisi */
  }
  const id = hostSlug(os.hostname())
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(file, id + '\n')
  } catch {
    /* lecture seule : le nom d'hôte sera recalculé au prochain lancement */
  }
  return id
}
const machine = machineId()
export const MACHINE = {
  id: machine,
  name: process.env.WEEVILS_MACHINE_NAME || process.env.WEEVILS_MACHINE || machine,
}

/** L'orchestrateur (la bande du haut) tourne sur une seule machine : celle qui sert l'app. */
export const ORCHESTRATOR = (process.env.WEEVILS_ORCHESTRATOR || (process.env.WEEVILS_MACHINE ? '0' : '1')) === '1'
export const ORCH_DIR = path.join(DATA_DIR, 'orchestrateur')

/** Sessions plus anciennes : ignorées (on ne relit pas tout l'historique). */
export const RECENT_MS = 3 * 24 * 3600_000
/** Sans signe de vie depuis ce délai, une session sans processus connu est considérée terminée. */
export const STALE_MS = 30 * 60_000
/** Session weevils sans activité : terminée dans l'app après 30 min, processus fermé après 2 h (lui écrire la rouvre avec --resume). */
export const DONE_AFTER_MS = Number(process.env.WEEVILS_DONE_AFTER_MIN ?? 30) * 60_000
export const KILL_AFTER_MS = Number(process.env.WEEVILS_KILL_AFTER_MIN ?? 120) * 60_000

/** Voix gratuite (edge-tts) : voix de chaque langue et débit. */
export const TTS_VOICE = {
  fr: process.env.WEEVILS_TTS_VOICE_FR?.trim() || 'fr-FR-RemyMultilingualNeural',
  en: process.env.WEEVILS_TTS_VOICE_EN?.trim() || 'en-US-AndrewMultilingualNeural',
}
export const TTS_RATE = process.env.WEEVILS_TTS_RATE?.trim() || '+25%'

/**
 * Page infra : 1 = cherche l'hébergeur de la machine (ipinfo.io) et ses offres (recherche web claude, une fois par
 * semaine) ; facts = faits locaux seulement, aucun appel sortant ; 0 = rien.
 */
export const DISCOVER: '0' | 'facts' | '1' = (() => {
  const v = process.env.WEEVILS_DISCOVER?.trim()
  return v === '0' || v === '1' ? v : 'facts'
})()
