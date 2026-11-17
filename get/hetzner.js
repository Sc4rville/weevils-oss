// get/hetzner.js — Hetzner's API, called from the person's own browser (get/index.html imports this file). The API
// token never leaves the browser except toward Hetzner itself (api.hetzner.cloud allows it: CORS): the setup service
// (get/server.mjs) never sees it. The service is told only what it needs to follow the install: the new server's id,
// address and size.
// Plain ES module, no dependency: the page loads it as is, and get/get.test.ts imports it under Node against a mock.

export const API = 'https://api.hetzner.cloud/v1'

// Three sizes, by memory (a Claude Code session takes up to about 1 GB): what runs in parallel, said in agents.
export const SIZES = [
  { size: 'light', memory: 4, agents: '2-3' },
  { size: 'recommended', memory: 8, agents: '6' },
  { size: 'strong', memory: 16, agents: '12' },
]
/** Where to put the machine: near the person (the page knows its browser's region). */
export const REGIONS = { europe: ['nbg1', 'fsn1', 'hel1'], america: ['ash', 'hil'], asia: ['sin'] }
const region = (r) => (REGIONS[r] ? r : 'europe')
/** Full, or that type not sold there right now: the next option is tried. Anything else (token, quota, payment) stops. */
export const HZ_RETRY = ['resource_unavailable', 'placement_error', 'invalid_input', 'unsupported_location']

/** One call. Errors carry Hetzner's own code (`unauthorized`, `forbidden`…) as `hz`, and the HTTP status. */
export async function hz(token, method, p, body, o = {}) {
  let r
  try {
    r = await (o.fetch || fetch)((o.api || API) + p, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw Object.assign(new Error('host_down'), { hz: 'host_down', status: 502 })
  }
  const data = await r.json().catch(() => ({}))
  if (!r.ok) {
    const code = data?.error?.code || `http_${r.status}`
    throw Object.assign(new Error(code), { status: r.status, hz: code })
  }
  return data
}

/** For each size, the cheapest current x86 type with that memory (2+ vCPU), and where it is sold, cheapest first.
 * Prices are what the person pays, VAT included: Hetzner bills by the hour (`hourly`), never more than `monthly` in a
 * month, and the server's IPv4 address on top of its type (`GET /pricing`; left out, `ipv4: false`, if that fails). */
export async function quote(token, where = 'europe', o = {}) {
  const [{ server_types: types = [] }, pricing] = await Promise.all([
    hz(token, 'GET', '/server_types?per_page=50', null, o),
    hz(token, 'GET', '/pricing', null, o).then((d) => d?.pricing, () => null),
  ])
  const ipv4 = (pricing?.primary_ips || []).find((x) => x.type === 'ipv4')?.prices || []
  const gross = (p, k) => Number(p?.[k]?.gross ?? NaN)
  const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d
  const locs = REGIONS[region(where)].concat(Object.values(REGIONS).flat().filter((l) => !REGIONS[region(where)].includes(l)))
  const sizes = []
  for (const z of SIZES) {
    const fit = []
    for (const t of types) {
      if (t.deprecated || t.deprecation || (t.architecture && t.architecture !== 'x86') || t.cores < 2 || t.memory !== z.memory) continue
      for (const loc of locs) {
        const p = (t.prices || []).find((x) => x.location === loc)
        if (!p) continue
        const ip = ipv4.find((x) => x.location === loc)
        fit.push({
          type: t.name, cores: t.cores, memory: t.memory, disk: t.disk, location: loc, ipv4: !!ip,
          hourly: round(gross(p, 'price_hourly') + (ip ? gross(ip, 'price_hourly') : 0), 6),
          monthly: round(gross(p, 'price_monthly') + (ip ? gross(ip, 'price_monthly') : 0), 4),
        })
      }
    }
    // Near first, then the cheapest.
    fit.sort((a, b) => (locs.indexOf(a.location) > 2) - (locs.indexOf(b.location) > 2) || a.monthly - b.monthly || locs.indexOf(a.location) - locs.indexOf(b.location))
    if (fit.length) sizes.push({ ...z, ...fit[0], currency: 'EUR', options: fit.slice(0, 6) })
  }
  if (!sizes.length) throw Object.assign(new Error('no_type'), { hz: 'no_type' })
  return { sizes }
}

/** A server as the page lists it: weevils made it (its label, or the name it gave it), where, since when. */
export const hzServer = (x) => ({
  id: x.id, name: x.name || '', ip: x.public_net?.ipv4?.ip || '', status: x.status || '', created: Date.parse(x.created) || 0,
  location: x.datacenter?.location?.city || x.datacenter?.location?.name || '', type: x.server_type?.name || '',
  sid: /^[a-z2-9]{10}$/.test(x.labels?.['weevils-sid'] || '') ? x.labels['weevils-sid'] : '',
  weevils: x.labels?.app === 'weevils' || x.labels?.weevils === 'true' || /^weevils-[a-z2-9]{6}$/.test(x.name || ''),
})

/** The servers weevils already made on this account (label app=weevils: every server the setup page ever created). */
export async function servers(token, o = {}) {
  const { servers: list = [] } = await hz(token, 'GET', '/servers?label_selector=app%3Dweevils&per_page=50&sort=created:desc', null, o)
  return list.map(hzServer).filter((s) => s.weevils).sort((a, b) => b.created - a.created).slice(0, 10)
}

/** Creates the server, the install in its cloud-init (`userData`, from the setup service: it only runs the public
 * install script for this setup). The size picked, else the next option where that one is full. Hetzner's answer
 * also holds a root password: dropped here, weevils never needs it. */
export async function create(token, { sid, size = 'recommended', where = 'europe', userData }, o = {}) {
  const { sizes } = await quote(token, where, o)
  const pick = sizes.find((x) => x.size === size) || sizes.find((x) => x.size === 'recommended') || sizes[0]
  const tried = new Set()
  let last
  for (const opt of [pick, ...pick.options]) {
    const key = `${opt.type}@${opt.location}`
    if (tried.has(key)) continue
    tried.add(key)
    try {
      const data = await hz(token, 'POST', '/servers', {
        name: `weevils-${sid.slice(0, 6)}`,
        server_type: opt.type,
        location: opt.location,
        image: 'ubuntu-24.04',
        user_data: userData,
        // How a later visit finds it again (same token): « continue on this one » instead of a second server.
        labels: { app: 'weevils', weevils: 'true', 'weevils-sid': sid },
        public_net: { enable_ipv4: true, enable_ipv6: true },
        start_after_create: true,
      }, o)
      const ip = data?.server?.public_net?.ipv4?.ip
      if (!ip) throw Object.assign(new Error('no_ip'), { hz: 'no_ip' })
      return { name: data.server.name, id: data.server.id, ip, size: pick.size, agents: pick.agents, type: opt.type, cores: opt.cores, memory: opt.memory, location: opt.location, hourly: opt.hourly, monthly: opt.monthly, currency: 'EUR' }
    } catch (e) {
      last = e
      if (!HZ_RETRY.includes(e.hz)) throw e
    }
  }
  throw last
}

/** Back into a server weevils made, whose setup is over or forgotten: Hetzner gives it a new root password (its guest
 * agent sets it). The page then hands that password, once, to the same SSH start as « I already have a VPS ». */
export async function rootPassword(token, serverId, o = {}) {
  const wait = o.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const r = await hz(token, 'POST', `/servers/${serverId}/actions/reset_password`, null, o)
  for (let i = 0; i < 45 && r.action?.id && r.action.status !== 'success'; i++) {
    const { action } = await hz(token, 'GET', `/servers/${serverId}/actions/${r.action.id}`, null, o)
    if (action?.status === 'success') break
    if (action?.status === 'error') throw Object.assign(new Error('reset_failed'), { hz: 'reset_failed' })
    await wait(2000)
  }
  if (typeof r.root_password !== 'string' || !r.root_password) throw Object.assign(new Error('reset_failed'), { hz: 'reset_failed' })
  return r.root_password
}
