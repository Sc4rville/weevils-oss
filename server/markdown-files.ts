import type http from 'node:http'
import type { Weevils } from './core.ts'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { tr } from './i18n.ts'
import M from './i18n/markdown-files.ts'

export const MARKDOWN_LIMIT = 400_000
export class MarkdownFileError extends Error {
  status: number
  constructor(status: number, key: 'invalid' | 'conflict' | 'readonly') { super(tr(M)[key]); this.status = status }
}
const excludedDirectories = new Set(['node_modules', 'dist', 'build', 'coverage', 'vendor', 'generated'])
const hash = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex')
function resolveMarkdown(root: string, rel: string) {
  if (!/\.(md|markdown)$/i.test(rel) || path.isAbsolute(rel) || rel.split(/[\\/]/).some((p, i, parts) => !p || p === '..' || p.startsWith('.') || (i < parts.length - 1 && excludedDirectories.has(p.toLowerCase()))) || rel.includes('\0')) throw new MarkdownFileError(400, 'invalid')
  const base = fs.realpathSync(root)
  let full = base
  for (const part of rel.split('/')) {
    full = path.join(full, part)
    if (fs.lstatSync(full).isSymbolicLink()) throw new MarkdownFileError(400, 'invalid')
  }
  if (!full.startsWith(base + path.sep)) throw new MarkdownFileError(400, 'invalid')
  const st = fs.statSync(full)
  if (!st.isFile() || st.nlink !== 1 || st.size > MARKDOWN_LIMIT) throw new MarkdownFileError(400, 'invalid')
  return { full, st }
}
export function readMarkdown(root: string, rel: string) {
  const { full, st } = resolveMarkdown(root, rel)
  const bytes = fs.readFileSync(full)
  if (bytes.length > MARKDOWN_LIMIT || bytes.includes(0) || !Buffer.from(bytes.toString('utf8')).equals(bytes)) throw new MarkdownFileError(400, 'invalid')
  let editable = true
  try { fs.accessSync(full, fs.constants.W_OK); fs.accessSync(path.dirname(full), fs.constants.W_OK) } catch { editable = false }
  return { path: rel, size: bytes.length, binary: false, content: bytes.toString('utf8'), truncated: false, revision: hash(bytes), editable, mode: st.mode }
}
/** Synchronous comparison + atomic replacement serializes app saves, never a blind retry after a lost response. */
export function saveMarkdown(root: string, rel: string, content: unknown, revision: unknown) {
  if (typeof content !== 'string' || typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision) || Buffer.byteLength(content) > MARKDOWN_LIMIT || content.includes('\0') || Buffer.from(content, 'utf8').toString('utf8') !== content) throw new MarkdownFileError(400, 'invalid')
  const previous = readMarkdown(root, rel)
  if (!previous.editable) throw new MarkdownFileError(403, 'readonly')
  // A response may have been lost after this exact content was committed.
  if (previous.content === content) return previous
  if (previous.revision !== revision) throw new MarkdownFileError(409, 'conflict')
  const { full } = resolveMarkdown(root, rel)
  const temp = path.join(path.dirname(full), `.weevils-edit-${crypto.randomUUID()}`)
  try {
    const fd = fs.openSync(temp, 'wx', previous.mode & 0o777)
    try { fs.writeFileSync(fd, content, 'utf8'); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    // Recheck after staging, so an editor that saved while staging cannot be overwritten.
    if (readMarkdown(root, rel).revision !== revision) throw new MarkdownFileError(409, 'conflict')
    fs.renameSync(temp, full)
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp) }
  return readMarkdown(root, rel)
}

/** Shared by the authenticated server and isolated HTTP integration tests. */
export function markdownFileRoutes(
  w: Pick<Weevils, 'remoteById' | 'repoDir' | 'file' | 'assertRepoExecution'>,
  json: (res: http.ServerResponse, status: number, body: unknown) => void,
  readBody: (req: http.IncomingMessage) => Promise<any>,
): [string, RegExp, (req: http.IncomingMessage, res: http.ServerResponse, url: URL, params: string[]) => Promise<void>][] {
  return [
  ['GET', /^\/api\/repos\/([^/]+)\/file$/, async (_req, res, url, [repo]) => {
    const remote = w.remoteById(url.searchParams.get('machine') ?? undefined)
    const p = url.searchParams.get('path') ?? ''
    if (remote) return json(res, 200, await remote.call('GET', `/api/repos/${repo}/file?path=${encodeURIComponent(p)}`))
    if (/\.(md|markdown)$/i.test(p)) {
      try { return json(res, 200, readMarkdown(w.repoDir(decodeURIComponent(repo)), p)) } catch { /* Non-editable files retain their existing reader. */ }
    }
    json(res, 200, await w.file(decodeURIComponent(repo), p))
  }],
  ['PUT', /^\/api\/repos\/([^/]+)\/file$/, async (req, res, url, [repo]) => {
    const remote = w.remoteById(url.searchParams.get('machine') ?? undefined)
    const p = url.searchParams.get('path') ?? ''
    const body = await readBody(req)
    try {
      if (!remote) w.assertRepoExecution(decodeURIComponent(repo))
      const file = remote ? await remote.call('PUT', `/api/repos/${repo}/file?path=${encodeURIComponent(p)}`, body)
        : saveMarkdown(w.repoDir(decodeURIComponent(repo)), p, body?.content, body?.revision)
      json(res, 200, file)
    } catch (e) {
      if (e instanceof MarkdownFileError || (e instanceof Error && 'status' in e && e.status === 409)) return json(res, Number(e.status), { error: e.message })
      throw e
    }
  }],
  ]
}
