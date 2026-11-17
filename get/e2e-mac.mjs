// "My computer" on a real Mac, end to end, without a browser. Starts get/server.mjs on this machine, creates a setup
// the way the page does (WebCrypto RSA-OAEP key pair, POST /api/job), runs the command the page shows with macOS's
// own bash, then checks what the page would get: the install done, the sealed link opened, the tunnel answering.
// Made for a macOS runner of GitHub Actions (Node 22, nothing else); it also runs on Linux.
//
//   WVGET_SOURCE=<a weevils checkout> node get/e2e-mac.mjs      installs the committed HEAD of that checkout
//   WVGET_BUNDLE=<a bundle file>      node get/e2e-mac.mjs      installs a bundle made by get/make-bundle.sh
//   … node get/e2e-mac.mjs --dry                                 all but the command: no install, no tunnel
//
// One of the two is required, on purpose: the repository is private, so the install cannot clone it from GitHub and
// the service hands it the code itself (GET_BUNDLE). WVGET_SOURCE is bundled by get/make-bundle.sh: one commit, HEAD,
// so uncommitted changes are NOT installed. The source must be a weevils whose install.sh supports macOS.
// In a workflow, after actions/checkout of a branch that has both get/ and the macOS installer:
//   WVGET_SOURCE="$GITHUB_WORKSPACE" node get/e2e-mac.mjs
//
// THIS INSTALLS WEEVILS for the current user, for real (~/weevils, Homebrew packages, Claude Code, a launchd agent, a
// Cloudflare quick tunnel): run it on a throwaway machine. Remove it with: ~/weevils/install.sh --uninstall --purge
// Other env: WVGET_LANG (en|fr), WVGET_TIMEOUT (minutes, default 40), WVGET_SHOW_LINK=1 (prints the login link).
// Not covered on a runner: sudo needs no password there and Homebrew is already installed, so "the password once in
// the terminal, then Homebrew first" never runs. That case needs a Mac without Homebrew and a person at its terminal.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config, createServer } from './server.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const dry = process.argv.includes('--dry')
const mac = process.platform === 'darwin'
const { subtle } = globalThis.crypto
let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  return ok
}
const stop = (why) => {
  console.error(`e2e-mac: ${why}`)
  fs.rmSync(tmp, { recursive: true, force: true })
  process.exit(2)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- the code to install, said explicitly
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wvget-e2e-'))
let bundle = process.env.WVGET_BUNDLE || ''
if (!bundle && process.env.WVGET_SOURCE) {
  bundle = path.join(tmp, 'weevils.bundle')
  console.log(execFileSync('bash', [path.join(HERE, 'make-bundle.sh'), 'HEAD', bundle, process.env.WVGET_SOURCE]).toString().trim())
}
if (!bundle) stop('say where the code comes from: WVGET_SOURCE=<a weevils checkout> or WVGET_BUNDLE=<a bundle file> (see the top of this file)')
if (!fs.existsSync(bundle)) stop(`no bundle at ${bundle}`)
// The installer inside that bundle: the service reads the step titles from it, like in production.
const unpacked = path.join(tmp, 'src')
execFileSync('git', ['clone', '-q', '-b', 'main', bundle, unpacked])
const installer = path.join(unpacked, 'install.sh')
if (!/Darwin/.test(fs.readFileSync(installer, 'utf8'))) {
  if (mac && !dry) stop('the install.sh in this source does not support macOS: give a checkout or bundle that has the macOS installer')
  console.log('NOTE  the install.sh in this source does not know macOS')
}

// ---------------------------------------------------------------- the service, on this machine
const port = await new Promise((r) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const p = s.address().port
    s.close(() => r(p))
  })
})
const base = `http://127.0.0.1:${port}`
const { server } = createServer(config({ GET_BASE: base, GET_BUNDLE: bundle, GET_INSTALLER: installer, GET_TRUST_PROXY: '0' }))
await new Promise((r) => server.listen(port, '127.0.0.1', r))
const api = async (p, body) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`${p}: ${data.error || r.status}`)
  return data
}

// ---------------------------------------------------------------- the page's side (index.html: newJob, unseal)
const pair = await subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt'])
const pub = Buffer.from(await subtle.exportKey('spki', pair.publicKey)).toString('base64')
const jwk = await subtle.exportKey('jwk', pair.privateKey)
const unseal = async (sealed) => {
  const key = await subtle.importKey('jwk', jwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt'])
  return new TextDecoder().decode(await subtle.decrypt({ name: 'RSA-OAEP' }, key, Buffer.from(sealed, 'base64')))
}
const job = await api('/api/job', { kind: 'pc', lang: process.env.WVGET_LANG === 'fr' ? 'fr' : 'en', pub })
check('the page gets the command to paste', job.command === `curl -fsSL ${base}/i/${job.sid} | bash`, job.command)

// macOS's own bash (3.2), whatever a newer one in the PATH says.
const bash = fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash'
console.log(`${os.type()} ${os.release()} ${os.arch()}, ${execFileSync(bash, ['--version']).toString().split('\n')[0]}`)
const script = await (await fetch(`${base}/i/${job.sid}`)).text()
check('its script has every value filled in', !/@[A-Z]+@/.test(script) && script.includes(`SID='${job.sid}'`) && script.includes(`MODE='pc'`))
const syntax = spawnSync(bash, ['-n'], { input: script })
check(`${bash} reads the script (bash -n)`, syntax.status === 0, syntax.stderr.toString().trim().slice(0, 200))
const got = await fetch(`${base}/weevils.bundle?sid=${job.sid}`)
check('the service hands the code to this setup', got.ok && (await got.arrayBuffer()).byteLength === fs.statSync(bundle).size)

if (dry) {
  // No install: the reports a run would send, with a link sealed the way the script's Node path does.
  const link = 'https://dry-run.trycloudflare.com/#k=DryRunCode123'
  const sealed = spawnSync(process.execPath, ['-e', /seal_node\(\) \{\n\s+WV_PUB=\$PUB node -e '([\s\S]*?)' 2>\/dev\/null/.exec(script)?.[1] || 'process.exit(1)'], { input: link, env: { ...process.env, WV_PUB: pub } }).stdout.toString()
  const send = (fields) => fetch(`${base}/r/${job.sid}`, { method: 'POST', body: new URLSearchParams(fields) })
  await send({ event: 'start' })
  await send({ event: 'step', step: 's_system' })
  await send({ event: 'step', step: 'tunnel' })
  await send({ event: 'done', url: 'https://dry-run.trycloudflare.com', mode: 'public', ready: 'no', sealed })
  const s = await api('/api/status', { sid: job.sid, view: job.view })
  check('reports reach the page', s.state === 'done' && s.steps.join(',') === 'start,s_system,tunnel,done', s.steps.join(','))
  check('the script’s Node sealing opens with the page’s key', (await unseal(s.result.sealed).catch(() => '')) === link)
  console.log(`\nDRY RUN: nothing was installed and no tunnel was opened. ${failed ? `${failed} check(s) failed` : 'all checks passed'}`)
  server.close()
  fs.rmSync(tmp, { recursive: true, force: true })
  process.exit(failed ? 1 : 0)
}

// ---------------------------------------------------------------- the command, for real
console.log(`\nrunning: curl -fsSL ${base}/i/${job.sid} | ${bash}\n`)
const run = spawn(bash, ['-c', `curl -fsSL '${base}/i/${job.sid}' | ${bash}`], { stdio: ['ignore', 'inherit', 'inherit'] })
let exit = null
run.on('exit', (c) => (exit = c ?? -1))
const t0 = Date.now()
const limit = Number(process.env.WVGET_TIMEOUT || 40) * 60_000
let last = ''
let s
for (;;) {
  s = await api('/api/status', { sid: job.sid, view: job.view })
  const line = `${s.state} ${s.steps.join(' → ')}`
  if (line !== last) console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${(last = line)}`)
  if (s.state === 'done' || s.state === 'failed') break
  if (exit !== null && exit !== 0) break
  if (Date.now() - t0 > limit) {
    run.kill('SIGTERM')
    break
  }
  await sleep(3000)
}
for (let i = 0; i < 100 && exit === null; i++) await sleep(200)

// ---------------------------------------------------------------- what the page would get
const home = os.homedir()
const log = (() => {
  try {
    return fs.readFileSync(path.join(home, 'weevils-install.log'), 'utf8')
  } catch {
    return ''
  }
})()
const summary = Object.fromEntries((/--- weevils summary ---\n([\s\S]*?)--- end ---/.exec(log)?.[1] || '').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
if (!check('the install ends: the page sees "done"', s.state === 'done', s.state === 'failed' ? s.error : s.state)) {
  // The end of the installer's log, without the access code.
  console.log(log.split('\n').slice(-40).join('\n').replace(/#k=\S+/g, '#k=…').replace(/^(code|link)=.*$/gm, '$1=…'))
}
check('the command itself ended well', exit === 0, `exit ${exit}`)
const want = ['start', 's_system', 's_source', 's_build', 's_service', 'tunnel', 'done']
check('the page saw the steps in order', want.every((k, i) => s.steps.includes(k) && (i === 0 || s.steps.indexOf(want[i - 1]) < s.steps.indexOf(k))), s.steps.join(','))
const url = s.result?.url || ''
check('the address is a Cloudflare quick tunnel, reachable from anywhere', /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(url) && s.result?.mode === 'public', `${url} ${s.result?.mode}`)
const link = s.result?.sealed ? await unseal(s.result.sealed).catch(() => '') : ''
check('the sealed link opens with the page’s key, on that address', !!url && link.startsWith(url + '/#k='), s.result?.sealed ? 'sealed received' : 'nothing sealed')
if (process.env.WVGET_SHOW_LINK) console.log(link)
check('the installer’s summary says ok', summary.status === 'ok' && summary.mode === 'public' && summary.url === url, `status=${summary.status} mode=${summary.mode} os=${summary.os}`)
if (mac) check('and that this is macOS', summary.os === 'macos', `os=${summary.os}`)

// The tunnel, from outside: a new trycloudflare name can take a moment to resolve.
let answer = 0
for (let i = 0; url && i < 30 && answer !== 200; i++) {
  answer = await fetch(`${url}/manifest.webmanifest`, { signal: AbortSignal.timeout(10_000) }).then((r) => r.status, () => 0)
  if (answer !== 200) await sleep(3000)
}
check('the tunnel answers over HTTPS', answer === 200, `manifest → ${answer}`)
const code = link.split('#k=')[1] || ''
const login = url && code ? await fetch(`${url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url }, body: JSON.stringify({ secret: code }) }).catch(() => null) : null
const cookie = (login?.headers.get('set-cookie') || '').split(';')[0]
const feed = cookie ? await fetch(`${url}/api/snapshot`, { headers: { cookie } }).then((r) => r.status, () => 0) : 0
check('the unsealed code logs in to that weevils', login?.status === 200 && feed === 200, `login → ${login?.status}, snapshot → ${feed}`)

if (mac) {
  // The link is kept by launchd when a session is open on the screen, else it is a plain background process.
  const label = 'com.github.sc4rville.weevils-link'
  const plist = path.join(home, 'Library/LaunchAgents', `${label}.plist`)
  const dom = `gui/${os.userInfo().uid}`
  const gui = spawnSync('launchctl', ['print', dom]).status === 0
  const running = spawnSync('pgrep', ['-f', 'cloudflared tunnel --no-autoupdate']).status === 0
  check('cloudflared is running', running)
  if (gui) {
    check('launchd keeps the link: the agent is loaded', spawnSync('launchctl', ['print', `${dom}/${label}`]).status === 0)
    check('its file is a valid property list', fs.existsSync(plist) && spawnSync('plutil', ['-lint', plist]).status === 0)
  } else {
    console.log(`NOTE  no session on this Mac's screen (${dom}): the link runs in the background, launchd was NOT exercised`)
    check('no agent file is left behind', !fs.existsSync(plist))
  }
}

console.log(`\n${failed ? `${failed} check(s) FAILED` : 'all checks passed'} in ${Math.round((Date.now() - t0) / 1000)}s`)
server.close()
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
