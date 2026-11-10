// Dictée depuis le téléphone : l'audio enregistré dans l'app est transcrit par OpenAI.
// Pas de « prompt » de transcription : il est recraché mot pour mot à la place de la voix (prouvé le 2026-08-02).
// Un clip presque vide fait halluciner le modèle dans une langue au hasard (« Pralność », « al », 2026-11-09) :
// la langue est imposée (celle de l'app) et un clip trop court ou sans parole n'est jamais envoyé.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import './config.ts' // charge ~/.config/weevils/env dans process.env
import { lang, tr, withLang, type Lang } from './i18n.ts'
import { isLang } from '../shared/i18n.ts'
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

/** Décode le clip avec ffmpeg (fichier temporaire : un mp4 d'iPhone ne se lit pas depuis un tube). Sans ffmpeg : null, on ne bloque rien. */
async function measure(data: Buffer, ext: string): Promise<{ seconds: number; voiced: number } | null> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wv-voix-'))
  const file = path.join(dir, `clip.${ext}`)
  try {
    await fs.promises.writeFile(file, data)
    const pcm = await new Promise<Buffer>((resolve, reject) =>
      execFile('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], { encoding: 'buffer', maxBuffer: 64 << 20, timeout: 10_000 }, (err, out) => (err ? reject(err) : resolve(out))), // i18n-ignore : arguments de ffmpeg, pas du texte affiché
    )
    return speechStats(new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2)), 16000)
  } catch {
    return null
  } finally {
    void fs.promises.rm(dir, { recursive: true, force: true })
  }
}

/** `l` : la langue de l'app (envoyée par le téléphone), sinon celle du serveur. */
export async function transcribe(data: Buffer, mime: string, l: unknown = lang()): Promise<string> {
  const language: Lang = isLang(l) ? l : lang()
  const nothing = () => new Error(withLang(language, () => tr(V).nothingHeard))
  const key = openaiKey()
  if (!key) throw new Error(tr(V).transcriptionOff)
  const type = mime.split(';')[0].trim() || 'audio/mp4'
  const ext = EXT[type] ?? 'm4a'
  const stats = await measure(data, ext)
  if (stats && !worthTranscribing(stats)) {
    console.log(`[voix] clip écarté : ${stats.seconds.toFixed(2)} s, ${stats.voiced.toFixed(2)} s de voix (${Math.round(data.length / 1024)} Ko)`)
    throw nothing()
  }
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(data)], { type }), `voix.${ext}`)
  form.append('model', 'gpt-4o-mini-transcribe')
  // La langue de l'app, imposée : sans elle, un bout de silence ressort en polonais ou en n'importe quoi.
  form.append('language', language)
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } }
    throw new Error(err.error?.message ?? tr(V).transcriptionError(res.status))
  }
  const out = (await res.json()) as { text?: string }
  const text = (out.text ?? '').trim()
  // Rien qu'un signe ou une lettre : pas une phrase.
  if (!/\p{L}{2}/u.test(text)) throw nothing()
  return text
}

