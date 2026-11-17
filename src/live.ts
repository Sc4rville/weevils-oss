// Live voice mode, phone side (server: server/live.ts). The microphone goes out as 16 kHz PCM over /api/live, Gemini's
// voice comes back as 24 kHz PCM and plays at once; when the server says "interrupted" (the user spoke over it), what
// is still queued is dropped. Nothing here ever sees a key.
import { automatedBrowser } from './automated'

export type LiveState = 'connecting' | 'listening' | 'speaking' | 'thinking'
/** Why a live session ended (or never started): the server's words, plus the phone's own (mic, network). */
export type LiveEnd = 'nokey' | 'billing' | 'quota' | 'auth' | 'model' | 'upstream' | 'nohere' | 'silence' | 'limit' | 'bye' | 'network' | 'mic' | 'user'

export interface LiveHandlers {
  state(s: LiveState): void
  cost(usd: number): void
  said(text: string): void
  /** Gemini finished a turn: the next words start a new caption. */
  turn(): void
  ended(why: LiveEnd): void
}

// One audio context, created and resumed inside the gesture itself (iOS plays nothing otherwise).
let ctx: AudioContext | null = null
/** A short tap after all (no live): the context goes back to sleep. */
export function parkLive() {
  if (ctx?.state === 'running') void ctx.suspend().catch(() => undefined)
}
export function primeLive() {
  try {
    if (!ctx || ctx.state === 'closed') ctx = new AudioContext()
    void ctx.resume().catch(() => undefined)
  } catch {
    /* no Web Audio: start() will say so */
  }
}

// Capture worklet: averages the device rate down to 16 kHz (a plain low-pass) and posts 20 ms frames of PCM 16-bit.
const WORKLET = `class C extends AudioWorkletProcessor{constructor(){super();this.r=sampleRate/16000;this.a=0;this.s=0;this.c=0;this.b=new Int16Array(320);this.n=0}
process(i){const x=i[0]&&i[0][0];if(!x)return true;for(let k=0;k<x.length;k++){this.s+=x[k];this.c++;this.a+=1;if(this.a>=this.r){this.a-=this.r;const v=Math.max(-1,Math.min(1,this.s/this.c));this.s=0;this.c=0;this.b[this.n++]=v*32767;if(this.n===320){const o=this.b.slice();this.port.postMessage(o.buffer,[o.buffer]);this.n=0}}}return true}}
registerProcessor('wv-live-capture',C)`

/** Frames of 20 ms: 15 frames of pre-roll, so the first syllable is never cut. */
const PREROLL = 15
/** Keep sending this long after the voice drops (Gemini decides the end of the turn on the silence it hears). */
const HANGOVER_MS = 2000

export class LiveSession {
  private ws: WebSocket | null = null
  private stream: MediaStream | null = null
  private node: AudioWorkletNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private playing = new Set<AudioBufferSourceNode>()
  private playhead = 0
  private thinking = 0
  private over = false
  private floor = 0.004
  private lastVoice = 0
  private sending = false
  private ring: ArrayBuffer[] = []
  private micOpened = false

  constructor(private h: LiveHandlers) {}

  start(lang: string) {
    this.h.state('connecting')
    if (!ctx) return this.end('mic')
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${proto}//${location.host}/api/live?lang=${encodeURIComponent(lang)}${automatedBrowser() ? '&automated=1' : ''}`)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.onmessage = (e) => (typeof e.data === 'string' ? this.message(JSON.parse(e.data)) : this.play(e.data as ArrayBuffer))
    ws.onclose = () => this.end('network')
    ws.onerror = () => undefined
  }

  /** The user ends it (a tap on the logo). */
  stop() {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'bye' }))
    this.end('user')
  }

  private async message(m: { t: string; code?: LiveEnd; why?: LiveEnd; usd?: number; text?: string }) {
    switch (m.t) {
      case 'ready':
        return this.mic()
      case 'nokey':
        return this.end('nokey')
      case 'error':
        return this.end(m.code ?? 'upstream')
      case 'closed':
        return this.end(m.why ?? 'bye')
      case 'cost':
        return this.h.cost(m.usd ?? 0)
      case 'said':
        return m.text && this.h.said(m.text)
      case 'done':
        return this.h.turn()
      case 'interrupted':
        this.h.turn()
        return this.hush()
      case 'handoff':
        this.thinking++
        return this.refresh()
      case 'answer':
        this.thinking = Math.max(0, this.thinking - 1)
        return this.refresh()
    }
  }

  private async mic() {
    // One microphone per conversation: a second « ready » (an older server renewing its Gemini link) must not open
    // another capture, whose frames would interleave with the first and garble what Gemini hears.
    if (this.micOpened) return
    this.micOpened = true
    const c = ctx
    if (!c) return this.end('mic')
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      if (this.over) return this.release()
      // iOS may pause the context when the microphone opens: resume it.
      await c.resume().catch(() => undefined)
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }))
      await c.audioWorklet.addModule(url)
      URL.revokeObjectURL(url)
      if (this.over) return this.release()
      this.source = c.createMediaStreamSource(this.stream)
      this.node = new AudioWorkletNode(c, 'wv-live-capture')
      this.node.port.onmessage = (e) => this.frame(e.data as ArrayBuffer)
      this.source.connect(this.node)
      this.refresh()
    } catch {
      this.end('mic')
    }
  }

  /** A light gate: frames go out while there is voice (plus pre-roll and a tail of silence), not during long silences. */
  private frame(buf: ArrayBuffer) {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const pcm = new Int16Array(buf)
    let sum = 0
    for (let i = 0; i < pcm.length; i++) sum += (pcm[i] / 32768) ** 2
    const rms = Math.sqrt(sum / pcm.length)
    const voiced = rms > Math.max(0.01, this.floor * 2.5)
    if (!voiced) this.floor = Math.max(0.002, this.floor * 0.995 + rms * 0.005)
    const now = performance.now()
    if (voiced) {
      if (!this.sending) for (const b of this.ring) ws.send(b)
      this.ring = []
      this.sending = true
      this.lastVoice = now
    }
    if (this.sending) {
      ws.send(buf)
      if (now - this.lastVoice > HANGOVER_MS) {
        this.sending = false
        ws.send(JSON.stringify({ t: 'pause' }))
      }
      return
    }
    this.ring.push(buf)
    if (this.ring.length > PREROLL) this.ring.shift()
  }

  private play(buf: ArrayBuffer) {
    const c = ctx
    if (!c || this.over) return
    const pcm = new Int16Array(buf)
    const audio = c.createBuffer(1, pcm.length, 24000)
    const ch = audio.getChannelData(0)
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768
    const src = c.createBufferSource()
    src.buffer = audio
    src.connect(c.destination)
    const at = Math.max(c.currentTime + 0.03, this.playhead)
    src.start(at)
    this.playhead = at + audio.duration
    this.playing.add(src)
    src.onended = () => {
      this.playing.delete(src)
      this.refresh()
    }
    this.refresh()
  }

  /** The user spoke over the voice: what is queued is dropped at once. */
  private hush() {
    for (const s of this.playing) {
      s.onended = null
      try {
        s.stop()
      } catch {
        /* already done */
      }
    }
    this.playing.clear()
    this.playhead = 0
    this.refresh()
  }

  private refresh() {
    if (this.over || !this.node) return
    this.h.state(this.playing.size ? 'speaking' : this.thinking ? 'thinking' : 'listening')
  }

  private release() {
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.source?.disconnect()
    this.node?.disconnect()
    this.node = null
  }

  private end(why: LiveEnd) {
    if (this.over) return
    this.over = true
    this.hush()
    this.release()
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onclose = null
      ws.close()
    }
    this.h.ended(why)
  }
}
