import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import type { Plugin } from 'vite'

interface Registration {
  version: 1
  gitCommonDir: string
  wrappers: { name: string; sha256: string }[]
}
const registryPath = () => path.join(os.homedir(), '.local/share/weevils/private-previews/build-wrappers.json')
const digest = (data: Buffer) => crypto.createHash('sha256').update(data).digest('hex')
const wrapperName = (name: string) => /^[a-z0-9][a-z0-9-]*(?:-access|-setup)\.html$/.test(name)
function commonDir(root: string): string | null {
  try {
    const dir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return fs.realpathSync(dir)
  } catch { return null }
}
function wrapperBytes(directory: string, name: string): Buffer {
  if (!wrapperName(name)) throw new Error('Invalid private preview wrapper filename')
  const file = path.join(directory, name)
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error(`Invalid private preview wrapper: ${name}`)
  return fs.readFileSync(file)
}

/** Explicit one-time registration of reviewed, token-free HTML only. Nothing is written to the repository. */
export function registerPreviewWrappers(root: string, names: string[], registry = registryPath()): void {
  const gitCommonDir = commonDir(root)
  if (!gitCommonDir) throw new Error('Private wrappers require a canonical Git checkout')
  if (!names.length || new Set(names).size !== names.length) throw new Error('Provide distinct reviewed wrapper filenames')
  const directory = path.join(path.dirname(registry), 'wrappers')
  const wrappers = names.map(name => ({ name, sha256: digest(wrapperBytes(directory, name)) }))
  const record: Registration = { version: 1, gitCommonDir, wrappers }
  const temp = `${registry}.${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(temp, JSON.stringify(record, null, 2), { mode: 0o600, flag: 'wx' })
    fs.renameSync(temp, registry)
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp) }
}

/** Only the registered checkout and its worktrees receive wrappers. Other clones and source exports get none. */
export function readPreviewWrappers(root: string, registry = registryPath()): { name: string; bytes: Buffer }[] {
  if (!fs.existsSync(registry)) return []
  const record = JSON.parse(fs.readFileSync(registry, 'utf8')) as Registration
  if (record.version !== 1 || !record.gitCommonDir || !Array.isArray(record.wrappers)) throw new Error('Invalid private preview wrapper registration')
  if (commonDir(root) !== record.gitCommonDir) return []
  if (!record.wrappers.length || new Set(record.wrappers.map(w => w.name)).size !== record.wrappers.length) throw new Error('Invalid private preview wrapper list')
  const directory = path.join(path.dirname(registry), 'wrappers')
  return record.wrappers.map(({ name, sha256 }) => {
    const bytes = wrapperBytes(directory, name)
    if (digest(bytes) !== sha256) throw new Error(`Private preview wrapper changed; review before registering again: ${name}`)
    return { name, bytes }
  })
}

/** Emit assets through Vite itself, so clean builds and arbitrary staging outDirs both preserve them. */
export function privatePreviewWrappers(registry?: string): Plugin {
  let root = ''
  return {
    name: 'weevils-private-preview-wrappers',
    apply: 'build',
    configResolved(config) { root = config.root },
    buildStart() {
      for (const { name, bytes } of readPreviewWrappers(root, registry)) this.emitFile({ type: 'asset', fileName: name, source: bytes })
    },
  }
}
