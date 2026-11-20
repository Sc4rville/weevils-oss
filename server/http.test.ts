import type http from 'node:http'
import { describe, expect, it } from 'vitest'
import { afterEach, beforeEach } from 'vitest'
import { browserSafe, configureLocalAuth, fromThisMachine, isLocal, localTokenProblem, markInternal, parseLocalToken, trustedFrom, trustedSource } from './http.ts'

const TOKEN = 'ab'.repeat(32)
const jailedSockets = new WeakSet<object>()
beforeEach(() => configureLocalAuth({ token: TOKEN, jailed: (s) => jailedSockets.has(s) }))
afterEach(() => configureLocalAuth(null))

/** A request as node:http hands it over: only the peer address and the headers matter here. By default it carries the
 *  machine's local token, as weevils-cli does. */
const req = (headers: Record<string, string> = {}, remoteAddress = '127.0.0.1') =>
  ({ socket: { remoteAddress }, headers: { host: '127.0.0.1:4179', 'x-weevils-local': TOKEN, ...headers } }) as unknown as http.IncomingMessage
const bare = (headers: Record<string, string> = {}) => {
  const r = req(headers)
  delete r.headers['x-weevils-local']
  return r
}

describe('the local token', () => {
  it('from this machine but without the token (any program that opens 127.0.0.1): not local, and said why', () => {
    expect(fromThisMachine(bare())).toBe(true)
    expect(isLocal(bare())).toBe(false)
    expect(localTokenProblem(bare())).toBe('missing')
    expect(trustedFrom(bare(), { from: 'weevboss' })).toBeUndefined()
  })
  it('a wrong token, a short one, or a token from far away: not local', () => {
    expect(isLocal(req({ 'x-weevils-local': 'cd'.repeat(32) }))).toBe(false)
    expect(localTokenProblem(req({ 'x-weevils-local': 'cd'.repeat(32) }))).toBe('wrong')
    expect(isLocal(req({ 'x-weevils-local': 'ab' }))).toBe(false)
    expect(isLocal(req({}, '10.0.0.5'))).toBe(false)
    expect(localTokenProblem(req({}, '10.0.0.5'))).toBeNull()
  })
  it('the token file\'s line, as curl -H @file sends it, or the bare token', () => {
    expect(isLocal(req({ 'x-weevils-local': TOKEN.toUpperCase() }))).toBe(true)
    expect(parseLocalToken(`X-Weevils-Local: ${TOKEN}\n`)).toBe(TOKEN)
    expect(parseLocalToken(TOKEN)).toBe(TOKEN)
    expect(parseLocalToken('X-Weevils-Local: nope')).toBe('')
  })
  it('an automation\'s jail has no token: local (its routes are limited elsewhere)', () => {
    const r = bare()
    jailedSockets.add(r.socket)
    expect(isLocal(r)).toBe(true)
  })
  it('never configured: nothing is local (fails closed)', () => {
    configureLocalAuth(null)
    expect(isLocal(req())).toBe(false)
  })
  it('a request weevilsd builds itself (the outbox replay) is local', () => {
    configureLocalAuth(null)
    const r = bare()
    markInternal(r)
    expect(isLocal(r)).toBe(true)
  })
})

describe('isLocal', () => {
  it('a loopback peer with a loopback Host and the token is local (weevils-cli)', () => {
    expect(isLocal(req())).toBe(true)
    expect(isLocal(req({ host: 'localhost:4179' }))).toBe(true)
    expect(isLocal(req({ host: '[::1]:4179' }, '::1'))).toBe(true)
    expect(isLocal(req({ host: 'localhost' }))).toBe(true)
  })

  it('an IPv4-mapped loopback peer is local', () => {
    expect(isLocal(req({}, '::ffff:127.0.0.1'))).toBe(true)
  })

  it('any proxy header means the request came from elsewhere', () => {
    for (const h of ['x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'forwarded', 'x-real-ip'])
      expect(isLocal(req({ [h]: '203.0.113.7' })), h).toBe(false)
  })

  it('a foreign Host (DNS rebinding) is not local', () => {
    expect(isLocal(req({ host: 'evil.com' }))).toBe(false)
    expect(isLocal(req({ host: 'evil.com:4179' }))).toBe(false)
    expect(isLocal(req({ host: '127.0.0.1.evil.com' }))).toBe(false)
    expect(isLocal(req({ host: 'evil.com@127.0.0.1' }))).toBe(false)
    expect(isLocal(req({ host: '' }))).toBe(false)
  })

  it('a page from another site, open in a local browser, is not local', () => {
    expect(isLocal(req({ origin: 'https://evil.com' }))).toBe(false)
    expect(isLocal(req({ origin: 'null' }))).toBe(false)
    expect(isLocal(req({ 'sec-fetch-site': 'cross-site' }))).toBe(false)
    expect(isLocal(req({ 'sec-fetch-site': 'same-site' }))).toBe(false)
  })

  it('the Vite dev proxy forwards its own Origin and Host (changeOrigin: false): local', () => {
    expect(isLocal(req({ host: '127.0.0.1:4178', origin: 'http://127.0.0.1:4178', 'sec-fetch-site': 'same-origin' }))).toBe(true)
    expect(isLocal(req({ host: '127.0.0.1:4178', origin: 'http://localhost:4178', 'sec-fetch-site': 'same-site' }))).toBe(true)
    expect(isLocal(req({ origin: 'http://127.0.0.1:4179' }))).toBe(true)
  })

  it("a page from another local server (a project's dev server, a cloned repo's preview) is not local", () => {
    expect(isLocal(req({ origin: 'http://localhost:4173', 'sec-fetch-site': 'same-site' }))).toBe(false)
    expect(isLocal(req({ origin: 'http://127.0.0.1:8080' }))).toBe(false)
    expect(isLocal(req({ origin: 'http://127.0.0.1' }))).toBe(false)
  })

  it('federation through the reverse tunnel: Host on another loopback port is local', () => {
    expect(isLocal(req({ host: '127.0.0.1:4192' }))).toBe(true)
  })

  it('a peer outside the machine is never local', () => {
    expect(isLocal(req({}, '10.0.0.5'))).toBe(false)
    expect(isLocal(req({}, '::ffff:10.0.0.5'))).toBe(false)
    expect(isLocal(req({}, ''))).toBe(false)
  })
})

describe('browserSafe (hook port)', () => {
  it('curl from hook.sh passes, a browser page from elsewhere does not', () => {
    expect(browserSafe(req({ host: '127.0.0.1:4180', 'content-type': 'application/json' }))).toBe(true)
    expect(browserSafe(req({ host: '127.0.0.1:4180', origin: 'https://evil.com' }))).toBe(false)
    expect(browserSafe(req({ host: 'evil.com:4180' }))).toBe(false)
  })
})

describe('trustedFrom', () => {
  it('a local request may sign as weevboss (weevils = its old name)', () => {
    expect(trustedFrom(req(), { from: 'weevils' })).toBe('weevboss')
    expect(trustedFrom(req(), { from: 'weevboss' })).toBe('weevboss')
  })

  it('an unknown author, or no from, gives nothing', () => {
    expect(trustedFrom(req(), { from: 'nobody-declared' })).toBeUndefined()
    expect(trustedFrom(req(), {})).toBeUndefined()
    expect(trustedFrom(req(), null)).toBeUndefined()
    expect(trustedFrom(req(), { from: 42 })).toBeUndefined()
  })

  it('the phone (through the proxy) can never set from', () => {
    expect(trustedFrom(req({ 'x-forwarded-for': '203.0.113.7' }), { from: 'weevils' })).toBeUndefined()
    expect(trustedFrom(req({}, '10.0.0.5'), { from: 'weevils' })).toBeUndefined()
    expect(trustedFrom(req({ origin: 'https://evil.com' }), { from: 'weevils' })).toBeUndefined()
  })
})

it('does not resolve a browser-provided source thread as a trusted author',()=>{
 let lookedUp=false
 expect(trustedFrom(req({'x-forwarded-for':'203.0.113.7'}),{from:'agent',sourceThread:'boss'},()=>{lookedUp=true;return 'weevboss'})).toBeUndefined()
 expect(lookedUp).toBe(false)
 expect(trustedFrom(req(),{from:'agent',sourceThread:'unknown'},()=>undefined)).toBe('agent')
})


it('runtime source overrides inherited author claims; unknown agent runtimes never become the user',()=>{
 const lookup=(id:string)=>id==='coder'?'codex':id==='boss'?'weevboss':undefined
 expect(trustedFrom(req(),{from:'weevboss',sourceThread:'coder'},lookup)).toBe('codex')
 expect(trustedSource(req(),{sourceThread:'coder'},lookup)).toBe('coder')
 expect(trustedFrom(req(),{sourceThread:'unknown'},lookup)).toBe('agent')
 expect(trustedSource(req(),{sourceThread:'unknown'},lookup)).toBeUndefined()
 expect(trustedSource(req({'x-forwarded-for':'203.0.113.7'}),{sourceThread:'boss'},lookup)).toBeUndefined()
 expect(trustedFrom(req(),{from:'codex',sourceThread:'boss'},lookup)).toBe('weevboss')
})
