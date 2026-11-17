import { availableTool, preferredTool, providerStatus, providerUnavailable } from './provider.ts'
// Modèle rapide et voix, sans API payante : claude -p --model haiku sur l'abonnement, edge-tts pour la voix.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { lang, tr, type Lang } from './i18n.ts'
import { detectLang } from '../shared/detect-lang.ts'
import V from './i18n/voice.ts'
import { openaiKey } from './transcribe.ts'
import { DATA_DIR, TTS_RATE, TTS_VOICE } from './config.ts'
import { CostLedger, callerOf } from './cost-ledger.ts'
import { which } from './platform.ts'

/** Provider failures stay distinct from a malformed content payload. No prompt in error messages. */
export class ModelError extends Error {
  readonly kind: 'quota' | 'auth' | 'io' | 'provider'
  readonly detail: string
  constructor(error: unknown, stdout = '', stderr = '') {
    const e = error as { code?: unknown; message?: string }
    const detail = (stdout + '\n' + stderr).trim().slice(0, 4000)
    const kind = /rate.?limit|usage.?limit|quota|out of.*(?:usage|credits)|hit your.*limit/i.test(detail) ? 'quota'
      : /unauth|not logged|authentication|login required|sign in|\b401\b/i.test(detail) ? 'auth'
      : /ENOSPC|EDQUOT|disk quota|no space left|EACCES|ENOENT/i.test(detail + String(e?.code)) ? 'io' : 'provider'
    super(`model ${kind} failure${e?.code !== undefined ? ` (${e.code})` : ''}`)
    this.kind = kind
    this.detail = detail
  }
}
/** What weevilsd's own calls cost, per caller and per day, and the answers of identical requests (server/cost-ledger.ts). */
export const ledger = new CostLedger(path.join(DATA_DIR, 'cost-ledger.json'))
process.once('exit', () => ledger.flush())

/** A small internal generation never needs Opus or Fable: WEEVILS_SMART_MODEL set to one of them still writes short
 *  prompts with Sonnet. */
export const SMALL_PROMPT = 8000
export function smartModel(prompt: string, env = process.env.WEEVILS_SMART_MODEL): string {
  const m = env?.trim() || 'sonnet'
  return /opus|fable/i.test(m) && prompt.length < SMALL_PROMPT ? 'sonnet' : m
}

/**
 * claude -p always answers in JSON (--output-format json) so its usage is counted; the text returned stays what it
 * was: the result, or the structured output when a schema was given. Not JSON (an older CLI, a test double): as before.
 */
export function claudeAnswer(stdout: string, schema: object | undefined, caller: string, model: string): string {
  let o: any
  try { o = JSON.parse(stdout) } catch { o = null }
  if (!o || typeof o !== 'object' || o.type !== 'result') return modelText(stdout, schema)
  if (o.usage) ledger.record(caller, model, o.usage)
  if (o.is_error) throw new ModelError({}, String(o.result ?? ''))
  if (schema) return o.structured_output ? JSON.stringify(o.structured_output) : stdout.trim()
  return String(o.result ?? '').trim()
}

/** The same request within the cache window: the answer already given, no call. */
function cachedCall(model: string, prompt: string, schema: object | undefined, run: (caller: string) => Promise<string>): Promise<string> {
  const caller = callerOf()
  const key = CostLedger.key(model, prompt, schema)
  const hit = ledger.get(key)
  if (hit !== undefined) {
    ledger.hit(caller, model)
    return Promise.resolve(hit)
  }
  return run(caller).then((text) => {
    ledger.put(key, text)
    return text
  })
}

const modelText = (stdout: string, schema?: object): string => {
  if (!schema) return stdout.trim()
  const result = parseJson<{ structured_output?: unknown; is_error?: boolean; result?: string }>(stdout)
  if (result?.is_error) throw new ModelError({}, result.result ?? '')
  return result?.structured_output ? JSON.stringify(result.structured_output) : stdout.trim()
}

/**
 * The command to hand to execFile for claude or codex: its bare name while the PATH has it (as always), otherwise
 * where installers put it (server/platform.ts: the same lookup that says it is installed, so « installed » never ends
 * in « command not found » under a service's short PATH). Not installed: the bare name, and execFile reports it.
 */
export function toolCommand(name: string, pathEnv = process.env.PATH ?? '', find: (cmd: string) => string | null = which): string {
  const found = find(name)
  return !found || pathEnv.split(path.delimiter).includes(path.dirname(found)) ? name : found
}

/** True when Claude itself would run now (logged in, no limit episode, no relay to Codex). */
export function claudeAvailable(): boolean {
  try { return availableTool('claude') === 'claude' && providerStatus('claude').logged } catch { return false }
}

/**
 * Background writing that must never spend Codex (the automation proposals): Claude Haiku
 * on the subscription, only while Claude is available. Otherwise it fails at once and the caller keeps what it has.
 */
export function claudeHaiku(prompt: string, timeout = 120_000, schema?: object): Promise<string> {
  if (!claudeAvailable()) return Promise.reject(new Error(providerUnavailable('claude')))
  return runHaiku(prompt, timeout, schema)
}

/** Une réponse courte de haiku : sans outils, sans session gardée. ~1,6 s mesuré sur le VPS. */
export function haiku(prompt: string, timeout = 20_000, schema?: object): Promise<string> {
  if (availableTool() === 'codex') {
    const status = providerStatus('codex')
    if (!status.installed || !status.logged) return Promise.reject(new Error(providerUnavailable('codex')))
    return relay(prompt, timeout, schema)
  }
  return runHaiku(prompt, timeout, schema)
}
function runHaiku(prompt: string, timeout: number, schema?: object): Promise<string> {
  return cachedCall('haiku', prompt, schema, (caller) => {
    const t0 = Date.now()
    return new Promise((resolve, reject) => {
      const c = execFile(toolCommand('claude'), ['-p', '--model', 'haiku', '--tools', '', '--no-session-persistence', '--output-format', 'json', ...(schema ? ['--json-schema', JSON.stringify(schema)] : []), prompt], { timeout, maxBuffer: 1 << 20, cwd: os.tmpdir() }, (err, stdout, stderr) => {
        console.log(`[rapide] haiku ${Date.now() - t0} ms${err ? ' · échec' : ''}`)
        if (err) reject(new ModelError(err, String(stdout ?? ''), String(stderr ?? '')))
        else { try { resolve(claudeAnswer(String(stdout ?? ''), schema, caller, 'haiku')) } catch (e) { reject(e) } }
      })
      c.stdin?.end()
    })
  })
}

/**
 * A considered answer from Claude on the user's subscription (claude -p, no tools, no kept session): the weevils'
 * questions, what to remember from an answer, the h24 proposals. Model: WEEVILS_SMART_MODEL (sonnet by default).
 * Never the OpenAI key: what is said about the user only goes to the model the user already runs.
 */
export function smart(prompt: string, timeout = 90_000, schema?: object): Promise<string> {
  if (availableTool() === 'codex') {
    const status = providerStatus('codex')
    if (!status.installed || !status.logged) return Promise.reject(new Error(providerUnavailable('codex')))
    return relay(prompt, timeout, schema)
  }
  const model = smartModel(prompt)
  return cachedCall(model, prompt, schema, (caller) => {
    const t0 = Date.now()
    return new Promise((resolve, reject) => {
      const c = execFile(toolCommand('claude'), ['-p', '--model', model, '--tools', '', '--no-session-persistence', '--output-format', 'json', ...(schema ? ['--json-schema', JSON.stringify(schema)] : []), prompt], { timeout, maxBuffer: 4 << 20, cwd: os.tmpdir() }, (err, stdout, stderr) => {
        console.log(`[rapide] ${model} ${Date.now() - t0} ms${err ? ' · échec' : ''}`)
        if (err) reject(new ModelError(err, String(stdout ?? ''), String(stderr ?? '')))
        else { try { resolve(claudeAnswer(String(stdout ?? ''), schema, caller, model)) } catch (e) { reject(e) } }
      })
      c.stdin?.end()
    })
  })
}

/**
 * The same kind of answer from Codex (codex exec, ephemeral, read-only, low effort), on the user's other subscription:
 * what the « for you » stream writes while Claude's usage is nearly full.
 */
export function relay(prompt: string, timeout = 120_000, schema?: object): Promise<string> {
  if (availableTool('codex') === 'claude') return smart(prompt, timeout, schema)
  const t0 = Date.now()
  // A private disk-backed scratch directory avoids per-user /tmp quotas and exposes no result in shared /tmp.
  const base = path.join(os.homedir(), '.cache', 'weevils')
  fs.mkdirSync(base, { recursive: true, mode: 0o700 })
  const dir = fs.mkdtempSync(path.join(base, 'relay-'))
  const out = path.join(dir, 'answer.txt')
  return new Promise((resolve, reject) => {
    const schemaFile = out + '.schema.json'
    if (schema) fs.writeFileSync(schemaFile, JSON.stringify(schema), { mode: 0o600 })
    const c = execFile(toolCommand('codex'), ['exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '-o', out, '-c', 'model_reasoning_effort="low"', ...(schema ? ['--output-schema', schemaFile] : []), prompt], { timeout, maxBuffer: 4 << 20, cwd: dir, env: { ...process.env, TMPDIR: dir } }, (err, stdout, stderr) => {
      let text = ''
      try {
        text = fs.readFileSync(out, 'utf8').trim()
      } catch {
        /* nothing written */
      }
      fs.rmSync(out, { force: true })
      fs.rmSync(schemaFile, { force: true })
      fs.rmSync(dir, { recursive: true, force: true })
      console.log(`[rapide] codex ${Date.now() - t0} ms${err || !text ? ' · échec' : ''}`)
      if (err || !text) reject(new ModelError(err, text || String(stdout ?? ''), String(stderr ?? '')))
      else resolve(text)
    })
    c.stdin?.end()
  })
}

/** The first JSON object or array in a model's answer (it sometimes wraps it in a code fence or a sentence). */
export function parseJson<T>(text: string): T | null {
  // Scan balanced candidates, respecting quoted brackets. A preamble or a second JSON block must not
  // make a complete first payload unparsable. Never invent missing values or close truncated JSON.
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '{' && text[start] !== '[') continue
    const stack: string[] = []
    let quoted = false, escaped = false
    for (let end = start; end < text.length; end++) {
      const c = text[end]
      if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue }
      if (c === '"') { quoted = true; continue }
      if (c === '{' || c === '[') stack.push(c)
      else if (c === '}' || c === ']') {
        if (stack.pop() !== (c === '}' ? '{' : '[')) break
        if (!stack.length) {
          const candidate = text.slice(start, end + 1)
          try { return JSON.parse(candidate) as T } catch { /* try a conservative trailing-comma repair */ }
          const repaired = candidate.replace(/"(?:\\.|[^"\\])*"|(,)\s*(?=[}\]])/g, (match, comma) => comma ? '' : match)
          try { return JSON.parse(repaired) as T } catch { start = end; break }
        }
      }
    }
    if (stack.length) return null
  }
  return null
}

/**
 * Réponse courte au plus vite : gpt-4.1 (~1 s, juste là où gpt-4o-mini invente) quand la clé OpenAI est là, sinon haiku (~3 s, abonnement).
 * Pour les questions posées depuis l'app, où l'on attend la réponse des yeux.
 */
export async function quick(prompt: string, maxTokens = 260): Promise<string> {
  if (preferredTool() === 'codex' || availableTool() === 'codex') return haiku(prompt, 120_000)
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

/** edge-tts : celui du PATH, sinon là où les installateurs le posent (~/.local/bin pour pipx, Homebrew sur un Mac :
 * server/platform.ts). null : pas installé. */
export function edgeTts(): string | null {
  return which('edge-tts')
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
