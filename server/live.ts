// Live voice mode: a natural spoken conversation with weevboss, through Gemini Live (speech to speech, its own turn
// detection and barge-in). Gemini is only the voice: anything concrete goes to weevboss, the same path as a typed
// message, and Gemini says the gist of weevboss's written answer.
//
//   phone ──(PCM 16 kHz, ws /api/live)──▶ weevilsd ──(wss, key in a header)──▶ Gemini Live
//   phone ◀──(PCM 24 kHz)────────────── weevilsd ◀──────────────────────────── Gemini Live
//                                          └─ ask_weevboss(request) ─▶ sendMain ─▶ weevboss's reply ─▶ said back
//
// The key never reaches the browser: the phone talks to weevilsd only. The cost is measured from Gemini's own usage
// counts and shown on the phone; after two minutes without a word either way, the session closes itself.

import type http from 'node:http'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer } from 'ws'
import type { Lang } from './i18n.ts'
import L from './i18n/live.ts'

const log = (s: string) => console.log(`[live] ${s}`)

export const UPSTREAM = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'
/** The cheapest current Live model with native audio (2026-11: gemini-3.8-live, same audio price as the older ones). */
export const liveModel = () => process.env.GEMINI_LIVE_MODEL?.trim() || 'gemini-3.8-live'
export const liveVoice = () => process.env.GEMINI_LIVE_VOICE?.trim() || 'Aoede'
export const geminiKey = () => process.env.GEMINI_API_KEY?.trim() || ''

/** USD per million tokens, gemini-3.8-live paid tier (ai.google.dev pricing, 2026-11). */
const PRICE = { in: { AUDIO: 3, TEXT: 0.75, IMAGE: 1, VIDEO: 1 } as Record<string, number>, out: { AUDIO: 12, TEXT: 4.5 } as Record<string, number> }
/** Fallback estimate when Gemini sends no usage: the per-minute rates of the same table. */
const PER_MIN = { in: 0.005, out: 0.018 }

export const SILENCE_MS = 120_000
/** A ceiling, so a forgotten phone never runs up a bill. */
export const MAX_MS = 30 * 60_000
/** How long a request to weevboss keeps the session open, waiting for its answer. */
const ANSWER_WAIT_MS = 8 * 60_000

export interface LiveDeps {
  key(): string
  sendMain(text: string): Promise<unknown>
  waitMainReply(since: number, timeoutMs: number): Promise<string | null>
  /** The last lines of weevboss's thread, for context. */
  recent(): { role: string; text: string }[]
  user(): string
  /** Tests point this at a fake Gemini. */
  upstream?: string
  silenceMs?: number
  /** False on a machine without weevboss. */
  enabled?(): boolean
}

type Usage = { promptTokensDetails?: { modality?: string; tokenCount?: number }[]; responseTokensDetails?: { modality?: string; tokenCount?: number }[]; promptTokenCount?: number; responseTokenCount?: number }

/** The cost of one usage report, in USD. Tokens without modality detail count as audio (the dearest). */
export function costOf(u: Usage): number {
  const side = (details: Usage['promptTokensDetails'], total: number | undefined, price: Record<string, number>) => {
    let usd = 0
    let counted = 0
    for (const d of details ?? []) {
      const n = d.tokenCount ?? 0
      counted += n
      usd += (n * (price[d.modality ?? 'AUDIO'] ?? price.AUDIO)) / 1e6
    }
    return usd + (Math.max(0, (total ?? 0) - counted) * price.AUDIO) / 1e6
  }
  return side(u.promptTokensDetails, u.promptTokenCount, PRICE.in) + side(u.responseTokensDetails, u.responseTokenCount, PRICE.out)
}

/** What went wrong upstream, in one word the app can say plainly. Never the raw message (it can echo request data). */
export function classify(code: number, reason: string): 'billing' | 'quota' | 'auth' | 'model' | 'upstream' {
  if (/prepay|credit|billing|payment/i.test(reason)) return 'billing'
  if (/quota|exhausted|rate limit|too many/i.test(reason) || code === 1013) return 'quota'
  if (/api key|permission|unauthenti|forbidden/i.test(reason) || code === 1008) return 'auth'
  if (/model|not found|not supported|invalid argument/i.test(reason) || code === 1007) return 'model'
  return 'upstream'
}

const tools = [
  {
    functionDeclarations: [
      {
        name: 'ask_weevboss',
        description: 'Hand a concrete request (code, a change, a session, a project, a status, a question about the user’s work) to weevboss, the agent that does the real work. Its answer comes back later as a message starting with [weevboss].', // i18n-ignore : model-facing tool declaration
        parameters: { type: 'OBJECT', properties: { request: { type: 'STRING', description: 'The user’s request, complete and in their own words.' } }, required: ['request'] }, // i18n-ignore
      },
      { name: 'end_live', description: 'End the live conversation, when the user says goodbye or asks to stop.', parameters: { type: 'OBJECT', properties: {} } }, // i18n-ignore
    ],
  },
]

/** One phone, one live conversation. */
export class LiveSession {
  private up: WebSocket | null = null
  private ready = false
  /** The phone heard « ready » once: a renewed Gemini connection must not open its microphone a second time. */
  private greeted = false
  private handle = ''
  private resuming = false
  private closed = false
  private readonly started = Date.now()
  private lastSpeech = Date.now()
  private lastModel = 0
  private modelBusy = false
  private pending = 0
  private answers: string[] = []
  private answerQueuedAt = 0
  private ending = false
  private usd = 0
  private turnUsage: Usage | null = null
  private sawUsage = false
  private inMs = 0
  private outBytes = 0
  private timer: ReturnType<typeof setInterval>
  private readonly m: (typeof L)[Lang]

  private readonly client: WebSocket
  private readonly deps: LiveDeps

  constructor(client: WebSocket, deps: LiveDeps, lang: Lang) {
    this.client = client
    this.deps = deps
    this.m = L[lang]
    this.timer = setInterval(() => this.tick(), 500)
    this.timer.unref?.()
    client.on('message', (data, binary) => this.fromPhone(data as Buffer, binary))
    client.on('close', () => this.finish('phone'))
    client.on('error', () => this.finish('phone'))
    if (deps.enabled && !deps.enabled()) this.fail('nohere')
    else if (!deps.key()) {
      this.send({ t: 'nokey' })
      this.finish('nokey')
    } else this.connect()
  }

  private send(m: Record<string, unknown>) {
    if (this.client.readyState === WebSocket.OPEN) this.client.send(JSON.stringify(m))
  }

  private toGemini(m: unknown) {
    if (this.up?.readyState === WebSocket.OPEN && this.ready) this.up.send(JSON.stringify(m))
  }

  private connect() {
    const up = new WebSocket(this.deps.upstream ?? UPSTREAM, { headers: { 'x-goog-api-key': this.deps.key() } })
    this.up = up
    this.ready = false
    // A renewed connection starts with no turn of Gemini's in progress (the old one died with its socket).
    this.modelBusy = false
    up.on('open', () => {
      const recent = this.deps
        .recent()
        .slice(-6)
        .map((m) => `${m.role === 'user' ? this.deps.user() : 'weevboss'}: ${m.text.replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').slice(0, 300)}`)
        .join(' | ')
        .slice(0, 1500)
      up.send(
        JSON.stringify({
          setup: {
            model: `models/${liveModel()}`,
            generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: liveVoice() } } } },
            systemInstruction: { parts: [{ text: this.m.system(this.deps.user(), recent) }] },
            tools,
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            // Each turn re-reads the context: a short sliding window keeps a long talk at the same price per minute.
            contextWindowCompression: { triggerTokens: 12000, slidingWindow: { targetTokens: 6000 } },
            sessionResumption: this.handle ? { handle: this.handle } : {},
          },
        }),
      )
    })
    up.on('message', (data) => this.fromGemini(data as Buffer))
    up.on('close', (code, reason) => {
      if (this.up !== up) return
      this.up = null
      if (this.closed) return
      if (this.resuming && this.handle) {
        this.resuming = false
        log('connexion renouvelée (session reprise)')
        return this.connect()
      }
      const why = reason.toString()
      const kind = classify(code, why)
      log(`Gemini a fermé (${code}, ${kind}) : ${why.slice(0, 160)}`)
      this.fail(kind)
    })
    up.on('error', (e) => log(`Gemini : ${(e as Error).message.slice(0, 160)}`))
  }

  private fail(code: string) {
    this.send({ t: 'error', code })
    this.finish(code)
  }

  private fromPhone(data: Buffer, binary: boolean) {
    if (binary) {
      // PCM 16-bit, 16 kHz, mono: 32 bytes a millisecond.
      this.inMs += data.length / 32
      return this.toGemini({ realtimeInput: { audio: { data: data.toString('base64'), mimeType: 'audio/pcm;rate=16000' } } })
    }
    let m: { t?: string }
    try {
      m = JSON.parse(data.toString())
    } catch {
      return
    }
    if (m.t === 'pause') this.toGemini({ realtimeInput: { audioStreamEnd: true } })
    else if (m.t === 'bye') this.finish('bye')
  }

  private fromGemini(data: Buffer) {
    let m: Record<string, any>
    try {
      m = JSON.parse(data.toString())
    } catch {
      return
    }
    if (m.setupComplete) {
      this.ready = true
      if (this.greeted) return
      this.greeted = true
      return this.send({ t: 'ready', model: liveModel() })
    }
    if (m.usageMetadata) {
      this.sawUsage = true
      this.turnUsage = m.usageMetadata
    }
    if (m.sessionResumptionUpdate?.resumable && m.sessionResumptionUpdate.newHandle) this.handle = m.sessionResumptionUpdate.newHandle
    if (m.goAway) this.resuming = true
    if (m.voiceActivity?.type === 'ACTIVITY_START') this.lastSpeech = Date.now()
    const sc = m.serverContent
    if (sc) {
      for (const p of sc.modelTurn?.parts ?? []) {
        if (!p.inlineData?.data) continue
        const pcm = Buffer.from(p.inlineData.data, 'base64')
        this.outBytes += pcm.length
        this.modelBusy = true
        this.lastModel = Date.now()
        if (this.client.readyState === WebSocket.OPEN) this.client.send(pcm, { binary: true })
      }
      if (sc.inputTranscription?.text) {
        this.lastSpeech = Date.now()
        this.send({ t: 'heard', text: sc.inputTranscription.text })
      }
      if (sc.outputTranscription?.text) this.send({ t: 'said', text: sc.outputTranscription.text })
      if (sc.interrupted) {
        this.modelBusy = false
        this.lastSpeech = Date.now()
        this.send({ t: 'interrupted' })
      }
      if (sc.turnComplete || sc.interrupted) this.commitUsage()
      if (sc.turnComplete) {
        this.modelBusy = false
        this.send({ t: 'done' })
        if (this.ending) setTimeout(() => this.finish('bye'), 1200)
      }
    }
    if (m.toolCall) this.toolCall(m.toolCall.functionCalls ?? [])
  }

  private commitUsage() {
    if (!this.turnUsage) return
    this.usd += costOf(this.turnUsage)
    this.turnUsage = null
    this.send({ t: 'cost', usd: this.cost() })
  }

  /** Measured from Gemini's usage when it sends some, else estimated from the audio time each way. */
  private cost() {
    const pendingTurn = this.turnUsage ? costOf(this.turnUsage) : 0
    if (this.sawUsage) return this.usd + pendingTurn
    return (this.inMs / 60_000) * PER_MIN.in + (this.outBytes / 48_000 / 60) * PER_MIN.out
  }

  private toolCall(calls: { id?: string; name?: string; args?: Record<string, unknown> }[]) {
    const responses = calls.map((c) => ({ id: c.id, name: c.name, response: { result: c.name === 'ask_weevboss' ? 'sent to weevboss; its answer will come as a [weevboss] message' : 'ok', scheduling: 'SILENT' } }))
    if (responses.length) this.toGemini({ toolResponse: { functionResponses: responses } })
    for (const c of calls) {
      if (c.name === 'end_live') this.ending = true
      if (c.name !== 'ask_weevboss') continue
      const request = String(c.args?.request ?? '').trim()
      if (request) void this.handoff(request)
    }
  }

  /** The request goes to weevboss exactly like a typed message; its written answer is said back when it lands. */
  private async handoff(request: string) {
    this.pending++
    this.send({ t: 'handoff', text: request })
    log(`→ weevboss : ${request.length} caractères`)
    const since = Date.now()
    try {
      await this.deps.sendMain(request)
    } catch (e) {
      this.pending--
      return this.queue(this.m.unreachable((e as Error).message.slice(0, 200)))
    }
    const reply = await this.deps.waitMainReply(since, ANSWER_WAIT_MS).catch(() => null)
    this.pending--
    if (this.closed) return
    log(`weevboss a répondu en ${Math.round((Date.now() - since) / 1000)} s`)
    this.send({ t: 'answer' })
    this.queue(reply ? this.m.answer(request.slice(0, 300), reply.replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').slice(0, 2000)) : this.m.stillWorking(request.slice(0, 300)))
  }

  private queue(text: string) {
    if (!this.answers.length) this.answerQueuedAt = Date.now()
    this.answers.push(text)
    this.tick()
  }

  private tick() {
    if (this.closed) return
    const now = Date.now()
    // An answer is said when nobody is talking (or after 20 s at worst): a client turn interrupts Gemini.
    if (this.answers.length && this.ready && ((!this.modelBusy && now - this.lastSpeech > 1500) || now - this.answerQueuedAt > 20_000)) {
      const text = this.answers.splice(0).join('\n\n')
      this.toGemini({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } })
      this.lastModel = now
    }
    if (now - this.started > MAX_MS) return this.close('limit')
    const quiet = now - Math.max(this.lastSpeech, this.lastModel)
    if (!this.pending && !this.answers.length && quiet > (this.deps.silenceMs ?? SILENCE_MS)) this.close('silence')
  }

  private close(why: string) {
    this.send({ t: 'closed', why })
    this.finish(why)
  }

  private finish(why: string) {
    if (this.closed) return
    this.closed = true
    clearInterval(this.timer)
    this.commitUsage()
    const ms = Date.now() - this.started
    if (this.up) {
      const up = this.up
      this.up = null
      up.close()
    }
    if (this.client.readyState === WebSocket.OPEN) this.client.close(1000)
    if (why !== 'nokey' && why !== 'nohere') {
      const usd = this.cost()
      const min = ms / 60_000
      log(
        `fin (${why}) · ${Math.round(ms / 1000)} s · ${(usd * 100).toFixed(2)} ¢ ${this.sawUsage ? 'mesurés' : 'estimés'} · ${min > 0.05 ? ((usd * 100) / min).toFixed(2) : '–'} ¢/min · micro ${Math.round(this.inMs / 1000)} s, voix ${Math.round(this.outBytes / 48_000)} s`,
      )
    }
  }
}

/** The websocket door: /api/live, after the same sign-in as the rest of the app and a same-origin check. */
export function liveUpgrade(deps: LiveDeps) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 })
  return (req: http.IncomingMessage, socket: Duplex, head: Buffer, lang: Lang) => {
    wss.handleUpgrade(req, socket, head, (ws) => new LiveSession(ws, deps, lang))
  }
}

/** A browser sends its page's Origin with a websocket, cookies included: only this server's own pages may open one. */
export function sameOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin
  const host = req.headers['x-forwarded-host'] ?? req.headers.host
  if (!origin || !host) return false
  try {
    return new URL(origin).host === String(host).split(',')[0].trim()
  } catch {
    return false
  }
}
