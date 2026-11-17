// What differs between Linux and macOS, in one place. Every function takes its platform (and what it runs) as a
// parameter with a default, so the macOS branches are tested on Linux. No import from config.ts: config.ts calls
// servicePath() while it loads.
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type Platform = NodeJS.Platform
export const IS_MAC = process.platform === 'darwin'

/** Where Homebrew puts commands: Apple Silicon, then Intel. */
export const BREW_DIRS = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin']

/** Folders where installers put commands without touching the PATH (same on both systems; Homebrew's on a Mac). */
export function toolDirs(platform: Platform = process.platform, home = os.homedir()): string[] {
  const dirs = [path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), path.join(home, '.npm-global', 'bin'), '/usr/local/bin']
  return platform === 'darwin' ? [...dirs, ...BREW_DIRS.filter((d) => !dirs.includes(d))] : [...dirs, '/opt/homebrew/bin']
}

/**
 * The PATH weevilsd and the agents it starts should have. On a Mac, launchd gives a service /usr/bin:/bin:/usr/sbin:/sbin
 * and nothing else: ~/.local/bin (claude, wv) and Homebrew's folders (tmux, jq, gh, node) are added when missing.
 * Linux: unchanged.
 */
export function servicePath(current = process.env.PATH ?? '', platform: Platform = process.platform, home = os.homedir()): string {
  if (platform !== 'darwin') return current
  const have = current.split(path.delimiter).filter(Boolean)
  const extra = [path.join(home, '.local', 'bin'), ...BREW_DIRS].filter((d) => !have.includes(d))
  return [...have, ...extra].join(path.delimiter)
}

/** An installed command: in the PATH, or where installers put it. */
export function which(cmd: string, platform: Platform = process.platform, home = os.homedir()): string | null {
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), ...toolDirs(platform, home)]
  for (const d of dirs.filter(Boolean)) {
    const f = path.join(d, cmd)
    try {
      fs.accessSync(f, fs.constants.X_OK)
      if (fs.statSync(f).isFile()) return f
    } catch {
      /* not here */
    }
  }
  return null
}

export type Exec = (file: string, args: string[], timeoutMs?: number) => Promise<string>
/** Runs a command, resolves with its stdout, rejects on a failure or a timeout. Never a shell. */
export const exec: Exec = (file, args, timeoutMs = 5000) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 8 << 20 }, (err, out) => (err ? reject(err) : resolve(String(out ?? ''))))
  })

/**
 * Memory a new process can really get, in bytes. Linux: os.freemem() (MemAvailable). macOS: os.freemem() only counts
 * untouched pages and is almost always tiny; vm_stat's free + inactive + speculative + purgeable pages is what the
 * system can hand over.
 */
export async function availableMem(platform: Platform = process.platform, run: Exec = exec, free = () => os.freemem()): Promise<number> {
  if (platform !== 'darwin') return free()
  try {
    return parseVmStat(await run('/usr/bin/vm_stat', [], 3000)) ?? free()
  } catch {
    return free()
  }
}
/** vm_stat's text → available bytes (null when it can't be read). */
export function parseVmStat(out: string): number | null {
  const page = Number(/page size of (\d+) bytes/.exec(out)?.[1] ?? 0)
  if (!page) return null
  const pages = (label: string) => Number(new RegExp(`^${label}:\\s+(\\d+)`, 'm').exec(out)?.[1] ?? 0)
  const n = pages('Pages free') + pages('Pages inactive') + pages('Pages speculative') + pages('Pages purgeable')
  return n > 0 ? n * page : null
}

/** A Mac with a battery is a laptop: `pmset -g batt` lists an InternalBattery (model names stopped saying "Book" in 2022). */
export const macHasBattery = (pmsetBatt: string) => /InternalBattery/.test(pmsetBatt)

/**
 * On a Mac, keeps the machine awake while weevilsd runs and the Mac is on mains power (caffeinate -s, tied to our pid:
 * it leaves with us). Off with WEEVILS_KEEP_AWAKE=0. Returns the pid of caffeinate, or undefined when nothing started.
 */
export function keepAwake(platform: Platform = process.platform, env: NodeJS.ProcessEnv = process.env, start: typeof spawn = spawn, pid = process.pid): number | undefined {
  if (platform !== 'darwin' || env.WEEVILS_KEEP_AWAKE?.trim() === '0') return undefined
  try {
    const child = start('/usr/bin/caffeinate', ['-s', '-w', String(pid)], { stdio: 'ignore', detached: false })
    child.on('error', () => undefined)
    child.unref()
    return child.pid
  } catch {
    return undefined
  }
}
