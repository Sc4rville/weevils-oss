// How each request is handled: answered now, sent now, or queued (and why it waits).
//
// The rule, in order:
//   1. The user's explicit words win: « urgent », « now », « tout de suite » → send now; « plus tard », « this
//      weekend », « demain », « pas urgent » → queue.
//   2. Otherwise the speed mode decides: pause / veille → queue, nothing auto-resumes; cruise → ongoing work goes on
//      (a request already in a session stays sent, a new one waits for weevboss); turbo / max → weevboss sends at
//      once, without waiting.
//
// The speed mode is read through one function, `speedMode()`, so the session that builds the modes plugs in here
// (setSpeedModeSource) without touching the ledger. Until then it is « cruise », weevboss's behaviour so far.

import type { Ask, Handling, HandlingWhy, SpeedMode } from '../shared/ledger.ts'

export type { Handling, HandlingWhy, SpeedMode } from '../shared/ledger.ts'

let source: () => SpeedMode | undefined = () => undefined

/** The speed mode builder plugs its reader in here. */
export function setSpeedModeSource(fn: () => SpeedMode | undefined) {
  source = fn
}

/** The current speed mode; « cruise » while the modes are not live. */
export function speedMode(): SpeedMode {
  try {
    const m = source()
    return m === 'pause' || m === 'veille' || m === 'cruise' || m === 'turbo' || m === 'max' ? m : 'cruise'
  } catch {
    return 'cruise'
  }
}

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[’‘`]/g, "'")

// i18n-ignore : matched against the user's own words (French and English), never shown
const NOW = /\b(urgent|urgence|asap|now|right away|immediately|tout de suite|maintenant|direct(ement)?|vite|en priorite|priorite|tt de suite|tds)\b/
// i18n-ignore : idem
const LATER = /\b(plus tard|later|apres|after|this weekend|ce week-?end|le week-?end|weekend|demain|tomorrow|next week|la semaine prochaine|quand tu (peux|auras le temps)|when you can|pas urgent|not urgent|no rush|pas presse|un jour|someday|a un moment)\b/

/** What the user's own words say about timing: 'now', 'later', or nothing. Exported for tests. */
export function explicitTiming(words: string): 'now' | 'later' | undefined {
  const w = fold(words)
  // « pas urgent » says later, even though it holds « urgent ».
  if (LATER.test(w)) return 'later'
  if (NOW.test(w)) return 'now'
  return undefined
}

export interface Decision {
  handling: Handling
  why: HandlingWhy
}

/**
 * The handling of one request. `state` is what weevboss's turn already did with it (answered in the thread, sent to a
 * session, or nothing yet); `words` are the user's exact words for it (every merged message).
 */
export function decide(o: { state: 'done' | 'dispatched' | 'open'; kind: Ask['kind']; words: string; mode?: SpeedMode }): Decision {
  const mode = o.mode ?? speedMode()
  if (o.state === 'done') return { handling: 'answered', why: o.kind === 'question' ? 'answered' : 'done-in-thread' }
  const timing = explicitTiming(o.words)
  if (o.state === 'dispatched') return { handling: 'sent', why: timing === 'now' ? 'you-said-now' : 'sent' }
  if (timing === 'later') return { handling: 'queued', why: 'you-said-later' }
  if (timing === 'now') return { handling: 'send', why: 'you-said-now' }
  if (mode === 'pause' || mode === 'veille') return { handling: 'queued', why: mode === 'pause' ? 'mode-pause' : 'mode-veille' }
  if (mode === 'turbo' || mode === 'max') return { handling: 'send', why: 'mode-turbo' }
  return { handling: 'queued', why: 'waits-for-weevboss' }
}
