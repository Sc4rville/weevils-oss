// Floating tips and action cards: the contract between weevilsd (personalized cards, GET /api/tips) and the app.

/** What accepting a card does. */
export type TipAction =
  /** weevilsd runs it: POST /api/tips/act { id }. */
  | { kind: 'server' }
  /** A prepared message sent to weevboss (already in the user's language). */
  | { kind: 'boss'; text: string }
  /** Opens a page of the app. */
  | { kind: 'open'; page: 'session'; id: string }
  | { kind: 'open'; page: 'conversations' }
  /** Asks for notifications on this device. */
  | { kind: 'push' }
  /** Opens weevboss's thread and starts a setup flow (a brick of shared/setup.ts: machine, voice…). */
  | { kind: 'setup'; brick: 'machine' | 'voice' | 'github' | 'claude' }

export interface TipCard {
  /** Stable id, including the situation ("idle-sessions:<hash>"): a card is never shown twice. */
  id: string
  /** Rule or catalog entry it comes from (picks the icon). */
  rule: string
  /** Big short text, two lines at most. */
  text: string
  /** Label of the accept target, when the card is an action. */
  accept?: string
  action?: TipAction
  /** Personalized (built from the real state) or a general tip. */
  personal: boolean
}

/** One load sample: time (ms), 1-minute load average, available memory ratio (0..1). */
export type LoadSample = [at: number, load: number, free: number]

/** Load history of one machine (GET /api/tips/load on each weevilsd). */
export interface MachineLoad {
  machineId: string
  name: string
  cores: number
  samples: LoadSample[]
}
