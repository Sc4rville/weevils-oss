// When a flying weevil may cross the screen. Pure functions (tested); src/ui/weevil.tsx only feeds them.
// Rare and polite: never in the first minutes, a random gap between two flights, a daily cap, and only when the home
// screen is calm (nothing open, nobody typing or talking).

/** Not before this long after the app opens. */
export const FIRST_MS = 3 * 60_000
/** Random gap between two flights. */
export const GAP_MIN_MS = 12 * 60_000
export const GAP_MAX_MS = 25 * 60_000
/** At most this many flights per 24 h (counted on the device). */
export const DAY_MAX = 6
/** No key pressed for this long. */
export const QUIET_MS = 20_000
/** Blocked when it was time: try again after this long. */
export const RETRY_MS = 45_000
/** Back to the app after a while away: a short grace before a weevil may fly. */
export const RETURN_MS = 60_000
/** Test hook (#weevil, or localStorage weevils-weevil-now = 1): a flight this soon, no daily cap. */
export const DEBUG_MS = 3_000
/** How often the component looks at the clock. */
export const TICK_MS = 2_000
const DAY = 24 * 3600_000

export interface WeevilState {
  /** When the last weevils flew (24 h kept). */
  flights: number[]
}

export function parseState(raw: string | null): WeevilState {
  try {
    const s = JSON.parse(raw ?? '') as Partial<WeevilState>
    return { flights: Array.isArray(s.flights) ? s.flights.filter((x) => typeof x === 'number' && Number.isFinite(x)) : [] }
  } catch {
    return { flights: [] }
  }
}

/** Records a flight (old ones forgotten). */
export const markFlown = (s: WeevilState, now: number): WeevilState => ({ flights: [...s.flights.filter((t) => now - t < DAY), now] })

/** A random gap between two flights. */
export const gap = (rand: () => number = Math.random) => GAP_MIN_MS + Math.floor(rand() * (GAP_MAX_MS - GAP_MIN_MS))

/**
 * When the next weevil may fly: FIRST_MS after the app opened, a random gap after the last flight, and once the oldest
 * of the day's flights is 24 h old when the cap is reached. debug: in DEBUG_MS, nothing else.
 */
export function nextAt(s: WeevilState, opened: number, now: number, debug = false, rand: () => number = Math.random): number {
  if (debug) return now + DEBUG_MS
  const recent = s.flights.filter((t) => now - t < DAY).sort((a, b) => a - b)
  let at = opened + FIRST_MS
  if (recent.length) at = Math.max(at, recent[recent.length - 1] + gap(rand))
  if (recent.length >= DAY_MAX) at = Math.max(at, recent[recent.length - DAY_MAX] + DAY)
  return Math.max(at, now)
}

export interface Calm {
  now: number
  /** A page is open. */
  page: boolean
  /** The 24/7 drawer is open, or weevboss's band. */
  drawer: boolean
  /** The intro, a tip card, a hint bubble or the gesture coach is on screen. */
  overlay: boolean
  /** The app is in the foreground. */
  visible: boolean
  /** A text field has the focus. */
  typing: boolean
  /** Last key pressed. */
  lastKey: number
  /** A voice logo listens or speaks. */
  voice: boolean
}

/** May a weevil fly right now? */
export const calm = (c: Calm) => !c.page && !c.drawer && !c.overlay && c.visible && !c.typing && !c.voice && c.now - c.lastKey >= QUIET_MS
