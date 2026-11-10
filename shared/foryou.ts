// "For you": the stream next to weevboss that tells, in bands, what the user's agents did, need and suggest.
// Contract between weevilsd (server/foryou.ts, main machine only) and the app (src/ui/foryou.tsx).
// Named "for you" everywhere in the code: "feed" already means the home list of project bands.

import type { Tool } from './api.ts'

/**
 * What an item is. The names are internal (never shown):
 * media: something to look at that an agent produced (render, screenshot, clip) · boss: a word from weevboss ·
 * mail: a message received from an outside actor (mail bridge author) · proposals: one or more suggested actions ·
 * session: what a session just did, asks, or why it stopped · improve: a way for weevils to work better for this user ·
 * alert: something that needs the user now · insight: something worth knowing about what the agents touch ·
 * milestone: a big number or a first time · stat: where things stand, as bars (a usage window, today's work per project…).
 */
export type ForYouKind = 'media' | 'boss' | 'mail' | 'proposals' | 'session' | 'improve' | 'alert' | 'insight' | 'milestone' | 'stat'

/** Picks the colour family: result (green), question (amber), alert (the alert red), neutral (the speaker's own colour), magic (gradient). */
export type ForYouTone = 'result' | 'question' | 'alert' | 'neutral' | 'magic'

export interface ForYouMedia {
  /** Served by GET /api/foryou/media/<id> (auth, Range): only files the stream itself listed, never a free path. */
  id: string
  type: 'image' | 'video'
  url: string
  /** File name, for the accessible label. */
  name: string
  bytes: number
}

/** A bar of a « stat » item (or under any item): where something stands. value/max draw the bar; shown is the figure in words (« 71 % », « 12 sur 18 »). */
export interface ForYouGauge {
  label: string
  value: number
  max: number
  shown: string
  /** Colour of the bar when it speaks of a project. */
  projectId?: string
  /** The bar is close to a limit: drawn in the alert colour. */
  hot?: boolean
}

/** One suggested action inside a « proposals » item. */
export interface ForYouCard {
  id: string
  title: string
  why: string
  /** optimizer: a task for the auto band (snap.optimizers) ; tip: a personal tip with an action ; boss: suggested by weevboss. */
  source: 'optimizer' | 'tip' | 'boss'
  /** Optimizer kind (tests, watch…) or tip rule: picks the glyph. */
  kind: string
  /** Label of the accept button when it is not a plain ✓. */
  accept?: string
}

/** A button under an item. The server knows what it does: POST /api/foryou/<item>/act { action }. */
export interface ForYouAction {
  id: string
  label: string
}

/** Where a tap on the item goes (client navigation). */
export type ForYouOpen =
  | { page: 'session'; id: string }
  /** weevboss's thread, on this message when known. */
  | { page: 'boss'; mid?: string }
  /** The auto drawer, on this task. */
  | { page: 'auto'; id?: string }
  | { page: 'usage' }
  | { page: 'machine' }

export interface ForYouItem {
  /** Same event identity as the session page, when applicable. */
  eventId?: string
  id: string
  kind: ForYouKind
  tone: ForYouTone
  at: number
  /** Who speaks: 'weevboss', an author id (Snapshot.config.authors), 'session', or 'weevils' (the system itself). Also the participant filter. */
  who: string
  projectId?: string
  sessionId?: string
  tool?: Tool
  /** Session title, mail subject, media caption: one short line above the text. */
  title?: string
  /** The words of the item, short (a result, a thought, a summary). Plain text. */
  text: string
  /** A question card: its short title, in bold above the question (the question itself is the text). */
  lead?: string
  /** mail: the whole message, unfolded in place on a tap. */
  body?: string
  media?: ForYouMedia[]
  cards?: ForYouCard[]
  actions?: ForYouAction[]
  /** A reply typed under the item goes there: POST /api/foryou/<id>/reply { text }. */
  reply?: 'boss' | 'session' | 'mail'
  open?: ForYouOpen
  /** « Learn more » exists: POST /api/foryou/<id>/more answers { text }, kept in moreText. */
  more?: boolean
  moreText?: string
  /** Bars: the item shows figures (a stat, or a result with its progress). */
  gauges?: ForYouGauge[]
  /** The item can be listened to, as a voice message in its speaker's own voice: the voice id for GET /api/speak/stream?text=…&voice=…
   *  (absent: no speech on this server). Each speaker keeps the same voice. */
  voice?: string
  /** Already under the user's eyes once (any device). */
  seen?: boolean
  /** Computed from the current state (an alert, pending proposals): it leaves on its own when the state does. */
  live?: boolean
}

/** The factory line at the top of the stream: what is turning right now. */
export interface ForYouPulse {
  working: number
  waiting: number
  /** Turns finished today (results delivered). */
  delivered: number
  /** Tasks of the auto band running or queued. */
  auto: number
}

/** GET /api/foryou. Items already ordered and paced by the server (server/foryou.ts arrange()). */
export interface ForYouFeed {
  rev: number
  items: ForYouItem[]
  pulse: ForYouPulse
}

/** In the snapshot (kept tiny: the whole snapshot is re-sent at every change). The app refetches GET /api/foryou when rev changes. */
export interface ForYouMark {
  rev: number
  unseen: number
}

export const FORYOU_KINDS: ForYouKind[] = ['media', 'boss', 'mail', 'proposals', 'session', 'improve', 'alert', 'insight', 'milestone', 'stat']
