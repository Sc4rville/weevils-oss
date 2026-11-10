// Contrat du coin infrastructure : machines (charge, mémoire, disque, historique, conseils), système de fichiers,
// abonnements Claude / Codex. Horodatages en millisecondes, pourcentages de 0 à 100.

/** normal < 70 % CPU / 80 % mémoire ≤ warn < 90 % / 92 % ≤ crit. */
export type Level = 'ok' | 'warn' | 'crit'

/** Ce que montre l'icône d'une machine dans le coin. */
export interface MachineBrief {
  id: string
  name: string
  online: boolean
  /** CPU sur les dernières secondes et mémoire utilisée (hors cache), en %. */
  cpu: number
  mem: number
  level: Level
  /** weevboss (l'orchestrateur) tourne ici. */
  weevboss: boolean
}

/** Une minute de l'historique du jour. */
export interface InfraPoint {
  at: number
  cpu: number
  /** Pic de CPU dans la minute. */
  cpuMax: number
  mem: number
  /** Swap utilisé en % (null : pas de swap). */
  swap: number | null
  load: number
  /** Sessions claude / codex vivantes, et ce qu'elles prennent avec leurs sous-processus (Mo, % d'un cœur). */
  agents: number
  agentMem: number
  agentCpu: number
  /** Disque utilisé en %. */
  disk?: number
  /** Les familles de processus les plus gourmandes (docker, vitest, claude…), quand la machine chauffe. */
  top?: [string, number][]
}

/** Ce que la machine sait d'elle-même. Un champ absent = inconnu (jamais deviné). */
export interface MachineFacts {
  hostname: string
  user: string
  os?: string
  kernel: string
  arch: string
  cpuModel?: string
  /** kvm, vmware, docker, wsl… (absent : machine physique). */
  virt?: string
  /** Machine physique : fabricant et modèle (DMI). */
  hardware?: string
  laptop?: boolean
  ip?: string
  /** L'IP est portée par une interface (sinon : derrière une box ou un NAT). */
  publicIp: boolean
  rdns?: string
  asn?: string
  /** Hébergeur (machine virtuelle à IP publique). */
  provider?: string
  /** Réseau d'accès (box, FAI) d'une machine qui n'est pas hébergée. */
  network?: string
  city?: string
  region?: string
  country?: string
  timezone?: string
  sshPort?: number
  /** Les hôtes que cette machine joint par SSH (~/.ssh/config). */
  ssh: SshTarget[]
}

export interface SshTarget {
  alias: string
  host: string
  user?: string
  port?: number
}

/** Comment une autre machine joint celle-ci (son alias SSH). */
export interface Reach {
  from: string
  alias: string
  user?: string
}

/** L'offre du fournisseur qui correspond, et le palier au-dessus (vérifiés sur son site ; null = pas vérifié). */
export interface Offer {
  plan: string | null
  price: number | null
  nextPlan: string | null
  nextVcpu: number | null
  nextRamGb: number | null
  nextPrice: number | null
  currency: string | null
  url: string | null
}

/** Ce qui consomme en ce moment : une session (avec tout ce qu'elle a lancé), un conteneur, ou une famille de processus. */
export interface Consumer {
  kind: 'session' | 'container' | 'process'
  label: string
  sessionId?: string
  projectId?: string
  /** Octets, et % d'un cœur. */
  mem: number
  cpu: number
  count: number
  /** Ce qui tourne dedans (vitest, chrome…), du plus gourmand au moins gourmand. */
  parts: string[]
}

/** Un jour d'historique : moyennes et pics. */
export interface DaySummary {
  day: string
  cpu: number
  cpuMax: number
  mem: number
  memMax: number
  disk?: number
}

export interface Episode {
  from: number
  to: number
  cpu: number
  mem: number
  /** Ce qui tournait le plus pendant la saturation. */
  culprit?: string
}

export interface ServerProc {
  port: number
  /** node, python, caddy… et le dossier (projet) dont il est lancé. */
  name: string
  dir?: string
  /** Adresse publique quand le port est exposé (Caddy). */
  url?: string
}

export interface InfraDetail {
  id: string
  name: string
  weevboss: boolean
  facts: MachineFacts
  offer: Offer | null
  reach: Reach[]
  cores: number
  /** Octets. */
  memTotal: number
  memUsed: number
  swapTotal: number
  swapUsed: number
  diskTotal: number
  diskUsed: number
  cpu: number
  load: [number, number, number]
  uptime: number
  /** Historique du jour, par tranches de 5 minutes (max de chaque tranche). */
  day: InfraPoint[]
  episodes: Episode[]
  /** Les 7 derniers jours, aujourd'hui compris. */
  days: DaySummary[]
  servers: ServerProc[]
  consumers: Consumer[]
  /** Conseils calculés à partir des mesures, dans la langue de l'utilisateur. */
  advice: string[]
}

export interface FsEntry {
  name: string
  dir: boolean
  size: number
  link?: boolean
}

export interface FsListing {
  path: string
  home: string
  entries: FsEntry[]
  error?: string
}

/** Une fenêtre de quota (5 h, semaine, semaine d'un modèle). */
export interface QuotaWindow {
  kind: 'session' | 'week' | 'model'
  /** Nom du modèle pour kind = model. */
  label?: string
  percent: number
  resetsAt: number | null
}

export interface QuotaInfo {
  ok: boolean
  plan?: string
  windows: QuotaWindow[]
  /** D'où viennent les chiffres (affiché nulle part, pour le débogage). */
  source: string
  at: number
  error?: string
}

export interface UsageInfo {
  claude: QuotaInfo
  codex: QuotaInfo
}

/** Consommation du jour, lue dans les transcripts (tokens) : la part de chacun, pas le quota lui-même. */
export interface UsageRow {
  id: string
  title: string
  projectId: string
  tool: 'claude' | 'codex'
  machine: string
  /** Tokens pondérés comme le prix (entrée 1, sortie 5, cache écrit 1,25, cache lu 0,1). */
  weight: number
  tokens: number
  last: number
}

/** Consommation du jour d'un modèle (même pondération que UsageRow). */
export interface UsageModel {
  tool: 'claude' | 'codex'
  model: string
  machine: string
  weight: number
  tokens: number
}

/** Débit en direct : tokens (entrée, sortie, cache) des réponses écrites dans les transcripts, par tranche. */
export interface TokenRate {
  available?: boolean
  step: number
  /** Fin de la dernière tranche (ms). */
  end: number
  buckets: number[]
}

export interface UsageToday {
  rows: UsageRow[]
  /** Absent quand une machine distante a une version plus ancienne. */
  models?: UsageModel[]
}
