import { describe, expect, it } from 'vitest'
import { speechStats, worthTranscribing } from './transcribe.ts'
import { follow } from './voicepipe.ts'

const RATE = 16000
/** PCM mono : `seconds` de bruit de fond très faible, avec `voiced` secondes d'un son franc au milieu. */
function clip(seconds: number, voiced: number): Int16Array {
  const pcm = new Int16Array(Math.round(seconds * RATE))
  const from = Math.round(((seconds - voiced) / 2) * RATE)
  for (let i = 0; i < pcm.length; i++) {
    const loud = i >= from && i < from + voiced * RATE
    pcm[i] = Math.round(Math.sin(i / 7) * (loud ? 6000 : 30))
  }
  return pcm
}

describe('clips vocaux à écarter (Whisper hallucine sur du presque rien)', () => {
  it('écarte un clip trop court, même plein de son', () => {
    expect(worthTranscribing(speechStats(clip(0.4, 0.4), RATE))).toBe(false)
  })
  it('écarte un clip assez long mais sans parole (souffle de la pièce)', () => {
    const s = speechStats(clip(2, 0), RATE)
    expect(s.voiced).toBe(0)
    expect(worthTranscribing(s)).toBe(false)
  })
  it('garde un clip court où l’on parle vraiment', () => {
    const s = speechStats(clip(1, 0.5), RATE)
    expect(s.seconds).toBeCloseTo(1, 2)
    expect(s.voiced).toBeGreaterThan(0.45)
    expect(worthTranscribing(s)).toBe(true)
  })
})

describe('un même son demandé deux fois n’est produit qu’une fois', () => {
  it('la seconde requête relit le début puis suit la suite', () => {
    const s = { chunks: [] as Uint8Array[], done: false, subs: new Set<(c: Uint8Array | null) => void>() }
    const emit = (c: Uint8Array | null) => {
      if (c) s.chunks.push(c)
      else s.done = true
      for (const f of [...s.subs]) f(c)
    }
    const got1: number[] = []
    const got2: number[] = []
    let ended = 0
    follow(s, { write: (b) => got1.push(b[0]), end: () => ended++ })
    emit(Uint8Array.of(1))
    follow(s, { write: (b) => got2.push(b[0]), end: () => ended++ })
    emit(Uint8Array.of(2))
    emit(null)
    expect(got1).toEqual([1, 2])
    expect(got2).toEqual([1, 2])
    expect(ended).toBe(2)
  })
})
