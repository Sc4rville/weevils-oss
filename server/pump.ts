// Structured Claude sessions (server/claude-pump.mjs): weevilsd's side. Behind WEEVILS_STRUCTURED=1, for NEW Claude
// sessions only; every other session keeps the tmux screen path. If the structured session does not come up, the
// caller falls back to the ordinary tmux launch (see Core.create).
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { DATA_DIR } from './config.ts'

export const structuredOn = () => process.env.WEEVILS_STRUCTURED === '1'
export const PUMP_DIR = path.join(DATA_DIR, 'pumps')
export const PUMP_SCRIPT = path.join(import.meta.dirname, 'claude-pump.mjs')

export interface PumpState {
  pid: number
  sessionId: string
  ready: boolean
  working: boolean
  queued: number
  question: null | { id: string; name: string; question: string; detail?: string; options: { id: string; label: string }[] }
  exited: null | { code: number; at: number }
  at: number
}

/** The pump's last written state, or undefined when it has none (not started, or its file is gone). */
export function pumpState(name: string): PumpState | undefined {
  try { return JSON.parse(fs.readFileSync(path.join(PUMP_DIR, `${name}.json`), 'utf8')) } catch { return undefined }
}

/** One request to the pump over its socket; rejects on any error, never retries (a retry could send twice). */
export function pumpCall(name: string, req: Record<string, unknown>, timeoutMs = 5000): Promise<PumpState> {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(path.join(PUMP_DIR, `${name}.sock`))
    let out = ''
    const timer = setTimeout(() => { c.destroy(); reject(new Error('structured session did not answer')) }, timeoutMs)
    c.on('connect', () => c.write(JSON.stringify(req) + '\n'))
    c.on('data', (d) => { out += d })
    c.on('error', (e) => { clearTimeout(timer); reject(e) })
    c.on('end', () => {
      clearTimeout(timer)
      try {
        const r = JSON.parse(out)
        if (r.ok) resolve(r.state)
        else reject(new Error(r.error || 'refused'))
      } catch { reject(new Error('structured session gave no answer')) }
    })
  })
}

/** The pane command for a structured Claude session; the first message goes through a file (no length or quoting limit). */
export function pumpCommand(name: string, claudeArgs: string[], first?: string): string[] {
  fs.mkdirSync(PUMP_DIR, { recursive: true, mode: 0o700 })
  let firstFile = '-'
  if (first?.trim()) {
    firstFile = path.join(PUMP_DIR, `${name}.first`)
    fs.writeFileSync(firstFile, first, { mode: 0o600 })
  }
  return [process.execPath, PUMP_SCRIPT, PUMP_DIR, name, firstFile, '--', ...claudeArgs, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio']
}

/** Waits until the pump says Claude answered its handshake; false after the deadline or if it exited. */
export async function pumpReady(name: string, deadlineMs = 20_000): Promise<boolean> {
  const end = Date.now() + deadlineMs
  while (Date.now() < end) {
    const s = pumpState(name)
    if (s?.exited) return false
    if (s?.ready) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

/** Leftover files of a pump whose pane is gone. */
export function pumpForget(name: string) {
  for (const ext of ['json', 'sock', 'first']) try { fs.unlinkSync(path.join(PUMP_DIR, `${name}.${ext}`)) } catch { /* already gone */ }
}
