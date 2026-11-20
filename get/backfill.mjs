// Rebuilds get's anonymous stats from Caddy's access log, for the days before the counters existed:
//   sudo cat /var/log/caddy/get.log | node get/backfill.mjs [--force]
// Same counters as the live ones (get/server.mjs), from what the log holds: visits (the page served), visitors (told
// apart in memory by address and browser, never written), where from (referrer, in-app browser), devices, link
// previews, options (price checks and VPS forms), installs started (servers created, VPS connections, scripts
// fetched), installs that went through (an install's full run of progress reports) and code downloads. The log has no
// time zone, so no country; and no beacon, so no « opened their weevils ». Test traffic is left out: this VPS
// (its own addresses), 127.*, 172.*, headless browsers and bots. A day that already has its file is kept (--force rewrites it).
// Installs that went through also get their line in the register, marked « log ». Prints numbers only.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { BOT, appendInstall, config, deviceOf, previewerOf, readJson, sourceOf, total, writeJson } from './server.mjs'

const cfg = config()
const force = process.argv.includes('--force')
const OWN = new Set([...Object.values(os.networkInterfaces()).flat().map((a) => a.address), ...(process.env.GET_OWN_IPS || '').split(',').filter(Boolean)])
const TEST = (ip) => !ip || OWN.has(ip) || ip.startsWith('127.') || ip.startsWith('172.') || ip === '::1'
const days = {}
const day = (d) => (days[d] ??= { day: d, visits: 0, visitors: 0, sources: {}, devices: {}, countries: {}, previews: {}, chose: {}, started: {}, succeeded: {}, switched: {}, bundles: 0, seen: new Set(), picked: new Set() })
const bump = (o, k) => (o[k] = (o[k] || 0) + 1)
const pending = [] // servers created / VPS connected, waiting for their install script to be fetched
const sids = {} // sid → { kind, reports, last }

for await (const line of readline.createInterface({ input: process.stdin })) {
  let o
  try {
    o = JSON.parse(line)
  } catch {
    continue
  }
  const r = o.request
  if (!r || typeof o.ts !== 'number') continue
  const ip = r.client_ip || r.remote_ip || ''
  const ua = r.headers?.['User-Agent']?.[0] || ''
  if (TEST(ip) || /headless/i.test(ua)) continue
  const t = o.ts * 1000
  const d = day(new Date(t).toISOString().slice(0, 10))
  const p = String(r.uri || '').replace(/\?.*$/, '')
  const who = `${ip}\0${ua}`
  if (r.method === 'GET' && p === '/') {
    const pv = previewerOf(ua)
    if (pv) bump(d.previews, pv)
    else if (o.status === 200 && !BOT.test(ua)) {
      d.visits++
      if (!d.seen.has(who)) d.seen.add(who), d.visitors++
      bump(d.sources, sourceOf(r.headers?.Referer?.[0], ua))
      bump(d.devices, deviceOf(ua))
      bump(d.countries, '??')
    }
    continue
  }
  // (Since 2026-11-17 the page creates the server from the browser and posts « created »: no quote reaches here.)
  let m = /^\/api\/(hetzner|hostinger)\/(quote|create|created)$/.exec(p)
  if (r.method === 'POST' && m) {
    if (m[2] === 'quote' && !d.picked.has(`${who}\0${m[1]}`)) d.picked.add(`${who}\0${m[1]}`), bump(d.chose, m[1])
    if ((m[2] === 'create' || m[2] === 'created') && o.status === 200) bump(d.started, m[1]), pending.push({ t, kind: m[1] })
    continue
  }
  if (r.method === 'POST' && p === '/api/ssh') {
    if (!d.picked.has(`${who}\0ssh`)) d.picked.add(`${who}\0ssh`), bump(d.chose, 'ssh')
    if (o.status === 200) bump(d.started, 'ssh'), pending.push({ t, kind: 'ssh' })
    continue
  }
  m = /^\/i\/([a-z2-9]{10})$/.exec(p)
  if (r.method === 'GET' && m && o.status === 200 && !/[?&]as=user/.test(r.uri) && !sids[m[1]]) {
    // Its setup: a server created in the last 15 minutes, a VPS connected in the last 2, else a computer.
    const i = pending.findIndex((x) => t - x.t < (x.kind === 'ssh' ? 120_000 : 900_000) && t >= x.t)
    const kind = i >= 0 ? pending.splice(i, 1)[0].kind : 'pc'
    if (kind === 'pc') bump(d.started, 'pc')
    sids[m[1]] = { kind, reports: 0, last: t }
    continue
  }
  m = /^\/r\/([a-z2-9]{10})$/.exec(p)
  if (r.method === 'POST' && m && sids[m[1]]) {
    sids[m[1]].reports++
    sids[m[1]].last = t
    continue
  }
  if (r.method === 'GET' && p === '/weevils.bundle' && o.status === 200) d.bundles++
}

// An install that went through sends a start, its steps and a last report: six or more.
const register = path.join(cfg.data, 'installs.csv')
const logged = fs.existsSync(register) && fs.readFileSync(register, 'utf8').split('\n').some((l) => l.endsWith(',log'))
for (const s of Object.values(sids).sort((a, b) => a.last - b.last)) {
  if (s.reports < 6) continue
  bump(day(new Date(s.last).toISOString().slice(0, 10)).succeeded, s.kind)
  if (!logged) appendInstall(register, { time: new Date(s.last).toISOString(), kind: s.kind, country: '??', version: '', origin: 'log' })
}

const dir = path.join(cfg.data, 'stats')
for (const d of Object.values(days).sort((a, b) => a.day.localeCompare(b.day))) {
  const { seen, picked, ...data } = d
  const file = path.join(dir, `${d.day}.json`)
  const kept = fs.existsSync(file) && !force
  if (!kept) writeJson(file, data)
  console.log(`${d.day}: ${data.visits} visits, ${data.visitors} visitors, previews ${total(data.previews)}, options ${total(data.chose)}, started ${total(data.started)}, installed ${total(data.succeeded)}, downloads ${data.bundles}${kept ? ' (file already there: kept)' : ''}`)
}
// The records, from every day on disk.
const records = readJson(path.join(cfg.data, 'records.json')) || {}
for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
  const d = /^\d{4}-\d\d-\d\d\.json$/.test(f) && readJson(path.join(dir, f))
  if (!d) continue
  for (const [k, n] of [['visits', d.visits || 0], ['installs', total(d.succeeded)]]) if (n > (records[k]?.n || 0)) records[k] = { day: f.slice(0, 10), n }
}
writeJson(path.join(cfg.data, 'records.json'), records)
console.log(`records: ${records.visits?.n ?? 0} visits on ${records.visits?.day ?? '—'}, ${records.installs?.n ?? 0} installs on ${records.installs?.day ?? '—'}${logged ? ' (register already had its log lines: none added)' : ''}`)
