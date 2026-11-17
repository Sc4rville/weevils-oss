// The voices of the « for you » stream: weevboss keeps the app's, each outside author gets one of its own, the same
// at every read and after a restart, different from weevboss's and from the other authors' while voices are left.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TTS_VOICE } from './config.ts'
import { DEFAULT_VOICE, EDGE_VOICES, Voices, isEdgeVoice, pickVoice, voiceParam, type Provider } from './foryou-voice.ts'

let dir: string
let provider: Provider
const flush = () => new Promise((r) => setTimeout(r, 0))
const make = (over: { bossVoice?: () => string | undefined; list?: () => Promise<string[]> } = {}) => new Voices({ file: path.join(dir, 'voices.json'), provider: () => provider, ...over })

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voices-'))
  provider = 'edge'
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('the voices of the stream', () => {
  it('no speech on this server: nobody has a voice', () => {
    provider = null
    const v = make()
    expect(v.of('weevboss', 'en')).toBeUndefined()
    expect(v.of('gepetto', 'en')).toBeUndefined()
  })

  it('weevboss keeps the voice of the app: an id the speak route reads as « none given »', () => {
    const v = make()
    expect(v.of('weevboss', 'fr')).toBe(DEFAULT_VOICE)
    expect(voiceParam(DEFAULT_VOICE)).toBeUndefined()
    expect(voiceParam('')).toBeUndefined()
    expect(voiceParam(null)).toBeUndefined()
    expect(voiceParam('fr-FR-DeniseNeural')).toBe('fr-FR-DeniseNeural')
  })

  it('the pick is stable, moves on from a voice already taken, and shares one only when none is left', () => {
    const list = ['a', 'b', 'c']
    const first = pickVoice('gepetto', list)!
    expect(pickVoice('gepetto', list)).toBe(first)
    expect(list).toContain(first)
    const second = pickVoice('gepetto', list, [first])!
    expect(second).not.toBe(first)
    expect(pickVoice('gepetto', list, list)).toBe(first)
    expect(pickVoice('gepetto', [])).toBeUndefined()
  })

  it('the free voice: each author its own from the fixed list, in the language read, never the app’s, the same after a restart', () => {
    const v = make()
    const authors = ['gepetto', 'instinct', 'juno', 'sentinel', 'atlas']
    for (const l of ['fr', 'en'] as const) {
      const got = authors.map((a) => v.of(a, l)!)
      expect(new Set(got).size).toBe(authors.length)
      for (const voice of got) {
        expect(EDGE_VOICES[l]).toContain(voice)
        expect(isEdgeVoice(voice)).toBe(true)
        expect(voice).not.toBe(TTS_VOICE[l])
      }
      expect(authors.map((a) => v.of(a, l))).toEqual(got)
      // Whatever the order they are met in after a restart.
      const again = make()
      expect([...authors].reverse().map((a) => again.of(a, l))).toEqual([...got].reverse())
    }
    expect(v.of('gepetto', 'fr')).not.toBe(v.of('gepetto', 'en'))
    for (const l of ['fr', 'en'] as const) {
      expect(EDGE_VOICES[l]).not.toContain(TTS_VOICE[l])
      expect(new Set(EDGE_VOICES[l]).size).toBe(EDGE_VOICES[l].length)
      expect(EDGE_VOICES[l].every(isEdgeVoice)).toBe(true)
    }
    expect(isEdgeVoice('default')).toBe(false)
    expect(isEdgeVoice('fr-FR-Denise; rm -rf')).toBe(false)
    expect(isEdgeVoice(undefined)).toBe(false)
  })

  it('Cartesia: the list is asked once in the background; until it is known an author has no voice, then one for good', async () => {
    provider = 'cartesia'
    let asked = 0
    let list = ['v-boss', 'v1', 'v2', 'v3']
    const v = make({ bossVoice: () => 'v-boss', list: async () => (asked++, list) })
    expect(v.of('weevboss', 'fr')).toBe(DEFAULT_VOICE)
    expect(v.of('gepetto', 'fr')).toBeUndefined()
    expect(v.of('instinct', 'fr')).toBeUndefined()
    await flush()
    expect(asked).toBe(1)
    const g = v.of('gepetto', 'fr')!
    const i = v.of('instinct', 'fr')!
    expect(['v1', 'v2', 'v3']).toContain(g)
    expect(['v1', 'v2', 'v3']).toContain(i)
    expect(i).not.toBe(g)
    // The provider's list changes, the server restarts and the list is not loaded yet: the same voices.
    list = ['other']
    const again = make({ bossVoice: () => 'v-boss', list: async () => (asked++, list) })
    expect(again.of('gepetto', 'fr')).toBe(g)
    expect(again.of('instinct', 'fr')).toBe(i)
    expect(asked).toBe(1)
  })

  it('Cartesia without a chosen voice: the first two of the list are left to the app', async () => {
    provider = 'cartesia'
    const v = make({ list: async () => ['f1', 'm1', 'f2', 'm2'] })
    v.of('gepetto', 'en')
    await flush()
    expect(['f2', 'm2']).toContain(v.of('gepetto', 'en'))
    expect(['f2', 'm2']).toContain(v.of('instinct', 'en'))
  })

  it('a list that cannot be read: no voice for the authors, weevboss still speaks, no retry at every read', async () => {
    provider = 'cartesia'
    let asked = 0
    const v = make({ list: async () => (asked++, Promise.reject(new Error('503'))) })
    expect(v.of('gepetto', 'fr')).toBeUndefined()
    await flush()
    expect(v.of('gepetto', 'fr')).toBeUndefined()
    await flush()
    expect(asked).toBe(1)
    expect(v.of('weevboss', 'fr')).toBe(DEFAULT_VOICE)
  })
})
