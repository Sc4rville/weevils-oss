// Premiers pas : le contrat entre weevilsd (server/tour.ts) et l'app (src/ui/tour.tsx).
//
// Une seule expérience, qui reprend là où l'installation s'est arrêtée (install.json écrit par install.sh) :
// 1. ce qui est déjà prêt est coché d'office (machine, Claude Code et son abonnement, Codex, GitHub, sessions et
//    projets retrouvés, téléphone…), jamais reproposé ;
// 2. une première vraie demande à weevboss, suivie en direct (il répond, ouvre une session, l'agent travaille) ;
// 3. les usages forts, un par un : chacun se joue sur place (démo marquée « démo », jamais mêlée aux vraies données,
//    retirée dès que la vraie brique est branchée), puis se branche d'un bouton ;
// 4. les gestes, appris en les faisant.
// L'état vit sur le serveur (DATA_DIR/tour.json) : le même sur tous les appareils, et weevboss le lit (weevils setup).

import type { Brick } from './setup.ts'

export const TOUR_IDS = [
  // déjà là (cochés d'office, jamais proposés)
  'install',
  'machine',
  'claude',
  'history',
  'phone',
  // la première demande
  'first',
  // les usages : démo jouable, puis branchement (les plus parlants d'abord)
  'voice',
  'h24',
  'mail',
  'devil',
  'push',
  'github',
  'night',
  'codex',
  // les gestes
  'g-talk',
  'g-repos',
  'g-calm',
  'g-back',
] as const
export type TourId = (typeof TOUR_IDS)[number]
export const isTourId = (s: unknown): s is TourId => typeof s === 'string' && (TOUR_IDS as readonly string[]).includes(s)

export type TourGroup = 'base' | 'first' | 'use' | 'gesture'
export const groupOf = (id: TourId): TourGroup =>
  id === 'first' ? 'first' : id.startsWith('g-') ? 'gesture' : ['install', 'machine', 'claude', 'history', 'phone'].includes(id) ? 'base' : 'use'

/** ready : déjà là au premier lancement ; done : fait pendant les premiers pas ; todo : à faire ; skip : passé. */
export type TourState = 'ready' | 'done' | 'todo' | 'skip'

/** Ce qui a une démo jouable sur place (les autres se branchent directement). */
export const DEMOS: ReadonlySet<TourId> = new Set(['voice', 'h24', 'mail', 'devil', 'github'])

/** La brique de branchement (src/ui/setup.tsx) derrière chaque usage. */
export const BRICK_OF: Partial<Record<TourId, Brick>> = {
  claude: 'claude',
  phone: 'phone',
  github: 'github',
  voice: 'voice',
  push: 'push',
  mail: 'mail',
  devil: 'devil',
  night: 'machine',
  codex: 'codex',
}

export interface TourStep {
  id: TourId
  state: TourState
  /** La démo a été jouée (l'usage n'est pas branché pour autant). */
  played?: boolean
  /** Les faits à montrer (« max », « 4 cœurs · 15 Go », « 12 projets »…), mis en mots par l'app. */
  facts?: Record<string, string | number | boolean>
}

/** Ce que l'installation a laissé (install.json, écrit par install.sh). */
export interface Handoff {
  by: 'agent' | 'terminal' | 'script'
  agent: string
  at: number
  mode: 'public' | 'lan' | 'local'
  phoneLink: boolean
}

export interface Tour {
  steps: TourStep[]
  /** La bande des premiers pas est montrée (fermée : rouverte par les réglages ou weevboss). */
  open: boolean
  /** Le premier écran (ce qui est déjà prêt, puis la première demande) a été vu. */
  intro: boolean
  /** Tout est fait, branché ou passé. */
  finished: boolean
  install?: Handoff
}

/** Ce qui reste, dans l'ordre : la prochaine étape est la première. */
export const pending = (t: Tour) => t.steps.filter((s) => s.state === 'todo')
export const counted = (t: Tour) => t.steps.filter((s) => groupOf(s.id) !== 'base' || s.state !== 'ready')
