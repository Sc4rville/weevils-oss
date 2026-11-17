// The real Claude Code sign-in (« claude auth login --claudeai »), driven for the user: weevils starts it, shows the
// official sign-in page, and hands it the code the page gives. No terminal on screen.
//
// Why it is not a plain child process with a pipe (as it was until 2026-11-14): the login waits for minutes while the
// person signs in on their phone, and weevilsd may restart meanwhile (an instance updates itself, KillMode=process). The
// child then lived on, but its stdin pipe died with the old server: the code went nowhere and the sign-in "failed",
// again and again. Now the CLI runs detached, reads its stdin from a FIFO and writes to a log file, both in a folder of
// its own, with its pid: a restarted server finds it and still hands it the code.
//
// Success is read from the login itself (claudeLogged: the credentials file, or the Keychain on a Mac), not from the
// CLI's exit code: a CLI that saved the login but did not exit in time was taken for a failure.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

export interface LoginDeps {
  /** Folder of the pending login (fifo, log, state.json). */
  dir: string
  /** The claude binary. */
  bin: string
  env: NodeJS.ProcessEnv
  /** Claude Code signed in (credentials file / Keychain). */
  logged: () => boolean
}

interface State { pid: number; at: number; url: string }

/** A sign-in page stays usable this long: after, a new one is started. */
export const LOGIN_TTL = 15 * 60_000

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}
const files = (d: LoginDeps) => ({ fifo: path.join(d.dir, 'in'), log: path.join(d.dir, 'out.log'), state: path.join(d.dir, 'state.json') })

/** The sign-in address in the CLI's output, once it is complete (the line after it has started), escapes removed. */
export function loginUrl(out: string): string {
  const clean = out.replace(ANSI, '')
  const m = /https:\/\/\S*oauth\/authorize\?\S+?(?=\s)/.exec(clean)
  return m?.[0] ?? ''
}

export const lastLine = (out: string) => out.replace(ANSI, '').split('\n').map((l) => l.trim()).filter(Boolean).pop()?.slice(0, 140) ?? ''

function readState(d: LoginDeps): State | null {
  try { return JSON.parse(fs.readFileSync(files(d).state, 'utf8')) as State } catch { return null }
}

/** The pending login, if its CLI still runs and it is not too old. */
export function pending(d: LoginDeps, now = Date.now()): State | null {
  const s = readState(d)
  return s && s.url && alive(s.pid) && now - s.at < LOGIN_TTL ? s : null
}

export function output(d: LoginDeps): string {
  try { return fs.readFileSync(files(d).log, 'utf8') } catch { return '' }
}

export function cancel(d: LoginDeps) {
  const s = readState(d)
  if (s && alive(s.pid)) {
    try { process.kill(-s.pid, 'SIGTERM') } catch { try { process.kill(s.pid, 'SIGTERM') } catch { /* gone */ } }
  }
  fs.rmSync(d.dir, { recursive: true, force: true })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Starts a sign-in (or gives back the pending one): the official page's address, '' when the CLI gave none. */
export async function start(d: LoginDeps, fresh = false, timeout = 25_000): Promise<string> {
  const cur = pending(d)
  if (cur && !fresh) return cur.url
  cancel(d)
  fs.mkdirSync(d.dir, { recursive: true, mode: 0o700 })
  const f = files(d)
  if (spawnSync('mkfifo', ['-m', '600', f.fifo]).status !== 0) return ''
  // stdin opened read-write: opening a FIFO for reading alone would block until a writer comes.
  const proc = spawn('sh', ['-c', 'exec 3<>"$1"; exec "$0" auth login --claudeai <&3 >"$2" 2>&1', d.bin, f.fifo, f.log], {
    env: { ...d.env, BROWSER: 'true' }, detached: true, stdio: 'ignore',
  })
  proc.unref()
  if (!proc.pid) return ''
  const st: State = { pid: proc.pid, at: Date.now(), url: '' }
  fs.writeFileSync(f.state, JSON.stringify(st), { mode: 0o600 })
  for (const end = Date.now() + timeout; Date.now() < end; await sleep(250)) {
    const url = loginUrl(output(d))
    if (url) {
      st.url = url
      fs.writeFileSync(f.state, JSON.stringify(st), { mode: 0o600 })
      return url
    }
    if (!alive(proc.pid)) break
  }
  return ''
}

export type Result = { ok: true } | { ok: false; why: string }

/** Hands the code from the sign-in page to the pending CLI, then waits until Claude Code is signed in. */
export async function submit(d: LoginDeps, code: string, timeout = 60_000): Promise<Result> {
  const s = pending(d)
  if (!s) return { ok: false, why: 'expired' }
  const f = files(d)
  const from = output(d).length
  try {
    // Non-blocking: with no reader left, this fails (ENXIO) instead of hanging the server.
    const fd = fs.openSync(f.fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)
    fs.writeSync(fd, code.replace(/\s+/g, '') + '\n')
    fs.closeSync(fd)
  } catch {
    return { ok: false, why: 'expired' }
  }
  for (const end = Date.now() + timeout; Date.now() < end; await sleep(400)) {
    if (d.logged()) {
      // Saved: the CLI may linger on its own; it is done.
      await sleep(1500)
      cancel(d)
      return { ok: true }
    }
    if (!alive(s.pid)) break
  }
  const why = lastLine(output(d).slice(from)).replace(/^Login failed:\s*/i, '')
  const ok = d.logged()
  cancel(d)
  return ok ? { ok: true } : { ok: false, why }
}
