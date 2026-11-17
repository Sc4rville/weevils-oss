// Who speaks with which voice in the « for you » stream (ForYouItem.voice, read by GET /api/speak/stream?voice=…).
// weevboss keeps the app's voice: DEFAULT_VOICE, which the route reads as « no voice given ». Every outside author
// gets one voice of its own, picked once (a hash of its id over the voices of the provider in the language being read,
// the next free one when another author already has it, never weevboss's) and kept in DATA_DIR/foryou-voices.json, so
// it stays the same whatever the provider's list becomes.
//
// Providers (server/voicepipe.ts): Cartesia when its key is set (the list comes from its API, asked once per language
// in the background: until it is known an author has no voice yet, so its items show no play button), else edge-tts
// when installed (EDGE_VOICES: a fixed list of Microsoft neural voices, checked against `edge-tts --list-voices` on
// 2026-11-10). No provider: no voice at all.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR, TTS_VOICE } from './config.ts'
import { cartesia, cartesiaVoices, edgeTts } from './fast.ts'
import { lang, type Lang } from './i18n.ts'

/** weevboss's voice id: « the voice the app already speaks with ». */
export const DEFAULT_VOICE = 'default'
export const voiceParam = (v: string | null | undefined): string | undefined => (v && v !== DEFAULT_VOICE ? v : undefined)

/** An edge-tts voice name (fr-FR-DeniseNeural): the only shape passed on to edge-tts. */
export const isEdgeVoice = (v: string | undefined): v is string => !!v && /^[a-z]{2,3}-[A-Z]{2}-[A-Za-z]{2,40}Neural$/.test(v)

/** Distinct voices for the outside authors when the free voice (edge-tts) speaks: women and men, several accents. */
export const EDGE_VOICES: Record<Lang, string[]> = {
  fr: ['fr-FR-DeniseNeural', 'fr-FR-HenriNeural', 'fr-FR-VivienneMultilingualNeural', 'fr-CA-AntoineNeural', 'fr-FR-EloiseNeural', 'fr-BE-GerardNeural', 'fr-CA-SylvieNeural', 'fr-CH-FabriceNeural'],
  en: ['en-US-AriaNeural', 'en-GB-RyanNeural', 'en-US-EmmaMultilingualNeural', 'en-US-BrianMultilingualNeural', 'en-GB-SoniaNeural', 'en-US-GuyNeural', 'en-AU-NatashaNeural', 'en-US-JennyNeural'],
}

/** A stable pick: the hash of the speaker's id over the list, moved on to the next voice nobody has. undefined: none left to give. */
export function pickVoice(who: string, list: string[], taken: Iterable<string> = []): string | undefined {
  const used = new Set(taken)
  if (!list.length) return undefined
  const start = crypto.createHash('sha1').update(who).digest().readUInt32BE(0) % list.length
  for (let i = 0; i < list.length; i++) {
    const v = list[(start + i) % list.length]
    if (!used.has(v)) return v
  }
  // More speakers than voices: sharing one beats being silent (still never weevboss's when another exists).
  return list[start]
}

export type Provider = 'cartesia' | 'edge' | null

export interface VoiceDeps {
  /** Default DATA_DIR/foryou-voices.json. */
  file?: string
  provider?: () => Provider
  /** Cartesia: the voice the app speaks with when it is known (chosen in the app, or CARTESIA_VOICE_ID). */
  bossVoice?: () => string | undefined
  /** Cartesia: the voice ids offered in the current language (fast.ts cartesiaVoices). */
  list?: () => Promise<string[]>
}

type Kept = Record<string, Record<string, string>>

export class Voices {
  private file: string
  private deps: VoiceDeps
  private kept: Kept
  private lists = new Map<Lang, string[]>()
  private loading = new Set<Lang>()
  private failedAt = new Map<Lang, number>()
  private prov: { at: number; v: Provider } | null = null

  constructor(deps: VoiceDeps = {}) {
    this.deps = deps
    this.file = deps.file ?? path.join(DATA_DIR, 'foryou-voices.json')
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown
      this.kept = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Kept) : {}
    } catch {
      this.kept = {}
    }
  }

  /** Speech on this server, and through what. Looked up at most once a minute (edge-tts is searched on the PATH). */
  provider(): Provider {
    if (this.deps.provider) return this.deps.provider()
    const now = Date.now()
    if (!this.prov || now - this.prov.at > 60_000) this.prov = { at: now, v: cartesia() ? 'cartesia' : edgeTts() ? 'edge' : null }
    return this.prov.v
  }

  private load(l: Lang) {
    if (this.loading.has(l) || Date.now() - (this.failedAt.get(l) ?? 0) < 10 * 60_000) return
    this.loading.add(l)
    // Called in the language being read: cartesiaVoices() notes it before its first await.
    void (this.deps.list ?? (async () => (await cartesiaVoices()).map((v) => v.id)))()
      .then((ids) => {
        const list = [...new Set(ids.filter((id) => typeof id === 'string' && id))]
        if (list.length) this.lists.set(l, list)
        else this.failedAt.set(l, Date.now())
      })
      .catch(() => void this.failedAt.set(l, Date.now()))
      .finally(() => this.loading.delete(l))
  }

  /** The voice of a speaker (ForYouDeps.voiceOf): undefined when this server cannot speak, or not yet in that voice. */
  of(who: string, l: Lang = lang()): string | undefined {
    const p = this.provider()
    if (!p) return undefined
    if (who === 'weevboss' || who === 'weevils' || who === 'session') return DEFAULT_VOICE
    const key = `${p}:${l}`
    const mine = (this.kept[key] ??= {})
    const list = p === 'edge' ? EDGE_VOICES[l] : this.lists.get(l)
    // Once given, a Cartesia voice stays even while the list is not loaded; an edge voice must still be one we pass on.
    if (mine[who] && (p === 'cartesia' || isEdgeVoice(mine[who]))) return mine[who]
    if (!list) return void this.load(l)
    const boss = p === 'edge' ? [TTS_VOICE[l]] : [this.deps.bossVoice?.()].filter((v): v is string => !!v)
    // Cartesia without a chosen voice speaks with the first of its list (a woman's or a man's: both are left to weevboss).
    const free = list.filter((v) => !boss.includes(v)).slice(p === 'cartesia' && !boss.length ? 2 : 0)
    const voice = pickVoice(who, free.length ? free : list, Object.values(mine))
    if (!voice) return undefined
    mine[who] = voice
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.kept))
      fs.renameSync(tmp, this.file)
    } catch (e) {
      console.error(`[foryou] voix : ${(e as Error).message}`)
    }
    return voice
  }
}
