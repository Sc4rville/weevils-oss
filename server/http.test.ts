import type http from 'node:http'
import { describe, expect, it } from 'vitest'
import { browserSafe, isLocal, trustedFrom } from './http.ts'

/** A request as node:http hands it over: only the peer address and the headers matter here. */
const req = (headers: Record<string, string> = {}, remoteAddress = '127.0.0.1') =>
  ({ socket: { remoteAddress }, headers: { host: '127.0.0.1:4179', ...headers } }) as unknown as http.IncomingMessage

describe('isLocal', () => {
  it('a loopback peer with a loopback Host is local (weevils-cli, curl)', () => {
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
