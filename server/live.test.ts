import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { classify, costOf, liveUpgrade, sameOrigin, type LiveDeps } from './live.ts'

// A fake Gemini Live and a fake phone around the real bridge.
const closers: (() => void)[] = []
afterEach(() => {
  while (closers.length) closers.pop()!()
})

async function listen(server: http.Server) {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  closers.push(() => server.close())
  return (server.address() as AddressInfo).port
}

async function fakeGemini(onClient: (ws: WebSocket, headers: http.IncomingHttpHeaders) => void) {
  const server = http.createServer()
  const wss = new WebSocketServer({ server })
  wss.on('connection', (ws, req) => onClient(ws, req.headers))
  closers.push(() => wss.close())
  return `ws://127.0.0.1:${await listen(server)}`
}

async function bridge(deps: Partial<LiveDeps> & { upstream: string }) {
  const full: LiveDeps = { key: () => 'test-key', sendMain: async () => ({}), waitMainReply: async () => null, recent: () => [], user: () => 'Ana', ...deps }
  const upgrade = liveUpgrade(full)
  const server = http.createServer()
  server.on('upgrade', (req, socket, head) => upgrade(req, socket, head, 'en'))
  const port = await listen(server)
  const phone = new WebSocket(`ws://127.0.0.1:${port}/api/live`)
  const got: Record<string, any>[] = []
  const audio: Buffer[] = []
  phone.on('message', (d, binary) => (binary ? audio.push(d as Buffer) : got.push(JSON.parse(d.toString()))))
  closers.push(() => phone.close())
  await new Promise((r) => phone.on('open', r))
  return { phone, got, audio }
}

const until = async (f: () => unknown, ms = 3000) => {
  const end = Date.now() + ms
  while (!f()) {
    if (Date.now() > end) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('live voice mode', () => {
  it('without a key: says so, and never calls Gemini', async () => {
    let called = false
    const upstream = await fakeGemini(() => (called = true))
    const { got } = await bridge({ upstream, key: () => '' })
    await until(() => got.length)
    expect(got[0]).toEqual({ t: 'nokey' })
    expect(called).toBe(false)
  })

  it('relays audio both ways, hands requests to weevboss and says its answer back', async () => {
    const toGemini: Record<string, any>[] = []
    let header = ''
    const upstream = await fakeGemini((ws, headers) => {
      header = String(headers['x-goog-api-key'])
      ws.on('message', (d) => {
        const m = JSON.parse(d.toString())
        toGemini.push(m)
        if (m.setup) ws.send(JSON.stringify({ setupComplete: {} }))
        if (m.realtimeInput?.audio) {
          ws.send(JSON.stringify({ serverContent: { inputTranscription: { text: 'run the tests' } } }))
          ws.send(JSON.stringify({ toolCall: { functionCalls: [{ id: 'c1', name: 'ask_weevboss', args: { request: 'Run the tests in weevils' } }] } }))
          ws.send(JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.alloc(4800).toString('base64') } }] } } }))
          ws.send(JSON.stringify({ usageMetadata: { promptTokenCount: 1000, responseTokenCount: 500, promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 900 }, { modality: 'TEXT', tokenCount: 100 }], responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 500 }] } }))
          ws.send(JSON.stringify({ serverContent: { turnComplete: true } }))
        }
      })
    })
    const sent: string[] = []
    const { phone, got, audio } = await bridge({
      upstream,
      sendMain: async (t) => void sent.push(t),
      waitMainReply: async () => 'All 412 tests pass.',
      recent: () => [{ role: 'user', text: 'hello' }],
    })
    await until(() => got.some((m) => m.t === 'ready'))
    expect(header).toBe('test-key')
    const setup = toGemini[0].setup
    expect(setup.model).toBe('models/gemini-3.8-live')
    expect(setup.systemInstruction.parts[0].text).toContain('in English')
    expect(setup.systemInstruction.parts[0].text).toContain('Ana: hello')
    phone.send(Buffer.alloc(640), { binary: true })
    await until(() => toGemini.some((m) => m.clientContent))
    expect(sent).toEqual(['Run the tests in weevils'])
    expect(toGemini.find((m) => m.toolResponse)!.toolResponse.functionResponses[0]).toMatchObject({ id: 'c1', name: 'ask_weevboss' })
    expect(toGemini.find((m) => m.clientContent)!.clientContent.turns[0].parts[0].text).toContain('All 412 tests pass.')
    expect(audio[0].length).toBe(4800)
    expect(got.map((m) => m.t)).toEqual(expect.arrayContaining(['heard', 'handoff', 'cost', 'done', 'answer']))
    const cost = got.find((m) => m.t === 'cost')!.usd
    expect(cost).toBeCloseTo((900 * 3 + 100 * 0.75 + 500 * 12) / 1e6, 8)
  })

  it('a billing refusal from Google reaches the phone as a plain word, not the raw message', async () => {
    const upstream = await fakeGemini((ws) => ws.on('message', () => ws.close(1011, 'Your prepayment credits are depleted. Please go to AI Studio')))
    const { got } = await bridge({ upstream })
    await until(() => got.some((m) => m.t === 'error'))
    expect(got.find((m) => m.t === 'error')).toEqual({ t: 'error', code: 'billing' })
  })

  it('the user cutting in reaches the phone at once as « interrupted »', async () => {
    const upstream = await fakeGemini((ws) =>
      ws.on('message', (d) => {
        const m = JSON.parse(d.toString())
        if (m.setup) ws.send(JSON.stringify({ setupComplete: {} }))
        if (m.realtimeInput?.audio) {
          ws.send(JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { data: Buffer.alloc(480).toString('base64') } }] } } }))
          ws.send(JSON.stringify({ serverContent: { interrupted: true } }))
        }
      }),
    )
    const { phone, got, audio } = await bridge({ upstream })
    await until(() => got.some((m) => m.t === 'ready'))
    phone.send(Buffer.alloc(640), { binary: true })
    await until(() => got.some((m) => m.t === 'interrupted'))
    expect(audio.length).toBe(1)
    expect(got.map((m) => m.t)).not.toContain('done')
  })

  it('a renewed Gemini connection (goAway) resumes the session without telling the phone « ready » again', async () => {
    const setups: Record<string, any>[] = []
    const upstream = await fakeGemini((ws) =>
      ws.on('message', (d) => {
        const m = JSON.parse(d.toString())
        if (!m.setup) return
        setups.push(m.setup)
        ws.send(JSON.stringify({ setupComplete: {} }))
        if (setups.length === 1) {
          ws.send(JSON.stringify({ sessionResumptionUpdate: { resumable: true, newHandle: 'h1' } }))
          ws.send(JSON.stringify({ goAway: { timeLeft: '1s' } }))
          setTimeout(() => ws.close(1000), 30)
        }
      }),
    )
    const { got } = await bridge({ upstream })
    await until(() => setups.length === 2)
    await new Promise((r) => setTimeout(r, 50))
    expect(setups[1].sessionResumption).toEqual({ handle: 'h1' })
    expect(got.filter((m) => m.t === 'ready')).toHaveLength(1)
    expect(got.map((m) => m.t)).not.toContain('error')
  })

  it('closes itself after a silence', async () => {
    const upstream = await fakeGemini((ws) => ws.on('message', (d) => JSON.parse(d.toString()).setup && ws.send(JSON.stringify({ setupComplete: {} }))))
    const { got } = await bridge({ upstream, silenceMs: 300 })
    await until(() => got.some((m) => m.t === 'closed'))
    expect(got.find((m) => m.t === 'closed')).toEqual({ t: 'closed', why: 'silence' })
  })
})

describe('live helpers', () => {
  it('classifies upstream refusals', () => {
    expect(classify(1011, 'Your prepayment credits are depleted')).toBe('billing')
    expect(classify(1011, 'RESOURCE_EXHAUSTED: quota')).toBe('quota')
    expect(classify(1008, 'API key not valid')).toBe('auth')
    expect(classify(1007, 'models/x is not found')).toBe('model')
    expect(classify(1006, '')).toBe('upstream')
  })
  it('prices usage, counting undetailed tokens as audio', () => {
    expect(costOf({ promptTokenCount: 1_000_000 })).toBeCloseTo(3)
    expect(costOf({ responseTokensDetails: [{ modality: 'TEXT', tokenCount: 1_000_000 }], responseTokenCount: 1_000_000 })).toBeCloseTo(4.5)
  })
  it('accepts only this server’s own pages', () => {
    const req = (h: Record<string, string>) => ({ headers: h }) as unknown as http.IncomingMessage
    expect(sameOrigin(req({ origin: 'https://w.example.com', host: 'w.example.com' }))).toBe(true)
    expect(sameOrigin(req({ origin: 'https://evil.example', host: 'w.example.com' }))).toBe(false)
    expect(sameOrigin(req({ host: 'w.example.com' }))).toBe(false)
  })
})
