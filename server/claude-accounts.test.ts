// Several Claude accounts (server/claude-accounts.ts): private folders sharing ~/.claude, the next account taking over
// at the limit before the Codex relay, cut sessions reopened under it, the offer made once. All simulated: temporary
// folders, quotas from files (WEEVILS_FAKE_CLAUDE_USAGE), a fake weevilsd. No call to Claude.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Session } from '../shared/api.ts'
import type { QuotaInfo } from '../shared/infra.ts'
import { ClaudeAccounts, MAIN } from './claude-accounts.ts'
import { MACHINE } from './config.ts'
import { setLang } from './i18n.ts'
import { Relay, type RelayHost } from './relay.ts'
import { claudeWindows } from './usage.ts'

const NOW = Date.parse('2026-11-17T14:00:00Z')
const H = 3600_000
let tmp: string
const saved = { ...process.env }

const usage = (pct: number, resetsIn = 2 * H) => ({ five_hour: { utilization: pct, resets_at: new Date(NOW + resetsIn).toISOString() }, seven_day: { utilization: 10, resets_at: new Date(NOW + 72 * H).toISOString() } })

function setup(extra = 1) {
  const home = path.join(tmp, 'home')
  const claudeHome = path.join(home, '.claude')
  fs.mkdirSync(path.join(claudeHome, 'projects'), { recursive: true })
  fs.writeFileSync(path.join(claudeHome, 'settings.json'), '{"hooks":{}}')
  fs.writeFileSync(path.join(claudeHome, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'main-token', expiresAt: NOW + H } }))
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, oauthAccount: { accountUuid: 'u-main', emailAddress: 'me@example.com' }, projects: {} }))
  const root = path.join(home, '.config', 'weevils', 'claude-accounts')
  const ids = Array.from({ length: extra }, (_, k) => `a${k + 2}`)
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'accounts.json'), JSON.stringify({ accounts: ids.map((id) => ({ id, at: NOW })), active: MAIN, since: 0, owners: {}, full: {}, handled: {} }))
  const fake = path.join(tmp, 'usage.json')
  process.env.WEEVILS_FAKE_CLAUDE_USAGE = fake
  let main: QuotaInfo = { ok: true, windows: claudeWindows(usage(40)), source: 'test', at: NOW }
  const x = {
    now: NOW,
    setMain: (pct: number) => (main = { ok: true, windows: claudeWindows(usage(pct)), source: 'test', at: x.now }),
    setAccount: (id: string, pct: number, resetsIn?: number) => fs.writeFileSync(`${fake}.${id}`, JSON.stringify(usage(pct, resetsIn))),
  }
  const a = new ClaudeAccounts({
    root, claudeHome, claudeJson: path.join(home, '.claude.json'),
    mainQuota: async () => main, windows: claudeWindows, bin: () => 'claude', env: () => ({}), now: () => x.now,
  })
  for (const id of ids) {
    a.prepare(id)
    fs.writeFileSync(path.join(root, id, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: `${id}-token`, expiresAt: NOW + H, subscriptionType: 'max' } }))
    const j = JSON.parse(fs.readFileSync(path.join(root, id, '.claude.json'), 'utf8'))
    fs.writeFileSync(path.join(root, id, '.claude.json'), JSON.stringify({ ...j, oauthAccount: { accountUuid: `u-${id}`, emailAddress: `${id}@example.com` } }))
    x.setAccount(id, 10)
  }
  return { a, x, root, claudeHome, home }
}

/** Lets the background quota reads land. */
const settle = () => new Promise((r) => setTimeout(r, 20))

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-accounts-'))
  process.env.WEEVILS_CLAUDE_ACCOUNTS = '1'
  delete process.env.CLAUDE_CONFIG_DIR
  setLang('en')
})
afterEach(() => {
  process.env = { ...saved }
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('the folder of an added account', () => {
  it('is private, keeps its own sign-in and links everything else to ~/.claude', () => {
    const { root, claudeHome } = setup()
    const dir = path.join(root, 'a2')
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    expect(fs.readlinkSync(path.join(dir, 'projects'))).toBe(path.join(claudeHome, 'projects'))
    expect(fs.readlinkSync(path.join(dir, 'settings.json'))).toBe(path.join(claudeHome, 'settings.json'))
    // Its own credentials and identity, never the main account's.
    expect(fs.lstatSync(path.join(dir, '.credentials.json')).isSymbolicLink()).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8')).claudeAiOauth.accessToken).toBe('a2-token')
    const own = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8'))
    expect(own.hasCompletedOnboarding).toBe(true)
    expect(own.oauthAccount.accountUuid).toBe('u-a2')
  })
})

describe('the switch', () => {
  it('moves to the next account with room, then leaves a full one aside until its reset', async () => {
    const { a, x } = setup(2)
    a.refresh()
    await settle()
    expect(a.rotate(x.now, 97, NOW + 2 * H)).toBe(true)
    expect(a.active).toBe('a2')
    expect(process.env.CLAUDE_CONFIG_DIR).toMatch(/claude-accounts\/a2$/)
    expect(a.spawnEnv().CLAUDE_CONFIG_DIR).toMatch(/a2$/)
    // a3 is full: the switch skips it and, the main one waiting for its reset, there is nowhere to go.
    x.setAccount('a3', 99, 5 * H)
    x.now += 10 * 60_000
    a.refresh()
    await settle()
    expect(a.rotate(x.now, 97)).toBe(false)
    expect(a.active).toBe('a2')
    // The main account's window has reset: back to it.
    x.now = NOW + 2 * H + 60_000
    x.setMain(0)
    expect(a.rotate(x.now, 97)).toBe(true)
    expect(a.active).toBe(MAIN)
    expect(process.env.CLAUDE_CONFIG_DIR).toBeUndefined()
    expect(a.spawnEnv()).toEqual({ CLAUDE_CONFIG_DIR: null })
  })

  it('reopens under the new account the sessions the limit cut under the old one, once each', async () => {
    const { a, x } = setup()
    a.noteOwner('s1')
    a.noteOwner('s2')
    a.refresh()
    await settle()
    a.rotate(x.now, 97)
    a.noteOwner('s3')
    const cut = (id: string): Session => ({ id, tool: 'claude', status: 'interrupted', interrupted: { at: x.now + 1000, reason: 'quota' } }) as unknown as Session
    const done: { id: string; text: string }[] = []
    const host = { sessions: () => [cut('s1'), { ...cut('s2'), status: 'working' } as Session, cut('s3')], carryOn: async (id: string, text: string) => void done.push({ id, text }) }
    a.carryOn(host)
    a.carryOn(host)
    expect(done).toEqual([{ id: 's1', text: 'Switched to Claude account 2. Carry on exactly where you stopped.' }])
    // The stop of s1 belongs to the old account: the relay leaves it to the switch. s3 runs under the new one.
    expect(a.stale('s1', x.now + 1000)).toBe(true)
    expect(a.stale('s3', x.now + 1000)).toBe(false)
    expect(a.mustReopen('s2')).toBe(true)
    expect(a.mustReopen('s3')).toBe(false)
  })

  it('is off without WEEVILS_CLAUDE_ACCOUNTS=1', async () => {
    const { a, x } = setup()
    delete process.env.WEEVILS_CLAUDE_ACCOUNTS
    expect(a.rotate(x.now, 97)).toBe(false)
    expect(a.view()).toBeUndefined()
    expect(a.offer()).toBe('')
  })
})

describe('with the relay', () => {
  function relay(a: ClaudeAccounts, x: { now: number }, sessions: Session[]) {
    const said: string[] = []
    const carried: string[] = []
    const opened: string[] = []
    const host: RelayHost = {
      sessions: () => sessions,
      transcript: () => undefined,
      send: async () => undefined,
      resume: async () => undefined,
      settle: () => undefined,
      openCodex: async (cwd) => (opened.push(cwd), 'wv-codex'),
      resolve: (id) => id,
      bossStop: () => undefined,
      bossRelayCut: async () => undefined,
      carryOn: async (id) => void carried.push(id),
      notify: () => undefined,
      say: (t) => void said.push(t),
      bump: () => undefined,
    }
    const r = new Relay(host, {
      quota: () => a.quota(), codexReady: () => true, write: async () => 'plan', git: async () => '', probe: async () => true, now: () => x.now, accounts: a,
    }, path.join(tmp, 'relay.json'))
    return { r, said, carried, opened }
  }
  const working = (over: Partial<Session> = {}): Session => ({
    id: 's1', projectId: 'demo', repo: 'demo', machineId: MACHINE.id, tool: 'claude', title: 'cart', status: 'working', cwd: '/w', openedAt: NOW - H,
    lastActivityAt: NOW, workStartedAt: NOW, origin: 'weevils', controllable: true, live: true, hasScreen: true, subagents: [], background: 0, messageCount: 2, queued: 0, ...over,
  })

  it('a second account takes over at the threshold: no Codex episode, the cut session carries on under it', async () => {
    const { a, x } = setup()
    a.noteOwner('s1')
    a.refresh()
    await settle()
    const sessions = [working()]
    const { r, carried, opened } = relay(a, x, sessions)
    x.setMain(98)
    await r.tick(x.now)
    expect(a.active).toBe('a2')
    expect(r.view().limit).toBeUndefined()
    expect(r.view().accounts?.map((l) => [l.n, l.active])).toEqual([[1, false], [2, true]])
    // Account 1 then cuts the session that was still working under it: it carries on under account 2, no plan.
    sessions[0] = working({ status: 'interrupted', workStartedAt: null, interrupted: { at: x.now + 30_000, reason: 'quota', detail: 'Claude usage limit reached. Your limit will reset at 4pm' } })
    x.now += 60_000
    await r.tick(x.now)
    expect(carried).toEqual(['s1'])
    expect(r.view().limit).toBeUndefined()
    expect(r.view().plans).toEqual([])
    expect(opened).toEqual([])
  })

  it('with every account full, the Codex relay comes as before, and the offer to add one is made once', async () => {
    const { a, x } = setup()
    x.setAccount('a2', 99)
    a.refresh()
    await settle()
    const { r } = relay(a, x, [working()])
    x.setMain(98)
    await r.tick(x.now)
    expect(a.active).toBe(MAIN)
    expect(r.view().limit?.kind).toBe('near')
  })

  it('offers to add an account once when only one is known', async () => {
    const { a, x } = setup(0)
    a.refresh()
    await settle()
    const { r, said } = relay(a, x, [working()])
    x.setMain(98)
    await r.tick(x.now)
    await r.tick(x.now + 10_000)
    expect(said.filter((s) => s.includes('[[setup:account]]'))).toHaveLength(1)
    expect(a.offer()).toBe('')
  })
})
