import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ReturnRelay, type ReturnHost } from './return-relay.ts'
import type { Session } from '../shared/api.ts'
import type { Transcript } from './transcripts.ts'
import { setLang } from './i18n.ts'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })
function world() {
  setLang('en', true)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'return-relay-')); dirs.push(dir)
  const s = { id: 'codex-source', tool: 'codex', title: 'Render project', cwd: '/fixture/project', status: 'interrupted', controllable: true, interrupted: { at: 1000, reason: 'quota' }, lastActivityAt: 1000 } as Session
  const transcript = { id: s.id, file: '/fixture/source.jsonl', firstPrompt: 'Monitor the existing GPU job and stop the paid pod when it finishes.', messages: [{ role: 'user', text: 'Do not restart the render.' }, { role: 'assistant', text: 'Existing job run-123, pod pod-456 is running.' }] } as Transcript
  const transcripts = new Map([[s.id, transcript]])
  const host: ReturnHost = { sessions: () => [s], transcript: id => transcripts.get(id), openClaude: vi.fn(async (_cwd, _title, _text, id) => id), bump: vi.fn() }
  const file = path.join(dir, 'handoffs.json')
  return { s, host, file, transcripts, relay: new ReturnRelay(file, host) }
}
it('keeps durable context while both providers are unavailable, then launches exactly once with a stable target', async () => {
  const x = world(); x.relay.request(x.s, 2000)
  await x.relay.tick(false)
  expect(x.host.openClaude).not.toHaveBeenCalled()
  const reload = new ReturnRelay(x.file, x.host)
  await reload.tick(true); await reload.tick(true)
  expect(x.host.openClaude).toHaveBeenCalledOnce()
  const args = vi.mocked(x.host.openClaude).mock.calls[0]
  expect(args[2]).toContain('[from:weevboss]')
  expect(args[2]).toContain('pod-456')
  expect(args[2]).toContain('never restart, interrupt or duplicate')
  expect(args[2]).toContain('/fixture/source.jsonl')
  expect(reload.target(x.s.id)).toBe(args[3])
  const again = new ReturnRelay(x.file, x.host); again.request(x.s); await again.tick(true)
  expect(x.host.openClaude).toHaveBeenCalledOnce()
})
it('never starts a second job after an ambiguous launch; a proven target reconciles the saved receipt', async () => {
  const x = world(); vi.mocked(x.host.openClaude).mockRejectedValue(new Error('ACK lost'))
  x.relay.request(x.s); await x.relay.tick(true)
  const pending = JSON.parse(fs.readFileSync(x.file, 'utf8'))[0]
  expect(pending.phase).toBe('uncertain')
  const reload = new ReturnRelay(x.file, x.host); await reload.tick(true)
  expect(x.host.openClaude).toHaveBeenCalledOnce()
  x.transcripts.set(pending.targetId, { id: pending.targetId } as Transcript)
  await reload.tick(true)
  expect(reload.target(x.s.id)).toBe(pending.targetId)
})
it('does not interrupt an active tour, a real question, an unmanaged source, or a source that resumed after preparation', async () => {
  const x = world()
  for (const patch of [{ status: 'working' }, { status: 'needs_user' }, { turnWorking: true }, { controllable: false }]) x.relay.request({ ...x.s, ...patch } as Session)
  expect(x.relay.view()).toEqual([])
  x.relay.request(x.s); x.s.status = 'working'; await x.relay.tick(true)
  expect(x.host.openClaude).not.toHaveBeenCalled()
})
it('uses the automation owner and its existing sandbox/workspace, not an unguarded general session', async () => {
  const x = world(); x.host.autoOwns = () => true; x.host.autoReturn = vi.fn(async (_id, _text, target) => target)
  x.relay.request(x.s); await x.relay.tick(true)
  expect(x.host.autoReturn).toHaveBeenCalledOnce()
  expect(x.host.openClaude).not.toHaveBeenCalled()
})
it('does not revive a task completed independently while its handoff waited', async () => {
  const x = world(); x.relay.request(x.s)
  x.s.status = 'idle'; x.s.lastActivityAt = 3000; delete x.s.interrupted
  await x.relay.tick(true)
  expect(x.host.openClaude).not.toHaveBeenCalled()
  expect(x.relay.holds(x.s.id)).toBe(false)
})

it('resumes an unanswered main turn through its ordinary owner, only after both writers are idle', async () => {
  const x = world(); x.host.isMain = () => true
  let busy = true; x.host.mainBusy = () => busy
  x.host.returnMain = vi.fn(async () => 'existing-main-claude')
  x.relay.request(x.s); await x.relay.tick(true)
  expect(x.host.returnMain).not.toHaveBeenCalled()
  busy = false
  const reload = new ReturnRelay(x.file, x.host); await reload.tick(true); await reload.tick(true)
  expect(x.host.returnMain).toHaveBeenCalledOnce()
  expect(x.host.openClaude).not.toHaveBeenCalled()
  expect(reload.target(x.s.id)).toBe('existing-main-claude')
  expect(vi.mocked(x.host.returnMain).mock.calls[0][0]).toContain('pod-456')
})

it('does not retry an ambiguous main dispatch just because the previous main transcript exists', async () => {
  const x = world(); x.host.isMain = () => true
  x.host.returnMain = vi.fn(async () => { throw new Error('ACK lost') })
  x.relay.request(x.s); await x.relay.tick(true)
  const pending = JSON.parse(fs.readFileSync(x.file, 'utf8'))[0]
  x.transcripts.set(pending.targetId, { id: pending.targetId } as Transcript)
  const reload = new ReturnRelay(x.file, x.host); await reload.tick(true)
  expect(x.host.returnMain).toHaveBeenCalledOnce()
  expect(reload.view()[0].phase).toBe('uncertain')
})
