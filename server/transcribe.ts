// Dictée depuis le téléphone : l'audio enregistré dans l'app est transcrit par OpenAI.
// Pas de « prompt » de transcription : il est recraché mot pour mot à la place de la voix (prouvé le 2026-08-02).
// Un clip presque vide fait halluciner le modèle dans une langue au hasard (« Pralność », « al », 2026-11-09) :
// la langue est imposée (celle de l'app) et un clip trop court ou sans parole n'est jamais envoyé.
//
// Jamais perdre ce qu'on a dit (10 min de parole réduites à une phrase, 2026-11-10) :
// - l'audio brut est gardé sur disque (DATA_DIR/voice-archive, 7 jours), avec le texte obtenu à côté ;
// - un long enregistrement est découpé en tranches de 90 s qui se chevauchent de 2 s, transcrites à part puis
//   recollées : gpt-4o-mini-transcribe plafonne sa sortie (~2 000 tokens) et coupe ou résume un long audio ;
// - le texte doit coller à la durée de parole (au moins 0,6 mot par seconde de voix) : sinon la tranche est
//   retranscrite avec le grand modèle, et si ça ne colle toujours pas, rien n'est envoyé (erreur, audio gardé).
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DATA_DIR } from './config.ts' // charge aussi ~/.config/weevils/env dans process.env
import { lang, tr, withLang, type Lang } from './i18n.ts'
import { isLang } from '../shared/i18n.ts'
import { which } from './platform.ts'
import V from './i18n/voice.ts'

/** Clé OpenAI : l'environnement, où config.ts a déjà chargé ~/.config/weevils/env. Jamais dans le code ni dans les logs. */
export function openaiKey(): string | undefined {
  return process.env.OPENAI_API_KEY?.trim() || undefined
}

const EXT: Record<string, string> = { 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac' }

/** Seuils d'un clip qui vaut d'être transcrit : assez long, et un peu de parole dedans. */
export const MIN_CLIP_S = 0.6
export const MIN_VOICED_S = 0.2
/** Niveau d'une tranche de 20 ms considérée comme de la voix (−45 dBFS : au-dessus du souffle d'une pièce calme). */
const VOICE_RMS = 10 ** (-45 / 20)

/** Durée et temps « parlé » d'un PCM 16 bits mono : tranches de 20 ms dont le niveau RMS dépasse le seuil de voix. */
export function speechStats(pcm: Int16Array, rate: number): { seconds: number; voiced: number } {
  const frame = Math.max(1, Math.round(rate * 0.02))
  let voicedFrames = 0
  for (let i = 0; i + frame <= pcm.length; i += frame) {
    let sum = 0
    for (let j = i; j < i + frame; j++) sum += (pcm[j] / 32768) ** 2
    if (Math.sqrt(sum / frame) >= VOICE_RMS) voicedFrames++
  }
  return { seconds: pcm.length / rate, voiced: (voicedFrames * frame) / rate }
}

export const worthTranscribing = (s: { seconds: number; voiced: number }) => s.seconds >= MIN_CLIP_S && s.voiced >= MIN_VOICED_S

/** L'audio brut de chaque dictée, gardé 7 jours (avec le texte obtenu, même fichier en .txt). */
export const ARCHIVE_DIR = path.join(DATA_DIR, 'voice-archive')
const KEEP_MS = 7 * 24 * 3600_000

/** Garde l'audio sur disque avant toute transcription ; purge ce qui a plus de 7 jours. Renvoie le chemin. */
export function archive(data: Buffer, ext: string): string {
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true })
  const now = Date.now()
  // Pending uploads and durable receipts have no automatic expiry: recovery owns their lifecycle.
  const entries = fs.readdirSync(ARCHIVE_DIR).filter((f) => f !== 'partial').map((f) => path.join(ARCHIVE_DIR, f))
  for (const p of entries) {
    try {
      if (now - fs.statSync(p).mtimeMs > KEEP_MS) fs.rmSync(p, { recursive: true, force: true })
    } catch {
      /* déjà parti */
    }
  }
  const file = path.join(ARCHIVE_DIR, `${new Date(now).toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 6)}.${ext}`)
  fs.writeFileSync(file, data)
  return file
}

/** Tranches d'un long enregistrement : 90 s, 2 s de chevauchement (un mot coupé à la frontière est entier d'un côté). */
export const CHUNK_S = 90
export const OVERLAP_S = 2
/** Au-delà, l'enregistrement est découpé. */
export const LONG_S = 120
/** Au moins tant de mots par seconde de voix (on parle à 2-3 mots/s ; les silences ne comptent pas). */
export const MIN_WORDS_PER_S = 0.6
/** En dessous de tant de secondes de voix, pas de contrôle (« oui », un nom). */
const CHECK_FROM_S = 15

export function windows(seconds: number): { from: number; to: number }[] {
  if (seconds <= LONG_S) return [{ from: 0, to: seconds }]
  const out: { from: number; to: number }[] = []
  for (let from = 0; from < seconds; from += CHUNK_S - OVERLAP_S) {
    const to = Math.min(seconds, from + CHUNK_S)
    out.push({ from, to })
    if (to >= seconds) break
  }
  // Une dernière tranche minuscule est rattachée à la précédente.
  const last = out.at(-1)!
  if (out.length > 1 && last.to - last.from < 15) {
    out.pop()
    out.at(-1)!.to = seconds
  }
  return out
}

const words = (s: string) => s.split(/\s+/).filter((w) => /\p{L}|\p{N}/u.test(w))
const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

/** Recolle deux tranches qui se chevauchent : les mots répétés au raccord ne sont gardés qu'une fois. */
export function stitch(a: string, b: string): string {
  if (!a) return b
  if (!b) return a
  const wa = a.split(/\s+/)
  const wb = b.split(/\s+/)
  for (let k = Math.min(15, wa.length, wb.length); k > 0; k--) {
    const tail = wa.slice(-k).map(norm).join(' ')
    if (tail && tail === wb.slice(0, k).map(norm).join(' ')) return `${a} ${wb.slice(k).join(' ')}`.trim()
  }
  return `${a} ${b}`
}

/** Le texte colle-t-il à la parole entendue ? (10 min de voix → une phrase : non) */
export const plausible = (text: string, voiced: number) => voiced < CHECK_FROM_S || words(text).length >= MIN_WORDS_PER_S * voiced

/** WAV 16 bits mono : une tranche du PCM décodé, envoyée telle quelle (sans perte, sans ffmpeg). */
function wav(pcm: Int16Array, rate: number): Buffer {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + pcm.length * 2, 4)
  h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(pcm.length * 2, 40)
  return Buffer.concat([h, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.length * 2)])
}

const RATE = 16000

/** Décode le clip en PCM 16 kHz mono avec ffmpeg (fichier temporaire : un mp4 d'iPhone ne se lit pas depuis un tube).
 * ffmpeg : celui du PATH, sinon là où les installateurs le posent (Homebrew sur un Mac, server/platform.ts).
 * Sans ffmpeg ou illisible : null, on ne bloque rien. */
async function decode(data: Buffer, ext: string): Promise<Int16Array | null> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wv-voix-'))
  const file = path.join(dir, `clip.${ext}`)
  try {
    await fs.promises.writeFile(file, data)
    const pcm = await new Promise<Buffer>((resolve, reject) =>
      execFile(which('ffmpeg') ?? 'ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-'], { encoding: 'buffer', maxBuffer: 1 << 30, timeout: 180_000 }, (err, out) => (err ? reject(err) : resolve(out))), // i18n-ignore : arguments de ffmpeg, pas du texte affiché
    )
    return new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2))
  } catch {
    return null
  } finally {
    void fs.promises.rm(dir, { recursive: true, force: true })
  }
}

/** Une requête de transcription. */
async function request(data: Buffer, type: string, name: string, language: Lang, model: string): Promise<string> {
  const key = openaiKey()
  if (!key) throw new Error(tr(V).transcriptionOff)
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(data)], { type }), name)
  form.append('model', model)
  // La langue de l'app, imposée : sans elle, un bout de silence ressort en polonais ou en n'importe quoi.
  form.append('language', language)
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } }
    throw new Error(err.error?.message ?? tr(V).transcriptionError(res.status))
  }
  return (((await res.json()) as { text?: string }).text ?? '').trim()
}

const MODEL = 'gpt-4o-mini-transcribe'
/** Le grand modèle, pour retranscrire une tranche dont le texte ne colle pas à la parole. */
const RETRY_MODEL = 'gpt-4o-transcribe'

/** `l` : la langue de l'app (envoyée par le téléphone), sinon celle du serveur. */
export async function transcribe(data: Buffer, mime: string, l: unknown = lang()): Promise<string> {
  const language: Lang = isLang(l) ? l : lang()
  const nothing = () => new Error(withLang(language, () => tr(V).nothingHeard))
  const type = mime.split(';')[0].trim() || 'audio/mp4'
  const ext = EXT[type] ?? 'm4a'
  // Sur disque avant tout, même sans clé ou si la transcription échoue.
  const file = archive(data, ext)
  if (!openaiKey()) throw new Error(tr(V).transcriptionOff)
  const pcm = await decode(data, ext)
  const stats = pcm ? speechStats(pcm, RATE) : null
  if (stats && !worthTranscribing(stats)) {
    console.log(`[voix] clip écarté : ${stats.seconds.toFixed(2)} s, ${stats.voiced.toFixed(2)} s de voix (${Math.round(data.length / 1024)} Ko)`)
    // A speech detector rejection is not permission to discard the original recording.
    throw nothing()
  }
  const incomplete = (voiced: number, text: string) => new Error(withLang(language, () => tr(V).incomplete(Math.max(1, Math.round(voiced / 60)), words(text).length, file)))
  /** Une tranche : transcrite, contrôlée, retranscrite par le grand modèle si le texte ne colle pas à la parole. */
  const one = async (audio: Buffer, audioType: string, name: string, voiced: number) => {
    let text = await request(audio, audioType, name, language, MODEL)
    if (!plausible(text, voiced)) {
      console.log(`[voix] anomalie : ${name}, ${voiced.toFixed(0)} s de voix → ${words(text).length} mots ; retranscription (${RETRY_MODEL})`)
      text = await request(audio, audioType, name, language, RETRY_MODEL)
      if (!plausible(text, voiced)) {
        console.log(`[voix] anomalie confirmée : ${name}, ${words(text).length} mots ; rien n'est envoyé, audio gardé : ${file}`)
        throw incomplete(voiced, text)
      }
    }
    return text
  }
  let text: string
  if (!pcm || !stats || stats.seconds <= LONG_S) {
    // Court (ou illisible par ffmpeg) : le fichier d'origine, en une requête.
    text = await one(data, type, `voix.${ext}`, stats?.voiced ?? 0)
  } else {
    const parts = windows(stats.seconds)
    const texts: string[] = new Array(parts.length).fill('')
    let next = 0
    const worker = async () => {
      for (let i = next++; i < parts.length; i = next++) {
        const slice = pcm.subarray(Math.floor(parts[i].from * RATE), Math.floor(parts[i].to * RATE))
        const s = speechStats(slice, RATE)
        if (!worthTranscribing(s)) continue
        texts[i] = await one(wav(slice, RATE), 'audio/wav', `voix-${i + 1}.wav`, s.voiced)
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, parts.length) }, worker))
    text = texts.reduce(stitch, '').trim()
    console.log(`[voix] long enregistrement : ${Math.round(stats.seconds)} s en ${parts.length} tranches → ${words(text).length} mots`)
    if (!plausible(text, stats.voiced)) throw incomplete(stats.voiced, text)
  }
  // Rien qu'un signe ou une lettre : pas une phrase.
  if (!/\p{L}{2}/u.test(text)) throw nothing()
  fs.writeFileSync(file.replace(/\.\w+$/, '.txt'), text)
  return text
}
