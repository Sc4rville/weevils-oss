// Where the disk goes: the largest folders, and which grow fastest. Read-only measurements only (du, find -printf on
// sizes and dates, docker system df): no file content is ever read, nothing is moved or deleted.
// One snapshot every 6 h at the lowest priority (nice 19, ionice idle), kept 30 days in DATA_DIR/disk/snapshots.jsonl.
// Growth is computed between real snapshots only; until there are enough of them the view says so.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DiskFolder, DiskGrowth, DiskRecent, DiskView } from '../shared/infra.ts'
import { DATA_DIR, HOME } from './config.ts'

const FILE = path.join(DATA_DIR, 'disk', 'snapshots.jsonl')
const EVERY = 6 * 3600_000
const KEEP = 30 * 86400_000
/** Growth needs two snapshots at least this far apart, within the last week. */
const MIN_SPAN = 12 * 3600_000
const WINDOW = 7 * 86400_000
/** Second-level folders smaller than this are not stored (they count in « other files in … »). */
const MIN_ITEM = 10 * 1024 ** 2
const GROWTH_FLOOR = 50 * 1024 ** 2
const RECENT_FLOOR = 100 * 1024 ** 2

/**
 * One measurement. Item keys: `h:<a>` and `h:<a>/<b>` for folders of the home directory (one and two levels),
 * `s:<name>` for a top-level folder of the same disk, `f:<name>` for a top-level file (swap files). Bytes allocated.
 */
export interface DiskSnapshot {
  at: number
  total: number
  used: number
  items: Record<string, number>
  /** Size of files modified in the last 7 days, by `<a>/<b>` (or `<a>/` for files directly in `<a>`). */
  recent?: Record<string, number>
  /** What Docker reports (its data is usually out of reach without root). */
  docker?: { type: string; size: number; reclaimable: number }[]
}

// ---------------------------------------------------------------- parsing (pure)

/** `du -k` output (« 1234\t/path ») under `root` → home items, keyed by relative path, depth 1 and 2. */
export function parseDu(out: string, root: string): Record<string, number> {
  const items: Record<string, number> = {}
  const base = root.endsWith('/') ? root : `${root}/`
  for (const line of out.split('\n')) {
    const m = /^(\d+)\t(.+)$/.exec(line)
    if (!m || !m[2].startsWith(base)) continue
    const rel = m[2].slice(base.length)
    const depth = rel.split('/').length
    const bytes = Number(m[1]) * 1024
    if (depth === 1 || (depth === 2 && bytes >= MIN_ITEM)) items[`h:${rel}`] = bytes
  }
  return items
}

/** Docker's human sizes are decimal (« 14.46GB », « 972.6MB », « 0B »). */
export function dockerBytes(s: string): number {
  const m = /^([\d.]+)\s*([kKMGT]?)B/.exec(s.trim())
  if (!m) return 0
  const mult = { '': 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12 }[m[2]] ?? 1
  return Math.round(Number(m[1]) * mult)
}

/** `docker system df --format '{{json .}}'`, one JSON object per line. */
export function parseDockerDf(out: string): DiskSnapshot['docker'] {
  const rows: NonNullable<DiskSnapshot['docker']> = []
  for (const line of out.split('\n')) {
    try {
      const r = JSON.parse(line) as { Type?: string; Size?: string; Reclaimable?: string }
      if (r.Type && r.Size) rows.push({ type: r.Type, size: dockerBytes(r.Size), reclaimable: dockerBytes((r.Reclaimable ?? '').split(' ')[0]) })
    } catch {
      /* not a JSON line */
    }
  }
  return rows
}

/** « bytes\tkey » lines from the find | awk pipeline → bytes by key (entries under 10 MB dropped). */
export function parseRecent(out: string): Record<string, number> {
  const r: Record<string, number> = {}
  for (const line of out.split('\n')) {
    const m = /^(\d+)\t(.+)$/.exec(line)
    if (m && m[2] !== '.' && Number(m[1]) >= MIN_ITEM) r[m[2]] = Number(m[1])
  }
  return r
}

// ---------------------------------------------------------------- view (pure)

const folderPath = (key: string, home: string) => (key.startsWith('h:') ? path.join(home, key.slice(2)) : key.startsWith('s:') ? `/${key.slice(2)}` : undefined)

/** Leaves whose growth is ranked: second-level home folders, « other files in <a> », system entries, swap, the rest. */
function leaves(s: DiskSnapshot): Record<string, number> {
  const out: Record<string, number> = {}
  const childSum: Record<string, number> = {}
  for (const [k, v] of Object.entries(s.items)) {
    if (!k.startsWith('h:')) continue
    const rel = k.slice(2)
    if (rel.includes('/')) {
      out[k] = v
      const top = rel.split('/')[0]
      childSum[top] = (childSum[top] ?? 0) + v
    }
  }
  for (const [k, v] of Object.entries(s.items)) {
    if (k.startsWith('h:') && !k.slice(2).includes('/')) out[`o:${k.slice(2)}`] = Math.max(0, v - (childSum[k.slice(2)] ?? 0))
    else if (k.startsWith('s:')) out[k] = v
  }
  const swap = Object.entries(s.items).filter(([k]) => k.startsWith('f:') && /swap/i.test(k)).reduce((a, [, v]) => a + v, 0)
  if (swap) out.swap = swap
  out.rest = rest(s)
  return out
}

const measured = (s: DiskSnapshot) => Object.entries(s.items).reduce((a, [k, v]) => (k.startsWith('h:') && k.slice(2).includes('/') ? a : a + v), 0)
const rest = (s: DiskSnapshot) => Math.max(0, s.used - measured(s))

function describe(key: string, home: string): Pick<DiskGrowth, 'name' | 'parent' | 'path' | 'kind'> {
  if (key === 'rest') return { name: 'rest', kind: 'rest' }
  if (key === 'swap') return { name: 'swap', kind: 'swap' }
  if (key.startsWith('o:')) return { name: key.slice(2), kind: 'loose', path: path.join(home, key.slice(2)) }
  if (key.startsWith('s:')) return { name: key.slice(2), kind: 'system', path: `/${key.slice(2)}` }
  const [a, b] = key.slice(2).split('/')
  return b ? { name: b, parent: a, kind: 'folder', path: path.join(home, a, b) } : { name: a, kind: 'folder', path: path.join(home, a) }
}

export function buildView(snaps: DiskSnapshot[], o: { home: string; measuring: boolean; next: number | null }): DiskView {
  const last = snaps[snaps.length - 1]
  const base: DiskView = { at: last?.at ?? null, measuring: o.measuring, next: o.next, samples: snaps.length, since: snaps[0]?.at ?? null, used: last?.used ?? 0, folders: [], growth: null, recent: [] }
  if (!last) return base

  // The largest folders: home folders (with their three largest inside), system folders, swap files, the rest.
  const folders: DiskFolder[] = []
  for (const [k, v] of Object.entries(last.items)) {
    if (k.startsWith('h:') && !k.slice(2).includes('/')) {
      const name = k.slice(2)
      const inside = Object.entries(last.items)
        .filter(([c]) => c.startsWith(`h:${name}/`))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([c, bytes]) => ({ name: c.slice(name.length + 3), bytes }))
      folders.push({ name, kind: 'folder', path: folderPath(k, o.home), bytes: v, inside })
    } else if (k.startsWith('s:')) folders.push({ name: k.slice(2), kind: 'system', path: folderPath(k, o.home), bytes: v, inside: [] })
  }
  const swap = Object.entries(last.items).filter(([k]) => k.startsWith('f:') && /swap/i.test(k))
  if (swap.length) folders.push({ name: 'swap', kind: 'swap', bytes: swap.reduce((a, [, v]) => a + v, 0), inside: [] })
  const r = rest(last)
  if (r > 0) folders.push({ name: 'rest', kind: 'rest', bytes: r, inside: (last.docker ?? []).filter((d) => d.size > 0).sort((a, b) => b.size - a.size).map((d) => ({ name: d.type, bytes: d.size, reclaimable: d.reclaimable })) })
  folders.sort((a, b) => b.bytes - a.bytes)
  base.folders = folders

  // Growth: between the newest snapshot and the oldest one of the last week, if they are 12 h apart at least.
  const from = snaps.find((s) => s.at >= last.at - WINDOW)
  if (from && last.at - from.at >= MIN_SPAN) {
    const days = (last.at - from.at) / 86400_000
    const a = leaves(from)
    const b = leaves(last)
    const items: DiskGrowth[] = [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .map((k) => ({ ...describe(k, o.home), perDay: Math.round(((b[k] ?? 0) - (a[k] ?? 0)) / days), bytes: b[k] ?? 0 }))
      .filter((g) => g.perDay >= GROWTH_FLOOR)
      .sort((x, y) => y.perDay - x.perDay)
      .slice(0, 5)
    base.growth = { since: from.at, perDay: Math.round((last.used - from.used) / days), items }
  }

  // Until then: what was written in the last 7 days (sizes of new or changed files), by folder.
  base.recent = Object.entries(last.recent ?? {})
    .map(([k, v]): DiskRecent => {
      const [a, b] = k.split('/')
      // Hard links count once in du but once per name in find: never more than the folder holds.
      const bytes = Math.min(v, last.items[`h:${b ? `${a}/${b}` : a}`] ?? v)
      return b ? { name: b, parent: a, bytes, path: path.join(o.home, a, b) } : { name: a, bytes, loose: true, path: path.join(o.home, a) }
    })
    .filter((r) => r.bytes >= RECENT_FLOOR)
    .sort((x, y) => y.bytes - x.bytes)
    .slice(0, 5)
  return base
}

// ---------------------------------------------------------------- measuring (child processes, lowest priority)

const run = (file: string, args: string[], timeout: number) =>
  new Promise<string>((resolve) => execFile(file, args, { timeout, maxBuffer: 32 << 20 }, (_err, stdout) => resolve(String(stdout ?? ''))))

let low: string[] | null = null
async function lowPriority(): Promise<string[]> {
  if (low) return low
  const ionice = process.platform === 'linux' && (await new Promise<boolean>((resolve) => execFile('ionice', ['-c3', 'true'], { timeout: 5000 }, (err) => resolve(!err))))
  low = ionice ? ['-n', '19', 'ionice', '-c3'] : ['-n', '19']
  return low
}
const nice = async (cmd: string[], timeout: number) => run('nice', [...(await lowPriority()), ...cmd], timeout)

function statfs(p: string) {
  try {
    const s = fs.statfsSync(p)
    return { total: s.blocks * s.bsize, used: (s.blocks - s.bavail) * s.bsize }
  } catch {
    return { total: 0, used: 0 }
  }
}

/** Takes one snapshot (about 15 s on a 100 GB home, idle priority). */
export async function measure(home = HOME): Promise<DiskSnapshot> {
  const at = Date.now()
  const items = parseDu(await nice(['du', '-x', '-k', '-d', '2', home], 20 * 60_000), home)
  // The rest of the same disk, top level: folders (du -s each) and files (swap), never the folder holding home.
  if (process.platform === 'linux') {
    let dev = -1
    try {
      dev = fs.statSync('/').dev
    } catch {
      /* no root to stat */
    }
    const top = home.split('/')[1]
    const dirs: string[] = []
    if (dev >= 0 && fs.statSync(home).dev === dev) {
      for (const e of fs.readdirSync('/', { withFileTypes: true })) {
        if (e.name === top || e.isSymbolicLink()) continue
        const full = `/${e.name}`
        try {
          const st = fs.lstatSync(full)
          if (st.dev !== dev) continue
          if (st.isDirectory()) dirs.push(full)
          else if (st.isFile() && st.blocks * 512 >= MIN_ITEM) items[`f:${e.name}`] = st.blocks * 512
        } catch {
          /* vanished */
        }
      }
    }
    if (dirs.length)
      for (const line of (await nice(['du', '-x', '-s', '-k', ...dirs], 20 * 60_000)).split('\n')) {
        const m = /^(\d+)\t\/(.+)$/.exec(line)
        if (m && Number(m[1]) * 1024 >= MIN_ITEM) items[`s:${m[2]}`] = Number(m[1]) * 1024
      }
  }
  const snap: DiskSnapshot = { at, ...statfs(home), items }
  // Recently written: sizes and dates of files only (find -printf), summed by folder two levels down.
  if (process.platform === 'linux') {
    const script = `find "$1" -xdev -type f -mtime -7 -printf '%b\\t%P\\n' 2>/dev/null | awk -F'\\t' '{n=split($2,a,"/"); k=(n>=3)?a[1]"/"a[2]:(n==2)?a[1]"/":"."; s[k]+=$1*512} END{for(k in s) printf "%d\\t%s\\n", s[k], k}'`
    snap.recent = parseRecent(await nice(['sh', '-c', script, 'sh', home], 20 * 60_000))
  }
  // Docker's own figures, only when its data folder is out of our reach (otherwise du already counted it).
  const root = (await run('docker', ['info', '--format', '{{.DockerRootDir}}'], 30_000)).trim()
  if (root) {
    let readable = false
    try {
      fs.accessSync(root, fs.constants.R_OK | fs.constants.X_OK)
      readable = true
    } catch {
      /* root-owned: Docker's numbers are the only ones */
    }
    if (!readable) {
      const rows = parseDockerDf(await run('docker', ['system', 'df', '--format', '{{json .}}'], 120_000))
      if (rows?.length) snap.docker = rows
    }
  }
  return snap
}

// ---------------------------------------------------------------- schedule and state

let snaps: DiskSnapshot[] | null = null
let measuring = false
let next: number | null = null
let timer: NodeJS.Timeout | null = null

function load(): DiskSnapshot[] {
  if (snaps) return snaps
  const cut = Date.now() - KEEP
  snaps = []
  try {
    for (const line of fs.readFileSync(FILE, 'utf8').split('\n')) {
      try {
        const s = JSON.parse(line) as DiskSnapshot
        if (s.at >= cut && s.items) snaps.push(s)
      } catch {
        /* torn line */
      }
    }
  } catch {
    /* none yet */
  }
  snaps.sort((a, b) => a.at - b.at)
  return snaps
}

function save(s: DiskSnapshot) {
  const all = load()
  all.push(s)
  const cut = Date.now() - KEEP
  const dropped = all.length - all.filter((x) => x.at >= cut).length
  snaps = all.filter((x) => x.at >= cut)
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true })
    if (dropped) fs.writeFileSync(FILE, snaps.map((x) => JSON.stringify(x)).join('\n') + '\n')
    else fs.appendFileSync(FILE, JSON.stringify(s) + '\n')
  } catch {
    /* read-only or full disk: the memory copy still serves */
  }
}

function schedule(delay: number) {
  if (timer) clearTimeout(timer)
  next = Date.now() + delay
  timer = setTimeout(() => void tick(), delay)
  timer.unref?.()
}

async function tick() {
  // A busy machine waits: measuring is never worth slowing live sessions.
  const cores = os.cpus().length || 1
  if (os.loadavg()[0] > cores * 1.5) return schedule(20 * 60_000)
  measuring = true
  next = null
  try {
    save(await measure())
  } catch {
    /* next time */
  } finally {
    measuring = false
    schedule(EVERY)
  }
}

let started = false
export function startDiskUsage() {
  if (started || process.env.WEEVILS_DISK_SNAPSHOTS === '0') return
  started = true
  const last = load().at(-1)
  const due = last ? last.at + EVERY - Date.now() : 0
  // Never right at start-up (the server has its own work then): two minutes at least.
  schedule(Math.max(2 * 60_000, due))
}

export function diskView(): DiskView {
  return buildView(load(), { home: HOME, measuring, next })
}
