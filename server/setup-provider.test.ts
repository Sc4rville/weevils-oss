import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Setup as SetupType, SetupDeps } from './setup.ts'
import { beforeEach, afterEach, afterAll, expect, it, vi } from 'vitest'
const auth = vi.hoisted(() => ({ codex: false, claude: false, spawn: vi.fn(), claudeStart: vi.fn(async () => 'https://claude.ai/oauth/authorize?code=1') }))
vi.mock('./provider.ts', () => ({
  preferredTool: () => process.env.WEEVILS_PROVIDER === 'codex' ? 'codex' : 'claude',
  providerStatus: (tool: 'claude' | 'codex' = process.env.WEEVILS_PROVIDER === 'codex' ? 'codex' : 'claude') => ({ installed: true, logged: auth[tool] }),
  providerReady: () => auth[process.env.WEEVILS_PROVIDER === 'codex' ? 'codex' : 'claude'],
  codexLogged: () => auth.codex,
}))
vi.mock('./claude-login.ts', () => ({ start: auth.claudeStart, output: () => '', submit: vi.fn(), cancel: vi.fn(), pending: () => null }))
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: auth.spawn }))
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-provider-'))
process.env.WEEVILS_CONFIG = path.join(directory, 'env')
const { Setup } = await import('./setup.ts')
const { CONFIG_FILE } = await import('./config.ts')
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }))
let setup: SetupType
let child: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; exitCode: number | null; kill: ReturnType<typeof vi.fn> }
beforeEach(() => {
  auth.codex = false; auth.claude = false; auth.spawn.mockReset(); auth.claudeStart.mockClear(); delete process.env.WEEVILS_PROVIDER
  child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, kill: vi.fn() })
  auth.spawn.mockReturnValue(child)
  setup = new Setup({ bump() {}, feed: () => ({ machines: [], projects: 0 }), remoteFacts: async () => [], devices: () => 0, push: () => 0, shortcut: () => false, seen: () => [], hasHistory: () => false, startMail() {}, handoff: async () => {} } as SetupDeps)
  vi.spyOn(setup, 'detect').mockResolvedValue({ codex: { installed: true, logged: false }, claude: { installed: true, logged: false } } as never)
})
afterEach(() => { child.emit('exit', null); delete process.env.WEEVILS_PROVIDER; vi.restoreAllMocks() })
it('persists the choice but never marks Codex authenticated until the actual login succeeds', async () => {
  const login = setup.chooseProvider('codex')
  await vi.waitFor(() => expect(auth.spawn).toHaveBeenCalledTimes(1))
  expect(auth.spawn.mock.calls[0][1]).toEqual(['login', '--device-auth'])
  child.stdout.emit('data', Buffer.from('https://auth.openai.com/codex/device\nABCD-EFGH'))
  await login
  expect(process.env.WEEVILS_PROVIDER).toBe('codex')
  expect(fs.readFileSync(CONFIG_FILE, 'utf8')).toContain('WEEVILS_PROVIDER=codex')
  expect(setup.flags()).toMatchObject({ provider: 'codex', codex: false, ready: false })
  auth.codex = true; child.exitCode = 0; child.emit('exit', 0)
  expect(setup.flags()).toMatchObject({ codex: true, ready: true })
})
it('repeated taps share the same device login instead of killing or duplicating it', async () => {
  const one = setup.chooseProvider('codex'), two = setup.chooseProvider('codex')
  await vi.waitFor(() => expect(auth.spawn).toHaveBeenCalledTimes(1))
  child.stdout.emit('data', Buffer.from('https://auth.openai.com/codex/device\nABCD-EFGH'))
  await Promise.all([one, two]); await setup.chooseProvider('codex')
  expect(auth.spawn).toHaveBeenCalledTimes(1); expect(child.kill).not.toHaveBeenCalled()
})
it('« sign in again » from a signed-out session starts a fresh login even with one on file, and never switches the provider', async () => {
  vi.spyOn(setup, 'detect').mockResolvedValue({ codex: { installed: true, logged: true }, claude: { installed: true, logged: true } } as never)
  // An ordinary tap: already signed in, nothing to do.
  await setup.ask('claude')
  expect(auth.spawn).not.toHaveBeenCalled()
  expect(auth.claudeStart).not.toHaveBeenCalled()
  expect(await setup.ask('claude', undefined, true)).toBe(true)
  expect(auth.claudeStart).toHaveBeenCalledTimes(1)
  expect(setup.messages().at(-1)?.text).toContain('https://claude.ai/oauth/authorize?code=1')
  expect(setup.takeOpen()).toBe('https://claude.ai/oauth/authorize?code=1')
  expect(process.env.WEEVILS_PROVIDER).toBeUndefined()
})
it('rejects an unavailable provider before changing the configured selection', async () => {
  vi.spyOn(setup, 'providers').mockReturnValue({ claude: true, codex: false })
  await expect(setup.chooseProvider('codex')).rejects.toThrow(/not available/)
  expect(process.env.WEEVILS_PROVIDER).toBeUndefined()
  expect(auth.spawn).not.toHaveBeenCalled()
})

// « Joignable de partout » (la brique reach) : sur un Mac rien ne demande les droits administrateur, et il n'y a pas de
// domaine à taper ; weevboss part sur Tailscale dès le tap. Linux : comme avant.
const state = (mac: boolean, sudo: 'yes' | 'password' | 'no', reach: 'local' | 'lan' | 'public' = 'local') => ({
  machine: { kind: mac ? 'laptop' : 'vps', mac, os: mac ? 'macOS 15.1' : 'Ubuntu 24.04', cpus: 8, ramGb: 16, uptimeDays: 1, alwaysOn: !mac, host: 'box', user: 'me', sshTarget: 'me@box', agents: 12, others: [], othersAlwaysOn: false },
  reach, url: reach === 'local' ? 'http://127.0.0.1:4179' : 'http://192.168.1.20:4179', https: false, port: 4179, clone: '~/weevils', sudo, pkg: mac ? 'brew' : 'apt',
  claude: { installed: true, logged: true }, codex: { installed: false, logged: false },
})
function reachSetup(s: ReturnType<typeof state>) {
  auth.claude = true
  const handoff = vi.fn(async (_text: string, _brief: string) => {})
  const it = new Setup({ bump() {}, feed: () => ({ machines: [], projects: 0 }), remoteFacts: async () => [], devices: () => 0, push: () => 0, shortcut: () => false, seen: () => [], hasHistory: () => false, startMail() {}, handoff } as SetupDeps)
  vi.spyOn(it, 'detect').mockResolvedValue(s as never)
  const said = () => it.messages().find((m) => m.id === it.lastSaid)?.text ?? ''
  return { it, handoff, said }
}
it('reach on a Mac: no admin rights asked, no VPS, no domain field; weevboss gets the Tailscale job at the tap, once', async () => {
  for (const sudo of ['password', 'no'] as const)
    for (const reach of ['local', 'lan', 'public'] as const) {
      const { it: s, handoff, said } = reachSetup(state(true, sudo, reach))
      expect(await s.ask('reach'), `${sudo} ${reach}`).toBe(false)
      expect(said()).toContain('Tailscale')
      expect(said()).not.toMatch(/admin rights|VPS|\bserver\b|domain|\[\[setup:machine\]\]/i)
      expect(handoff).toHaveBeenCalledTimes(1)
      expect(handoff.mock.calls[0][0]).toBe('Make me reachable from anywhere with Tailscale.')
      expect(handoff.mock.calls[0][1]).toContain('https://tailscale.com/download/mac')
      expect(handoff.mock.calls[0][1]).not.toMatch(/\bsudo\b|tailscale\.com\/install\.sh/)
      // A second tap right after: the same explanation, not a second job.
      await s.ask('reach')
      expect(handoff).toHaveBeenCalledTimes(1)
    }
})
it('reach on a Mac before the agent is signed in: nothing is handed over, the sign-in comes first', async () => {
  const { it: s, handoff, said } = reachSetup(state(true, 'password'))
  auth.claude = false
  expect(await s.ask('reach')).toBe(false)
  expect(handoff).not.toHaveBeenCalled()
  expect(said()).toContain('[[setup:claude]]')
})
it('a domain typed on a Mac (an older app, the API) is answered plainly, with the button of the way that works', async () => {
  const { it: s, handoff, said } = reachSetup(state(true, 'password'))
  await s.apply('reach', { domain: 'https://weevils.example.com/' })
  expect(handoff).not.toHaveBeenCalled()
  expect(said()).toContain('weevils.example.com')
  expect(said()).toContain('Tailscale')
  expect(said()).toContain('[[setup:reach]]')
  expect(said()).not.toMatch(/admin rights|VPS/)
})
it('reach on Linux is unchanged: admin rights needed without passwordless sudo, the domain-or-Tailscale field with it', async () => {
  const locked = reachSetup(state(false, 'password'))
  expect(await locked.it.ask('reach')).toBe(false)
  expect(locked.said()).toContain('I need admin rights on this machine')
  expect(locked.said()).toContain('[[setup:machine]]')
  expect(locked.handoff).not.toHaveBeenCalled()
  const open = reachSetup(state(false, 'yes'))
  expect(await open.it.ask('reach')).toBe(true)
  expect(open.said()).toContain('Two ways: a domain name pointing at the machine')
  expect(open.said()).toContain('Type your domain below, or leave it empty and I’ll go with Tailscale.')
  expect(open.handoff).not.toHaveBeenCalled()
  await open.it.apply('reach', { domain: '' })
  expect(open.handoff).toHaveBeenCalledTimes(1)
  expect(open.handoff.mock.calls[0][1]).toContain('`sudo tailscale up`')
})
