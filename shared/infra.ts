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
  /** Where the disk goes (absent: an older weevilsd that does not measure it). */
  diskView?: DiskView
}

/**
 * Where the disk goes: the largest folders and which grow fastest, from read-only measurements (du, file sizes and
 * dates) taken every 6 h. Growth is only ever computed between real measurements: null until there are enough.
 */
export interface DiskView {
  /** Newest measurement (null: none yet). */
  at: number | null
  measuring: boolean
  /** When the next measurement is planned. */
  next: number | null
  samples: number
  /** Oldest measurement kept. */
  since: number | null
  /** Disk used at the newest measurement, bytes. */
  used: number
  /** Largest first. `folder`: a folder of the home directory; `system`: a top-level folder of the disk; `swap`: swap
   *  files; `rest`: what the measurement cannot reach (Docker's data, other users, the system), used minus measured. */
  folders: DiskFolder[]
  growth: { since: number; perDay: number; items: DiskGrowth[] } | null
  /** Size of the files new or changed in the last 7 days, by folder (shown while growth is not known yet). */
  recent: DiskRecent[]
}

export interface DiskFolder {
  name: string
  kind: 'folder' | 'system' | 'swap' | 'rest'
  path?: string
  bytes: number
  /** The largest folders inside; for `rest`, what Docker reports (images, build cache…). */
  inside: { name: string; bytes: number; reclaimable?: number }[]
}

export interface DiskGrowth {
  name: string
  /** The home folder it sits in. */
  parent?: string
  /** `loose`: files sitting directly in the folder `name`, outside its larger subfolders. */
  kind: 'folder' | 'loose' | 'system' | 'swap' | 'rest'
  path?: string
  /** Bytes per day, and size now. */
  perDay: number
  bytes: number
}

export interface DiskRecent {
  name: string
  parent?: string
  /** Files directly in `name`, outside its larger subfolders. */
  loose?: boolean
  path?: string
  bytes: number
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
  /** When the figures were read (for stale ones: their age, shown as « 12 min ago »). */
  at: number
  error?: string
  /** The last read failed (429, network): these are the last known figures, kept. */
  stale?: boolean
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

/** Spend estimate from the transcripts (API list prices, a common unit across models) matched with the Claude quota. */
export interface WindowSpend {
  start: number
  end: number
  cost: number
  tokens: number
  /** Real percent from the quota answer, when known. */
  percent?: number
}
export interface SpendSummary {
  at: number
  /** The quota answer these figures were matched with (its read time). */
  quotaAt?: number
  week: WindowSpend & { byModel: { model: string; cost: number; tokens: number }[]; bySession: { sid: string; cost: number; tokens: number }[] }
  session?: WindowSpend
  /** API-price dollars per hour, last 60 min and last 5 h. */
  burn: { hour: number; fiveHours: number }
  /** Dollars per 1 % of the week, learned from the quota (null until the week is past 3 %). */
  perPercent: number | null
  /** Estimated week percent now (real percent + spend since that reading). */
  weekPercentNow?: number
  /** Percent of the week per hour at the last hour's / last 5 h's pace. */
  pctPerHour?: { hour: number; fiveHours: number }
  /** When the week reaches 100 % at the last 5 h's pace; null: not before it resets. */
  limitAt?: number | null
  codexTokens: { week: number; hour: number }
}
