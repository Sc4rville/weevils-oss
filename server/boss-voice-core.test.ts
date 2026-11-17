// weevboss's thread, as weevilsd guards it (server/core.ts): a test never writes there (CONTRIBUTING.md: a test brief
// starts with [test]), whoever relays it, and each message records where it came from (server/boss-origins.ts).
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'

vi.hoisted(() => { process.env.WEEVILS_ORCHESTRATOR = '1'; process.env.WEEVILS_BOSS_TURNS = '0' })
const mux = vi.hoisted(() => ({
  sendText: vi.fn(async (_name: string, _text: string) => {}),
  sendKey: vi.fn(async (_name: string, _key: string) => {}),
  capture: vi.fn(async (_name: string) => ''),
  spawnWv: vi.fn(async (..._args: unknown[]) => {}),
  killWv: vi.fn(async (_name: string) => {}),
  listWv: vi.fn(async () => [] as unknown[]),
  setOpt: vi.fn(async (..._args: unknown[]) => {}),
}))
vi.mock('./mux.ts', async (orig) => ({ ...(await orig<typeof import('./mux.ts')>()), ...mux }))
vi.mock('./voicepipe.ts', () => ({ keepWarm() {}, warmCues() {} }))
vi.mock('./fast.ts', () => ({ setCartesiaVoice() {} }))
vi.mock('./titles.ts', async (orig) => ({ ...(await orig<typeof import('./titles.ts')>()), llmTitles: async () => [] }))

const { Weevils } = await import('./core.ts')
const { DATA_DIR, HOME, ORCH_DIR } = await import('./config.ts')
const { BOSS_DIR } = await import('./boss-turns.ts')
const { readOrigins, originKey } = await import('./boss-origins.ts')
const { setLang } = await import('./i18n.ts')
const CoreM = (await import('./i18n/core.ts')).default
type Transcript = import('./transcripts.ts').Transcript

const NOW = Date.parse('2026-11-14T06:00:00Z')
const MIN = 60_000
const cwd = path.join(HOME, 'projects', 'demo')
fs.mkdirSync(cwd, { recursive: true })

let w: InstanceType<typeof Weevils>
const transcript = (over: Partial<Transcript> = {}): Transcript => {
  const id = over.id ?? 's1'
  return { id, tool: 'claude', file: `/nowhere/${id}.jsonl`, cwd, openedAt: NOW - 20 * MIN, lastActivityAt: NOW - MIN, workStartedAt: null, phase: 'idle', firstPrompt: 'refais le panier', messages: [{ id: `${id}-m0`, role: 'user', text: 'refais le panier', at: NOW - 20 * MIN }], subagents: [], offset: 0, partial: '', queued: [], ...over } as Transcript
}
const add = (t: Transcript) => (w.store.byFile.set(t.file, t), t)
/** Claude and Codex both busy: weevilsd keeps the message for later (429) after its checks, without any agent. */
const parked = () => ({ executionTool: () => null, retryAt: () => NOW + MIN, bossOn: () => false, takeBossBack: () => undefined, relayOf: () => undefined, relayedBy: () => undefined, covers: () => false, view: () => ({ mode: 'ask', codex: true, switchAt: 97, plans: [] }) })

beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
  for (const f of Object.values(mux)) f.mockReset()
  mux.capture.mockResolvedValue('')
  mux.listWv.mockResolvedValue([])
  fs.rmSync(path.join(DATA_DIR, 'state.json'), { force: true })
  fs.rmSync(path.join(BOSS_DIR, 'origins.jsonl'), { force: true })
  setLang('en', true)
  w = new Weevils()
  w.relay = parked() as never
  w.orchestratorId = 'boss'
  add(transcript({ id: 'boss', cwd: ORCH_DIR }))
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

it('a [test] message never reaches weevboss, nor any agent', async () => {
  await expect(w.sendMain('[test] What time of day is best for a code review?')).rejects.toMatchObject({ status: 409, message: CoreM.en.testNotInBoss })
  await expect(w.sendMain('[from:gepetto] TEST ping the boss')).rejects.toMatchObject({ status: 409 })
  expect(mux.spawnWv).not.toHaveBeenCalled()
  expect(mux.sendText).not.toHaveBeenCalled()
  expect(readOrigins(BOSS_DIR)).toEqual([])
})

it("a test session relaying through weevboss's conversation id is refused too", async () => {
  add(transcript({ id: 'probe', firstPrompt: '[test] check the live voice' }))
  expect(w.isBossTarget('boss')).toBe(true)
  expect(w.isBossTarget('__main')).toBe(true)
  expect(w.isBossTarget('probe')).toBe(false)
  await expect(w.send('boss', 'In two sentences, what can you do?', 'agent', 'probe')).rejects.toMatchObject({ status: 409, message: CoreM.en.testNotInBoss })
  await expect(w.send('boss', '[test] hello')).rejects.toMatchObject({ status: 409 })
  expect(mux.sendText).not.toHaveBeenCalled()
})

it('a test session still writes to its own project sessions', async () => {
  add(transcript({ id: 'probe', firstPrompt: '[test] check the live voice' }))
  const target = add(transcript({ id: 'proj' }))
  const outcome = await w.send(target.id, 'go on', 'agent', 'probe').then(() => 'sent', (e: Error) => e.message)
  expect(outcome).not.toBe(CoreM.en.testNotInBoss)
})

it('each message to weevboss records where it came from (kept even when it waits for a provider)', async () => {
  await expect(w.sendMain('How do you think I should dress tonight?', undefined, 'live')).rejects.toMatchObject({ status: 429 })
  await expect(w.sendMain('what are my projects up to?')).rejects.toMatchObject({ status: 429 })
  expect(readOrigins(BOSS_DIR).map((r) => [r.origin, r.key])).toEqual([
    ['live', originKey('How do you think I should dress tonight?')],
    ['server', originKey('what are my projects up to?')],
  ])
})
