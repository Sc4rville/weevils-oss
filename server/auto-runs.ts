// What an « auto » run left behind, for the automation page (GET /api/auto/:id…): the files it changed (git diff in
// its worktree, or what was written in its workspace during the run), the links it gave, its screenshots, and the
// archive of each run (DATA_DIR/auto/<id>/<startedAt>.json, its images beside it in <startedAt>/). For the systemd
// timers, the runs come from the user journal, one per invocation. The tasks are in server/optimizers.ts, the timers
// and jobs in core.ts. Pure parts tested in auto-runs.test.ts.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AutoOutputFile, AutoRun, AutoRunDetail } from '../shared/api.ts'

export const IMAGE_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }
export const isImage = (p: string) => Object.hasOwn(IMAGE_MIME, path.extname(p).toLowerCase())

const MAX_LINKS = 20
const MAX_FILES = 300
/** Images copied into the archive per run, and the largest one. */
const MAX_IMAGES = 6
const MAX_IMAGE_BYTES = 8 << 20
/** A new text file under this size gets its lines counted (+N). */
const COUNT_BYTES = 1 << 20
/** A report or a message kept in the archive, at most. */
export const MAX_REPORT = 200_000
/** Lines of log kept per run (timer, job). */
export const MAX_LOG_LINES = 200

/** The web links of a report and a message, in order, once each (trailing punctuation off). */
export function extractLinks(...texts: (string | undefined)[]): string[] {
  const out: string[] = []
  for (const t of texts)
    for (const m of (t ?? '').matchAll(/https?:\/\/[^\s<>"'`()[\]{}]+/g)) {
      const u = m[0].replace(/[.,;:!?*_]+$/, '')
      if (u.length > 10 && !out.includes(u)) out.push(u)
      if (out.length >= MAX_LINKS) return out
    }
  return out
}

/**
 * `git diff -z --numstat` and `git diff -z --name-status` (renames found) of the same range → the files, in name-status
 * order. A binary file counts 0 lines; a copy reads as added.
 */
export function parseDiff(numstat: string, names: string, cwd: string): AutoOutputFile[] {
  const counts = new Map<string, { add: number; del: number }>()
  const a = numstat.split('\0')
  for (let i = 0; i < a.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t([^]*)$/.exec(a[i].replace(/^\n/, ''))
    if (!m) continue
    let p = m[3]
    // A rename: « add del \0 old \0 new ».
    if (p === '') {
      p = a[i + 2] ?? ''
      i += 2
    }
    if (p) counts.set(p, { add: m[1] === '-' ? 0 : Number(m[1]), del: m[2] === '-' ? 0 : Number(m[2]) })
  }
  const out: AutoOutputFile[] = []
  const b = names.split('\0')
  for (let i = 0; i < b.length && out.length < MAX_FILES; i++) {
    const k = b[i].replace(/^\n/, '')[0]
    if (!k) continue
    let p: string | undefined
    let status: AutoOutputFile['status']
    if (k === 'R' || k === 'C') {
      p = b[i + 2]
      i += 2
      status = k === 'R' ? 'R' : 'A'
    } else {
      p = b[i + 1]
      i += 1
      status = k === 'A' || k === 'D' ? k : 'M'
    }
    if (!p) continue
    const c = counts.get(p) ?? { add: 0, del: 0 }
    out.push({ path: p, abs: path.join(cwd, p), status, add: c.add, del: c.del })
  }
  return out
}

/** Lines of a small text file (a new file's « +N »), 0 for a binary or a large one. */
function lineCount(file: string): number {
  try {
    const st = fs.lstatSync(file)
    if (!st.isFile() || st.size > COUNT_BYTES) return 0
    const buf = fs.readFileSync(file)
    if (buf.subarray(0, 8000).includes(0)) return 0
    const text = buf.toString('utf8')
    return text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0
  } catch {
    return 0
  }
}

/**
 * The git dirs of a task's worktree, fixed by the server, never read from the worktree: a jailed agent can rewrite the
 * worktree's `.git` file and everything under `<repo>/.git` but its `config` and `hooks` (jailArgs), so letting git find
 * its dirs from there would let it point them at a config of its own, whose clean filter or fsmonitor git would then
 * run here, unjailed. So git gets a private admin dir made here (privateGitDir): the worktree's HEAD and index copied
 * as data, its `commondir` the repo's `.git`, whose config is read-only in the jail. null: not a worktree of that repo.
 */
export interface WorktreeGit {
  cwd: string
  /** <repo>/.git/worktrees/<name>: where its HEAD and index are read (as data only). */
  adminDir: string
  commonDir: string
  /** Its HEAD: a ref under refs/ or a commit id, nothing else. */
  head: string
}

const isDir = (p: string) => fs.lstatSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false

export function worktreeGit(repoDir: string, cwd: string): WorktreeGit | null {
  const commonDir = path.join(repoDir, '.git')
  if (!isDir(commonDir) || !isDir(cwd)) return null
  const admin = path.join(commonDir, 'worktrees')
  let names: string[]
  try {
    names = fs.readdirSync(admin)
  } catch {
    return null
  }
  // The admin dir whose gitdir names this worktree; else the one git gives by default (the folder's name).
  const own = path.join(cwd, '.git')
  const named = names.find((n) => {
    try {
      return path.resolve(fs.readFileSync(path.join(admin, n, 'gitdir'), 'utf8').trim()) === own
    } catch {
      return false
    }
  })
  const name = named ?? (names.includes(path.basename(cwd)) ? path.basename(cwd) : undefined)
  if (!name || !isDir(path.join(admin, name))) return null
  const head = adminFile(path.join(admin, name), 'HEAD', 4096)?.toString('utf8').trim() ?? ''
  if (!/^(ref: refs\/[\w./-]+|[0-9a-f]{40}|[0-9a-f]{64})$/.test(head) || head.includes('..')) return null
  return { cwd, adminDir: path.join(admin, name), commonDir, head }
}

/** An index past this size is not copied (git then sees no index: the diff is still right, only slower). */
const MAX_INDEX = 64 << 20

/** A regular file of the admin dir (never a link, never too big), or undefined. */
function adminFile(dir: string, name: string, max: number): Buffer | undefined {
  const f = path.join(dir, name)
  const st = fs.lstatSync(f, { throwIfNoEntry: false })
  return st?.isFile() && st.size <= max ? fs.readFileSync(f) : undefined
}

/** Runs `use` with git's environment pointed at a private admin dir (see WorktreeGit), removed after. */
async function withGit<T>(w: WorktreeGit, use: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weevils-git-'))
  try {
    fs.writeFileSync(path.join(dir, 'HEAD'), `${w.head}\n`)
    fs.writeFileSync(path.join(dir, 'commondir'), `${w.commonDir}\n`)
    const index = adminFile(w.adminDir, 'index', MAX_INDEX)
    if (index) fs.writeFileSync(path.join(dir, 'index'), index)
    const env: NodeJS.ProcessEnv = {}
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v
    return await use({ ...env, GIT_DIR: dir, GIT_COMMON_DIR: w.commonDir, GIT_WORK_TREE: w.cwd, GIT_ATTR_NOSYSTEM: '1' })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const git = (w: WorktreeGit, env: NodeJS.ProcessEnv, args: string[]) =>
  new Promise<string>((resolve, reject) =>
    // Never an external diff or a textconv driver (a task wrote the worktree's attributes), never an fsmonitor.
    execFile('git', ['-c', 'core.fsmonitor=false', ...args], { cwd: w.cwd, env, timeout: 20_000, maxBuffer: 16 << 20 }, (e, out) => (e ? reject(e) : resolve(out))),
  )

/** HEAD of a task's worktree (where a run starts from), or undefined when it is none (worktreeGit). */
export async function headOf(repoDir: string, cwd: string): Promise<string | undefined> {
  const w = worktreeGit(repoDir, cwd)
  if (!w) return undefined
  try {
    return (await withGit(w, (env) => git(w, env, ['rev-parse', 'HEAD']))).trim() || undefined
  } catch {
    return undefined
  }
}

/**
 * What a run changed in its worktree: its commits since `base`, plus what it left uncommitted and the new files git
 * does not track yet, those only when written during the run (`since` on: a recurring task's worktree keeps what an
 * earlier run left lying there, never shown again as this run's). null when git cannot tell (not a repo, base gone).
 */
export async function gitFiles(repoDir: string, cwd: string, base: string, since = 0): Promise<AutoOutputFile[] | null> {
  const w = worktreeGit(repoDir, cwd)
  if (!w) return null
  try {
    const diff = ['diff', '-z', '-M', '--no-ext-diff', '--no-textconv']
    // One after the other: they share the private index (git refreshes it).
    const [num, names, others, committed] = await withGit(w, async (env) => [
      await git(w, env, [...diff, '--numstat', base]),
      await git(w, env, [...diff, '--name-status', base]),
      await git(w, env, ['ls-files', '-z', '--others', '--exclude-standard']),
      await git(w, env, ['diff', '-z', '--no-ext-diff', '--no-textconv', '--name-only', base, 'HEAD']),
    ])
    const inCommits = new Set(committed.split('\0').filter(Boolean))
    const fresh = (abs: string) => {
      const st = fs.lstatSync(abs, { throwIfNoEntry: false })
      return !!st && st.mtimeMs >= since - 2000
    }
    const out = parseDiff(num, names, cwd).filter((f) => !since || inCommits.has(f.path) || fresh(f.abs))
    for (const p of others.split('\0').filter(Boolean)) {
      if (out.length >= MAX_FILES) break
      const abs = path.join(cwd, p)
      if (since && !fresh(abs)) continue
      out.push({ path: p, abs, status: 'A', add: lineCount(abs), del: 0 })
    }
    return out
  } catch {
    return null
  }
}

/**
 * What a run wrote in a folder that is no repo: the files modified during the run (from − 2 s … to + 2 s), new ones
 * as added. Hidden entries, node_modules and `skip` (the report) are left out; links are never followed.
 */
export function mtimeFiles(dir: string, from: number, to: number, skip: string[] = []): AutoOutputFile[] {
  const out: AutoOutputFile[] = []
  let seen = 0
  const walk = (rel: string, depth: number) => {
    let es: fs.Dirent[]
    try {
      es = fs.readdirSync(path.join(dir, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of es) {
      if (++seen > 5000 || out.length >= MAX_FILES) return
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const r = rel ? `${rel}/${e.name}` : e.name
      const abs = path.join(dir, r)
      if (e.isDirectory()) {
        if (depth < 6) walk(r, depth + 1)
        continue
      }
      if (!e.isFile() || skip.includes(abs)) continue
      let st: fs.Stats
      try {
        st = fs.lstatSync(abs)
      } catch {
        continue
      }
      if (st.mtimeMs < from - 2000 || st.mtimeMs > to + 2000) continue
      const added = (st.birthtimeMs || st.ctimeMs) >= from - 2000
      out.push({ path: r, abs, status: added ? 'A' : 'M', add: added ? lineCount(abs) : 0, del: 0 })
    }
  }
  walk('', 0)
  return out.sort((x, y) => x.path.localeCompare(y.path))
}

/**
 * An image file a task may show (GET /api/auto/:id/blob): an absolute path (or one relative to the first root) with
 * an image extension, no « .. », whose real path (links followed) is a regular image file under one of `roots` (its
 * workspace, its archive). Its real path, else null.
 */
export function blobPath(p: unknown, roots: string[]): string | null {
  if (typeof p !== 'string' || !p || p.includes('\0') || !roots.length) return null
  if (p.split(/[\\/]/).includes('..') || !isImage(p)) return null
  const want = path.isAbsolute(p) ? p : path.join(roots[0], p)
  let real: string
  try {
    real = fs.realpathSync(want)
    if (!fs.statSync(real).isFile()) return null
  } catch {
    return null
  }
  if (!isImage(real)) return null
  for (const r of roots) {
    let root: string
    try {
      root = fs.realpathSync(r)
    } catch {
      continue
    }
    if (real.startsWith(root + path.sep)) return real
  }
  return null
}

/** The runs of an automation, one file each: DATA_DIR/auto/<id>/<startedAt>.json (+ <startedAt>/ for its images). */
export class RunArchive {
  readonly dir: string
  constructor(dir: string) {
    this.dir = dir
  }

  /** The folder of one automation (an id is a task id: hex). */
  home(id: string): string {
    // i18n-ignore : never shown (ids are checked by the routes)
    if (!/^[\w-]+$/.test(id)) throw new Error('bad id')
    return path.join(this.dir, id)
  }

  write(id: string, d: AutoRunDetail) {
    const f = path.join(this.home(id), `${d.run.startedAt}.json`)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(d))
    fs.renameSync(`${f}.tmp`, f)
  }

  read(id: string, startedAt: number): AutoRunDetail | null {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(this.home(id), `${startedAt}.json`), 'utf8')) as AutoRunDetail
      return d && typeof d === 'object' && d.run ? { ...d, files: d.files ?? [], links: d.links ?? [], images: d.images ?? [] } : null
    } catch {
      return null
    }
  }

  /** The images among a run's files, copied beside its archive (the worktree changes at the next run): their copies. */
  copyImages(id: string, startedAt: number, files: AutoOutputFile[]): string[] {
    const out: string[] = []
    const to = path.join(this.home(id), String(startedAt))
    for (const f of files) {
      if (out.length >= MAX_IMAGES) break
      if (f.status === 'D' || !isImage(f.path)) continue
      try {
        const st = fs.lstatSync(f.abs)
        if (!st.isFile() || st.size > MAX_IMAGE_BYTES) continue
        fs.mkdirSync(to, { recursive: true })
        const dest = path.join(to, `${out.length}-${path.basename(f.path)}`)
        fs.copyFileSync(f.abs, dest)
        out.push(dest)
      } catch {
        /* gone meanwhile */
      }
    }
    return out
  }

  /** Keeps the runs started at `keep`, removes the others (and their images). */
  prune(id: string, keep: number[]) {
    const home = this.home(id)
    let names: string[]
    try {
      names = fs.readdirSync(home)
    } catch {
      return
    }
    const kept = new Set(keep.map(String))
    for (const n of names) if (!kept.has(n.replace(/\.json$/, ''))) fs.rmSync(path.join(home, n), { recursive: true, force: true })
  }

  drop(id: string) {
    fs.rmSync(this.home(id), { recursive: true, force: true })
  }
}

/** One invocation of a timer's service in the user journal: a run, its log lines. */
export interface JournalRun extends AutoRun {
  inv: string
  lines: string[]
}

/**
 * `journalctl --user -u <svc> -o json` → its runs, oldest first, grouped by invocation (the service's own lines carry
 * _SYSTEMD_INVOCATION_ID, systemd's about it USER_INVOCATION_ID): first and last line, failed when it exited non-zero
 * or ended on a failed result. Lines without an invocation (a start skipped on a condition) are no run.
 */
export function journalRuns(stdout: string): JournalRun[] {
  const by = new Map<string, JournalRun>()
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    let o: Record<string, unknown>
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    const inv = String(o._SYSTEMD_INVOCATION_ID || o.USER_INVOCATION_ID || o.INVOCATION_ID || '')
    const ts = Math.round(Number(o.__REALTIME_TIMESTAMP) / 1000)
    if (!inv || !Number.isFinite(ts) || ts <= 0) continue
    let r = by.get(inv)
    if (!r) by.set(inv, (r = { inv, at: ts, startedAt: ts, ok: true, lines: [] }))
    r.startedAt = Math.min(r.startedAt, ts)
    r.at = Math.max(r.at, ts)
    const exit = o.EXIT_STATUS
    if ((exit !== undefined && exit !== '' && String(exit) !== '0') || (typeof o.UNIT_RESULT === 'string' && o.UNIT_RESULT !== 'success') || (typeof o.JOB_RESULT === 'string' && !['done', 'skipped'].includes(o.JOB_RESULT))) r.ok = false
    if (typeof o.MESSAGE === 'string' && o._SYSTEMD_INVOCATION_ID) {
      r.lines.push(o.MESSAGE)
      if (r.lines.length > MAX_LOG_LINES) r.lines.shift()
    }
  }
  return [...by.values()].sort((a, b) => a.startedAt - b.startedAt)
}

/** The last `n` lines of a log file, colours off. */
export function tailLines(file: string, n = MAX_LOG_LINES): string {
  try {
    const st = fs.statSync(file)
    const len = Math.min(st.size, 256 << 10)
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, st.size - len)
    fs.closeSync(fd)
    return buf
      .toString('utf8')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
      .replace(/\r(?!\n)/g, '\n')
      .split('\n')
      .slice(-n)
      .join('\n')
      .trim()
  } catch {
    return ''
  }
}

/** `systemctl show <units> -p Id -p Description` → Description by unit (empty ones left out). */
export function unitDescriptions(stdout: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const block of stdout.split(/\n\s*\n/)) {
    const id = /^Id=(.+)$/m.exec(block)?.[1]?.trim()
    const d = /^Description=(.*)$/m.exec(block)?.[1]?.trim()
    if (id && d) out.set(id, d)
  }
  return out
}
