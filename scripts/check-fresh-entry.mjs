#!/usr/bin/env node
// Read-only smoke check of a disposable blank instance. Only login/logout mutate it.
// Usage: node scripts/check-fresh-entry.mjs https://fresh.example.test /path/to/access-code
// The code and cookie stay in memory and are never printed. No provider or model is called.
import fs from 'node:fs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
const [origin, secretFile] = process.argv.slice(2)
if (!origin || !secretFile) throw new Error('Usage: check-fresh-entry.mjs ORIGIN ACCESS_CODE_FILE')
const base = new URL(origin)
assert.ok(['http:', 'https:'].includes(base.protocol))
assert.equal(base.username + base.password + base.search + base.hash, '')
const secret = fs.readFileSync(secretFile, 'utf8').trim()
let cookie = ''
async function request(path, body, signed = false) {
  const response = await fetch(new URL(path, base), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(signed && cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  })
  return { response, data: await response.json().catch(() => null) }
}
const checks = {}
assert.equal((await request('/api/me')).data.authed, false)
assert.equal((await request('/api/snapshot')).response.status, 401)
assert.equal((await request('/api/login', { secret: 'deliberately-invalid-smoke-code' })).response.status, 401)
checks.unauthenticatedAccessDenied = true
const login = await request('/api/login', { secret })
assert.equal(login.response.status, 200)
const header = login.response.headers.get('set-cookie') ?? ''
assert.match(header, /HttpOnly/i)
assert.match(header, /SameSite=Lax/i)
if (base.protocol === 'https:') assert.match(header, /Secure/i)
cookie = header.split(';')[0]
assert.match(cookie, /^wv=.+/)
checks.loginCookieProtected = true
try {
  assert.equal((await request('/api/me', undefined, true)).data.authed, true)
  const snapshot = await request('/api/snapshot', undefined, true)
  assert.equal(snapshot.response.status, 200)
  assert.equal(snapshot.data.sessions.length, 0, 'Blank instance unexpectedly contains sessions')
  assert.equal(snapshot.data.projects.length, 0, 'Blank instance unexpectedly contains projects')
  assert.ok(!snapshot.data.config.userName, 'Blank instance has a personalized user name')
  const memory = await request('/api/memory', undefined, true)
  assert.equal(memory.response.status, 200)
  assert.equal(memory.data.items.length, 0, 'Blank instance unexpectedly contains memory items')
  checks.blankSessionsProjectsMemory = true
  checks.personalizedUserNameAbsent = true
  const build = await request('/build.json')
  if (build.response.ok && build.data?.commit) checks.commit = build.data.commit
  else {
    // Source archives and Docker copies may omit .git, so Vite cannot emit build.json.
    const html = await (await fetch(base, { signal: AbortSignal.timeout(15000) })).text()
    const asset = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1]
    assert.ok(asset, 'No application entry bundle found')
    const bundle = await fetch(new URL(asset, base), { signal: AbortSignal.timeout(15000) })
    assert.equal(bundle.status, 200)
    assert.match(bundle.headers.get('content-type') ?? '', /javascript/)
    checks.entryAsset = asset
    checks.entrySha256 = createHash('sha256').update(Buffer.from(await bundle.arrayBuffer())).digest('hex')
    checks.commitMetadataAvailable = false
  }
} finally {
  const logout = await request('/api/logout', {}, true)
  assert.equal(logout.response.status, 200)
}
assert.equal((await request('/api/me', undefined, true)).data.authed, false)
assert.equal((await request('/api/snapshot', undefined, true)).response.status, 401)
checks.loggedOutCookieRevoked = true
console.log(JSON.stringify({ origin: base.origin, checks, modelRequests: 0 }, null, 2))
