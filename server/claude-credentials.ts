// Claude Code's login, wherever it keeps it: ~/.claude/.credentials.json on Linux, the Keychain on a Mac (a generic
// password, service "Claude Code-credentials", holding the same JSON). The file is always tried first. Nothing read
// here is ever logged.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { exec, type Exec, type Platform } from './platform.ts'

export interface ClaudeOauth {
  accessToken?: string
  subscriptionType?: string
  rateLimitTier?: string
  expiresAt?: number
}

const SERVICE = 'Claude Code-credentials'
const SECURITY = '/usr/bin/security'
const home = () => process.env.HOME || os.homedir()
const credentialsFile = () => path.join(home(), '.claude', '.credentials.json')

const parse = (text: string): ClaudeOauth | null => {
  try {
    const o = JSON.parse(text)?.claudeAiOauth
    return o && typeof o === 'object' ? (o as ClaudeOauth) : null
  } catch {
    return null
  }
}
/** `security -w` prints the secret as text, or as hex when it holds bytes it won't print. */
export function parseKeychain(out: string): ClaudeOauth | null {
  const s = out.trim()
  return parse(s) ?? (/^([0-9a-f]{2})+$/i.test(s) ? parse(Buffer.from(s, 'hex').toString('utf8')) : null)
}

const fromFile = (): ClaudeOauth | null => {
  try {
    return parse(fs.readFileSync(credentialsFile(), 'utf8'))
  } catch {
    return null
  }
}

let keychain: { at: number; v: ClaudeOauth } | null = null
/** The Keychain is asked at most every 10 minutes, and again once the token it gave has expired. */
const fresh = (c: { at: number; v: ClaudeOauth }, now: number) => now - c.at < 600_000 && !(c.v.expiresAt && c.v.expiresAt - 60_000 < now)

/** Claude Code's OAuth login (token, plan), or null when there is none to read. */
export async function claudeOauth(platform: Platform = process.platform, run: Exec = exec, now = Date.now()): Promise<ClaudeOauth | null> {
  const file = fromFile()
  if (file?.accessToken) return file
  if (platform !== 'darwin') return file
  if (keychain && fresh(keychain, now)) return keychain.v
  try {
    const v = parseKeychain(await run(SECURITY, ['find-generic-password', '-s', SERVICE, '-w'], 5000))
    keychain = v?.accessToken ? { at: now, v } : null
    return v
  } catch {
    keychain = null
    return null
  }
}
/** After a refused token (401) or a new login: the next read asks the Keychain again. */
export function forgetClaudeOauth(): void {
  keychain = null
  logged = null
}

/** The plan Claude Code noted at login (pro, max…), from the file or from the last Keychain read. Synchronous. */
export function claudePlanName(): string {
  const p = (fromFile() ?? keychain?.v)?.subscriptionType ?? ''
  return /^[a-z0-9_-]{1,20}$/i.test(p) ? p.toLowerCase() : ''
}

export type Probe = (file: string, args: string[]) => boolean
/** Does the Keychain hold the entry? Only its existence is asked: no secret is read, so macOS shows no dialog. */
const probe: Probe = (file, args) => {
  try {
    execFileSync(file, args, { timeout: 2000, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
let logged: { at: number; v: boolean } | null = null
let account: { mtime: number; v: boolean } | null = null
/** The account Claude Code notes in ~/.claude.json: the sign of a login when the Keychain can't be asked (over SSH). */
function accountNoted(): boolean {
  const f = path.join(home(), '.claude.json')
  try {
    const mtime = fs.statSync(f).mtimeMs
    if (account?.mtime !== mtime) account = { mtime, v: /"oauthAccount"\s*:\s*\{/.test(fs.readFileSync(f, 'utf8')) }
    return account.v
  } catch {
    return false
  }
}

/**
 * Claude Code is logged in: a key in the environment, the credentials file, or on a Mac the Keychain entry (asked at
 * most every 15 s: this is called often) or the account noted in ~/.claude.json. Synchronous.
 * tokenOnly: the credentials file counts only when it holds Claude's own token (what the provider check always asked).
 */
export function claudeLoggedIn(platform: Platform = process.platform, has: Probe = probe, now = Date.now(), tokenOnly = false): boolean {
  if (process.env.ANTHROPIC_API_KEY?.trim() || process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return true
  // The setup takes any credentials file for a login; the provider check (tokenOnly) wants Claude's token in it.
  if (tokenOnly) {
    if (fromFile()?.accessToken) return true
  } else {
    try {
      if (fs.statSync(credentialsFile()).size > 2) return true
    } catch {
      /* no file */
    }
  }
  if (platform !== 'darwin') return false
  if (!logged || now - logged.at > 15_000) logged = { at: now, v: has(SECURITY, ['find-generic-password', '-s', SERVICE]) || accountNoted() }
  return logged.v
}
