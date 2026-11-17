// Several Claude accounts of the user's own, side by side, and the switch from one to the next at its usage limit.
//
// Claude Code keeps its sign-in in its config folder (CLAUDE_CONFIG_DIR, ~/.claude by default: .credentials.json on
// Linux, and its account in .claude.json). Each added account is one such folder, ~/.config/weevils/claude-accounts/<id>,
// private (0700), holding its own sign-in only: every other entry (projects = the transcripts, settings.json = the
// hooks, skills, plugins…) is a link to ~/.claude. So a session started under account 1 resumes under account 2 with its
// whole transcript (`claude --resume <id>`), and weevils keeps reading every transcript in ~/.claude/projects.
//
// The account is added with the official sign-in (`claude auth login`, server/claude-login.ts) run with that folder:
// no new OAuth, no token handled here. Its quota is read with its own token, never refreshed here (Claude Code does it
// when a session runs under it). Nothing secret is logged, nothing leaves ~/.config/weevils.
//
// The switch: when the relay (server/relay.ts) would open a limit episode, it asks rotate() first. If another account
// still has room, it becomes the active one: new sessions, weevboss' turns and every `claude -p` of weevilsd use it
// (process.env.CLAUDE_CONFIG_DIR), and each session cut by the limit under an older account is reopened under it, in
// the same row, with one calm line in its thread. When none has room, the Codex relay takes over as before.
//
// Off unless WEEVILS_CLAUDE_ACCOUNTS=1. Linux: on a Mac, Claude Code keeps an added account's sign-in in the Keychain,
// which is not read here.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Session } from '../shared/api.ts'
import type { QuotaInfo } from '../shared/infra.ts'
import * as login from './claude-login.ts'
import { tr } from './i18n.ts'
import M from './i18n/claude-accounts.ts'
import InfraM from './i18n/infra.ts'

export const MAIN = 'main'
/** Sign-in entries that stay each account's own; everything else in ~/.claude is shared through a link. */
const OWN = new Set(['.credentials.json', '.claude.json'])
const QUOTA_EVERY_MS = 5 * 60_000
const QUOTA_BACKOFF_MS = 15 * 60_000
/** An account left at its limit with no known reset time is not tried again before this. */
const UNKNOWN_RESET_MS = 3600_000

export const accountsOn = (env: NodeJS.ProcessEnv = process.env) => env.WEEVILS_CLAUDE_ACCOUNTS === '1'

export interface AccountView {
  id: string
  /** 1, 2, 3…: « account 2 ». */
  n: number
  /** The account's e-mail, as Claude Code noted it. */
  label: string
  plan?: string
  /** The fullest of its 5-hour and weekly windows; null: not known yet. */
  percent: number | null
  resetsAt: number | null
  active: boolean
  logged: boolean
}

interface Index {
  accounts: { id: string; at: number }[]
  active: string
  /** When the active account became active. */
  since: number
  /** The account each session weevils started runs under (unknown: the main one). */
  owners: Record<string, string>
  /** An account left at its limit: not tried again before this time. */
  full: Record<string, number>
  /** The interruption of a session already reopened under another account (its time). */
  handled: Record<string, number>
  /** weevboss offered to add an account once. */
  offered?: boolean
  pending?: string
}

interface Creds { accessToken?: string; expiresAt?: number; subscriptionType?: string; rateLimitTier?: string }

export interface AccountsDeps {
  /** ~/.config/weevils/claude-accounts */
  root: string
  /** ~/.claude */
  claudeHome: string
  /** ~/.claude.json */
  claudeJson: string
  /** The main account's quota (server/usage.ts claudeQuota: one shared, rate-limited read). */
  mainQuota: () => Promise<QuotaInfo>
  /** The windows of /api/oauth/usage (server/usage.ts claudeWindows). */
  windows: (d: unknown) => QuotaInfo['windows']
  bin: () => string
  env: () => NodeJS.ProcessEnv
  fetch?: typeof fetch
  now?: () => number
}

/** What the switch asks of weevilsd: reopen a cut session (its pane closed first) with a message. */
export interface AccountsHost {
  sessions(): Session[]
  carryOn(id: string, text: string): Promise<unknown>
}

const readJson = (f: string): any => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch {
    return null
  }
}
const writePrivate = (f: string, data: unknown) => {
  const tmp = `${f}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 })
  fs.renameSync(tmp, f)
}

/** The fullest 5-hour or weekly window still running. */
function hottest(q: QuotaInfo | null | undefined, now: number): { percent: number; resetsAt: number | null } | null {
  let best: { percent: number; resetsAt: number | null } | null = null
  for (const w of q?.ok ? q.windows : []) {
    if (w.kind !== 'session' && w.kind !== 'week') continue
    if (w.resetsAt && w.resetsAt <= now) continue
    if (!best || w.percent > best.percent) best = { percent: w.percent, resetsAt: w.resetsAt }
  }
  return best
}

export class ClaudeAccounts {
  private d: AccountsDeps
  private i: Index
  private quotas = new Map<string, { q: QuotaInfo; nextAt: number }>()
  private reading = new Set<string>()
  /** CLAUDE_CONFIG_DIR as weevilsd found it: what the main account means. */
  private original: string | undefined

  constructor(d: AccountsDeps) {
    this.d = d
    this.original = process.env.CLAUDE_CONFIG_DIR
    const saved = readJson(this.indexFile()) as Partial<Index> | null
    this.i = { accounts: [], active: MAIN, since: 0, owners: {}, full: {}, handled: {}, ...(saved ?? {}) }
    if (this.i.active !== MAIN && !this.i.accounts.some((a) => a.id === this.i.active)) this.i.active = MAIN
    this.apply()
  }

  private now() {
    return this.d.now?.() ?? Date.now()
  }
  private indexFile() {
    return path.join(this.d.root, 'accounts.json')
  }
  private save() {
    try {
      fs.mkdirSync(this.d.root, { recursive: true, mode: 0o700 })
      writePrivate(this.indexFile(), this.i)
    } catch (e) {
      console.error(`[accounts] state not saved: ${(e as Error).message}`)
    }
  }
  on() {
    return accountsOn()
  }

  // ---------------------------------------------------------------- folders

  dirOf(id: string): string | null {
    return id === MAIN ? null : path.join(this.d.root, id)
  }
  private creds(id: string): Creds | null {
    const dir = this.dirOf(id) ?? this.original ?? this.d.claudeHome
    return readJson(path.join(dir, '.credentials.json'))?.claudeAiOauth ?? null
  }
  private profile(id: string): any {
    const f = id === MAIN ? (this.original ? path.join(this.original, '.claude.json') : this.d.claudeJson) : path.join(this.dirOf(id)!, '.claude.json')
    return readJson(f)?.oauthAccount ?? null
  }
  logged(id: string) {
    return !!this.creds(id)?.accessToken
  }

  /** The folder of an account: private, its own sign-in, every other entry a link to ~/.claude. */
  prepare(id: string) {
    const dir = this.dirOf(id)
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.mkdirSync(path.join(this.d.claudeHome, 'projects'), { recursive: true })
    for (const name of fs.readdirSync(this.d.claudeHome)) {
      if (OWN.has(name)) continue
      const link = path.join(dir, name)
      if (fs.lstatSync(link, { throwIfNoEntry: false })) continue
      fs.symlinkSync(path.join(this.d.claudeHome, name), link)
    }
    // Claude Code's settings (onboarding done, trusted folders…) without the main account's identity.
    const own = path.join(dir, '.claude.json')
    if (!fs.existsSync(own)) {
      const main = readJson(this.d.claudeJson) ?? {}
      delete main.oauthAccount
      delete main.userID
      writePrivate(own, main)
    }
  }

  /** The folder is trusted under the active account too: a session never opens on « Do you trust this folder? ». */
  trust(cwd: string) {
    const dir = this.dirOf(this.i.active)
    if (!dir || !this.on()) return
    try {
      this.prepare(this.i.active)
      const f = path.join(dir, '.claude.json')
      const d = readJson(f) ?? {}
      d.projects ??= {}
      if (d.projects[cwd]?.hasTrustDialogAccepted) return
      d.projects[cwd] = { ...(d.projects[cwd] ?? {}), hasTrustDialogAccepted: true }
      writePrivate(f, d)
    } catch (e) {
      console.error(`[accounts] trust: ${(e as Error).message}`)
    }
  }

  // ---------------------------------------------------------------- the active account

  get active() {
    return this.on() ? this.i.active : MAIN
  }
  numberOf(id: string) {
    return id === MAIN ? 1 : this.i.accounts.findIndex((a) => a.id === id) + 2
  }
  /** The environment a Claude session starts with: the active account's folder (null: CLAUDE_CONFIG_DIR unset). */
  spawnEnv(): Record<string, string | null> {
    const dir = this.dirOf(this.active)
    return { CLAUDE_CONFIG_DIR: dir ?? this.original ?? null }
  }
  /** weevilsd's own `claude -p` (weevboss' turns, titles, the probe) follow the active account. */
  private apply() {
    const dir = this.dirOf(this.active)
    if (dir) process.env.CLAUDE_CONFIG_DIR = dir
    else if (this.original === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = this.original
  }
  private setActive(id: string, now: number) {
    const from = this.i.active
    // Its folder's links are made before anything runs under it (weevboss' turns, `claude -p`).
    try { this.prepare(id) } catch (e) { console.error(`[accounts] prepare: ${(e as Error).message}`) }
    this.i.active = id
    this.i.since = now
    this.save()
    this.apply()
    console.log(`[accounts] Claude account ${this.numberOf(from)} → ${this.numberOf(id)}`)
  }

  noteOwner(sessionId: string | undefined) {
    if (!sessionId || !this.on()) return
    this.i.owners[sessionId] = this.i.active
    const keys = Object.keys(this.i.owners)
    if (keys.length > 400) for (const k of keys.slice(0, keys.length - 400)) delete this.i.owners[k]
    this.save()
  }
  ownerOf(sessionId: string) {
    return this.i.owners[sessionId] ?? MAIN
  }
  /** A stop the switch deals with: it happened under an account that is no longer the active one. */
  stale(sessionId: string, at: number): boolean {
    if (!this.on() || this.i.since === 0) return false
    return at < this.i.since || (sessionId !== 'weevboss' && this.ownerOf(sessionId) !== this.i.active)
  }

  // ---------------------------------------------------------------- quotas

  /** The active account's quota: what the relay watches. */
  async quota(): Promise<QuotaInfo> {
    if (this.active === MAIN) return this.d.mainQuota()
    await this.read(this.active, true)
    return this.quotas.get(this.active)?.q ?? { ok: false, windows: [], source: 'account', at: this.now() }
  }

  private async read(id: string, wait = false) {
    const now = this.now()
    const cur = this.quotas.get(id)
    if ((cur && now < cur.nextAt) || this.reading.has(id)) return
    this.reading.add(id)
    const job = this.fetchQuota(id)
      .then((q) => this.quotas.set(id, { q, nextAt: this.now() + (q.ok ? QUOTA_EVERY_MS : QUOTA_BACKOFF_MS) }))
      .catch(() => undefined)
      .finally(() => this.reading.delete(id))
    if (wait) await job
  }

  private async fetchQuota(id: string): Promise<QuotaInfo> {
    const now = this.now()
    if (id === MAIN) return this.d.mainQuota()
    const source = 'api.anthropic.com/api/oauth/usage'
    // Simulation (a throwaway server): the file of WEEVILS_FAKE_CLAUDE_USAGE, suffixed with the account's id.
    const fake = process.env.WEEVILS_FAKE_CLAUDE_USAGE
    if (fake) {
      const d = readJson(`${fake}.${id}`)
      return d ? { ok: true, plan: 'fake', windows: this.d.windows(d), source: 'fake', at: now } : { ok: false, windows: [], source: 'fake', at: now, error: tr(InfraM).unavailable }
    }
    const c = this.creds(id)
    // An expired token is left to Claude Code, which renews it when a session runs under the account.
    if (!c?.accessToken || (c.expiresAt && c.expiresAt < now)) return { ok: false, windows: [], source, at: now, error: tr(InfraM).expired }
    const res = await (this.d.fetch ?? fetch)('https://api.anthropic.com/api/oauth/usage', {
      headers: { authorization: `Bearer ${c.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'user-agent': 'weevils' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return { ok: false, windows: [], source, at: now, error: `HTTP ${res.status}` }
    return { ok: true, plan: c.subscriptionType, windows: this.d.windows(await res.json()), source, at: now }
  }

  /** Every account's quota, read in the background (at most every 5 min each). */
  refresh() {
    if (!this.on()) return
    for (const id of this.ids()) if (this.logged(id)) void this.read(id)
  }

  private ids() {
    return [MAIN, ...this.i.accounts.map((a) => a.id)]
  }
  private percent(id: string, now: number) {
    const q = this.quotas.get(id)?.q
    return q?.ok ? (hottest(q, now)?.percent ?? 0) : null
  }

  // ---------------------------------------------------------------- the switch

  /**
   * The active account is at (or near) its limit: the next account with room becomes the active one. False: none has
   * room (or there is only one), the Codex relay takes over. Synchronous: it decides from the figures already read.
   */
  rotate(now: number, switchAt: number, resetsAt?: number | null): boolean {
    if (!this.on() || !this.i.accounts.length) return false
    const ids = this.ids()
    const from = this.i.active
    const start = ids.indexOf(from)
    for (let k = 1; k < ids.length; k++) {
      const id = ids[(start + k) % ids.length]
      if (!this.logged(id) || (this.i.full[id] ?? 0) > now) continue
      const p = this.percent(id, now)
      if (p !== null && p >= switchAt) continue
      this.i.full[from] = resetsAt && resetsAt > now ? resetsAt : now + UNKNOWN_RESET_MS
      this.setActive(id, now)
      return true
    }
    return false
  }

  /** Sessions cut by the limit under an older account: reopened under the active one, in the same row. */
  carryOn(host: AccountsHost) {
    if (!this.on() || this.i.since === 0) return
    const n = this.numberOf(this.i.active)
    for (const s of host.sessions()) {
      const cut = s.tool === 'claude' && s.status === 'interrupted' && s.interrupted && (s.interrupted.reason === 'quota' || s.interrupted.reason === 'api')
      if (!cut || this.ownerOf(s.id) === this.i.active || this.i.handled[s.id] === s.interrupted!.at) continue
      // An API error only counts when it came with the switch (the limit can surface as an error).
      if (s.interrupted!.reason === 'api' && s.interrupted!.at < this.i.since - 10 * 60_000) continue
      this.i.handled[s.id] = s.interrupted!.at
      this.save()
      console.log(`[accounts] ${s.id.slice(0, 8)} carries on under account ${n}`)
      void host.carryOn(s.id, tr(M).switched(n)).catch((e) => console.error(`[accounts] ${s.id.slice(0, 8)}: ${(e as Error).message}`))
    }
  }

  /** A session with a pane still open under another account: its next message reopens it under the active one. */
  mustReopen(sessionId: string | undefined) {
    return !!sessionId && this.on() && this.i.since > 0 && this.ownerOf(sessionId) !== this.i.active
  }

  /** Once, when the relay first comes up and the user has a single account: the sentence and its chip. */
  offer(): string {
    if (!this.on() || this.i.accounts.length || this.i.offered) return ''
    this.i.offered = true
    this.save()
    return `${tr(M).offer} [[setup:account]]`
  }

  // ---------------------------------------------------------------- adding one

  private loginDeps(id: string): login.LoginDeps {
    return {
      dir: path.join(this.d.root, '.login'),
      bin: this.d.bin(),
      env: { ...this.d.env(), CLAUDE_CONFIG_DIR: this.dirOf(id)! },
      logged: () => this.logged(id),
    }
  }

  /** Starts the official sign-in for a new account: the page's address ('' when the CLI gave none). */
  async startAdd(): Promise<string> {
    const keep = this.i.pending && !this.logged(this.i.pending) ? this.i.pending : undefined
    const id = keep ?? `a${crypto.randomBytes(3).toString('hex')}`
    if (!keep) {
      this.i.pending = id
      this.save()
    }
    this.prepare(id)
    return login.start(this.loginDeps(id), !keep)
  }

  /** The code the sign-in page gave: the new account, or why not. */
  async submitAdd(code: string): Promise<{ ok: true; n: number; who: string } | { ok: false; why: string }> {
    const id = this.i.pending
    if (!id) return { ok: false, why: 'expired' }
    const r = await login.submit(this.loginDeps(id), code)
    if (!r.ok) return r
    const mine = this.profile(id)?.accountUuid
    const known = this.ids().filter((x) => x !== id).some((x) => mine && this.profile(x)?.accountUuid === mine)
    delete this.i.pending
    if (known) {
      fs.rmSync(this.dirOf(id)!, { recursive: true, force: true })
      this.save()
      return { ok: false, why: tr(M).same }
    }
    this.i.accounts.push({ id, at: this.now() })
    this.save()
    void this.read(id)
    console.log(`[accounts] Claude account ${this.numberOf(id)} added`)
    return { ok: true, n: this.numberOf(id), who: String(this.profile(id)?.emailAddress ?? '') }
  }

  remove(id: string) {
    if (id === MAIN || !this.i.accounts.some((a) => a.id === id)) return
    if (this.i.active === id) this.setActive(MAIN, this.now())
    this.i.accounts = this.i.accounts.filter((a) => a.id !== id)
    for (const [k, v] of Object.entries(this.i.owners)) if (v === id) delete this.i.owners[k]
    fs.rmSync(this.dirOf(id)!, { recursive: true, force: true })
    this.quotas.delete(id)
    this.save()
  }

  view(now = this.now()): AccountView[] | undefined {
    if (!this.on()) return undefined
    return this.ids().map((id) => {
      const q = this.quotas.get(id)?.q
      const h = q?.ok ? hottest(q, now) : null
      const c = this.creds(id)
      return {
        id,
        n: this.numberOf(id),
        label: String(this.profile(id)?.emailAddress ?? ''),
        ...(c?.subscriptionType ? { plan: c.subscriptionType } : {}),
        percent: q?.ok ? (h?.percent ?? 0) : null,
        resetsAt: h?.resetsAt ?? null,
        active: id === this.i.active,
        logged: this.logged(id),
      }
    })
  }
}

let shared: ClaudeAccounts | null = null
/** The instance of weevilsd (set up by server/index.ts); null in tests that don't make one. */
export const accounts = () => shared
export function setAccounts(a: ClaudeAccounts | null) {
  shared = a
}
export const defaultRoot = (home = os.homedir()) => path.join(home, '.config', 'weevils', 'claude-accounts')
