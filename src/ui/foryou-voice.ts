import { getLang } from '../i18n'
import { humanFeedText, rawEngineeringNotice } from '../../shared/feed-text.ts'
// « Pour toi » : voice messages. ONE audio element for the whole stream: starting an item stops the one that was
// playing. Nothing is synthesised before the tap (GET /api/speak/stream starts with it; iOS plays nothing without one).
// weevboss's logo has its own element (src/ui/voice.tsx): the two never speak together, whoever starts last wins.
// They only know each other through two window events, so neither module needs the other to work (or to be tested).
import { useSyncExternalStore } from 'react'

/** The logo is about to speak: the voice message being read stops. */
export const LOGO_SAYS = 'weevils:logo-says'
/** A voice message starts: the logo stops speaking. */
export const ITEM_SAYS = 'weevils:item-says'

export type VoicePhase = 'idle' | 'loading' | 'playing' | 'error'
export interface VoiceState {
  phase: VoicePhase
  /** Whole seconds played (the length is not known before the end: the sound comes as a stream). */
  seconds: number
}

const IDLE: VoiceState = { phase: 'idle', seconds: 0 }
const ERROR_MS = 4000

let audio: HTMLAudioElement | null = null
/** The item being read (or the one that just failed), and where it stands. */
let current: string | null = null
let state: VoiceState = IDLE
let errTimer: ReturnType<typeof setTimeout> | undefined
const listeners = new Set<() => void>()

function set(id: string | null, next: VoiceState) {
  if (current === id && state.phase === next.phase && state.seconds === next.seconds) return
  current = id
  state = next
  for (const l of listeners) l()
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** The address a voice message is read from: the item's words, in its speaker's own voice. */
export const voiceUrl = (text: string, voice: string) => `/api/speak/stream?${new URLSearchParams({ text: text.slice(0, 1500), voice, lang: getLang() })}`

function fail(id: string) {
  if (current !== id) return
  audio?.pause()
  set(id, { phase: 'error', seconds: 0 })
  clearTimeout(errTimer)
  errTimer = setTimeout(() => current === id && state.phase === 'error' && set(null, IDLE), ERROR_MS)
}

/** Silence: the item being read stops (a tap on it, another one starting, the page closing, weevboss speaking). */
export function stopVoice(id?: string) {
  if (!current || (id && id !== current) || state.phase === 'error') return
  audio?.pause()
  set(null, IDLE)
}

export function retainVoice(ids: ReadonlySet<string>) { if (current && !ids.has(current)) stopVoice() }

/** A tap on a voice message: it starts (whatever was playing stops), or stops when it was the one playing. */
export function toggleVoice(id: string, text: string, voice: string) {
  if (rawEngineeringNotice(id, text)) return stopVoice()
  text = humanFeedText(text)
  if (!text) return stopVoice()
  clearTimeout(errTimer)
  if (current === id && (state.phase === 'playing' || state.phase === 'loading')) return stopVoice(id)
  window.dispatchEvent(new Event(ITEM_SAYS))
  let a = audio
  if (!a) {
    try {
      a = audio = new Audio()
    } catch {
      set(id, IDLE)
      return fail(id)
    }
    a.preload = 'none'
  }
  a.pause()
  set(id, { phase: 'loading', seconds: 0 })
  a.onplaying = () => current === id && set(id, { phase: 'playing', seconds: Math.floor(a.currentTime || 0) })
  a.ontimeupdate = () => current === id && state.phase === 'playing' && set(id, { phase: 'playing', seconds: Math.floor(a.currentTime || 0) })
  a.onended = () => current === id && set(null, IDLE)
  a.onerror = () => fail(id)
  a.src = voiceUrl(text, voice)
  try {
    void a.play()?.catch((e: unknown) => {
      // A pause (stop, or another item starting) interrupts play(): that is not a failure.
      if ((e as { name?: string } | null)?.name !== 'AbortError') fail(id)
    })
  } catch {
    fail(id)
  }
}

if (typeof window !== 'undefined') window.addEventListener(LOGO_SAYS, () => stopVoice())

const getAll = () => (current && state.phase !== 'error' ? current : null)
/** The id of the item being read aloud right now, if any (the top band's preview marks its strip). */
export const useVoiceId = (): string | null => useSyncExternalStore(subscribe, getAll, getAll)

/** Where this item's voice message stands. */
export function useVoice(id: string): VoiceState {
  const get = () => (current === id ? state : IDLE)
  return useSyncExternalStore(subscribe, get, get)
}

/** Tests only. */
export function resetVoice() {
  clearTimeout(errTimer)
  audio?.pause()
  audio = null
  set(null, IDLE)
}
