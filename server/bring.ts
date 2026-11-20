// Bring your conversations: Claude Code and Codex conversations from another computer, resumed here in one tap.
//
// Both tools keep a conversation on the machine where it ran, as one file (Claude Code: ~/.claude/projects/<folder>/
// <id>.jsonl; Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl); neither account syncs them. Resuming one
// elsewhere only takes that file, in the right place, with its folder paths moved to where the project lives here
// (`claude --resume <id>` looks in the folder named after the working directory; `codex resume <id>` finds the file by
// its id anywhere under sessions/).
//
// Two ways a computer shows up here:
// - a computer with nothing installed: the app shows one line to paste in its terminal (`curl …/api/bring.sh | bash -s
//   <code>`, server/bring.sh). The script sends the list (first and last lines of each conversation, never the whole
//   file), then waits, and sends whole only the ones tapped. The one-time code is the only key; the server never names a
//   file to send, only a number from the script's own list.
// - a machine already connected to this weevils (WEEVILS_REMOTES): its weevilsd lists its own conversations
//   (GET /api/bring/local) and hands over one by its key (GET /api/bring/local/file), over the same link as the rest.
//
// Arriving here: the project's repository is found among the local clones (same origin) or cloned; without a
// repository, a folder of the same name. Paths under the old project folder are rewritten to the new one, the file is
// written where the tool looks, and the conversation counts as active from now on (brought.json), so it sits with the
// recent ones and resumes with a message. Nothing of the conversation is logged.

import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import type http from 'node:http'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import zlib from 'node:zlib'
import type { BringItem, BringSource, BringView } from '../shared/bring.ts'
import type { Tool } from '../shared/api.ts'
import { parseTranscriptText, titleOf } from './transcripts.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UUID_END = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
const HEAD = 49152
const TAIL = 16384
const MAX_LIST = 300
/** A link nobody used for this long is closed; one in use stays open this long after the computer's last call. */
const LINK_UNUSED_MS = 24 * 3600_000
const LINK_IDLE_MS = 2 * 3600_000
const ONLINE_MS = 60_000

/** Claude Code's folder for a working directory: every character other than a letter or a digit becomes « - ». */
export const claudeSlug = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-')

/** What one conversation's first and last lines say: its id, title, folder. Null: not one to offer (a script's
 * one-off `claude -p`, weevboss's own threads, nothing the user wrote). */
export function describe(tool: Tool, file: string, head: string, tail: string, size: number, mtimeSec: number, names?: Map<string, string>): (BringItem & { file: string }) | null {
  // A cut line at either end is dropped; a file that fits in its head is whole.
  const h = size > Buffer.byteLength(head) ? head.slice(0, head.lastIndexOf('\n') + 1) : head
  const t = tail ? tail.slice(tail.indexOf('\n') + 1) : ''
  const tr = parseTranscriptText(file, tool, `${h}\n${t}`)
  const fromName = tool === 'claude' ? path.basename(file, '.jsonl') : UUID_END.exec(file)?.[1]
  const id = tool === 'claude' ? fromName : tr.id
  if (!id || !UUID.test(id) || (tool === 'codex' && fromName && fromName !== id)) return null
  if (tr.headless || /\/\.local\/share\/weevils(\/|$)/.test(tr.cwd)) return null
  if (!tr.messages.some((m) => m.role === 'user')) return null
  const title = names?.get(id)?.trim() || titleOf(tr)
  return { key: `${tool}:${id}`, tool, id, title, project: tr.cwd ? path.basename(tr.cwd) || '~' : '', at: mtimeSec * 1000, size, file }
}

/** The list a computer sends (server/bring.sh): per conversation a header line « WVB1 n tool size mtime headLen tailLen
 * path », then its head and tail bytes. Codex's names come as a « codex-index » entry. */
export function parseIndex(buf: Buffer): (BringItem & { file: string; n: number })[] {
  const raw: { n: number; tool: Tool; size: number; mtime: number; head: string; tail: string; file: string }[] = []
  const names = new Map<string, string>()
  let pos = 0
  while (pos < buf.length && raw.length < MAX_LIST + 5) {
    const nl = buf.indexOf(10, pos)
    if (nl < 0) break
    const f = buf.subarray(pos, nl).toString('utf8').split('\t')
    if (f[0] !== 'WVB1' || f.length < 8) break
    const [n, tool, size, mtime, hl, tl] = [Number(f[1]), f[2], Number(f[3]), Number(f[4]), Number(f[5]), Number(f[6])]
    const file = f.slice(7).join('\t')
    if (![n, size, mtime, hl, tl].every((x) => Number.isFinite(x) && x >= 0) || hl > 1 << 20 || tl > 1 << 20) break
    const start = nl + 1
    const head = buf.subarray(start, start + hl).toString('utf8')
    const tail = buf.subarray(start + hl, start + hl + tl).toString('utf8')
    pos = start + hl + tl
    if (tool === 'codex-index') {
      for (const line of head.split('\n')) {
        try {
          const o = JSON.parse(line) as { id?: string; thread_name?: string }
          if (o.id && typeof o.thread_name === 'string') names.set(o.id, o.thread_name)
        } catch {
          /* a cut line */
        }
      }
    } else if (tool === 'claude' || tool === 'codex') raw.push({ n, tool, size, mtime, head, tail, file })
  }
  const out: (BringItem & { file: string; n: number })[] = []
  const seen = new Set<string>()
  for (const r of raw) {
    const d = describe(r.tool, r.file, r.head, r.tail, r.size, r.mtime, names)
    if (d && !seen.has(d.key)) {
      seen.add(d.key)
      out.push({ ...d, n: r.n })
    }
  }
  return out.sort((a, b) => b.at - a.at)
}

// ---------------------------------------------------------------- this machine's own conversations (when it is the other one)

function walk(dir: string, depth: number, out: string[]) {
  let list: fs.Dirent[] = []
  try {
    list = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of list) {
    const p = path.join(dir, e.name)
    if (e.isDirectory() && depth > 0) walk(p, depth - 1, out)
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p)
  }
}

function readEnds(file: string, size: number): { head: string; tail: string } {
  const fd = fs.openSync(file, 'r')
  try {
    const h = Buffer.alloc(Math.min(size, HEAD))
    fs.readSync(fd, h, 0, h.length, 0)
    let t = Buffer.alloc(0)
    if (size > HEAD + TAIL) {
      t = Buffer.alloc(TAIL)
      fs.readSync(fd, t, 0, TAIL, size - TAIL)
    }
    return { head: h.toString('utf8'), tail: t.toString('utf8') }
  } finally {
    fs.closeSync(fd)
  }
}

/** This machine's conversations, the most recent first (what another weevils lists when this one is connected to it). */
function scanLocal(claudeDir: string, codexHome: string): (BringItem & { file: string })[] {
  const files: [Tool, string][] = []
  try {
    for (const d of fs.readdirSync(claudeDir)) {
      const out: string[] = []
      walk(path.join(claudeDir, d), 0, out)
      for (const f of out) files.push(['claude', f])
    }
  } catch {
    /* no Claude Code here */
  }
  for (const sub of ['sessions', 'archived_sessions']) {
    const out: string[] = []
    walk(path.join(codexHome, sub), 3, out)
    for (const f of out) if (path.basename(f).startsWith('rollout-')) files.push(['codex', f])
  }
  const stat = files.map(([tool, f]) => {
    try {
      const s = fs.statSync(f)
      return { tool, f, size: s.size, mtime: Math.floor(s.mtimeMs / 1000) }
    } catch {
      return null
    }
  }).filter((x) => !!x).sort((a, b) => b.mtime - a.mtime).slice(0, MAX_LIST)
  const names = new Map<string, string>()
  try {
    const idx = path.join(codexHome, 'session_index.jsonl')
    const size = fs.statSync(idx).size
    const fd = fs.openSync(idx, 'r')
    const len = Math.min(size, 1 << 18)
    const b = Buffer.alloc(len)
    fs.readSync(fd, b, 0, len, size - len)
    fs.closeSync(fd)
    for (const line of b.toString('utf8').split('\n')) {
      try {
        const o = JSON.parse(line) as { id?: string; thread_name?: string }
        if (o.id && o.thread_name) names.set(o.id, o.thread_name)
      } catch {
        /* cut line */
      }
    }
  } catch {
    /* no index */
  }
  const out: (BringItem & { file: string })[] = []
  for (const s of stat) {
    try {
      const { head, tail } = readEnds(s.f, s.size)
      const d = describe(s.tool, s.f, head, tail, s.size, s.mtime, names)
      if (d) out.push(d)
    } catch {
      /* unreadable */
    }
  }
  return out
}

/** The git facts of a conversation's folder on this machine (sent along with the file). */
async function gitFacts(cwd: string): Promise<{ origin: string; root: string; branch: string }> {
  const g = (args: string[]) => new Promise<string>((resolve) => execFile('git', ['-C', cwd, ...args], { timeout: 5000 }, (e, out) => resolve(e ? '' : String(out).trim())))
  if (!cwd || !fs.existsSync(cwd)) return { origin: '', root: '', branch: '' }
  const [root, origin, branch] = await Promise.all([g(['rev-parse', '--show-toplevel']), g(['remote', 'get-url', 'origin']), g(['rev-parse', '--abbrev-ref', 'HEAD'])])
  return { origin, root, branch }
}

// ---------------------------------------------------------------- arriving here

export interface PlaceDeps {
  home: string
  projectsDir: string
  roots: string[]
  claudeDir: string
  codexDir: string
  /** git, with no prompt ever (a private repository without access fails, it does not wait). */
  git: (args: string[], cwd?: string) => Promise<{ ok: boolean; out: string }>
  now?: () => Date
}

export const realGit: PlaceDeps['git'] = (args, cwd) =>
  new Promise((resolve) =>
    execFile('git', args, {
      cwd,
      timeout: 10 * 60_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https:ssh:git', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new' },
    }, (e, out, err) => resolve({ ok: !e, out: String(out || err).trim() })),
  )

/** « git@github.com:me/app.git », « https://tok@github.com/me/app » → « github.com/me/app »: same repository? */
export function sameRepo(a: string, b: string): boolean {
  const norm = (u: string) =>
    u.trim().replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, '').replace(/^([^/:]+):(?!\d+\/)/, '$1/').replace(/:\d+\//, '/').replace(/\.git\/?$/, '').replace(/\/+$/, '').toLowerCase()
  return !!a && !!b && norm(a) === norm(b)
}
/** Only real remote addresses are cloned (never a local path, an option or git's ext:: transport). */
export const cloneable = (u: string) => /^(https:\/\/|ssh:\/\/|git@)[^\s]+$/.test(u) && !/(^|@|\/\/)-/.test(u)
/** The repository's name in its address (« me/app.git » → « app »). */
export const repoName = (u: string) => (u.replace(/\.git\/?$/, '').replace(/\/+$/, '').split(/[/:]/).pop() || '').replace(/[^\w.-]/g, '-').replace(/^[.-]+/, '') || 'project'
/** Credentials inside an address never reach a log. */
export const safeUrl = (u: string) => u.replace(/\/\/[^@/]+@/, '//')

const isDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

async function findClone(origin: string, d: PlaceDeps): Promise<string | null> {
  for (const root of d.roots) {
    let names: string[] = []
    try {
      names = fs.readdirSync(root)
    } catch {
      continue
    }
    for (const n of names) {
      const dir = path.join(root, n)
      if (!fs.existsSync(path.join(dir, '.git'))) continue
      const r = await d.git(['-C', dir, 'remote', 'get-url', 'origin'])
      if (r.ok && sameRepo(r.out, origin)) return dir
    }
  }
  return null
}

/** Where the project of a conversation lives here, and how its old folder maps to it. */
export async function place(o: { cwd: string; origin?: string; root?: string; branch?: string }, d: PlaceDeps): Promise<{ from: string; to: string; cwd: string; note?: string }> {
  // Resolved first: a folder written with « .. » never points outside where it claims to be.
  const cwd = path.resolve('/', o.cwd || '/')
  // The same folder exists here, in this user's home (same user name, same layout): nothing moves.
  const inside = (r: string) => cwd === r || cwd.startsWith(`${r.replace(/\/+$/, '')}/`)
  if (o.cwd && isDir(cwd) && [d.home, ...d.roots].some(inside)) return { from: cwd, to: cwd, cwd }
  const r = o.root ? path.resolve('/', o.root) : ''
  const root = r && r !== '/' && (cwd === r || cwd.startsWith(`${r}/`)) ? r : ''
  const rel = root ? path.relative(root, cwd) : ''
  let to = ''
  let note: string | undefined
  if (o.origin && cloneable(o.origin)) {
    to = (await findClone(o.origin, d)) ?? ''
    if (!to) {
      to = path.join(d.projectsDir, repoName(o.origin))
      for (let i = 2; fs.existsSync(to); i++) to = path.join(d.projectsDir, `${repoName(o.origin)}-${i}`)
      fs.mkdirSync(d.projectsDir, { recursive: true })
      const r = await d.git(['clone', '--quiet', '--', o.origin, to])
      if (r.ok && o.branch && o.branch !== 'HEAD') await d.git(['-C', to, 'checkout', '--quiet', o.branch])
      if (!r.ok) note = 'clone'
    }
  } else if (/^\/(home|Users)\/[^/]+$|^\/root$/.test(cwd)) {
    // Opened in the home folder over there: the home folder here.
    return { from: cwd, to: d.home, cwd: d.home }
  } else {
    to = path.join(d.projectsDir, repoName(path.basename(root || cwd)))
  }
  const from = root || cwd
  const at = rel ? path.join(to, rel) : to
  fs.mkdirSync(at, { recursive: true })
  return { from, to, cwd: at, ...(note ? { note } : {}) }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** The old project folder → the new one, wherever it is written (cwd fields, commands, file paths), never a longer
 * name that merely starts the same (« /a/app » does not touch « /a/app2 »). */
export function rewritePaths(text: string, from: string, to: string): string {
  if (!from || from === to || from === '/') return text
  return text.replace(new RegExp(`${escapeRe(from)}(?![A-Za-z0-9._-])`, 'g'), to.replace(/\$/g, '$$$$'))
}

/** The file really is that conversation (its first lines carry its id). */
function checkContent(tool: Tool, id: string, text: string): boolean {
  const lines = text.split('\n', 400)
  for (const line of lines) {
    if (!line.trim()) continue
    let o: any
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if (tool === 'codex') return o.type === 'session_meta' && o.payload?.id === id
    if (o.sessionId === id) return true
  }
  return false
}

function findCodex(codexDir: string, id: string): string | null {
  const out: string[] = []
  walk(codexDir, 3, out)
  return out.find((f) => f.endsWith(`-${id}.jsonl`)) ?? null
}

export interface Arrived {
  state: 'here' | 'failed'
  sessionId?: string
  cwd?: string
  note?: string
  /** It was already on this machine: nothing written. */
  already?: boolean
}

/** One conversation file (already received, uncompressed, in `file`) becomes a session of this machine. */
export async function arrive(o: { tool: Tool; id: string; file: string; name?: string; origin?: string; root?: string; branch?: string }, d: PlaceDeps): Promise<Arrived> {
  if (!UUID.test(o.id)) return { state: 'failed', note: 'id' }
  const raw = fs.readFileSync(o.file, 'utf8')
  if (!checkContent(o.tool, o.id, raw)) return { state: 'failed', note: 'content' } // i18n-ignore: internal code, never displayed
  const t = parseTranscriptText(o.file, o.tool, raw.slice(0, 2_000_000))
  if (o.tool === 'codex') {
    const there = findCodex(d.codexDir, o.id)
    if (there) return { state: 'here', sessionId: o.id, already: true }
  }
  const p = await place({ cwd: t.cwd, origin: o.origin, root: o.root, branch: o.branch }, d)
  const text = rewritePaths(raw, p.from, p.to)
  let dest: string
  if (o.tool === 'claude') {
    dest = path.join(d.claudeDir, claudeSlug(p.cwd), `${o.id}.jsonl`)
    if (fs.existsSync(dest)) return { state: 'here', sessionId: o.id, cwd: p.cwd, already: true }
  } else {
    const now = d.now?.() ?? new Date()
    const day = path.join(d.codexDir, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'))
    const base = o.name && new RegExp(`^rollout-[0-9T.-]+-${o.id}\\.jsonl$`).test(o.name) ? o.name : `rollout-${now.toISOString().slice(0, 19).replace(/:/g, '-')}-${o.id}.jsonl`
    dest = path.join(day, base)
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const tmp = `${dest}.part-${process.pid}`
  fs.writeFileSync(tmp, text, { mode: 0o600 })
  fs.renameSync(tmp, dest)
  return { state: 'here', sessionId: o.id, cwd: p.cwd, ...(p.note ? { note: p.note } : {}) }
}

// ---------------------------------------------------------------- the module

interface Item extends BringItem {
  file: string
  n?: number
}
interface Link {
  code: string
  createdAt: number
  seen: number
  host: string
  items: Map<string, Item>
  wants: number[]
  waiter: ((lines: string) => void) | null
}
export interface RemoteLike {
  id: string
  url: string
  online: boolean
  snap: { machines?: { name?: string }[] } | null
  call<T>(method: string, path: string, body?: unknown): Promise<T>
  /** The headers that authenticate this machine to the remote (its local token). */
  headers?(): Record<string, string>
}

export interface BringDeps extends PlaceDeps {
  dataDir: string
  codexHome: string
  remotes: () => RemoteLike[]
  /** The sessions list changed (a conversation arrived). */
  bump: () => void
}

export class Bring {
  private links = new Map<string, Link>()
  private states = new Map<string, Pick<BringItem, 'state' | 'sessionId' | 'note'>>()
  private remoteLists = new Map<string, { at: number; items: Item[] }>()
  private brought: Record<string, { at: number; from: string }> = {}
  private queue: Promise<unknown> = Promise.resolve()
  private localCache: { at: number; items: Item[] } | null = null
  private file: string
  private d: BringDeps

  constructor(d: BringDeps) {
    this.d = d
    this.file = path.join(d.dataDir, 'brought.json')
    try {
      this.brought = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      this.brought = {}
    }
  }

  broughtAt = (id: string): number | undefined => this.brought[id]?.at
  count = () => Object.keys(this.brought).length

  /** The one-time code for a computer's line (the same one while it is still open and unused). */
  link(): string {
    this.sweep()
    const open = [...this.links.values()].find((l) => !l.items.size && Date.now() - l.createdAt < LINK_UNUSED_MS / 2)
    if (open) return open.code
    const code = crypto.randomBytes(18).toString('base64url')
    this.links.set(code, { code, createdAt: Date.now(), seen: 0, host: '', items: new Map(), wants: [], waiter: null })
    return code
  }

  private sweep() {
    const now = Date.now()
    for (const [code, l] of this.links)
      if ((l.seen ? now - l.seen > LINK_IDLE_MS : false) || now - l.createdAt > LINK_UNUSED_MS + (l.seen ? LINK_IDLE_MS : 0)) {
        l.waiter?.('bye\n')
        this.links.delete(code)
      }
    while (this.links.size > 8) this.links.delete(this.links.keys().next().value!)
  }

  private linkOf(code: string): Link | null {
    this.sweep()
    const l = this.links.get(code)
    if (!l) return null
    l.seen = Date.now()
    return l
  }

  private decorate(source: string, it: Item): BringItem {
    const { file: _f, n: _n, ...rest } = it
    const s = this.states.get(`${source}|${it.key}`)
    const here = this.brought[it.id]
    return { ...rest, ...(s ?? (here ? { state: 'here' as const, sessionId: it.id } : {})) }
  }

  async view(): Promise<BringView> {
    this.sweep()
    const sources: BringSource[] = []
    for (const l of this.links.values())
      if (l.items.size) sources.push({ id: `pc:${l.code}`, name: l.host || 'computer', live: Date.now() - l.seen < ONLINE_MS, items: [...l.items.values()].map((i) => this.decorate(`pc:${l.code}`, i)) })
    for (const r of this.d.remotes()) {
      if (!r.online) continue
      const items = await this.remoteItems(r).catch(() => [] as Item[])
      if (items.length) sources.push({ id: `remote:${r.id}`, name: r.snap?.machines?.[0]?.name || r.id, live: true, items: items.map((i) => this.decorate(`remote:${r.id}`, i)) })
    }
    const waiting = [...this.links.values()].some((l) => !l.items.size)
    return { sources, waiting }
  }

  private async remoteItems(r: RemoteLike): Promise<Item[]> {
    const c = this.remoteLists.get(r.id)
    if (c && Date.now() - c.at < 30_000) return c.items
    const res = await r.call<{ items: Item[] }>('GET', '/api/bring/local')
    const items = (res.items ?? []).filter((i) => i && (i.tool === 'claude' || i.tool === 'codex') && UUID.test(i.id))
    this.remoteLists.set(r.id, { at: Date.now(), items })
    return items
  }

  /** GET /api/bring/local: this machine's conversations, for the weevils it is connected to. */
  local(): { items: BringItem[] } {
    if (!this.localCache || Date.now() - this.localCache.at > 30_000) this.localCache = { at: Date.now(), items: scanLocal(this.d.claudeDir, this.d.codexHome) }
    return { items: this.localCache.items.map(({ file: _f, ...i }) => i) }
  }

  /** GET /api/bring/local/file?key=: one of the listed files (never any other path), with its folder's git facts. */
  async sendLocal(key: string, res: http.ServerResponse): Promise<void> {
    const it = (this.localCache?.items ?? scanLocal(this.d.claudeDir, this.d.codexHome)).find((i) => i.key === key)
    if (!it) {
      res.writeHead(404).end()
      return
    }
    const head = readEnds(it.file, fs.statSync(it.file).size).head
    const t = parseTranscriptText(it.file, it.tool, head.slice(0, head.lastIndexOf('\n') + 1))
    const git = await gitFacts(t.cwd)
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'x-git-origin': encodeURI(git.origin), 'x-git-root': encodeURI(git.root), 'x-git-branch': encodeURI(git.branch), 'x-name': encodeURI(path.basename(it.file)) })
    await pipeline(fs.createReadStream(it.file), res)
  }

  /** A tap: bring this conversation. */
  request(source: string, key: string): { ok: boolean } {
    const k = `${source}|${key}`
    const st = this.states.get(k)
    if (st?.state === 'moving') return { ok: true }
    if (source.startsWith('pc:')) {
      const l = this.links.get(source.slice(3))
      const it = l?.items.get(key)
      if (!l || !it || it.n === undefined) return { ok: false }
      this.states.set(k, { state: 'moving' })
      if (!l.wants.includes(it.n)) l.wants.push(it.n)
      this.flush(l)
      return { ok: true }
    }
    if (source.startsWith('remote:')) {
      const r = this.d.remotes().find((x) => x.id === source.slice(7) && x.online)
      const it = this.remoteLists.get(source.slice(7))?.items.find((i) => i.key === key)
      if (!r || !it) return { ok: false }
      this.states.set(k, { state: 'moving' })
      void this.fromRemote(r, it, k)
      return { ok: true }
    }
    return { ok: false }
  }

  private flush(l: Link) {
    if (!l.waiter || !l.wants.length) return
    const w = l.waiter
    l.waiter = null
    w(`${l.wants.splice(0).join('\n')}\n`)
  }

  private async fromRemote(r: RemoteLike, it: Item, k: string) {
    const tmp = path.join(this.d.dataDir, 'uploads', `bring-${crypto.randomBytes(6).toString('hex')}`)
    try {
      fs.mkdirSync(path.dirname(tmp), { recursive: true })
      const res = await fetch(`${r.url}/api/bring/local/file?key=${encodeURIComponent(it.key)}`, { headers: r.headers?.() ?? {}, signal: AbortSignal.timeout(10 * 60_000) })
      if (!res.ok || !res.body) throw new Error(String(res.status))
      await pipeline(res.body as unknown as NodeJS.ReadableStream, fs.createWriteStream(tmp, { mode: 0o600 }))
      const h = (n: string) => decode(res.headers.get(n) ?? '')
      await this.settle(k, r.snap?.machines?.[0]?.name || r.id, { tool: it.tool, id: it.id, file: tmp, name: h('x-name'), origin: h('x-git-origin'), root: h('x-git-root'), branch: h('x-git-branch') })
    } catch {
      this.states.set(k, { state: 'failed' })
      this.d.bump()
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  }

  /** One at a time (a clone can take a while; two conversations of the same project must not clone it twice). */
  private settle(k: string, from: string, o: Parameters<typeof arrive>[0]) {
    const job = this.queue.then(async () => {
      const r = await arrive(o, this.d).catch(() => ({ state: 'failed' as const }) as Arrived)
      if (r.state === 'here' && !r.already) {
        this.brought[o.id] = { at: Date.now(), from }
        fs.mkdirSync(path.dirname(this.file), { recursive: true })
        fs.writeFileSync(this.file, JSON.stringify(this.brought))
      }
      this.states.set(k, { state: r.state, ...(r.sessionId ? { sessionId: r.sessionId } : {}), ...(r.note ? { note: r.note } : {}) })
      console.log(`[bring] ${o.tool} ${o.id.slice(0, 8)} from ${from}: ${r.state}${r.already ? ' (already here)' : ''}${r.note ? ` (${r.note})` : ''}`)
      this.d.bump()
    })
    this.queue = job.catch(() => undefined)
    return job
  }

  // ---------------------------------------------------------------- the computer's side (server/bring.sh)

  /** Routes reached with the one-time code instead of the access code. Answers true when it handled the request. */
  async pcRoute(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<boolean> {
    const text = (status: number, body: string) => {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end(body)
    }
    if (pathname === '/api/bring.sh' && req.method === 'GET') {
      const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '')
      const proto = String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0].trim()
      if (!/^[A-Za-z0-9.:[\]-]{1,255}$/.test(host) || !/^https?$/.test(proto)) return text(400, 'bad host\n'), true
      const script = fs.readFileSync(new URL('./bring.sh', import.meta.url), 'utf8').replace('__BASE__', `${proto}://${host}`)
      text(200, script)
      return true
    }
    const m = /^\/api\/bring\/pc\/([A-Za-z0-9_-]{16,64})\/(index|next|file\/(\d{1,4}))$/.exec(pathname)
    if (!m) return false
    const l = this.linkOf(m[1])
    // Gone (expired, or never was): the script stops on « bye ».
    if (!l) return text(m[2] === 'next' ? 200 : 404, 'bye\n'), true
    if (m[2] === 'index' && req.method === 'POST') {
      const buf = await readLimited(req.pipe(zlib.createGunzip()), 200 << 20).catch(() => null)
      if (!buf) return text(400, 'unreadable\n'), true
      const items = parseIndex(buf)
      l.host = String(req.headers['x-host'] ?? '').replace(/[^\w.-]/g, '').slice(0, 40)
      l.items = new Map(items.map((i) => [i.key, i]))
      console.log(`[bring] a computer listed ${items.length} conversations`)
      this.d.bump()
      return text(200, `ok ${items.length}\n`), true
    }
    if (m[2] === 'next' && req.method === 'GET') {
      if (l.wants.length) return text(200, `${l.wants.splice(0).join('\n')}\n`), true
      l.waiter?.('\n')
      const t = setTimeout(() => {
        if (l.waiter === done) l.waiter = null
        text(200, '\n')
      }, 25_000)
      const done = (body: string) => {
        clearTimeout(t)
        text(200, body)
      }
      l.waiter = done
      req.on('close', () => {
        if (l.waiter === done) l.waiter = null
        clearTimeout(t)
      })
      return true
    }
    if (m[3] && req.method === 'POST') {
      const n = Number(m[3])
      const it = [...l.items.values()].find((i) => i.n === n)
      if (!it) return text(404, 'unknown\n'), true
      const k = `pc:${l.code}|${it.key}`
      const tmp = path.join(this.d.dataDir, 'uploads', `bring-${crypto.randomBytes(6).toString('hex')}`)
      fs.mkdirSync(path.dirname(tmp), { recursive: true })
      try {
        let size = 0
        const gunzip = zlib.createGunzip()
        gunzip.on('data', (c: Buffer) => {
          size += c.length
          if (size > 2 ** 31) gunzip.destroy(new Error('too large')) // i18n-ignore: internal, never displayed
        })
        await pipeline(req, gunzip, fs.createWriteStream(tmp, { mode: 0o600 }))
        const h = (name: string) => Buffer.from(String(req.headers[name] ?? ''), 'latin1').toString('utf8').trim()
        await this.settle(k, l.host || 'computer', { tool: it.tool, id: it.id, file: tmp, name: path.basename(it.file), origin: h('x-git-origin'), root: h('x-git-root'), branch: h('x-git-branch') })
        text(this.states.get(k)?.state === 'here' ? 200 : 422, `${this.states.get(k)?.state ?? 'failed'}\n`)
      } catch {
        this.states.set(k, { state: 'failed' })
        this.d.bump()
        text(400, 'failed\n')
      } finally {
        fs.rmSync(tmp, { force: true })
      }
      return true
    }
    return false
  }
}

const decode = (s: string) => {
  try {
    return decodeURI(s)
  } catch {
    return ''
  }
}

function readLimited(stream: NodeJS.ReadableStream, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    let size = 0
    stream.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new Error('too large')) // i18n-ignore: internal, never displayed
        ;(stream as unknown as { destroy?: () => void }).destroy?.()
      } else parts.push(c)
    })
    stream.on('end', () => resolve(Buffer.concat(parts)))
    stream.on('error', reject)
  })
}
