// Who may speak as the user into weevboss's thread (server/boss-door.ts). On 2026-11-14 a live-voice test played
// recorded questions through the live instance (« What time of day is best for a code review? »): loopback needed no
// code, and they reached weevboss as the user's. These tests pin the doors shut for scripts on this machine.
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bossDoor } from './boss-door.ts'
import { automated, userVoice } from './http.ts'
import { executeOutbox } from './outbox-http.ts'
import { LOCAL } from '../test/local-token.ts'
import { Outbox, OutboxError } from './outbox.ts'

const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const HEADLESS = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36'

/** A request as node:http hands it over: peer address, headers, url. */
const req = (headers: Record<string, string> = {}, remoteAddress = '127.0.0.1', url = '/api/main') =>
  ({ socket: { remoteAddress }, url, headers: { host: '127.0.0.1:4179', ...LOCAL, ...headers } }) as unknown as http.IncomingMessage
/** The phone through Caddy, with its device cookie. */
const phone = (extra: Record<string, string> = {}) => req({ host: 'weevils.example.com', 'x-forwarded-for': '203.0.113.7', 'x-forwarded-proto': 'https', cookie: 'wv=good', 'user-agent': SAFARI, ...extra }, '127.0.0.1')

const make = (over: Partial<Parameters<typeof bossDoor>[0]> = {}) =>
  bossDoor({
    hasDevice: (r) => /(?:^|;\s*)wv=good/.test(String(r.headers.cookie ?? '')),
    isBossTarget: (id) => id === 'boss-thread' || id === '__main',
    sourceAuthor: (id) => (id === 'agent-thread' ? 'codex' : undefined),
    refusal: () => 'only you can write to weevboss',
    allowLocal: () => false,
    ...over,
  })

const refused = (f: () => void) => {
  try { f() } catch (e) { return e instanceof OutboxError && e.status === 403 }
  return false
}

describe('automated / userVoice', () => {
  it('an automated browser says so (header, websocket query, headless user agent)', () => {
    expect(automated(req({ 'x-weevils-automated': '1' }))).toBe(true)
    expect(automated(req({}, '127.0.0.1', '/api/live?lang=en&automated=1'))).toBe(true)
    expect(automated(req({ 'user-agent': HEADLESS }))).toBe(true)
    expect(automated(req({ 'user-agent': SAFARI }))).toBe(false)
    expect(automated(req({}, '127.0.0.1', '/api/live?lang=en&notautomated=1'))).toBe(false)
  })

  it('only a known device that is not automated speaks as the user', () => {
    expect(userVoice(phone(), true)).toBe(true)
    expect(userVoice(req(), false)).toBe(false) // a loopback script: trusted, but not the user's voice
    expect(userVoice(phone({ 'x-weevils-automated': '1' }), true)).toBe(false)
  })
})

describe('bossDoor.guard', () => {
  const door = make()

  it('refuses a loopback script with no cookie and no signature on every door into weevboss', () => {
    for (const p of ['/api/main', '/api/main/attach', '/api/sessions/boss-thread/send', '/api/sessions/boss-thread/attach', '/api/sessions/__main/send'])
      expect(refused(() => door.guard(req(), p, { text: 'What time of day is best for a code review?' })), p).toBe(true)
  })

  it('lets the signed-in phone through', () => {
    expect(refused(() => door.guard(phone(), '/api/main', { text: 'hi' }))).toBe(false)
    expect(refused(() => door.guard(phone(), '/api/sessions/boss-thread/send', { text: 'hi' }))).toBe(false)
  })

  it('an automated browser is refused even with a device cookie', () => {
    expect(refused(() => door.guard(phone({ 'x-weevils-automated': '1' }), '/api/main', { text: 'hi' }))).toBe(true)
    expect(refused(() => door.guard(phone({ 'user-agent': HEADLESS }), '/api/main', { text: 'hi' }))).toBe(true)
  })

  it('a local signed post (an agent, the weevils command) is let in: it is shown under its author, never as the user', () => {
    expect(refused(() => door.guard(req(), '/api/main', { text: 'build is green', from: 'codex' }))).toBe(false)
    expect(refused(() => door.guard(req(), '/api/sessions/boss-thread/send', { text: 'done', from: 'agent', sourceThread: 'agent-thread' }))).toBe(false)
  })

  it('a signature does not open the doors that would deliver unsigned (attach to a session) nor an empty text', () => {
    expect(refused(() => door.guard(req(), '/api/sessions/boss-thread/attach', { text: 'x', from: 'codex' }))).toBe(true)
    expect(refused(() => door.guard(req(), '/api/main', { text: '  ', from: 'codex' }))).toBe(true)
  })

  it('a signature from the phone is ignored (trustedFrom is local only): the phone needs its cookie like any message', () => {
    expect(refused(() => door.guard(phone({ cookie: '' }), '/api/main', { text: 'hi', from: 'weevboss' }))).toBe(true)
  })

  it("leaves project sessions alone: the door is weevboss's thread", () => {
    expect(refused(() => door.guard(req(), '/api/sessions/project-1/send', { text: 'go on' }))).toBe(false)
    expect(refused(() => door.guard(req(), '/api/sessions', { text: 'x' }))).toBe(false)
  })

  it('a test copy (WEEVILS_ALLOW_LOCAL_VOICE=1) lets its own scripts in', () => {
    expect(refused(() => make({ allowLocal: () => true }).guard(req(), '/api/main', { text: 'hi' }))).toBe(false)
  })

  it('reads WEEVILS_ALLOW_LOCAL_VOICE by default, on each request', () => {
    const d = make({ allowLocal: undefined })
    vi.stubEnv('WEEVILS_ALLOW_LOCAL_VOICE', '')
    expect(refused(() => d.guard(req(), '/api/main', { text: 'hi' }))).toBe(true)
    vi.stubEnv('WEEVILS_ALLOW_LOCAL_VOICE', '1')
    expect(refused(() => d.guard(req(), '/api/main', { text: 'hi' }))).toBe(false)
    vi.unstubAllEnvs()
  })
})

describe('bossDoor taps, live voice, local claim', () => {
  const door = make()

  it('a For you action, reply or explanation speaks for the user: the app only', () => {
    for (const p of ['/api/foryou/b%3A1/act', '/api/foryou/b%3A1/reply', '/api/explain']) {
      expect(door.tapAllowed(req(), 'POST', p), p).toBe(false)
      expect(door.tapAllowed(phone(), 'POST', p), p).toBe(true)
    }
    // Reading, dismissing and the weevils command's own posts stay open to this machine.
    expect(door.tapAllowed(req(), 'GET', '/api/foryou')).toBe(true)
    expect(door.tapAllowed(req(), 'POST', '/api/foryou/b%3A1/dismiss')).toBe(true)
    expect(door.tapAllowed(req(), 'POST', '/api/foryou/post')).toBe(true)
  })

  it("Siri's turn: its own token or the app; a loopback script can neither post a turn nor read the token", () => {
    expect(door.voiceAllowed(req(), '/api/voice/turn', false)).toBe(false) // curl -d '{"text":"…"}' 127.0.0.1:4179/api/voice/turn
    expect(door.voiceAllowed(req(), '/api/voice/shortcut', false)).toBe(false) // GET the token, then post with it
    expect(door.voiceAllowed(req(), '/api/voice/turn', true)).toBe(true) // the Siri shortcut, with its token
    expect(door.voiceAllowed(phone(), '/api/voice/shortcut', false)).toBe(true) // the app shows or renews the token
    expect(door.voiceAllowed(req(), '/api/voice/clip/abc.mp3', false)).toBe(true)
    expect(door.voiceAllowed(req(), '/api/voice/chunk', false)).toBe(true)
    expect(make({ allowLocal: () => true }).voiceAllowed(req(), '/api/voice/turn', false)).toBe(true)
  })

  it('live voice: the phone yes; a websocket script or an automated browser on loopback, no', () => {
    expect(door.liveAllowed(phone(), true)).toBe(true)
    expect(door.liveAllowed(req({}, '127.0.0.1', '/api/live?lang=en'), true)).toBe(false) // /tmp/liveprobe/e2e.mjs
    expect(door.liveAllowed(phone({ 'user-agent': HEADLESS }), true)).toBe(false) // Playwright with a fake microphone
    expect(make({ allowLocal: () => true }).liveAllowed(req(), true)).toBe(true)
    expect(make({ allowLocal: () => true }).liveAllowed(req(), false)).toBe(false)
  })

  it('a real browser on this machine may claim a device; a script or an automated browser may not', () => {
    expect(door.localClaimAllowed(req({ 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Safari/605.1.15' }))).toBe(true)
    expect(door.localClaimAllowed(req({ 'user-agent': 'node' }))).toBe(false)
    expect(door.localClaimAllowed(req({ 'user-agent': 'curl/8.5.0' }))).toBe(false)
    expect(door.localClaimAllowed(req({ 'user-agent': HEADLESS }))).toBe(false)
    expect(door.localClaimAllowed(req({ 'user-agent': SAFARI, 'x-weevils-automated': '1' }))).toBe(false)
    expect(door.localClaimAllowed(phone())).toBe(false) // from elsewhere: the login link, with the code
    // A browser has no local token: the claim never needed it (the route adds that the caller is this user's process).
    const browser = req({ 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Safari/605.1.15' })
    delete browser.headers['x-weevils-local']
    expect(door.localClaimAllowed(browser)).toBe(true)
  })
})

describe('bossDoor.text', () => {
  const door = make()
  it("signs a local author's text, and marks the origin", () => {
    expect(door.text(req(), { text: ' build is green ', from: 'codex' })).toEqual({ text: '[from:codex] build is green', origin: 'server' })
    expect(door.text(phone(), { text: 'hi', from: 'codex' })).toEqual({ text: 'hi', origin: 'device' })
  })
})

// The same chain as server/index.ts: the outbox accepts on the original request (the door runs there), then replays
// on a rebuilt loopback request with no cookie, which must neither be refused nor lose the author.
describe('through the outbox', () => {
  let dir = ''
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }) })

  async function harness() {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-boss-door-'))
    const door = make()
    const delivered: { text: string; origin: string }[] = []
    const routes: Parameters<typeof executeOutbox>[1] = [['POST', /^\/api\/main$/, async (rq, res, u) => {
      let raw = ''
      for await (const c of rq) raw += c
      const body = JSON.parse(raw)
      door.guard(rq, u.pathname, body)
      delivered.push(door.text(rq, body))
      res.writeHead(200); res.end(JSON.stringify({ id: 'boss' }))
    }]]
    const box = new Outbox(dir, (task) => executeOutbox(task, routes))
    const accept = async (rq: http.IncomingMessage, key: string, body: Record<string, unknown>) => {
      door.guard(rq, '/api/main', body)
      const { trustedFrom } = await import('./http.ts')
      const from = trustedFrom(rq, body, () => undefined)
      const kept = { text: body.text, ...(from ? { from } : {}) }
      return box.accept(key, { url: '/api/main', body: kept, lane: 'main' })
    }
    const settle = async () => { for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r)) }
    return { box, accept, delivered, settle }
  }

  it("the phone's message is accepted, then replayed without a cookie and delivered as the user's", async () => {
    const h = await harness()
    await h.accept(phone(), 'phone-message-0001', { text: 'what are my projects up to?' })
    await h.settle()
    expect(h.box.get('phone-message-0001')).toMatchObject({ status: 'delivered' })
    expect(h.delivered).toEqual([{ text: 'what are my projects up to?', origin: 'device' }])
  })

  it('a signed local post keeps its author when replayed (it used to come out as the user)', async () => {
    const h = await harness()
    await h.accept(req(), 'agent-message-0001', { text: 'deploy finished', from: 'codex' })
    await h.settle()
    expect(h.delivered).toEqual([{ text: '[from:codex] deploy finished', origin: 'server' }])
  })

  it('a loopback script is refused before the outbox keeps anything', async () => {
    const h = await harness()
    await expect(h.accept(req(), 'script-message-0001', { text: 'In two sentences, what can you do?' })).rejects.toMatchObject({ status: 403 })
    expect(h.box.get('script-message-0001')).toBeUndefined()
    expect(h.delivered).toEqual([])
  })
})
