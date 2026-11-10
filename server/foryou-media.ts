// "For you" media shelf: the only images and videos the stream can show. A file gets here on purpose
// (`weevils show <file>`, or a path cited in the message that ends a turn), never by scanning folders; the bytes
// route serves registered ids only, so no path ever comes from a request.

import crypto from 'node:crypto'
import fs from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { tr } from './i18n.ts'
import M from './i18n/foryou-media.ts'
import type { ForYouMedia } from '../shared/foryou.ts'

export type MediaType = 'image' | 'video'

export interface ShelfEntry {
  id: string
  /** Real path (symlinks resolved) at registration. */
  path: string
  type: MediaType
  bytes: number
  mtime: number
  name: string
  /** Last registration: the cap drops the oldest. */
  at: number
}

/** Why a file was refused: `reason` is the catalog key (the message is already in the server's language). */
export type MediaReason = 'missing' | 'notFile' | 'outside' | 'badType' | 'badHeader' | 'tooBig'
export class MediaRefused extends Error {
  reason: MediaReason
  constructor(reason: MediaReason, message: string) {
    super(message)
    this.name = 'MediaRefused'
    this.reason = reason
  }
}

const EXT: Record<string, { type: MediaType; mime: string }> = {
  png: { type: 'image', mime: 'image/png' },
  jpg: { type: 'image', mime: 'image/jpeg' },
  jpeg: { type: 'image', mime: 'image/jpeg' },
  gif: { type: 'image', mime: 'image/gif' },
  webp: { type: 'image', mime: 'image/webp' },
  avif: { type: 'image', mime: 'image/avif' },
  mp4: { type: 'video', mime: 'video/mp4' },
  m4v: { type: 'video', mime: 'video/mp4' },
  webm: { type: 'video', mime: 'video/webm' },
  mov: { type: 'video', mime: 'video/quicktime' },
}
const EXTS = Object.keys(EXT).join('|')

export const MAX_ENTRIES = 600
export const CAPS: Record<MediaType, number> = { image: 25 * 1024 * 1024, video: 400 * 1024 * 1024 }
/** Bytes read to recognise a file. */
const HEAD = 64

const extOf = (p: string) => path.extname(p).slice(1).toLowerCase()

/** Content type of a media file name (by extension); undefined when it is neither an image nor a video we take. */
export const mimeOf = (p: string): string | undefined => EXT[extOf(p)]?.mime

/** What the first bytes of a file are, whatever its name says. null: nothing we show. */
export function sniff(b: Uint8Array): MediaType | null {
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength)
  const at = (s: string, o = 0) => buf.length >= o + s.length && buf.toString('latin1', o, o + s.length) === s
  if (at('\x89PNG\r\n\x1a\n')) return 'image'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image'
  if (at('GIF87a') || at('GIF89a')) return 'image'
  if (at('RIFF') && at('WEBP', 8)) return 'image'
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'video' // EBML (webm)
  if (at('ftyp', 4)) {
    // ISO media: the brands (major at 8, compatible ones from 16) tell a still image (avif) from a film.
    const size = Math.min(buf.length, Math.max(16, buf.readUInt32BE(0)))
    const brands = [buf.toString('latin1', 8, 12)]
    for (let o = 16; o + 4 <= size; o += 4) brands.push(buf.toString('latin1', o, o + 4))
    return brands.some((x) => x === 'avif' || x === 'avis') ? 'image' : 'video'
  }
  // Old QuickTime files start straight with an atom, without « ftyp ».
  if (['moov', 'mdat', 'wide', 'free', 'skip'].some((a) => at(a, 4))) return 'video'
  return null
}

/**
 * One byte range of a file of `size` bytes, from a Range header. null: no usable range (absent, another unit,
 * several ranges, malformed) → the whole file with 200, as HTTP allows. 'unsatisfiable' → 416.
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header)
  if (!m || (!m[1] && !m[2])) return null
  if (!m[1]) {
    // « -n »: the last n bytes.
    const n = Number(m[2])
    if (!n || !size) return 'unsatisfiable'
    return { start: Math.max(0, size - n), end: size - 1 }
  }
  const start = Number(m[1])
  const end = m[2] ? Number(m[2]) : size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (m[2] && end < start)) return null
  if (start >= size) return 'unsatisfiable'
  return { start, end: Math.min(end, size - 1) }
}

/** Folders an agent's own machinery lives in: nothing cited from there is a result to show. */
const hidden = (seg: string) => seg === 'node_modules' || (seg.startsWith('.') && seg !== '.' && seg !== '..')

// A path-looking word ending with a media extension, or the same between backticks / quotes / link parentheses
// (where it may hold spaces).
const BARE = new RegExp(`[^\\s\`"'«»“”‘’<>()\\[\\]{}|*,;]+\\.(?:${EXTS})(?![\\w/]|[.-]\\w)`, 'gi') // i18n-ignore : motif de recherche (guillemets français), jamais affiché
const QUOTED = new RegExp(`(?:\`|"|“|«\\s?|\\]\\(<?)([^\`"“”«»\\n()<>]{1,400}?\\.(?:${EXTS}))(?=\\s?[\`"”»)>]|\\s+"[^"\\n]*"\\))`, 'gi') // i18n-ignore : motif de recherche (guillemets français), jamais affiché

/** Paths of images and videos cited in prose, in order of appearance, as written (not checked). */
export function citedPaths(text: string): string[] {
  const hits: { i: number; p: string }[] = []
  for (const m of text.matchAll(QUOTED)) {
    const p = m[1].trim()
    // Words between two quotes that merely end with a file name are prose, not a path with spaces.
    if (/\s/.test(p) && !m[0].startsWith('`') && !p.split(/\s/)[0].includes('/')) continue
    hits.push({ i: m.index + m[0].indexOf(p), p })
  }
  for (const m of text.matchAll(BARE)) {
    // Already inside a quoted hit (a path with spaces): keep the whole one.
    if (hits.some((h) => m.index >= h.i && m.index < h.i + h.p.length && h.p.length > m[0].length)) continue
    hits.push({ i: m.index, p: m[0] })
  }
  const out: string[] = []
  for (const h of hits.sort((a, b) => a.i - b.i)) {
    // « file=/x/a.png », « rendu:/x/a.png »: keep the path.
    if (h.p.includes('://')) continue
    const p = h.p.replace(/^[^/~]*[=:](?=[~/])/, '')
    if (out.includes(p)) continue
    out.push(p)
  }
  return out
}

export class MediaShelf {
  private file: string
  private roots: string[]
  private caps: Record<MediaType, number>
  private entries = new Map<string, ShelfEntry>()

  /** `caps` (bytes per type) only exists for the tests. */
  constructor(opts: { file: string; roots: string[]; caps?: Partial<Record<MediaType, number>> }) {
    this.file = opts.file
    this.roots = opts.roots.filter(Boolean).map((r) => path.resolve(r))
    this.caps = { ...CAPS, ...opts.caps }
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { entries?: ShelfEntry[] }
      for (const e of raw.entries ?? []) {
        if (e && typeof e.id === 'string' && typeof e.path === 'string' && (e.type === 'image' || e.type === 'video')) this.entries.set(e.id, e)
      }
    } catch {
      // No shelf yet, or unreadable: start empty.
    }
  }

  /** Roots as they really are on disk (a root can be a symlink, or not exist yet). */
  private realRoots(): string[] {
    const out: string[] = []
    for (const r of this.roots) {
      try {
        out.push(fs.realpathSync(r))
      } catch {
        // Not there (no inbox yet).
      }
    }
    return out
  }

  private inside(real: string, roots: string[]): boolean {
    return roots.some((r) => real.startsWith(r.endsWith(path.sep) ? r : r + path.sep))
  }

  private absolute(p: string, cwd?: string): string | null {
    const s = p.trim()
    if (!s || s.includes('\0')) return null
    if (s === '~' || s.startsWith('~/')) return path.join(os.homedir(), s.slice(1))
    if (path.isAbsolute(s)) return path.resolve(s)
    return cwd && path.isAbsolute(cwd) ? path.resolve(cwd, s) : null
  }

  /** The first bytes of a file say what `type` promises. */
  private looksLike(file: string, type: MediaType): boolean {
    let fd: number | undefined
    try {
      fd = fs.openSync(file, 'r')
      const buf = Buffer.alloc(HEAD)
      const n = fs.readSync(fd, buf, 0, HEAD, 0)
      return sniff(buf.subarray(0, n)) === type
    } catch {
      return false
    } finally {
      if (fd !== undefined) fs.closeSync(fd)
    }
  }

  private save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ entries: [...this.entries.values()] }), { mode: 0o600 })
      fs.renameSync(tmp, this.file)
    } catch {
      // Disk full or read-only: the shelf stays in memory.
    }
  }

  add(p: string, cwd?: string): ShelfEntry {
    const t = tr(M)
    const abs = this.absolute(p, cwd)
    if (!abs) throw new MediaRefused('missing', t.missing)
    let real: string
    let st: fs.Stats
    try {
      real = fs.realpathSync(abs)
      st = fs.statSync(real)
    } catch {
      throw new MediaRefused('missing', t.missing)
    }
    // The jail is checked on the real path: a link inside a project that points elsewhere is elsewhere.
    if (!this.inside(real, this.realRoots())) throw new MediaRefused('outside', t.outside)
    if (!st.isFile()) throw new MediaRefused('notFile', t.notFile)
    const ext = extOf(real)
    const kind = EXT[ext]
    if (!kind) throw new MediaRefused('badType', t.badType)
    const cap = this.caps[kind.type]
    if (st.size > cap) throw new MediaRefused('tooBig', t.tooBig(Math.max(1, Math.floor(cap / (1024 * 1024)))))
    if (!this.looksLike(real, kind.type)) throw new MediaRefused('badHeader', t.badHeader(ext))

    const id = crypto.createHash('sha256').update(real).digest('hex').slice(0, 16)
    const entry: ShelfEntry = { id, path: real, type: kind.type, bytes: st.size, mtime: Math.round(st.mtimeMs), name: path.basename(real), at: Date.now() }
    this.entries.delete(id)
    this.entries.set(id, entry)
    if (this.entries.size > MAX_ENTRIES) {
      const old = [...this.entries.values()].sort((a, b) => a.at - b.at).slice(0, this.entries.size - MAX_ENTRIES)
      for (const e of old) this.entries.delete(e.id)
    }
    this.save()
    return entry
  }

  /** A cited path is refused when it goes through a hidden folder below a root (.run, .work, .git, node_modules). */
  private hiddenBelowRoot(abs: string, roots: string[]): boolean {
    // Roots themselves may sit under a dot folder (~/.local/share/weevils): only what is below counts.
    const below = roots.filter((r) => abs.startsWith(r + path.sep)).sort((a, b) => a.length - b.length)[0]
    return below !== undefined && abs.slice(below.length).split(path.sep).some(hidden)
  }

  fromText(text: string, cwd: string | undefined, max = 4): ShelfEntry[] {
    const out: ShelfEntry[] = []
    try {
      const real = this.realRoots()
      const roots = [...new Set([...this.roots, ...real])]
      // Bounded: a message listing a hundred frames costs forty stats, not a hundred.
      for (const cited of citedPaths(String(text ?? '')).slice(0, 40)) {
        if (out.length >= max) break
        for (const candidate of cited.includes('%') ? [cited, decoded(cited)] : [cited]) {
          const abs = this.absolute(candidate, cwd)
          if (!abs) continue
          try {
            if (this.hiddenBelowRoot(abs, roots) || this.hiddenBelowRoot(fs.realpathSync(abs), real)) break
            const e = this.add(abs)
            if (!out.some((o) => o.id === e.id)) out.push(e)
            break
          } catch {
            // Not there, not ours, not a media: not cited for the stream.
          }
        }
      }
    } catch {
      // Never breaks the turn that ends.
    }
    return out
  }

  get(id: string): ShelfEntry | null {
    const e = this.entries.get(id)
    if (!e) return null
    try {
      // Still the same real file (a link swapped in its place would leave the jail), still that kind of media.
      const st = fs.statSync(e.path)
      if (!st.isFile() || fs.realpathSync(e.path) !== e.path || st.size > this.caps[e.type]) throw new Error()
      const mtime = Math.round(st.mtimeMs)
      if (st.size !== e.bytes || mtime !== e.mtime) {
        if (!this.looksLike(e.path, e.type)) throw new Error()
        e.bytes = st.size
        e.mtime = mtime
        this.save()
      }
      return e
    } catch {
      this.entries.delete(id)
      this.save()
      return null
    }
  }

  /** Every entry whose file is still there, newest first (the gone ones are dropped). */
  list(): ShelfEntry[] {
    return [...this.entries.keys()]
      .map((id) => this.get(id))
      .filter((e): e is ShelfEntry => !!e)
      .sort((a, b) => b.at - a.at)
  }

  view(e: ShelfEntry): ForYouMedia {
    return { id: e.id, type: e.type, url: '/api/foryou/media/' + e.id, name: e.name, bytes: e.bytes }
  }

  serve(req: IncomingMessage, res: ServerResponse, id: string): void {
    const gone = () => {
      if (res.headersSent) return void res.destroy()
      res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ error: tr(M).gone }))
    }
    const e = this.get(id)
    if (!e) return gone()
    let fd: number
    let size: number
    try {
      // Size and bytes from the same open file: the length announced is the length sent.
      fd = fs.openSync(e.path, 'r')
      const st = fs.fstatSync(fd)
      if (!st.isFile()) {
        fs.closeSync(fd)
        return gone()
      }
      size = st.size
    } catch {
      return gone()
    }
    const headers: Record<string, string | number> = {
      'content-type': mimeOf(e.path) ?? 'application/octet-stream',
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=3600',
      'x-content-type-options': 'nosniff',
    }
    const range = parseRange(typeof req.headers.range === 'string' ? req.headers.range : undefined, size)
    if (range === 'unsatisfiable') {
      fs.closeSync(fd)
      res.writeHead(416, { ...headers, 'content-range': `bytes */${size}`, 'content-length': 0 }).end()
      return
    }
    const start = range ? range.start : 0
    const end = range ? range.end : size - 1
    headers['content-length'] = end - start + 1
    if (range) headers['content-range'] = `bytes ${start}-${end}/${size}`
    res.writeHead(range ? 206 : 200, headers)
    if (req.method === 'HEAD' || end < start) {
      fs.closeSync(fd)
      res.end()
      return
    }
    const stream = fs.createReadStream('', { fd, start, end, autoClose: true })
    // Headers are gone already: a read error can only cut the response short.
    stream.on('error', () => res.destroy())
    // The player went away (seek, page closed): stop reading.
    res.on('close', () => stream.destroy())
    stream.pipe(res)
  }
}

function decoded(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}
