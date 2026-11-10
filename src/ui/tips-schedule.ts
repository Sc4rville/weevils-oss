// When a floating tip may appear, and which one. Pure functions (tested), the component only feeds them.
// Rare by design: the user idle on the feed, one card at a time, a long cooldown, a daily cap, never the same card twice.

import type { TipCard } from '../../shared/tips.ts'

/** No pointer, key, scroll or touch on the feed for this long before a card may come. */
export const IDLE_MS = 45_000
/** At least this long between two cards. */
export const COOLDOWN_MS = 25 * 60_000
/** At most this many cards per 24 h. */
export const DAY_MAX = 4
/** An ignored card slides away after this long (it still counts as seen). */
export const SHOW_MS = 14_000
/** How often the component checks the conditions. */
export const CHECK_MS = 5_000
/** Nothing new to show (every card already seen): don't ask weevilsd again before this long. */
export const EMPTY_RETRY_MS = 10 * 60_000
/** Dev only (localStorage "weevils-tips-debug" = "1"): short idle, no cooldown, no daily cap. */
export const DEBUG_IDLE_MS = 5_000
/** Seen ids kept on the device (oldest forgotten beyond). */
const SEEN_MAX = 400
const DAY = 24 * 3600_000

export interface TipsState {
  /** Ids of every card already shown on this device. */
  seen: string[]
  /** When the last cards were shown (24 h kept). */
  shown: number[]
  /** Turned off in the settings. */
  off: boolean
}

export const emptyState = (): TipsState => ({ seen: [], shown: [], off: false })

export function parseState(raw: string | null): TipsState {
  try {
    const s = JSON.parse(raw ?? '') as Partial<TipsState>
    return {
      seen: Array.isArray(s.seen) ? s.seen.filter((x) => typeof x === 'string') : [],
      shown: Array.isArray(s.shown) ? s.shown.filter((x) => typeof x === 'number') : [],
      off: s.off === true,
    }
  } catch {
    return emptyState()
  }
}

export interface Moment {
  now: number
  /** Last pointer / key / scroll / touch. */
  lastInput: number
  /** A card is on screen. */
  showing: boolean
  /** A page, a focused field, a hidden app, the intro or the open 24/7 drawer. */
  blocked: boolean
  debug: boolean
}

/** May a new card appear now? */
export function ready(s: TipsState, m: Moment): boolean {
  if (s.off || m.showing || m.blocked) return false
  if (m.now - m.lastInput < (m.debug ? DEBUG_IDLE_MS : IDLE_MS)) return false
  if (m.debug) return true
  const recent = s.shown.filter((t) => m.now - t < DAY)
  if (recent.length >= DAY_MAX) return false
  return !recent.some((t) => m.now - t < COOLDOWN_MS)
}

/** The card to show: an unseen personalized card first (in the server's order of importance), otherwise a random unseen tip. */
export function pick(cards: TipCard[], s: TipsState, rand: () => number = Math.random): TipCard | null {
  const seen = new Set(s.seen)
  const fresh = cards.filter((c) => !seen.has(c.id))
  const personal = fresh.find((c) => c.personal)
  if (personal) return personal
  const general = fresh.filter((c) => !c.personal)
  return general.length ? general[Math.floor(rand() * general.length) % general.length] : null
}

/** Records a card as shown (seen for good, and the start of the cooldown). */
export function markShown(s: TipsState, id: string, now: number): TipsState {
  return {
    ...s,
    seen: [...s.seen.filter((x) => x !== id), id].slice(-SEEN_MAX),
    shown: [...s.shown.filter((t) => now - t < DAY), now],
  }
}
