import { afterEach, expect, it, vi } from 'vitest'
import { Remote } from './remotes.ts'
import { MACHINE } from './config.ts'
import type { Snapshot } from '../shared/api.ts'
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
it('rejects a reverse tunnel returning this machine, including repeated polls', async () => {
  vi.useFakeTimers()
  const snapshot = { version: 1, machines: [{ id: MACHINE.id }], sessions: [], h24: [] }
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(snapshot)))
  const r = new Remote('pc', 'http://127.0.0.1:4192', vi.fn())
  r.start()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(r.online).toBe(false)
  expect(r.snap).toBeNull()
  expect(r.has('anything')).toBe(false)
})
it('accepts only peer-owned records and removes duplicate identities from a federated peer', async () => {
  vi.useFakeTimers()
  const own = { id: 'pc-session', machineId: 'pc' }
  const echo = { id: 'vps-session', machineId: MACHINE.id }
  const snapshot = { version: 1, machines: [{ id: 'pc' }, { id: MACHINE.id }], sessions: [own, echo, own], h24: [{ id: 'job' }, { id: 'job' }], relay: { plans: [{ sessionId: own.id }, { sessionId: echo.id }] } } as unknown as Snapshot
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(snapshot)))
  const r = new Remote('pc', 'http://peer', vi.fn())
  r.start()
  await vi.advanceTimersByTimeAsync(1)
  expect(r.online).toBe(true)
  expect(r.snap?.sessions).toEqual([own])
  expect(r.snap?.machines).toHaveLength(1)
  expect(r.snap?.h24).toEqual([{ id: 'job' }])
  expect(r.snap?.relay?.plans).toEqual([{ sessionId: own.id }])
})
