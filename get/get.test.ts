// get/server.mjs: the public setup service. A mock Hetzner API, the real bootstrap's encryption through openssl, and
// the guards (preview key, SSRF, step allowlist, rate limits). No real network beyond 127.0.0.1.
// The Mac path, as far as Linux can check it: the script under bash 3.2, the page for a Mac visitor, the Node way of
// sealing the link. Its branches run for real in get/test-macos.sh (a fake Mac) and get/e2e-mac.mjs (a real one).
import { execFileSync, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Window } from 'happy-dom'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error plain JavaScript module, no types
import * as HZ from './hetzner.js'
import { config, createServer, publicAddress, sslip, stepTitles, loadJobs, saveJobs, createStore, describeStats } from './server.mjs'
import { claimSetup } from '../server/get-claim.ts'

const listen = (s: http.Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)))

// ---- a Hetzner API double
const created: Record<string, unknown>[] = []
/** Servers on the account (GET /servers with label app=weevils, GET /servers/{id}), and the passwords reset. */
const hzServers: any[] = []
const resets: number[] = []
let slowCreate = 0
const hzServer = (id: number, name: string, labels: Record<string, string> = {}) => ({ id, name, status: 'running', created: new Date(Date.now() - 12 * 60_000).toISOString(), labels, public_net: { ipv4: { ip: '172.30.99.10' } }, datacenter: { location: { name: 'nbg1', city: 'Nuremberg' } }, server_type: { name: 'cx33' } })
const hetzner = http.createServer((req, res) => {
  const auth = req.headers.authorization
  const reply = (status: number, body: unknown) => (res.writeHead(status, { 'content-type': 'application/json' }), res.end(JSON.stringify(body)))
  if (auth === 'Bearer readonlytoken0000000000') {
    if (req.method === 'POST') return reply(403, { error: { code: 'forbidden', message: 'insufficient permissions' } })
  } else if (auth !== 'Bearer goodtoken00000000000000') return reply(401, { error: { code: 'unauthorized', message: 'unable to authenticate' } })
  if (req.method === 'GET' && req.url === '/pricing') {
    // Hetzner bills the server's IPv4 address on top of its type (shape from the API reference, GET /pricing).
    const ip = (location: string) => ({ location, price_hourly: { net: '0.0008', gross: '0.0010' }, price_monthly: { net: '0.5000', gross: '0.5950' } })
    return reply(200, { pricing: { currency: 'EUR', vat_rate: '19.00', primary_ips: [{ type: 'ipv6', prices: [] }, { type: 'ipv4', prices: ['nbg1', 'fsn1', 'hel1', 'ash'].map(ip) }] } })
  }
  if (req.method === 'GET' && req.url?.startsWith('/server_types')) {
    const price = (location: string, gross: string) => ({ location, price_hourly: { net: '0', gross: (Number(gross) / 625).toFixed(4) }, price_monthly: { net: '0', gross } })
    return reply(200, {
      server_types: [
        { name: 'cx22', cores: 2, memory: 4, disk: 40, architecture: 'x86', deprecated: true, prices: [price('nbg1', '3.00')] },
        { name: 'cx11', cores: 1, memory: 2, disk: 20, architecture: 'x86', prices: [price('nbg1', '2.00')] },
        { name: 'cax11', cores: 2, memory: 4, disk: 40, architecture: 'arm', prices: [price('nbg1', '3.50')] },
        { name: 'cpx22', cores: 2, memory: 4, disk: 80, architecture: 'x86', prices: [price('nbg1', '6.00'), price('hel1', '5.50')] },
        { name: 'cx23', cores: 2, memory: 4, disk: 40, architecture: 'x86', prices: [price('nbg1', '4.15'), price('fsn1', '4.15'), price('ash', '3.90')] },
        { name: 'cx33', cores: 4, memory: 8, disk: 80, architecture: 'x86', prices: [price('nbg1', '6.59'), price('fsn1', '6.59')] },
        { name: 'cpx32', cores: 4, memory: 8, disk: 160, architecture: 'x86', prices: [price('nbg1', '12.00')] },
        { name: 'cx43', cores: 8, memory: 16, disk: 160, architecture: 'x86', prices: [price('nbg1', '11.99'), price('hel1', '11.99')] },
      ],
    })
  }
  if (req.method === 'POST' && req.url === '/servers') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const b = JSON.parse(body)
      created.push(b)
      if (created.length === 1 && b.location === 'nbg1') return reply(412, { error: { code: 'resource_unavailable', message: 'full' } })
      setTimeout(() => reply(201, { server: { id: 42, name: b.name, public_net: { ipv4: { ip: '5.75.130.50' } } }, root_password: 'never-used' }), slowCreate)
    })
    return
  }
  if (req.method === 'GET' && req.url === '/servers?label_selector=app%3Dweevils&per_page=50&sort=created:desc') return reply(200, { servers: hzServers.filter((x) => x.labels.app === 'weevils') })
  let m = /^\/servers\/(\d+)$/.exec(req.url || '')
  if (req.method === 'GET' && m) {
    const x = hzServers.find((y) => String(y.id) === m![1])
    return x ? reply(200, { server: x }) : reply(404, { error: { code: 'not_found' } })
  }
  m = /^\/servers\/(\d+)\/actions\/reset_password$/.exec(req.url || '')
  if (req.method === 'POST' && m && auth === 'Bearer goodtoken00000000000000') {
    resets.push(Number(m[1]))
    return reply(201, { root_password: 'right', action: { id: 7, command: 'reset_password', status: 'running' } })
  }
  if (req.method === 'GET' && /^\/servers\/\d+\/actions\/7$/.test(req.url || '')) return reply(200, { action: { id: 7, status: 'success' } })
  reply(404, { error: { code: 'not_found' } })
})

let hzPort = 0
let base = ''
let svc: http.Server
let gated: http.Server
let gatedBase = ''

beforeAll(async () => {
  hzPort = await listen(hetzner)
  const cfg = config({ GET_BASE: 'https://get.example', GET_HETZNER_API: `http://127.0.0.1:${hzPort}`, GET_TRUST_PROXY: '0', GET_ALLOW_TARGETS: '172.30.99.10', GET_TARGET_URLS: '172.30.99.10=https://essai.example' })
  svc = createServer(cfg).server
  base = `http://127.0.0.1:${await listen(svc)}`
  gated = createServer(config({ GET_PREVIEW_KEY: 'letmein', GET_TRUST_PROXY: '0' })).server
  gatedBase = `http://127.0.0.1:${await listen(gated)}`
})
afterAll(() => {
  hetzner.close()
  svc.close()
  gated.close()
})

const post = async (p: string, body: unknown, b = base) => {
  const r = await fetch(b + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: r.status, data: (await r.json().catch(() => ({}))) as Record<string, any> }
}
const keyPair = () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const pubB64 = (k: crypto.KeyObject) => k.export({ type: 'spki', format: 'der' }).toString('base64')
const report = (sid: string, fields: Record<string, string>) => fetch(`${base}/r/${sid}`, { method: 'POST', body: new URLSearchParams(fields) })

describe('helpers', () => {
  it('reads the step titles from install.sh, both languages', () => {
    const t = stepTitles(config().installer)
    expect(t['getting weevils']).toBe('s_source')
    expect(t['dependencies and app build']).toBe('s_build')
    expect(Object.values(t)).toContain('s_https')
    expect(Object.keys(t).some((k) => /é/.test(k))).toBe(true)
  })
  it('reads them from both spellings of the installer’s table (bash 4 arrays, bash 3.2 plain variables)', () => {
    const file = path.join(os.tmpdir(), `wvget-titles-${process.pid}.sh`)
    fs.writeFileSync(file, 'EN[s_source]="getting weevils"\nFR_s_source="récupération de weevils"\nEN_waiting="waiting for weevilsd"\nEN_usage="usage: install.sh"\nEN_s_build_extra="no"\n')
    expect(stepTitles(file)).toEqual({ 'getting weevils': 's_source', 'récupération de weevils': 's_source', 'waiting for weevilsd': 'waiting' })
    fs.rmSync(file)
  })
  it('names a machine by its address', () => {
    expect(sslip('203.0.113.5')).toBe('203-0-113-5.sslip.io')
  })
  it('tells private, loopback and link-local addresses from public ones', () => {
    for (const ip of ['127.0.0.1', '10.0.0.1', '192.168.1.2', '169.254.169.254', '172.16.0.1', '100.64.0.1', '::1', 'fd00::1']) expect(publicAddress(ip)).toBe(false)
    expect(publicAddress('8.8.8.8')).toBe(true)
  })
})

describe('Hetzner, from the browser (mock API)', () => {
  const o = () => ({ api: `http://127.0.0.1:${hzPort}`, wait: async () => {} })
  // One setup for this whole block (the service allows a dozen new setups an hour per address).
  let job: any
  beforeAll(async () => (job = (await post('/api/job', { kind: 'hetzner', lang: 'en', pub: pubB64(keyPair().publicKey) })).data))
  it('quotes three sizes (4, 8, 16 GB) with their agents and the cheapest x86 type near the person', async () => {
    const q = await HZ.quote('goodtoken00000000000000', 'europe', o())
    // What the person pays, VAT included: the type plus its IPv4 address, by the hour, never more than the month.
    expect(q.sizes.map((z: any) => [z.size, z.type, z.location, z.hourly, z.monthly, z.ipv4, z.agents])).toEqual([
      ['light', 'cx23', 'nbg1', 0.0076, 4.745, true, '2-3'],
      ['recommended', 'cx33', 'nbg1', 0.0115, 7.185, true, '6'],
      ['strong', 'cx43', 'nbg1', 0.0202, 12.585, true, '12'],
    ])
    expect((await HZ.quote('goodtoken00000000000000', 'america', o())).sizes[0]).toMatchObject({ type: 'cx23', location: 'ash', monthly: 4.495 })
    await expect(HZ.quote('badtoken000000000000000', 'europe', o())).rejects.toMatchObject({ hz: 'unauthorized', status: 401 })
  })
  it('creates the server from the browser with the setup’s cloud-init, and tells the service only the server', async () => {
    // The page gets the cloud-init of its setup: it only runs that setup's install script.
    expect(job.userData).toBe(`#cloud-config\nruncmd:\n  - [bash, -c, "curl -fsSL --retry 5 --retry-delay 3 https://get.example/install.sh | bash -s ${job.sid} > /var/log/weevils-get.log 2>&1"]\n`)
    await expect(HZ.create('readonlytoken0000000000', { sid: job.sid, size: 'light', userData: job.userData }, o())).rejects.toMatchObject({ hz: 'forbidden', status: 403 })
    const s = await HZ.create('goodtoken00000000000000', { sid: job.sid, size: 'recommended', userData: job.userData }, o())
    // Full in the first place: the next option.
    expect(s).toMatchObject({ ip: '5.75.130.50', type: 'cx33', location: 'fsn1', size: 'recommended', agents: '6' })
    const sent = created.at(-1) as Record<string, any>
    expect(sent.image).toBe('ubuntu-24.04')
    expect(sent.user_data).toBe(job.userData)
    expect(sent.labels).toEqual({ app: 'weevils', weevils: 'true', 'weevils-sid': job.sid })
    expect(JSON.stringify(s)).not.toMatch(/never-used/)
    expect((await post('/api/hetzner/created', { sid: job.sid, view: job.view, server: { ...s, size: 'huge' } })).data.error).toBe('bad_size')
    expect((await post('/api/hetzner/created', { sid: job.sid, view: job.view, server: { ...s, ip: '127.0.0.1' } })).data.error).toBe('bad_server')
    const ok = await post('/api/hetzner/created', { sid: job.sid, view: job.view, server: s })
    expect(ok.status).toBe(200)
    expect(ok.data).toMatchObject({ state: 'running', step: 'created', reach: '5-75-130-50.sslip.io', server: { id: 42, ip: '5.75.130.50', type: 'cx33', size: 'recommended', agents: '6' } })
    // Told again (a second tap, a page reopened): the same server, never another.
    expect((await post('/api/hetzner/created', { sid: job.sid, view: job.view, server: { ...s, id: 43 } })).data.server.id).toBe(42)
  })
  it('lists the servers weevils made on the account and gets a fresh root password, all from the browser', async () => {
    hzServers.push(hzServer(801, 'weevils-aaaaaa', { app: 'weevils', 'weevils-sid': 'abcdefghjk' }), hzServer(802, 'my-database'))
    const list = await HZ.servers('goodtoken00000000000000', o())
    expect(list).toEqual([expect.objectContaining({ id: 801, sid: 'abcdefghjk', ip: '172.30.99.10', location: 'Nuremberg', weevils: true })])
    expect(await HZ.rootPassword('goodtoken00000000000000', 801, o())).toBe('right')
    expect(resets.at(-1)).toBe(801)
    hzServers.length = 0
  })
  it('takes no token anywhere: the token-taking routes are gone, and the page may only talk to Hetzner besides itself', async () => {
    for (const r of ['quote', 'servers', 'create', 'continue']) expect((await post(`/api/hetzner/${r}`, { sid: job.sid, view: job.view, token: 'goodtoken00000000000000', size: 'light' })).status).toBe(404)
    const csp = (await fetch(base + '/')).headers.get('content-security-policy') || ''
    expect(csp).toMatch(/connect-src 'self' https:\/\/api\.hetzner\.cloud;/)
    const lib = await fetch(base + '/hetzner.js')
    expect(lib.headers.get('content-type')).toMatch(/^text\/javascript/)
    expect(await lib.text()).toContain('export async function create(')
    const src = fs.readFileSync(path.join(import.meta.dirname, 'server.mjs'), 'utf8')
    expect(src).not.toMatch(/b\.token|authorization: `Bearer/)
  })
  it('needs the page’s view token for every call', async () => {
    expect((await post('/api/status', { sid: job.sid, view: 'x'.repeat(job.view.length) })).status).toBe(404)
    expect((await post('/api/hetzner/created', { sid: job.sid, server: { id: 1, ip: '5.75.130.50', size: 'light' } })).status).toBe(404)
  })
})

describe('Hostinger is no longer offered', () => {
  it('refuses a Hostinger setup and has no Hostinger route', async () => {
    expect((await post('/api/job', { kind: 'hostinger', lang: 'en', pub: pubB64(keyPair().publicKey) })).status).toBe(400)
    const job = (await post('/api/job', { kind: 'hetzner', lang: 'en', pub: pubB64(keyPair().publicKey) })).data
    expect((await post('/api/hostinger/quote', { sid: job.sid, view: job.view, token: '123|hostingertoken000000000' })).status).toBe(404)
  })
})

describe('an install, end to end through the API', () => {
  it('serves its script, keeps only allowlisted step titles, and relays a link only the page can open', async () => {
    const { publicKey, privateKey } = keyPair()
    const job = (await post('/api/job', { kind: 'ssh', lang: 'fr', pub: pubB64(publicKey) })).data
    // The command pasted on the machine: its first request starts the setup (from here, an address the Internet
    // can't reach: set up like a computer, with a link of its own).
    expect(await (await fetch(`${base}/i/${job.sid}.env`)).text()).toMatch(/^lang=fr\nmode=pc\nreach=\n/)
    const script = await (await fetch(`${base}/i/${job.sid}`)).text()
    expect(script).not.toMatch(/@[A-Z]+@/)
    expect(script).toContain(`SID='${job.sid}'`)
    expect(script).toContain(`MODE='pc'`)
    execFileSync('bash', ['-n'], { input: script })

    await report(job.sid, { event: 'start' })
    await report(job.sid, { event: 'step', title: 'récupération de weevils' })
    await report(job.sid, { event: 'step', title: '  code : SECRET123' })
    let st = (await post('/api/status', { sid: job.sid, view: job.view })).data
    expect(st.steps).toEqual(['created', 'start', 's_source'])
    expect(JSON.stringify(st)).not.toContain('SECRET123')

    // The bootstrap's own openssl command, then the page's RSA-OAEP SHA-256 decryption.
    const link = 'https://essai.example/#k=AbCdEf123456'
    const der = Buffer.from(pubB64(publicKey), 'base64')
    const fs = await import('node:fs')
    const tmp = `/tmp/wvget-test-${process.pid}.der`
    fs.writeFileSync(tmp, der)
    const sealed = execFileSync('openssl', ['pkeyutl', '-encrypt', '-pubin', '-keyform', 'DER', '-inkey', tmp, '-pkeyopt', 'rsa_padding_mode:oaep', '-pkeyopt', 'rsa_oaep_md:sha256', '-pkeyopt', 'rsa_mgf1_md:sha256'], { input: link }).toString('base64')
    fs.rmSync(tmp)
    await report(job.sid, { event: 'done', url: 'https://essai.example', mode: 'public', ready: 'no', sealed })
    st = (await post('/api/status', { sid: job.sid, view: job.view })).data
    expect(st.state).toBe('done')
    expect(st.result.url).toBe('https://essai.example')
    const opened = crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(st.result.sealed, 'base64')).toString()
    expect(opened).toBe(link)
    // A finished setup no longer serves its script.
    expect((await fetch(`${base}/i/${job.sid}`)).status).toBe(404)
  })
  it('reports a failure without anything that looks like a login link', async () => {
    const job = (await post('/api/job', { kind: 'pc', lang: 'en', pub: pubB64(keyPair().publicKey) })).data
    expect(job.command).toBe(`curl -fsSL https://get.example/install.sh | bash -s ${job.sid}`)
    await fetch(`${base}/i/${job.sid}.env`)
    await report(job.sid, { event: 'failed', error: 'oops https://x/#k=abc' })
    const st = (await post('/api/status', { sid: job.sid, view: job.view })).data
    expect(st.state).toBe('failed')
    expect(st.error).not.toContain('abc')
  })
  it('takes the two steps the bootstrap does itself by name, and no other name', async () => {
    const job = (await post('/api/job', { kind: 'pc', lang: 'en', pub: pubB64(keyPair().publicKey) })).data
    await report(job.sid, { event: 'start' })
    await report(job.sid, { event: 'step', step: 's_system' })
    await report(job.sid, { event: 'step', step: 'done' })
    await report(job.sid, { event: 'step', step: 'https://x/#k=abc' })
    await report(job.sid, { event: 'step', step: 'tunnel' })
    const st = (await post('/api/status', { sid: job.sid, view: job.view })).data
    expect(st.state).toBe('running')
    expect(st.steps).toEqual(['start', 's_system', 'tunnel'])
  })
  it('rejects a weak or malformed page key', async () => {
    const weak = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey
    expect((await post('/api/job', { kind: 'pc', pub: pubB64(weak) })).data.error).toBe('bad_key')
    expect((await post('/api/job', { kind: 'pc', pub: 'A'.repeat(300) })).data.error).toBe('bad_key')
  })
})

describe('coming back to a setup (page closed, another browser, the same token)', () => {
  const GOOD = 'goodtoken00000000000000'
  // Its own service: behind a proxy (Caddy), each test from its own address, so the rate limits stay out of the way.
  let base2 = ''
  let store: any
  let svc2: http.Server
  let ip = ''
  let n = 0
  beforeAll(async () => {
    const cfg = config({ GET_BASE: 'https://get.example', GET_HETZNER_API: `http://127.0.0.1:${hzPort}`, GET_ALLOW_TARGETS: '172.30.99.10', GET_TARGET_URLS: '172.30.99.10=https://essai.example', GET_HANDOFF: '' })
    const made = createServer(cfg, { notifier: null })
    svc2 = made.server
    store = made.store
    base2 = `http://127.0.0.1:${await listen(svc2)}`
  })
  afterAll(() => svc2.close())
  beforeEach(() => (ip = `198.51.100.${++n}`))
  const post = async (p: string, body: unknown, ua = 'iPhone test') => {
    const r = await fetch(base2 + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, 'user-agent': ua }, body: JSON.stringify(body) })
    return { status: r.status, data: (await r.json().catch(() => ({}))) as Record<string, any> }
  }
  const report = (sid: string, fields: Record<string, string>) => fetch(`${base2}/r/${sid}`, { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.9' }, body: new URLSearchParams(fields) })
  const b64u = (b: Buffer) => b.toString('base64url')
  /** What the page derives from its resume link's secret: the token for the status, the key that seals its own key. */
  const fromSecret = (secret: string) => ({
    view: b64u(crypto.createHash('sha256').update(`weevils-view:${secret}`).digest()),
    box: crypto.createHash('sha256').update(`weevils-key:${secret}`).digest(),
  })
  const seal = (box: Buffer, text: string) => {
    const iv = crypto.randomBytes(12)
    const c = crypto.createCipheriv('aes-256-gcm', box, iv)
    return Buffer.concat([iv, c.update(text), c.final(), c.getAuthTag()]).toString('base64')
  }
  const open = (box: Buffer, wrapped: string) => {
    const all = Buffer.from(wrapped, 'base64')
    const d = crypto.createDecipheriv('aes-256-gcm', box, all.subarray(0, 12))
    d.setAuthTag(all.subarray(-16))
    return Buffer.concat([d.update(all.subarray(12, -16)), d.final()]).toString()
  }
  const pageJob = async (kind: string, ua = 'iPhone test') => {
    const kp = keyPair()
    const secret = b64u(crypto.randomBytes(16))
    const { view, box } = fromSecret(secret)
    const jwk = JSON.stringify(kp.privateKey.export({ format: 'jwk' }))
    const j = (await post('/api/job', { kind, lang: 'en', pub: pubB64(kp.publicKey), view, wrapped: seal(box, jwk) }, ua)).data as any
    return { ...j, secret, box, kp, jwk }
  }

  it('lets a page derive its own view token and leave its key sealed: a resume link alone gets both back', async () => {
    const job = await pageJob('hetzner')
    expect(job.view).toBe(fromSecret(job.secret).view)
    const plain = (await post('/api/status', { sid: job.sid, view: job.view })).data
    expect(plain.wrapped).toBeUndefined()
    const full = (await post('/api/status', { sid: job.sid, view: job.view, full: true })).data
    expect(open(fromSecret(job.secret).box, full.wrapped)).toBe(job.jwk)
    // A page from before (no token of its own): the service picks one, as it always did.
    const old = (await post('/api/job', { kind: 'hetzner', lang: 'en', pub: pubB64(keyPair().publicKey) })).data
    expect(old.view).toMatch(/^[A-Za-z0-9_-]{24}$/)
  })

  it('keeps a failure for the page that comes back, and tells how far the account’s setups are (no token)', async () => {
    const bad = await pageJob('hetzner')
    expect((await post('/api/hetzner/failed', { sid: bad.sid, view: bad.view, error: 'forbidden' })).status).toBe(200)
    expect((await post('/api/status', { sid: bad.sid, view: bad.view })).data).toMatchObject({ state: 'waiting', creating: false, createError: 'forbidden' })
    const first = await pageJob('hetzner')
    Object.assign(store.get(first.sid), { server: { id: 601, name: `weevils-${first.sid.slice(0, 6)}`, ip: '172.30.99.10' }, state: 'running' })
    await report(first.sid, { event: 'step', title: 'getting weevils' })
    const r = (await post('/api/hetzner/setups', { sid: bad.sid, view: bad.view, sids: [first.sid, 'zzzzzzzzzz', 'not a sid'] })).data
    expect(r.setups).toEqual({ [first.sid]: { state: 'running', step: 's_source', steps: expect.any(Array) } })
    expect(JSON.stringify(r)).not.toMatch(/172\.30|weevils-/)
  })

  it('takes over a setup still installing, by the server’s label (the install asks for the page’s key at the end)', async () => {
    const first = await pageJob('hetzner')
    Object.assign(store.get(first.sid), { server: { id: 601, name: `weevils-${first.sid.slice(0, 6)}`, ip: '172.30.99.10' }, state: 'running' })
    expect((await fetch(`${base2}/i/${first.sid}`)).status).toBe(200)
    const second = await pageJob('hetzner', 'another browser')
    expect((await post('/api/hetzner/attach', { sid: second.sid, view: second.view, label: 'zzzzzzzzzz' })).data.error).toBe('not_live')
    expect((await post('/api/hetzner/attach', { sid: second.sid, view: second.view, label: first.sid, server: 999 })).data.error).toBe('not_live')
    const r = (await post('/api/hetzner/attach', { sid: second.sid, view: second.view, label: first.sid, server: 601 })).data
    expect(r).toMatchObject({ attached: true, sid: first.sid, state: 'running' })
    // The second page's resume link now opens the first setup; the first page's no longer does.
    expect((await post('/api/status', { sid: first.sid, view: second.view })).status).toBe(200)
    expect((await post('/api/status', { sid: first.sid, view: first.view })).status).toBe(404)
    expect(await (await fetch(`${base2}/k/${first.sid}`)).text()).toBe(pubB64(second.kp.publicKey))
    // A finished one is not taken over.
    store.get(first.sid).state = 'done'
    const third = await pageJob('hetzner', 'a third browser')
    expect((await post('/api/hetzner/attach', { sid: third.sid, view: third.view, label: first.sid, server: 601 })).data.error).toBe('not_live')
  })

  it('starts the install again on a finished or forgotten server with the same command, pasted in its console', async () => {
    // The page shows Hetzner's new root password itself: the service only gives this setup's command.
    const job = await pageJob('hetzner')
    expect(job.command).toBe(`curl -fsSL https://get.example/install.sh | bash -s ${job.sid}`)
    expect(job.userData).toContain(`/install.sh | bash -s ${job.sid}`)
    const env = await (await fetch(`${base2}/i/${job.sid}.env`, { headers: { 'x-forwarded-for': '172.30.99.10' } })).text()
    expect(env).toMatch(/^lang=en\nmode=url\nreach=https:\/\/essai\.example\npub=/)
    expect((await post('/api/status', { sid: job.sid, view: job.view })).data).toMatchObject({ state: 'running', step: 'created', server: { ip: '172.30.99.10' } })
  })

  it('takes no password, key or token anywhere', async () => {
    const job = await pageJob('ssh')
    const secrets = { password: 'right', key: '-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----', token: GOOD, host: '172.30.99.10' }
    for (const r of ['/api/ssh', '/api/hetzner/quote', '/api/hetzner/create', '/api/hetzner/continue', '/api/hetzner/servers']) expect((await post(r, { sid: job.sid, view: job.view, ...secrets })).status).toBe(404)
    // The routes that remain ignore such fields and never keep them.
    for (const r of ['/api/status', '/api/hetzner/setups', '/api/hetzner/attach', '/api/hetzner/failed']) await post(r, { sid: job.sid, view: job.view, ...secrets })
    expect(JSON.stringify(store.get(job.sid))).not.toMatch(/right|goodtoken|PRIVATE KEY/)
    const src = fs.readFileSync(path.join(import.meta.dirname, 'server.mjs'), 'utf8')
    expect(src).not.toMatch(/b\.(password|key|token)\b|spawn\(|askpass/)
  })

  it('gives a VPS the same command as a computer: pasted there, it starts, its address from where it asks', async () => {
    const job = await pageJob('ssh')
    expect(job.command).toBe(`curl -fsSL https://get.example/install.sh | bash -s ${job.sid}`)
    expect(job.win).toBeUndefined()
    expect((await post('/api/status', { sid: job.sid, view: job.view, full: true })).data.command).toBe(job.command)
    expect((await post('/api/status', { sid: job.sid, view: job.view })).data.state).toBe('waiting')
    const env = await (await fetch(`${base2}/i/${job.sid}.env`, { headers: { 'x-forwarded-for': '5.75.130.77' } })).text()
    expect(env).toMatch(/^lang=en\nmode=vps\nreach=5-75-130-77\.sslip\.io\npub=/)
    expect((await post('/api/status', { sid: job.sid, view: job.view })).data).toMatchObject({ state: 'running', step: 'created', server: { ip: '5.75.130.77' } })
    // Pasted on a machine the Internet can't reach: set up like a computer (a link of its own for the phone).
    const home = await pageJob('ssh')
    expect(await (await fetch(`${base2}/i/${home.sid}.env`, { headers: { 'x-forwarded-for': '192.168.1.20' } })).text()).toMatch(/\nmode=pc\nreach=\n/)
  })

  it('shows the same browser at the same address how far its setup is, and nothing that opens it', async () => {
    const job = await pageJob('hetzner', 'Mozilla/5.0 (iPhone) nearby-test')
    expect((await post('/api/nearby', {}, 'Mozilla/5.0 (iPhone) nearby-test')).data.jobs).toEqual([])
    store.get(job.sid).server = { id: 9, name: 'weevils-abcdef', ip: '198.51.100.9' }
    store.get(job.sid).state = 'running'
    const r = (await post('/api/nearby', {}, 'Mozilla/5.0 (iPhone) nearby-test')).data
    expect(r.jobs).toEqual([{ kind: 'hetzner', state: 'running', step: 'created', steps: [], created: expect.any(Number), creating: false }])
    expect(JSON.stringify(r)).not.toMatch(new RegExp(`${job.sid}|${job.view}|198\\.51|weevils-abcdef`))
    expect((await post('/api/nearby', {}, 'another phone')).data.jobs).toEqual([])
    ip = '198.51.100.250'
    expect((await post('/api/nearby', {}, 'Mozilla/5.0 (iPhone) nearby-test')).data.jobs).toEqual([])
  })

  it('keeps a finished setup’s link for days, then an hour after the first login on the new weevils', async () => {
    const job = await pageJob('ssh')
    Object.assign(store.get(job.sid), { state: 'running', server: { ip: '172.30.99.10' } })
    const link = 'https://essai.example/#k=abc123'
    const sealed = crypto.publicEncrypt({ key: job.kp.publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(link)).toString('base64')
    await report(job.sid, { event: 'done', url: 'https://essai.example', mode: 'public', ready: 'yes', sealed })
    const j = store.get(job.sid)
    // Long after the old 10-minute limit, and 6 days later: still there.
    j.touched = Date.now() - 6 * 864e5
    store.sweep()
    expect((await post('/api/status', { sid: job.sid, view: job.view })).data.result.sealed).toBe(sealed)
    // The first login there says so (server/get-claim.ts): an hour more, then the link goes.
    expect((await report(job.sid, { event: 'claimed' })).status).toBe(200)
    expect((await post('/api/status', { sid: job.sid, view: job.view })).data).toMatchObject({ claimed: true, result: { sealed } })
    j.claimed = Date.now() - 2 * 3600_000
    store.sweep()
    const after = (await post('/api/status', { sid: job.sid, view: job.view, full: true })).data
    expect(after).toMatchObject({ state: 'done', claimed: true, result: { url: 'https://essai.example', sealed: '' }, wrapped: '' })
    j.touched = Date.now() - 8 * 864e5
    store.sweep()
    expect((await post('/api/status', { sid: job.sid, view: job.view })).status).toBe(404)
  })

  it('hands everything to the next run, from either handoff format, and says when a call to the host was cut short', () => {
    const file = path.join(os.tmpdir(), `wvget-handoff-${process.pid}`)
    const a = createStore()
    const j = a.create('hetzner', 'en', 'pub', { view: 'v'.repeat(43), wrapped: 'w'.repeat(120), near: 'n' })
    j.creating = true
    expect(saveJobs(a, file)).toBe(1)
    const b = createStore()
    expect(loadJobs(b, file)).toBe(1)
    expect(b.salt).toBe(a.salt)
    expect(b.get(j.sid)).toMatchObject({ view: 'v'.repeat(43), wrapped: 'w'.repeat(120), creating: false, createError: 'interrupted' })
    fs.writeFileSync(file, JSON.stringify([{ sid: 'abcdefghjk', view: 'x', state: 'running', touched: Date.now(), steps: [] }]))
    const c = createStore()
    expect(loadJobs(c, file)).toBe(1)
    expect(c.get('abcdefghjk')).toMatchObject({ state: 'running', claimed: 0, wrapped: '' })
  })

  it('tells the setup page once, at the first login on the new weevils', async () => {
    const file = path.join(os.tmpdir(), `wvget-claim-${process.pid}`)
    const posts: string[] = []
    const post = (async (u: string, o: any) => (posts.push(`${u} ${o.body}`), new Response('{}'))) as any
    expect(claimSetup(file, post)).toBe(false)
    fs.writeFileSync(file, 'https://get.scarville.tech/r/abcdefghjk\n')
    expect(claimSetup(file, post)).toBe(true)
    expect(posts).toEqual(['https://get.scarville.tech/r/abcdefghjk event=claimed'])
    expect(fs.existsSync(file)).toBe(false)
    expect(claimSetup(file, post)).toBe(false)
    fs.writeFileSync(file, 'http://evil.example/r/abcdefghjk')
    expect(claimSetup(file, post)).toBe(false)
    expect(posts.length).toBe(1)
  })
})

describe('anonymous stats', () => {
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
  const today = () => new Date().toISOString().slice(0, 10)
  it('counts visits, visitors, sources, devices, countries, previews and the funnel; keeps the register and the records; nothing about anyone', async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'get-stats-'))
    fs.mkdirSync(path.join(data, 'stats'))
    fs.writeFileSync(path.join(data, 'stats', '2000-01-01.json'), '{}')
    const installed: string[] = []
    const env = { GET_TRUST_PROXY: '0', GET_HANDOFF: '', GET_DATA: data, GET_STATS_LOCAL: '1', GET_STATS_KEY: 'k'.repeat(24) }
    const one = createServer(config(env), { notifier: { installed: (kind: string) => installed.push(kind), day: () => {} } })
    const b = `http://127.0.0.1:${await listen(one.server)}`
    // Older than 90 days: gone.
    expect(fs.existsSync(path.join(data, 'stats', '2000-01-01.json'))).toBe(false)
    const hit = (body: object, ua = iphone) => fetch(b + '/api/hit', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': ua }, body: JSON.stringify(body) })
    await hit({ e: 'open', ref: 'https://t.co', tz: 'Europe/Paris' })
    await hit({ e: 'open', ref: '', tz: 'Europe/Paris' })
    await hit({ e: 'open', ref: 'android-app://com.whatsapp/', tz: 'America/New_York' }, 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile Safari/537.36')
    await hit({ e: 'open' }, 'curl/8.5.0') // a script, not a visit
    await fetch(b + '/', { headers: { 'user-agent': 'WhatsApp/2.23.20.0 A' } })
    await fetch(b + '/', { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0' } })
    await hit({ e: 'chose', kind: 'pc' })
    await hit({ e: 'chose', kind: 'nope' })
    // A computer: the setup (with the page's time zone), its script fetched, its last report.
    const job = (await post('/api/job', { kind: 'pc', pub: pubB64(keyPair().publicKey), tz: 'Europe/Paris' }, b)).data
    await fetch(b + `/i/${job.sid}`)
    await fetch(b + `/r/${job.sid}`, { method: 'POST', body: new URLSearchParams({ event: 'done', url: 'https://x.example', mode: 'public', ready: 'yes', version: 'abcdef1' }) })
    await hit({ e: 'switch', kind: 'pc' })
    one.stats.flush()
    const file = path.join(data, 'stats', `${today()}.json`)
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ visits: 3, visitors: 2, sources: { twitter: 1, direct: 1, whatsapp: 1 }, devices: { iphone: 2, android: 1 }, countries: { FR: 2, US: 1 }, previews: { whatsapp: 1, imessage: 1 }, chose: { pc: 1 }, started: { pc: 1 }, succeeded: { pc: 1 }, switched: { pc: 1 } })
    expect(installed).toEqual(['pc'])
    const register = fs.readFileSync(path.join(data, 'installs.csv'), 'utf8').trim().split('\n')
    expect(register[0]).toBe('time,host,country,version,id,origin')
    expect(register[1]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z,computer,FR,abcdef1,[a-z2-9]{8},live$/)
    expect(JSON.parse(fs.readFileSync(path.join(data, 'records.json'), 'utf8'))).toEqual({ visits: { day: today(), n: 3 }, installs: { day: today(), n: 1 } })
    // Nothing that leads back to anyone, anywhere on disk.
    for (const f of [file, path.join(data, 'installs.csv'), path.join(data, 'records.json')]) {
      const text = fs.readFileSync(f, 'utf8')
      expect(text).not.toContain('127.0.0.1')
      expect(text).not.toMatch(/iPhone OS|Android 14|Europe\/Paris/)
    }
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600')
    // The private page: records first; behind its key; the register as CSV.
    const page = await fetch(b + `/stats/${'k'.repeat(24)}`)
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('visits, the record day')
    expect(html).toContain('computer')
    expect((await fetch(b + `/stats/${'x'.repeat(24)}`)).status).toBe(404)
    expect(await (await fetch(b + `/stats/${'k'.repeat(24)}/installs.csv`)).text()).toContain(',computer,FR,abcdef1,')
    // « N people already run weevils »: off by default, on with GET_PUBLIC_COUNT=1.
    expect(await (await fetch(b + '/')).text()).not.toContain('data-count=')
    const two = createServer(config({ ...env, GET_PUBLIC_COUNT: '1' }), { notifier: null })
    const b2 = `http://127.0.0.1:${await listen(two.server)}`
    expect(await (await fetch(b2 + '/')).text()).toContain('<html lang="en" data-count="1">')
    one.server.close()
    two.server.close()
    one.stats.stop()
    two.stats.stop()
    expect(describeStats([JSON.parse(fs.readFileSync(file, 'utf8'))])).toMatch(/3 visits, about 2 visitors[\s\S]*Funnel: 1 \(computer 1\) picked an option/)
  })
  it('rebuilds the days before it from Caddy\'s log, without this VPS\'s own traffic', () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'get-backfill-'))
    const t0 = Date.parse('2026-11-13T21:00:00Z') / 1000
    const line = (dt: number, ip: string, method: string, uri: string, status: number, ua = iphone, ref = '') => JSON.stringify({ ts: t0 + dt, status, request: { client_ip: ip, method, host: 'get.scarville.tech', uri, headers: { 'User-Agent': [ua], ...(ref && { Referer: [ref] }) } } })
    const log = [
      line(0, '203.0.113.5', 'GET', '/', 200, iphone, 'https://t.co/'),
      line(1, '203.0.113.5', 'GET', '/', 200),
      line(2, '203.0.113.250', 'GET', '/', 200),
      line(3, '172.17.0.2', 'GET', '/', 200),
      line(4, '198.51.100.9', 'GET', '/', 200, 'Mozilla/5.0 HeadlessChrome/131.0'),
      line(5, '198.51.100.10', 'GET', '/', 404, 'WhatsApp/2.23.20.0 A'),
      line(10, '203.0.113.5', 'POST', '/api/hetzner/quote', 200),
      line(20, '203.0.113.5', 'POST', '/api/hetzner/create', 200),
      line(80, '198.51.100.7', 'GET', '/i/abcdefghjk', 200, 'curl/8.5.0'),
      line(81, '198.51.100.7', 'GET', '/weevils.bundle?sid=abcdefghjk', 200, 'curl/8.5.0'),
      ...[90, 100, 110, 120, 130, 140].map((dt) => line(dt, '198.51.100.7', 'POST', '/r/abcdefghjk', 200, 'curl/8.5.0')),
    ].join('\n')
    const r = spawnSync('node', [path.join(import.meta.dirname, 'backfill.mjs')], { input: log, env: { ...process.env, GET_DATA: data, GET_OWN_IPS: '203.0.113.250' }, encoding: 'utf8' })
    expect(r.status).toBe(0)
    expect(r.stdout).not.toMatch(/\d+\.\d+\.\d+\.\d+/)
    expect(JSON.parse(fs.readFileSync(path.join(data, 'stats', '2026-11-13.json'), 'utf8'))).toMatchObject({ visits: 2, visitors: 1, sources: { twitter: 1, direct: 1 }, previews: { whatsapp: 1 }, chose: { hetzner: 1 }, started: { hetzner: 1 }, succeeded: { hetzner: 1 }, bundles: 1 })
    expect(fs.readFileSync(path.join(data, 'installs.csv'), 'utf8')).toMatch(/\n2026-11-13T21:02:20\.000Z,Hetzner,\?\?,,[a-z2-9]{8},log\n$/)
    expect(JSON.parse(fs.readFileSync(path.join(data, 'records.json'), 'utf8'))).toEqual({ visits: { day: '2026-11-13', n: 2 }, installs: { day: '2026-11-13', n: 1 } })
  })
})

describe('guards', () => {
  it('hides the page and API behind the preview key until launch, without relying on a redirect or a cookie', async () => {
    const gate = await fetch(gatedBase + '/')
    expect(gate.status).toBe(404)
    expect(await gate.text()).toContain('location.replace("/?k="')
    expect((await post('/api/job', { kind: 'pc', pub: 'x' }, gatedBase)).status).toBe(404)
    expect((await fetch(gatedBase + '/?k=wrong')).status).toBe(404)
    // The key in the URL opens the page directly (no 302), and keeps working on reload.
    const page = await fetch(gatedBase + '/?k=letmein', { redirect: 'manual' })
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    // The page's own assets are public; its API calls carry the key in a header.
    expect((await fetch(gatedBase + '/qrcode.js')).status).toBe(200)
    const r = await fetch(gatedBase + '/api/job', { method: 'POST', headers: { 'content-type': 'application/json', 'x-get-key': 'letmein' }, body: JSON.stringify({ kind: 'pc', pub: pubB64(keyPair().publicKey) }) })
    expect(r.status).toBe(200)
    // A cookie still works too.
    expect((await fetch(gatedBase + '/', { headers: { cookie: 'gk=letmein' } })).status).toBe(200)
  })
  it('open to anyone since the launch: an old ?k= link still opens the page, which carries its share card', async () => {
    const page = await fetch(base + '/?k=anOldSharedKey', { redirect: 'manual' })
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('<meta property="og:title" content="weevils — your AI dev team, in your pocket">')
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">')
    // Versioned by the image's own hash: X keeps a card per URL.
    const v = crypto.createHash('sha256').update(fs.readFileSync(path.join(import.meta.dirname, 'og.png'))).digest('hex').slice(0, 8)
    expect(html).toContain(`<meta property="og:image" content="https://tryweevils.scarville.tech/og.png?v=${v}">`)
    expect(html).toContain(`<meta name="twitter:image" content="https://tryweevils.scarville.tech/og.png?v=${v}">`)
    // The card: a PNG of 1200×630, small enough for WhatsApp's previews.
    const card = await fetch(base + '/og.png')
    expect(card.headers.get('content-type')).toBe('image/png')
    const png = Buffer.from(await card.arrayBuffer())
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630])
    expect(png.length).toBeLessThan(300_000)
  })
  it('a restart keeps the setups in progress: the stopping service hands them to the next one through RAM', async () => {
    const handoff = path.join(os.tmpdir(), `get-handoff-${process.pid}.jobs`)
    const one = createServer(config({ GET_TRUST_PROXY: '0', GET_HANDOFF: handoff }))
    const job = (await post('/api/job', { kind: 'pc', pub: pubB64(keyPair().publicKey) }, `http://127.0.0.1:${await listen(one.server)}`)).data
    expect(await one.drain()).toBe(1)
    expect((fs.statSync(handoff).mode & 0o777).toString(8)).toBe('600')
    const two = createServer(config({ GET_TRUST_PROXY: '0', GET_HANDOFF: handoff }))
    expect(loadJobs(two.store, handoff)).toBe(1)
    expect(fs.existsSync(handoff)).toBe(false)
    const st = await post('/api/status', { sid: job.sid, view: job.view }, `http://127.0.0.1:${await listen(two.server)}`)
    two.server.close()
    expect(st.status).toBe(200)
    expect(st.data).toMatchObject({ sid: job.sid, kind: 'pc', state: 'waiting' })
  })
  it('lets an installed weevils update itself: the version, the snapshot, the script for older installs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'get-bundle-'))
    fs.writeFileSync(path.join(dir, 'w.bundle'), 'BUNDLE')
    fs.writeFileSync(path.join(dir, 'w.bundle.rev'), 'a'.repeat(40) + '\n')
    const own = createServer(config({ GET_TRUST_PROXY: '0', GET_BUNDLE: path.join(dir, 'w.bundle'), GET_HANDOFF: '' })).server
    const b = `http://127.0.0.1:${await listen(own)}`
    expect(await (await fetch(b + '/version')).json()).toEqual({ rev: 'a'.repeat(40), short: 'aaaaaaa' })
    const codes = []
    for (let i = 0; i < 7; i++) codes.push((await fetch(b + '/weevils.bundle')).status)
    expect(codes).toEqual([200, 200, 200, 200, 200, 200, 404])
    const script = await (await fetch(b + '/update')).text()
    own.close()
    expect(script).toContain('weevils-update')
    expect(script).toContain('_weevils_update "$@"')
  })
  it('claims nothing until the public repository is open: then « The code is open, on GitHub », with its link', async () => {
    let open = false
    const github = http.createServer((req, res) => {
      if (req.url !== '/repos/Sc4rville/weevils-oss' || !open) return res.writeHead(404).end('{"message":"Not Found"}')
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"private":false}')
    })
    const api = `http://127.0.0.1:${await listen(github)}`
    const page = async (b: string) => (await fetch(b + '/')).text()
    const tick = () => new Promise((r) => setTimeout(r, 150))
    const closed = createServer(config({ GET_TRUST_PROXY: '0', GET_HANDOFF: '', GET_GITHUB_API: api })).server
    const b1 = `http://127.0.0.1:${await listen(closed)}`
    await page(b1)
    await tick()
    expect(await page(b1)).not.toContain('data-code=')
    open = true
    const opened = createServer(config({ GET_TRUST_PROXY: '0', GET_HANDOFF: '', GET_GITHUB_API: api })).server
    const b2 = `http://127.0.0.1:${await listen(opened)}`
    await page(b2)
    await tick()
    const html = await page(b2)
    closed.close()
    opened.close()
    github.close()
    expect(html).toContain('<html lang="en" data-code="https://github.com/Sc4rville/weevils-oss">')
    expect(html).toContain('<a href="https://x.com/weevilscode" data-t="soon">')
  })
  it('limits job creation per address', async () => {
    const own = createServer(config({ GET_TRUST_PROXY: '0' })).server
    const b = `http://127.0.0.1:${await listen(own)}`
    const pub = pubB64(keyPair().publicKey)
    const codes: number[] = []
    for (let i = 0; i < 14; i++) codes.push((await post('/api/job', { kind: 'pc', pub }, b)).status)
    own.close()
    expect(codes.filter((c) => c === 200)).toHaveLength(12)
    expect(codes.at(-1)).toBe(429)
  })
})

// ---- macOS
const here = path.dirname(new URL(import.meta.url).pathname)
const bootstrap = fs.readFileSync(path.join(here, 'bootstrap.sh'), 'utf8')
const page = fs.readFileSync(path.join(here, 'index.html'), 'utf8')

describe('the shared script (a computer)', () => {
  it('is the same file for everyone, with its checksum, says what it does, and reads its settings as plain values', async () => {
    const job = (await post('/api/job', { kind: 'pc', lang: 'fr', pub: pubB64(keyPair().publicKey) })).data
    const sh = await (await fetch(`${base}/install.sh`)).text()
    expect(sh).not.toMatch(/@[A-Z]+@/)
    expect(sh).not.toContain(job.sid)
    expect(sh).toContain(`SID=''`)
    for (const s of ['WHAT IT DOES', 'WHAT IT NEVER DOES', 'UNDO, in one line', '_weevils_get "$@"']) expect(sh).toContain(s)
    execFileSync('bash', ['-n'], { input: sh })
    const sum = (await (await fetch(`${base}/install.sh.sha256`)).text()).split(' ')[0]
    expect(sum).toBe(crypto.createHash('sha256').update(sh).digest('hex'))
    expect((await post('/api/status', { sid: job.sid, view: job.view })).data.state).toBe('waiting')
    const env = await (await fetch(`${base}/i/${job.sid}.env`)).text()
    expect(env).toMatch(/^lang=fr\nmode=pc\nreach=\npub=[A-Za-z0-9+/=]{200,800}\n$/)
    expect((await post('/api/status', { sid: job.sid, view: job.view })).data.state).toBe('running')
    expect((await fetch(`${base}/i/zzzzzzzzzz.env`)).status).toBe(404)
  })

  it('pins the release key, serves the security notes and the key, and installs only code the key signed', async () => {
    const sh = await (await fetch(`${base}/install.sh`)).text()
    const pub = fs.readFileSync(path.join(here, 'release-key.pub'), 'utf8').trim()
    expect(sh).toContain(`RELEASE_KEY='${pub}'`)
    expect(await (await fetch(`${base}/release-key.pub`)).text()).toBe(pub + '\n')
    const notes = await (await fetch(`${base}/security`)).text()
    for (const s of ['## What the install does', '## What leaves your machine', '## Remove it', pub.split(' ')[1]]) expect(notes).toContain(s)
    // The bootstrap's own check, cut out of the script, against a throwaway key (the real one never leaves its machine).
    const fn = /^  verify_bundle\(\) \{\n[\s\S]*?\n  \}$/m.exec(bootstrap)?.[0]
    expect(fn).toBeTruthy()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-sig-'))
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(dir, 'k')])
    fs.writeFileSync(path.join(dir, 'weevils.bundle'), 'the code')
    execFileSync('ssh-keygen', ['-q', '-Y', 'sign', '-n', 'weevils-release', '-f', path.join(dir, 'k'), path.join(dir, 'weevils.bundle')])
    // The signature is fetched from "$2/weevils.bundle.sig": here a file URL (a sync call would block a local server).
    const check = (file: string, key: string) =>
      spawnSync('bash', ['-c', `${fn}\nRELEASE_KEY="$K"; verify_bundle "$1" "$2"`, 'x', file, `file://${dir}`], { env: { ...process.env, K: key } }).status
    try {
      const good = fs.readFileSync(path.join(dir, 'k.pub'), 'utf8').trim()
      expect(check(path.join(dir, 'weevils.bundle'), good)).toBe(0)
      fs.writeFileSync(path.join(dir, 'other'), 'other code')
      expect(check(path.join(dir, 'other'), good)).not.toBe(0)
      expect(check(path.join(dir, 'weevils.bundle'), pub)).not.toBe(0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('Windows', () => {
  it('gets a PowerShell command that hands the install to WSL, and a failed run can be pasted again', async () => {
    const job = (await post('/api/job', { kind: 'pc', lang: 'en', pub: pubB64(keyPair().publicKey) })).data
    expect(job.win).toBe(`powershell -c "irm https://get.example/w/${job.sid} | iex"`)
    const ps = await (await fetch(`${base}/w/${job.sid}`)).text()
    expect(ps).toContain(`$sid = '${job.sid}'`)
    expect(ps).toContain(`wsl.exe -d $d -- bash -lc "curl -fsSL '$base/install.sh' | bash -s $sid"`)
    expect(ps).toContain('no Linux (WSL) yet')
    expect((await post('/api/status', { sid: job.sid, view: job.view })).data.state).toBe('running')
    // No WSL there: the page is told why, and the same command works once it is set up.
    await fetch(`${base}/r/${job.sid}`, { method: 'POST', body: new URLSearchParams({ event: 'failed', error: 'no WSL' }) })
    expect((await post('/api/status', { sid: job.sid, view: job.view })).data).toMatchObject({ state: 'failed', error: 'no WSL' })
    expect((await fetch(`${base}/i/${job.sid}`)).status).toBe(200)
    expect((await post('/api/status', { sid: job.sid, view: job.view })).data).toMatchObject({ state: 'running', error: '' })
    // Git Bash: the bootstrap goes to WSL itself, or says what is missing.
    expect(bootstrap).toMatch(/MINGW\* \| MSYS\* \| CYGWIN\*\)/)
    expect(page).toContain("os === 'windows' && job.win ? job.win : job.command")
  })
})

describe('a Mac', () => {
  it('gets a script that macOS’s own bash (3.2) can read', async () => {
    const job = (await post('/api/job', { kind: 'pc', lang: 'fr', pub: pubB64(keyPair().publicKey) })).data
    const script = await (await fetch(`${base}/i/${job.sid}`)).text()
    expect(script).not.toMatch(/@[A-Z]+@/)
    expect(script).toContain(`MODE='pc'`)
    // The real thing when Docker has the image (never pulled from a test), else the host's bash.
    const bash32 = spawnSync('docker', ['image', 'inspect', 'bash:3.2'], { stdio: 'ignore' }).status === 0
    const r = bash32 ? spawnSync('docker', ['run', '--rm', '-i', 'bash:3.2', 'bash', '-n'], { input: script }) : spawnSync('bash', ['-n'], { input: script })
    expect(r.stderr.toString()).toBe('')
    expect(r.status).toBe(0)
    // What bash 3.2 or the tools of macOS do not have (see the contract of the port), comments left out.
    const code = bootstrap.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
    for (const gnu of [/tail [^|\n]*--pid/, /sed -i /, /(?<!openssl )base64 -[dw] /, /readlink -f/, /date -d/, /stat -c/, /\bsha256sum\b/, /\btimeout \d/, /\bsetsid\b/, /declare -A/, /\bmapfile\b/, /\$\{[A-Za-z_]+,,\}/, /\|&/, /&>>/]) expect(code).not.toMatch(gnu)
  }, 120_000)

  it('seals the link with Node as well as with openssl, both opened the way the page does (WebCrypto RSA-OAEP, SHA-256)', async () => {
    // The page's own key pair and import (index.html: newJob, unseal).
    const pair = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt'])
    const pub = Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64')
    const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt'])
    const link = 'https://essai-mac.trycloudflare.com/#k=AbCdEf123456_-xyz'
    // The bootstrap's own shell functions, cut out of the script.
    const fns = ['seal_openssl', 'seal_node'].map((name) => new RegExp(`^  ${name}\\(\\) \\{\\n[\\s\\S]*?\\n  \\}$`, 'm').exec(bootstrap)?.[0])
    expect(fns.every(Boolean)).toBe(true)
    for (const how of ['seal_node', 'seal_openssl']) {
      const sealed = execFileSync('bash', ['-euo', 'pipefail', '-c', `${fns.join('\n')}\n${how}`], { input: link, env: { ...process.env, PUB: pub } }).toString()
      expect(sealed, how).toMatch(/^[A-Za-z0-9+/=]{340,350}$/)
      const opened = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, key, Buffer.from(sealed, 'base64')))
      expect(opened, how).toBe(link)
    }
    // No openssl at all, or one that fails (an old LibreSSL): nothing comes out, and nothing breaks the script.
    const none = execFileSync('bash', ['-euo', 'pipefail', '-c', `openssl() { return 1; }\n${fns.join('\n')}\nseal_openssl; echo "[$?]"`], { input: link, env: { ...process.env, PUB: pub } }).toString()
    expect(none).toBe('[0]\n')
    expect(bootstrap).toMatch(/\[ "\$OS" != Darwin \] \|\| order='node openssl'/)
  })

  // The page's script, run for one visitor: what the first screen shows.
  async function firstScreen(userAgent: string, lang = 'en', url = 'https://get.example/') {
    const window = new Window({ url, settings: { navigator: { userAgent } } })
    // The page's anonymous counters (/api/hit) go through sendBeacon: no network here.
    Object.defineProperty(window.navigator, 'sendBeacon', { value: () => true, configurable: true })
    const document = window.document
    document.body.innerHTML = /<body>([\s\S]*?)<script src=/.exec(page)![1]
    window.localStorage.setItem('wvlang', lang)
    const calls: string[] = []
    const fetchStub = async (p: string) => {
      calls.push(p)
      const body = p === '/api/job' ? { sid: 'abcdefghjk', view: 'v', command: 'curl -fsSL https://get.example/i/abcdefghjk | bash' } : { state: 'waiting', steps: [] }
      return { ok: true, status: 200, json: async () => body }
    }
    const code = /<script>\n([\s\S]*?)<\/script>/.exec(page)![1]
    const names = ['window', 'document', 'navigator', 'localStorage', 'location', 'matchMedia', 'scrollTo', 'getSelection', 'fetch', 'crypto', 'setTimeout', 'setInterval']
    const values = [window, document, window.navigator, window.localStorage, window.location, () => ({ matches: false }), () => {}, () => ({ selectAllChildren() {} }), fetchStub, crypto.webcrypto, () => 0, () => 0]
    new Function(...names, code)(...values)
    const app = document.getElementById('app')!
    return { app, calls, document, text: () => app.textContent || '' }
  }
  const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15'
  const LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'

  it('is offered the “connect this computer” command on the first screen, like Linux, with the nudge toward a server', async () => {
    const mac = await firstScreen(MAC)
    await vi.waitFor(() => expect(mac.text()).toContain('curl -fsSL https://get.example/i/abcdefghjk | bash'), { timeout: 20_000 })
    expect(mac.calls).toContain('/api/job')
    expect(mac.text()).toContain('Connect this computer')
    expect(mac.text()).toContain('Better: a server')
    expect(mac.text()).toContain('your phone and computer are off')
    expect(mac.text()).toContain('Mac password')
    expect(mac.text()).not.toMatch(/Linux for now|take a VPS/)
    // Same screen for Linux, without the Mac note; a phone gets servers first and no command.
    const linux = await firstScreen(LINUX)
    await vi.waitFor(() => expect(linux.text()).toContain('curl -fsSL https://get.example/i/abcdefghjk | bash'), { timeout: 20_000 })
    expect(linux.text()).toContain('Connect this computer')
    expect(linux.text()).not.toContain('Mac password')
    const phone = await firstScreen(IPHONE)
    // A phone asks only whether it already started a setup from here (nothing kept: a fresh visit).
    expect(phone.calls.filter((c) => c !== '/api/nearby')).toEqual([])
    // Exactly three machines: Hetzner, a VPS rented anywhere, the person's computer.
    expect(phone.text()).toContain('Create a server for me at Hetzner')
    expect(phone.text()).toContain('I already have a VPS')
    expect(phone.text()).toContain('My computer')
    // A Mac works (bootstrap.sh handles Darwin): the computer option names it, never « Linux » alone.
    expect(phone.text()).toContain('Mac, Linux, or Windows with WSL.')
    expect(page).not.toMatch(/\(Linux\)|Linux only|Linux seulement/)
    expect(phone.text()).not.toMatch(/Hostinger|hPanel/)
    expect(phone.text()).not.toContain('curl')
    // French, and no sentence left that sends a Mac away.
    const fr = await firstScreen(MAC, 'fr')
    expect(fr.text()).toContain('Branche cet ordinateur')
    expect(fr.text()).toContain('mot de passe du Mac')
    expect((await firstScreen(IPHONE, 'fr')).text()).toContain('Mac, Linux, ou Windows avec WSL.')
    expect(page).not.toMatch(/Hostinger|hPanel/)
    expect(page).not.toMatch(/Linux for now|Linux pour l’instant|prends un VPS|take a VPS/)
  }, 60_000)

  it('needs no resume button: three choices, and a return from Hetzner’s site lands back on the token screen', async () => {
    const phone = await firstScreen(IPHONE)
    expect(phone.text()).not.toMatch(/Pick up where|Already started|resume link/i)
    expect(page).not.toContain('function resumeScreen')
    const back = await firstScreen(IPHONE, 'en', 'https://get.example/#hetzner')
    await vi.waitFor(() => expect(back.text()).toContain('A server of your own, at Hetzner'))
    expect(back.text()).not.toContain('Plug in your machine')
    // One Back button, fixed top left, on every step after the first (and the phone's gesture: one history entry per
    // step); the page reopens where it was. No detour, no restart link, no resume-link box, no nearby screen.
    expect(page).not.toMatch(/function keepBox|function nearbyScreen|W\.noVps|W\.startOver|W\.seePrice/)
    expect(page).toContain('<button id="backbtn" type="button" hidden>')
    expect(page).toMatch(/#backbtn \{ position: fixed;/)
    expect(page).toContain('history.pushState({ wv: 1, doc: DOC, pushed: 1, form: name }')
    expect(phone.document.getElementById('backbtn').hidden).toBe(true)
    expect(back.document.getElementById('backbtn').hidden).toBe(false)
    expect(back.document.getElementById('backbtn').textContent).toBe('← Back')
    // A failure offers one way on: « Try again ».
    expect(page).not.toMatch(/failSame|againSame|W\.retry\b/)
  })

  it('resumes a computer setup on the first screen, where its command already is', async () => {
    expect(page).toContain("const computer = os === 'linux' || os === 'windows' || os === 'mac'")
    expect(page).toContain('if (!computer) pc()')
  })
})

describe('progress reports: one machine per setup', () => {
  it('a report from another address cannot finish or fail the setup', async () => {
    const made = createServer(config({ GET_BASE: 'https://get.example', GET_HANDOFF: '' }), { notifier: null })
    const b = `http://127.0.0.1:${await listen(made.server)}`
    try {
      const job = made.store.create('vps', 'en', 'pub')!
      const post = (ip: string, fields: Record<string, string>) => fetch(`${b}/r/${job.sid}`, { method: 'POST', headers: { 'x-forwarded-for': ip }, body: new URLSearchParams(fields) })
      expect((await post('203.0.113.9', { event: 'start' })).status).toBe(200)
      expect((await post('198.51.100.66', { event: 'done', url: 'https://evil.example', mode: 'public', ready: 'yes' })).status).toBe(404)
      expect((await post('198.51.100.66', { event: 'failed', error: 'x' })).status).toBe(404)
      expect(job.state).toBe('running')
      expect((await post('203.0.113.9', { event: 'done', url: 'https://ok.example', mode: 'public', ready: 'yes' })).status).toBe(200)
      expect(job.result?.url).toBe('https://ok.example')
    } finally {
      made.server.close()
    }
  })
})
