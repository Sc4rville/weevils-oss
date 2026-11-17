// weevboss's request ledger (server/boss-ledger.ts), as the server keeps it and the app's « requests » page reads it.

export type AskStatus = 'open' | 'dispatched' | 'done' | 'dropped'
export type Outcome = 'done' | 'question' | 'failed' | 'progress'
/** answered: done in weevboss's reply · sent: in a session · send: to send now, not yet sent · queued: waits. */
export type Handling = 'answered' | 'sent' | 'send' | 'queued'
export type HandlingWhy = 'answered' | 'done-in-thread' | 'sent' | 'you-said-now' | 'you-said-later' | 'mode-pause' | 'mode-veille' | 'mode-turbo' | 'waits-for-weevboss'
/** The speed mode (pause, veille, croisière, turbo, max), read through server/request-handling.ts. */
export type SpeedMode = 'pause' | 'veille' | 'cruise' | 'turbo' | 'max'

/** One more message merged into a request (a follow-up, a correction): its id and the user's exact words. */
export interface MergedWords {
  src: string
  quote: string
  at: number
  from: string
}

export interface Dispatch {
  session: string
  /** Project · tool · title of the session when it was sent, for a reader who no longer sees it. */
  label?: string
  at: number
  brief?: string
  expect?: string
  /** What the session said back, judged once per stop. */
  report?: string
  outcome?: Outcome
  reportAt?: number
  /** lastActivityAt of the session when it was last judged (a new stop is judged again). */
  judgedAt?: number
}

export interface Ask {
  /** r12 */
  id: string
  /** The request in one plain sentence, in the app's language. */
  text: string
  /** The user's exact words. */
  quote: string
  /** The message it came from: a journal id (weevils recall) or a capture id. */
  src: string
  /** 'user' or the declared author of an agent message. */
  from: string
  at: number
  kind: 'task' | 'question'
  status: AskStatus
  goal?: string
  dispatches: Dispatch[]
  /** The latest word on it (a report, a note, why it was closed). */
  note?: string
  progressAt: number
  closedAt?: number
  closedBy?: 'user' | 'weevboss' | 'auto'
  /** Follow-ups and corrections merged into this request, oldest first (the first message is src/quote). */
  more?: MergedWords[]
  /** How it is handled, and why (older requests have none: read from their status). */
  handling?: Handling
  why?: HandlingWhy
}

export interface Goal {
  /** A short slug: blow-up, open-source… */
  id: string
  title: string
  why?: string
  status: 'active' | 'done' | 'paused'
  at: number
  progress?: string
  progressAt?: number
}

export type TraceKind = 'request' | 'dispatch' | 'report' | 'decision' | 'status' | 'goal'
export interface TraceEntry {
  at: number
  kind: TraceKind
  text: string
  /** kind status: what the request became (done, dropped, open, dispatched, progress). */
  status?: string
  goal?: string
  asks?: string[]
  session?: string
  who?: string
  why?: string
  expect?: string
  src?: string
}

export type KnowledgeKind = 'rule' | 'decision' | 'fact'
export interface Knowledge {
  /** k12 */
  id: string
  kind: KnowledgeKind
  text: string
  at: number
  updatedAt: number
  /** Messages it came from (recall ids), newest last. */
  src: string[]
  goal?: string
  /** How many times it was stated again. */
  seen: number
}

/** GET /api/boss/ledger */
export interface LedgerView {
  goals: (Goal & { total: number; done: number; open: number; stale: number; sessions: string[] })[]
  asks: (Ask & { stale: boolean })[]
  pending: { cid: string; at: number; text: string; from: string }[]
  trace: TraceEntry[]
  knowledge: Knowledge[]
  digestTokens: number
}
