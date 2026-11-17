// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LiveSession, primeLive, type LiveState } from './live'

// The phone side of live voice against a fake /api/live and a fake Web Audio: what the user hears stops the moment
// they cut in, and one conversation never opens the microphone twice.
let socket: FakeSocket
class FakeSocket {
  static OPEN = 1
  readyState = 1
  binaryType = ''
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  sent: unknown[] = []
  constructor(public url: string) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    socket = this
  }
  send(d: unknown) {
    this.sent.push(d)
  }
  close() {}
  say(m: unknown) {
    this.onmessage?.({ data: m instanceof ArrayBuffer ? m : JSON.stringify(m) })
  }
}

const sources: { stopped: boolean }[] = []
let workletNodes = 0
class FakeContext {
  state = 'running'
  currentTime = 0
  destination = {}
  audioWorklet = { addModule: async () => {} }
  resume = async () => {}
  suspend = async () => {}
  createBuffer(_c: number, n: number, rate: number) {
    return { duration: n / rate, getChannelData: () => new Float32Array(n) }
  }
  createBufferSource() {
    const s = { buffer: null, stopped: false, onended: null as (() => void) | null, connect() {}, start() {}, stop() { s.stopped = true } }
    sources.push(s)
    return s
  }
  createMediaStreamSource() {
    return { connect() {}, disconnect() {} }
  }
}
class FakeWorklet {
  port = { onmessage: null }
  constructor() {
    workletNodes++
  }
  disconnect() {}
}

const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop() {} }] }))
const flush = () => new Promise((r) => setTimeout(r, 10))

beforeEach(() => {
  sources.length = 0
  workletNodes = 0
  getUserMedia.mockClear()
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('AudioContext', FakeContext)
  vi.stubGlobal('AudioWorkletNode', FakeWorklet)
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  primeLive()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function open() {
  const states: LiveState[] = []
  const turn = vi.fn()
  const s = new LiveSession({ state: (x) => states.push(x), cost: () => {}, said: () => {}, turn, ended: () => {} })
  s.start('en')
  return { s, states, turn }
}

it('cutting in stops every queued piece of the voice at once and listens again', async () => {
  const { states, turn } = open()
  socket.say({ t: 'ready' })
  await flush()
  socket.say(new Int16Array(2400).buffer)
  socket.say(new Int16Array(2400).buffer)
  expect(states.at(-1)).toBe('speaking')
  socket.say({ t: 'interrupted' })
  await flush()
  expect(sources).toHaveLength(2)
  expect(sources.every((x) => x.stopped)).toBe(true)
  expect(turn).toHaveBeenCalled()
  expect(states.at(-1)).toBe('listening')
})

it('a second « ready » (a renewed link) never opens a second microphone', async () => {
  open()
  socket.say({ t: 'ready' })
  await flush()
  socket.say({ t: 'ready' })
  await flush()
  expect(getUserMedia).toHaveBeenCalledTimes(1)
  expect(workletNodes).toBe(1)
})
