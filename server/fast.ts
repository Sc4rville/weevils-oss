// Modèle rapide et voix, sans API payante : claude -p --model haiku sur l'abonnement, edge-tts pour la voix.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { lang, tr, type Lang } from './i18n.ts'
import { detectLang } from '../shared/detect-lang.ts'
import V from './i18n/voice.ts'
import { openaiKey } from './transcribe.ts'
import { TTS_RATE, TTS_VOICE } from './config.ts'

/** Une réponse courte de haiku : sans outils, sans session gardée. ~1,6 s mesuré sur le VPS. */
export function haiku(prompt: string, timeout = 20_000): Promise<string> {
  const t0 = Date.now()
  return new Promise((resolve, reject) => {
    const c = execFile('claude', ['-p', '--model', 'haiku', '--tools', '', '--no-session-persistence', prompt], { timeout, maxBuffer: 1 << 20, cwd: os.tmpdir() }, (err, stdout) => {
      console.log(`[rapide] haiku ${Date.now() - t0} ms${err ? ' · échec' : ''}`)
      if (err) reject(err)
      else resolve(stdout.toString().trim())
    })
    c.stdin?.end()
  })
}

/**
 * Réponse courte au plus vite : gpt-4.1 (~1 s, juste là où gpt-4o-mini invente) quand la clé OpenAI est là, sinon haiku (~3 s, abonnement).
 * Pour les questions posées depuis l'app, où l'on attend la réponse des yeux.
 */
export async function quick(prompt: string, maxTokens = 260): Promise<string> {
  const key = openaiKey()
  if (key) {
    const t0 = Date.now()
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: process.env.WEEVILS_QUICK_MODEL ?? 'gpt-4.1', max_tokens: maxTokens, temperature: 0.3, messages: [{ role: 'user', content: prompt }] }),
        signal: AbortSignal.timeout(6000),
      })
      const j = (await res.json()) as { choices?: { message?: { content?: string } }[] }
      const out = (j.choices?.[0]?.message?.content ?? '').trim()
      console.log(`[rapide] réponse ${Date.now() - t0} ms`)
      if (out) return out
    } catch {
      /* repli haiku */
    }
  }
  return haiku(prompt)
}

/** edge-tts : celui du PATH, sinon ~/.local/bin/edge-tts (pipx install edge-tts). null : pas installé. */
function edgeTts(): string | null {
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean), path.join(os.homedir(), '.local', 'bin')]
  for (const dir of dirs) {
    const bin = path.join(dir, 'edge-tts')
    try {
      fs.accessSync(bin, fs.constants.X_OK)
      return bin
    } catch {
      /* pas ici */
    }
  }
  return null
}

/** Voix gratuite dans la langue de l'app (voix neuronales Microsoft via edge-tts), débit TTS_RATE (+25 % par défaut). MP3. */
export function tts(text: string, l: Lang = detectLang(text) ?? lang(), voice = TTS_VOICE[l]): Promise<Buffer> {
  const out = path.join(os.tmpdir(), `wv-tts-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`)
  const bin = edgeTts()
  if (!bin) return Promise.reject(new Error(tr(V).noEdgeTts))
  const t0 = Date.now()
  return new Promise((resolve, reject) => {
    execFile(bin, ['--voice', voice, `--rate=${TTS_RATE}`, '--text', text, '--write-media', out], { timeout: 20_000 }, (err) => {
      console.log(`[rapide] voix ${Date.now() - t0} ms${err ? ' · échec' : ''}`)
      if (err) return reject(err)
      try {
        resolve(fs.readFileSync(out))
      } finally {
        fs.rmSync(out, { force: true })
      }
    })
  })
}

// ---------------------------------------------------------------- Cartesia (Sonic, streaming)

/** Clé et réglages lus dans l'environnement du service (EnvironmentFile ~/.config/weevils/env). */
export const cartesia = () => (process.env.CARTESIA_API_KEY ? { key: process.env.CARTESIA_API_KEY, model: process.env.CARTESIA_MODEL ?? 'sonic-latest', voice: process.env.CARTESIA_VOICE_ID } : null)

/** Voix par défaut de chaque langue (la première de l'API), gardée en mémoire. */
const langVoice: Partial<Record<string, string>> = {}
async function defaultVoice(key: string, l: Lang = lang()): Promise<string> {
  if (langVoice[l]) return langVoice[l]
  const res = await fetch(`https://api.cartesia.ai/voices?language=${l}&limit=20`, { headers: { 'X-API-Key': key, 'Cartesia-Version': '2025-04-16' } })
  const j = (await res.json()) as { data?: { id: string; language?: string }[] } | { id: string; language?: string }[]
  const list = Array.isArray(j) ? j : (j.data ?? [])
  const id = list.find((v) => v.language === l)?.id ?? list[0]?.id
  if (!id) throw new Error(tr(V).noCartesiaVoice)
  return (langVoice[l] = id)
}

/** Voix choisie dans l'app (persistée par le daemon). */
let chosenVoice: string | undefined
export const setCartesiaVoice = (id: string | undefined) => (chosenVoice = id)

export interface VoiceChoice {
  id: string
  name: string
  gender?: string
}

/** 6 à 8 voix variées dans la langue de l'app : on alterne femmes et hommes, dans l'ordre de l'API. */
export async function cartesiaVoices(): Promise<VoiceChoice[]> {
  const c = cartesia()
  if (!c) throw new Error(tr(V).noCartesiaKey)
  const l = lang()
  const res = await fetch(`https://api.cartesia.ai/voices?language=${l}&limit=100`, { headers: { 'X-API-Key': c.key, 'Cartesia-Version': '2025-04-16' } })
  if (!res.ok) throw new Error(`cartesia : ${res.status}`)
  const j = (await res.json()) as any
  const all = ((Array.isArray(j) ? j : (j.data ?? [])) as any[]).filter((v) => !v.language || v.language === l)
  const pick = (g: string) => all.filter((v) => (v.gender ?? '').toLowerCase().startsWith(g))
  const f = pick('f'), m = pick('m'), other = all.filter((v) => !f.includes(v) && !m.includes(v))
  const out: any[] = []
  for (let i = 0; out.length < 8 && (i < f.length || i < m.length || i < other.length); i++) for (const list of [f, m, other]) if (list[i] && out.length < 8) out.push(list[i])
  return out.map((v) => ({ id: v.id, name: String(v.name ?? v.id).split(/[-–(]/)[0].trim(), gender: v.gender }))
}

/**
 * Flux MP3 de Cartesia : les premiers octets arrivent en quelques centaines de ms, on les relaie tels quels.
 * Langue : celle donnée (le message entier), sinon celle du texte, sinon la langue réglée ; jamais un réglage global seul.
 */
export async function cartesiaStream(text: string, voiceId?: string, language?: Lang): Promise<ReadableStream<Uint8Array>> {
  const l = language ?? detectLang(text) ?? lang()
  const c = cartesia()
  if (!c) throw new Error(tr(V).noCartesiaKey)
  const t0 = Date.now()
  const res = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: { 'X-API-Key': c.key, 'Cartesia-Version': '2025-04-16', 'content-type': 'application/json' },
    body: JSON.stringify({
      model_id: c.model,
      transcript: text,
      voice: { mode: 'id', id: voiceId ?? chosenVoice ?? c.voice ?? (await defaultVoice(c.key, l)) },
      language: l,
      output_format: { container: 'mp3', sample_rate: 44100, bit_rate: 128000 },
    }),
  })
  if (!res.ok || !res.body) throw new Error(`cartesia : ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`)
  console.log(`[rapide] cartesia premiers octets ${Date.now() - t0} ms`)
  return res.body
}
