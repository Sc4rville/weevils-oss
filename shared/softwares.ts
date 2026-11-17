// Contrat de la page « mes logiciels » : tout ce que l'utilisateur fait tourner ou construit, détecté sur ses machines
// (repos des racines de projets, services systemd --user, conteneurs Docker, sites publiés, jobs de LOGS_DIR).
// Rien n'est saisi à la main, sauf la correction d'avancement (un tap). Horodatages en millisecondes.

/** web : a une interface à montrer dans un navigateur ; les autres n'en ont pas (aperçu en terminal). */
export type SoftwareKind = 'web' | 'service' | 'api' | 'bot' | 'cli' | 'lib'

/**
 * 1 : vers une première version utilisable (percent = chemin parcouru jusqu'à elle).
 * 2 : une version utilisable existe, on continue (percent = maturité de cette version).
 * 3 : de vrais utilisateurs ou clients (percent = traction, échelle log).
 */
export type Phase = 1 | 2 | 3

export interface Progress {
  phase: Phase
  /** 0 à 100, dans la phase. */
  percent: number
  /** Pourquoi, en quelques mots, dans la langue de l'utilisateur (vide : rien à dire). */
  reason: string
  /** estimate : modèle à partir des signaux ; heuristic : calcul sans modèle (repli) ; user : corrigé d'un tap. */
  source: 'estimate' | 'heuristic' | 'user'
  at: number
}

/** État de lancement : idle (rien ne tourne), starting (en cours, voir tail), running, failed (voir tail). */
export type RunState = 'idle' | 'starting' | 'running' | 'failed'

/** D'où viennent les lignes de l'aperçu terminal (toujours une vraie sortie, jamais du texte inventé). */
export type TailSource = 'log' | 'journal' | 'docker' | 'run' | 'git'

export interface Software {
  /** Stable : « <machine>:<clé> » (clé = famille de repos, ou unit:<nom>, docker:<nom>, site:<nom>). */
  id: string
  name: string
  /** Ce que c'est, une phrase (phrase du repo en cache quand il y en a une). */
  blurb?: string
  machine: string
  /** Checkout principal (vide pour un service sans repo). */
  repo: string
  /** Toutes les copies de travail du même logiciel (worktrees, variantes), la principale d'abord. */
  repos: string[]
  kind: SoftwareKind
  /** Adresse où son interface est visible maintenant (exposée, publiée). */
  url?: string
  /** L'interface accepte d'être affichée dans un cadre (ni X-Frame-Options, ni frame-ancestors restrictif). */
  embeddable?: boolean
  /** Port local sur lequel il écoute ou écoutera (port du projet). */
  port?: number
  run: RunState
  /** Les vraies dernières lignes (au plus 40), sans codes ANSI. */
  tail: string[]
  tailSource: TailSource
  /** Horodatage de la dernière capture d'écran (image : GET /api/softwares/<id>/shot) ; absent = pas de capture. */
  shot?: number
  progress: Progress
  /** Ce qu'un tap lance quand rien ne tourne (absent : rien à lancer, on montre l'état et la sortie). */
  launch?: { how: 'dev' | 'start' | 'preview' | 'static' | 'unit' | 'docker' | 'help'; cmd: string }
  /** Ce qui le fait tourner en permanence, quand c'est le cas (unit:<nom>, docker:<nom>, site:<nom>). */
  hosts: string[]
  /** weevils l'a lancé lui-même (d'un tap) : c'est la seule chose que POST /stop arrête. */
  owned?: boolean
  lastCommitAt: number
  lastActivityAt: number
}

export interface SoftwareList {
  softwares: Software[]
}

/** POST /api/softwares/<id>/progress : correction d'un tap ; reset revient à l'estimation. */
export interface ProgressFix {
  phase?: Phase
  percent?: number
  reset?: boolean
}
