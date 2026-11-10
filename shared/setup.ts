// Accueil et branchements par weevboss : le contrat entre weevilsd (server/setup.ts) et l'app (src/ui/setup.tsx).
//
// weevboss accueille et guide dans son propre fil. Ses messages (ceux du modèle comme ceux que weevilsd écrit en son
// nom : accueil, confirmation d'un branchement) peuvent porter des puces « [[setup:<brique>]] » : l'app les retire du
// texte et les montre comme des boutons sous le message. Un tap lance le branchement : weevboss dit en une phrase ce que
// ça apporte (message généré à partir de l'état réel), puis le champ du bas pose les questions une par une. Les valeurs
// tapées vont droit au fichier de config de weevilsd (~/.config/weevils/env), jamais au modèle ni aux journaux.
//
// Jamais de commande à taper : ce qui s'installe, weevilsd l'installe lui-même (Claude Code, gh, la voix gratuite,
// Codex), les connexions passent par un lien et un code collé en bas, et le reste (domaine, Tailscale, une machine à
// installer) part chez weevboss, qui a un terminal.

/** Ce que weevboss sait détecter, conseiller et brancher. */
export const BRICKS = ['phone', 'push', 'reach', 'machine', 'claude', 'codex', 'github', 'voice', 'devil', 'mail', 'author', 'quota', 'security', 'shortcut', 'install'] as const
export type Brick = (typeof BRICKS)[number]
export const isBrick = (s: unknown): s is Brick => typeof s === 'string' && (BRICKS as readonly string[]).includes(s)

/** Une question du champ du bas, dans un parcours de branchement. */
export interface SetupField {
  name: string
  /** Masqué à la saisie, jamais réaffiché (le fil montre « •••• » et les 4 derniers caractères). */
  secret?: boolean
  /** Une réponse vide passe à la suite (modèle local sans clé…). */
  optional?: boolean
  /** Clavier adapté ; « choice » : des boutons à la place du champ. */
  kind?: 'url' | 'email' | 'text' | 'choice'
  /** Les réponses possibles d'un « choice ». */
  options?: string[]
  /** Réponses d'un « choice » qui terminent le parcours tout de suite (« j'en ai pas »). */
  stop?: string[]
}

/** Les hébergeurs proposés pour brancher un VPS (« none » : pas encore de VPS, weevboss aide à en choisir un). */
export const PROVIDERS = ['hetzner', 'ovh', 'hostinger', 'scaleway', 'digitalocean', 'other', 'none'] as const

/** Les parcours qui se remplissent dans le champ du bas, question par question ; les réponses partent ensemble à la
 * fin (POST /api/setup/apply), weevilsd vérifie (connexion au modèle, à GitHub, à la boîte mail…) et répond dans le fil. */
export const FIELDS: Partial<Record<Brick, SetupField[]>> = {
  // Le code que la page de connexion de Claude affiche, à coller (weevilsd a lancé « claude auth login »).
  claude: [{ name: 'code', secret: true }],
  machine: [
    { name: 'provider', kind: 'choice', options: [...PROVIDERS], stop: ['none'] },
    { name: 'host', kind: 'url' },
    { name: 'user', optional: true },
    { name: 'password', secret: true, optional: true },
  ],
  reach: [{ name: 'domain', kind: 'url', optional: true }],
  devil: [
    { name: 'url', kind: 'url' },
    { name: 'model' },
    { name: 'key', secret: true, optional: true },
  ],
  voice: [
    { name: 'cartesia', secret: true, optional: true },
    { name: 'openai', secret: true, optional: true },
  ],
  github: [{ name: 'token', secret: true }],
  mail: [
    { name: 'gmail', kind: 'email' },
    { name: 'password', secret: true },
  ],
  author: [
    { name: 'name' },
    { name: 'email', kind: 'email' },
    { name: 'color', optional: true },
  ],
}

/** Ce qu'un tap sur la puce renvoie : le champ du bas s'ouvre-t-il (weevilsd a posté l'explication avant) ? */
export interface AskResult {
  ok: true
  flow: boolean
}

/** Les seules clés que « weevils config set » peut écrire ; le reste du fichier de config ne bouge pas. */
export const SETUP_KEYS = ['DEVIL_API_URL', 'DEVIL_MODEL', 'DEVIL_API_KEY', 'OPENAI_API_KEY', 'CARTESIA_API_KEY', 'CARTESIA_VOICE_ID', 'WEEVILS_MAIL_ADDRESS', 'WEEVILS_MAIL_PASSWORD', 'WEEVILS_USER_NAME', 'WEEVILS_GH_OWNER'] as const
export type SetupKey = (typeof SETUP_KEYS)[number]
export const isSetupKey = (s: unknown): s is SetupKey => typeof s === 'string' && ((SETUP_KEYS as readonly string[]).includes(s) || /^WEEVILS_AUTHOR_[A-Z0-9_]{1,32}$/.test(s))
export const SECRET_KEYS: ReadonlySet<string> = new Set(['DEVIL_API_KEY', 'OPENAI_API_KEY', 'CARTESIA_API_KEY', 'WEEVILS_MAIL_PASSWORD'])

/** L'appareil d'où l'app est ouverte : l'accueil s'y adapte (QR sur ordinateur, écran d'accueil sur téléphone). */
export interface Device {
  os: 'ios' | 'android' | 'mac' | 'windows' | 'linux' | 'other'
  mobile: boolean
  /** Ouverte depuis l'écran d'accueil (mode app). */
  standalone: boolean
}

/** « [[setup:devil]] » : une puce de branchement dans un message de weevboss. */
export const CHIP = /\[\[setup:([a-z]+)\]\]/g

/** Le texte sans ses puces (pour l'afficher, le lire à voix haute ou le résumer), et les briques qu'elles désignent. */
export function splitChips(text: string): { text: string; chips: Brick[] } {
  const chips: Brick[] = []
  const clean = text.replace(CHIP, (_m, b: string) => {
    if (isBrick(b) && !chips.includes(b)) chips.push(b)
    return ''
  })
  return { text: chips.length ? clean.replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim() : text, chips }
}

/** Le bloc de contexte ajouté à un message envoyé à weevboss (ce que weevilsd a écrit en son nom) : jamais affiché. */
export const CONTEXT_BLOCK = /\s*⟦weevils[^⟧]*⟧\s*$/
