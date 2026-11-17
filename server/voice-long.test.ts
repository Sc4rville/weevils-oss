// Une dictée de 10 minutes n'est jamais réduite à une phrase (2026-11-10) : audio gardé sur disque, découpé en tranches
// de 90 s qui se chevauchent, chaque tranche transcrite puis recollée ; un texte qui ne colle pas à la durée de parole
// est retranscrit, et s'il ne colle toujours pas, rien n'est envoyé.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

process.env.OPENAI_API_KEY = 'sk-test'
const { ARCHIVE_DIR, CHUNK_S, LONG_S, stitch, transcribe, windows } = await import('./transcribe.ts')
const { addChunk, finishUpload } = await import('./voicepipe.ts')

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const RATE = 16000
/** Un faux enregistrement : `seconds` de « parole » (son franc), avec un court silence toutes les 10 s, en WAV. */
function fakeSpeech(seconds: number): Buffer {
  const pcm = new Int16Array(seconds * RATE)
  for (let i = 0; i < pcm.length; i++) pcm[i] = (i / RATE) % 10 < 9.5 ? Math.round(Math.sin(i / 7) * 6000) : 0
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + pcm.length * 2, 4)
  h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(RATE, 24)
  h.writeUInt32LE(RATE * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(pcm.length * 2, 40)
  return Buffer.concat([h, Buffer.from(pcm.buffer)])
}

/** Ce que « dit » la tranche n : 150 mots, dont les 3 premiers répètent la fin de la tranche précédente (chevauchement). */
const said = (n: number) => [...(n > 1 ? [`fin${n - 1}a`, `fin${n - 1}b`, `fin${n - 1}c`] : []), ...Array.from({ length: 144 }, (_, i) => `t${n}m${i}`), `fin${n}a`, `fin${n}b`, `fin${n}c`].join(' ')

let calls: { name: string; model: string; seconds: number }[]
/** OpenAI simulé : `answer(n, model)` donne le texte de la tranche n (0 : le fichier entier). */
function mockOpenAI(answer: (n: number, model: string) => string) {
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const form = init.body as FormData
    const file = form.get('file') as File
    const model = String(form.get('model'))
    const n = Number(/voix-(\d+)\.wav/.exec(file.name)?.[1] ?? 0)
    // Durée de la tranche, lue dans l'en-tête WAV (octets de données / 32 000).
    const buf = Buffer.from(await file.arrayBuffer())
    calls.push({ name: file.name, model, seconds: file.type === 'audio/wav' ? buf.readUInt32LE(40) / (RATE * 2) : 0 })
    return new Response(JSON.stringify({ text: answer(n, model) }), { status: 200 })
  })
}

beforeEach(() => {
  calls = []
  fs.rmSync(ARCHIVE_DIR, { recursive: true, force: true })
})
afterEach(() => vi.unstubAllGlobals())

describe('découpe et recollage', () => {
  it('10 min → 7 tranches de 90 s au plus, qui se chevauchent et couvrent tout', () => {
    const w = windows(600)
    expect(w.length).toBe(7)
    expect(w[0]).toEqual({ from: 0, to: 90 })
    for (let i = 1; i < w.length; i++) expect(w[i].from).toBeLessThan(w[i - 1].to)
    expect(w.at(-1)!.to).toBe(600)
    expect(Math.max(...w.map((x) => x.to - x.from))).toBeLessThanOrEqual(CHUNK_S)
    expect(windows(LONG_S)).toEqual([{ from: 0, to: LONG_S }])
  })
  it('les mots répétés au raccord ne sont gardés qu’une fois', () => {
    expect(stitch('il fait beau, on y va', 'on y va demain matin')).toBe('il fait beau, on y va demain matin')
    expect(stitch('a b c', 'd e')).toBe('a b c d e')
  })
})

describe.skipIf(!hasFfmpeg)('une dictée de 10 minutes', () => {
  it('est transcrite en entier : toutes les tranches, dans l’ordre, recollées sans doublon ; l’audio et le texte restent sur disque', async () => {
    mockOpenAI((n) => said(n))
    const text = await transcribe(fakeSpeech(600), 'audio/wav', 'fr')
    expect(calls.map((c) => c.name).sort()).toEqual(['voix-1.wav', 'voix-2.wav', 'voix-3.wav', 'voix-4.wav', 'voix-5.wav', 'voix-6.wav', 'voix-7.wav'])
    expect(calls.every((c) => c.model === 'gpt-4o-mini-transcribe' && c.seconds <= CHUNK_S)).toBe(true)
    const w = text.split(' ')
    expect(w.length).toBe(7 * 147)
    for (let n = 1; n <= 7; n++) expect(text).toContain(`t${n}m0 `)
    expect(w.indexOf('t1m0')).toBeLessThan(w.indexOf('t7m143'))
    expect(w.filter((x) => x === 'fin3a')).toHaveLength(1)
    const kept = fs.readdirSync(ARCHIVE_DIR)
    expect(kept.filter((f) => f.endsWith('.wav'))).toHaveLength(1)
    expect(fs.readFileSync(path.join(ARCHIVE_DIR, kept.find((f) => f.endsWith('.txt'))!), 'utf8')).toBe(text)
  }, 60_000)

  it('une tranche tronquée (une phrase pour 90 s) est signalée et retranscrite par le grand modèle', async () => {
    mockOpenAI((n, model) => (n === 3 && model === 'gpt-4o-mini-transcribe' ? 'Bon, alors.' : said(n)))
    const text = await transcribe(fakeSpeech(600), 'audio/wav', 'fr')
    expect(calls.filter((c) => c.name === 'voix-3.wav').map((c) => c.model)).toEqual(['gpt-4o-mini-transcribe', 'gpt-4o-transcribe'])
    expect(text).toContain('t3m100')
  }, 60_000)

  it('10 minutes qui ne donnent qu’une phrase : rien n’est envoyé, l’erreur le dit, l’audio est gardé', async () => {
    mockOpenAI(() => 'Bon, alors.')
    await expect(transcribe(fakeSpeech(600), 'audio/wav', 'fr')).rejects.toThrow(/transcription incomplète .*rien n’est envoyé.*voice-archive/)
    expect(fs.readdirSync(ARCHIVE_DIR).filter((f) => f.endsWith('.wav'))).toHaveLength(1)
  }, 60_000)

  it('envoyée en morceaux pendant plus de 10 minutes, la dictée garde tous ses morceaux (le début n’est plus effacé)', async () => {
    mockOpenAI((n) => said(n))
    const audio = fakeSpeech(600)
    const t0 = Date.now()
    const now = vi.spyOn(Date, 'now')
    const size = Math.ceil(audio.length / 40)
    // 40 morceaux, un toutes les 15 s : le dernier arrive 9 min 45 après le premier, puis une pause de 2 min.
    for (let i = 0; i < 40; i++) {
      now.mockReturnValue(t0 + i * 15_000 + (i === 39 ? 120_000 : 0))
      addChunk('dictee-longue', i, 'audio/wav', audio.subarray(i * size, (i + 1) * size).toString('base64'))
    }
    now.mockRestore()
    const text = await finishUpload('dictee-longue', 'fr')
    expect(text.split(' ').length).toBe(7 * 147)
    expect(fs.existsSync(path.join(ARCHIVE_DIR, 'partial', 'dictee-longue', 'receipt.json'))).toBe(true)
  }, 60_000)
})

describe.skipIf(!hasFfmpeg)('rejected recordings remain recoverable', () => {
  it.each(['legacy', 'chunks'] as const)('preserves the byte-exact original from %s without a provider call', async (entrypoint) => {
    mockOpenAI(() => 'must not be called')
    const audio = fakeSpeech(entrypoint === 'legacy' ? 0.4 : 2)
    if (entrypoint === 'chunks') audio.fill(0, 44)
    if (entrypoint === 'legacy') await expect(transcribe(audio, 'audio/wav', 'en')).rejects.toThrow()
    else {
      addChunk('quiet-upload', 0, 'audio/wav', audio.toString('base64'))
      await expect(finishUpload('quiet-upload', 'en', 1)).rejects.toThrow()
      expect(fs.readFileSync(path.join(ARCHIVE_DIR, 'partial', 'quiet-upload', '0000000'))).toEqual(audio)
    }
    expect(calls).toEqual([])
    const files = fs.readdirSync(ARCHIVE_DIR).filter(f => f.endsWith('.wav'))
    expect(files).toHaveLength(1)
    expect(fs.readFileSync(path.join(ARCHIVE_DIR, files[0]))).toEqual(audio)
    expect(fs.readdirSync(ARCHIVE_DIR).some(f => f.endsWith('.txt'))).toBe(false)
  })
})
