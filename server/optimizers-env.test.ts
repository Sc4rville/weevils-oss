// The environment of an « auto » task's session (server/optimizers.ts guardEnv) reaches claude through createIn, and
// only for that session: tmux is simulated, the command weevils hands it is checked.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mux = vi.hoisted(() => ({
  spawnWv: vi.fn(async (..._args: unknown[]) => {}),
  listWv: vi.fn(async () => [] as unknown[]),
  setOpt: vi.fn(async (..._args: unknown[]) => {}),
}))
vi.mock('./mux.ts', async (orig) => ({ ...(await orig<typeof import('./mux.ts')>()), ...mux }))
vi.mock('./voicepipe.ts', () => ({ keepWarm() {}, warmCues() {} }))
vi.mock('./fast.ts', async (orig) => ({ ...(await orig<typeof import('./fast.ts')>()), smart: vi.fn(), setCartesiaVoice() {} }))
vi.mock('./titles.ts', async (orig) => ({ ...(await orig<typeof import('./titles.ts')>()), llmTitles: async () => [] }))

const { Weevils } = await import('./core.ts')
const { SAFETY_ARGS, guardEnv } = await import('./optimizers.ts')

let tmp: string
beforeEach(() => {
  mux.spawnWv.mockReset()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-env-'))
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('auto — the task session environment', () => {
  it('createIn puts env before claude: the guard variables set, the tokens removed, nothing else changed', async () => {
    const w = new Weevils()
    const g = guardEnv(path.join(tmp, 'guard'), { GH_TOKEN: 'x', OPENAI_API_KEY: 'k' })
    const { id } = await w.createIn(tmp, 'Harden tests', 'the brief', SAFETY_ARGS, { ...g, unset: [...g.unset, 'bad name;rm'] })
    const command = mux.spawnWv.mock.calls[0][4] as string[]
    const claude = command.indexOf('claude')
    expect(command[0]).toBe('env')
    const before = command.slice(0, claude)
    expect(before.join(' ')).toContain('-u GH_TOKEN -u GITHUB_TOKEN')
    expect(before).toContain('-u')
    expect(before).toContain('OPENAI_API_KEY')
    expect(before).not.toContain('bad name;rm')
    expect(before).toContain(`GH_CONFIG_DIR=${path.join(tmp, 'guard', 'gh')}`)
    expect(before).toContain('GIT_SSH_COMMAND=/bin/false')
    expect(before.join(' ')).toContain('=url.weevils-no-push://.pushInsteadOf')
    // Then claude with its deny list, no MCP server, its session id and the brief, as before.
    expect(command.slice(claude)).toEqual(expect.arrayContaining([...SAFETY_ARGS, '--session-id', id, 'the brief']))
    expect(command.at(-1)).toBe('the brief')
  })

  it('the jail comes first, then env, then claude', async () => {
    const w = new Weevils()
    const g = guardEnv(path.join(tmp, 'guard'), {})
    await w.createIn(tmp, 'Jailed', 'the brief', SAFETY_ARGS, { ...g, wrap: ['bwrap', '--dev-bind', '/', '/', '--'] })
    const command = mux.spawnWv.mock.calls[0][4] as string[]
    expect(command.slice(0, 6)).toEqual(['bwrap', '--dev-bind', '/', '/', '--', 'env'])
    expect(command.indexOf('claude')).toBeGreaterThan(5)
  })

  it('a session started without env keeps the plain command (the user’s own sessions are untouched)', async () => {
    const w = new Weevils()
    await w.createIn(tmp, 'Plain', 'hello')
    const command = mux.spawnWv.mock.calls[0][4] as string[]
    expect(command[0]).toBe('claude')
    expect(command).not.toContain('env')
  })
})
