import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Outbox, OutboxError, OutboxDeferred, deliveryContext, type OutboxTask } from './outbox.ts'
let dir: string
const task: OutboxTask = { url: '/api/main', body: { text: '1' }, lane: 'main' }
const id = 'test-message-00000001'
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-outbox-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })
it('acks before delivery and retries lost HTTP acceptance without a second injection', async () => {
 let finish!: (v: { id: string }) => void
 const run = vi.fn(() => new Promise<{ id: string }>(r => { finish = r }))
 const box = new Outbox(dir, run)
 expect(box.accept(id, task).status).toBe('accepted')
 expect(run).not.toHaveBeenCalled()
 await tick()
 expect(box.accept(id, task).status).toBe('delivering')
 expect(run).toHaveBeenCalledTimes(1)
 finish({ id: 'existing-thread' }); await tick()
 expect(box.accept(id, task)).toMatchObject({ status: 'delivered', id: 'existing-thread' })
 expect(run).toHaveBeenCalledTimes(1)
 const reloaded = new Outbox(dir, run)
 expect(reloaded.accept(id, task).status).toBe('delivered')
 expect(run).toHaveBeenCalledTimes(1)
})
it('retains dispatch beyond twelve seconds without turning an accepted message into a retry', async () => {
 let finish!: () => void
 const run = vi.fn(() => new Promise<undefined>(r => { finish = () => r(undefined) }))
 const box = new Outbox(dir, run)
 box.accept(id, task); await tick()
 const date = vi.spyOn(Date, 'now').mockReturnValue(Date.now()+30_000)
 expect(box.accept(id, task).status).toBe('delivering')
 expect(run).toHaveBeenCalledTimes(1)
 finish(); await tick(); date.mockRestore()
 expect(box.get(id)?.status).toBe('delivered')
})
it('recovers accepted work but never retries delivery interrupted by restart', async () => {
 const box = new Outbox(dir, async () => undefined)
 // Build an accepted persisted record without running its queued microtask.
 box.accept(id, task)
 const record = fs.readdirSync(dir).find(f => f.endsWith('.json'))!
 const saved = JSON.parse(fs.readFileSync(path.join(dir, record), 'utf8'))
 await tick()
 fs.writeFileSync(path.join(dir, record), JSON.stringify({ ...saved, status: 'delivering' }))
 const run = vi.fn(async () => undefined), reloaded = new Outbox(dir, run)
 reloaded.start(); await tick()
 expect(reloaded.get(id)?.status).toBe('uncertain')
 expect(reloaded.accept(id, task).status).toBe('uncertain')
 expect(run).not.toHaveBeenCalled()
 fs.writeFileSync(path.join(dir, record), JSON.stringify(saved))
 const recovered = new Outbox(dir, run); recovered.start(); await tick(); await tick()
 expect(run).toHaveBeenCalledTimes(1)
 expect(recovered.get(id)?.status).toBe('delivered')
})
it('rejects reuse with different text, separates lanes, and passes stable native delivery identity', async () => {
 const seen: string[] = []
 const box = new Outbox(dir, async () => { seen.push(deliveryContext.getStore()!.messageId); return {} })
 box.accept(id, task)
 expect(() => box.accept(id, { ...task, body: { text: '2' } })).toThrow(OutboxError)
 box.accept('test-message-00000002', { ...task, lane: 'another' })
 await tick(); await tick()
 expect(seen).toEqual([id, 'test-message-00000002'])
})
it('distinguishes a proven refusal from uncertainty and never retries either', async () => {
 const run = vi.fn(async () => { throw new Error('socket closed after sending') })
 const box = new Outbox(dir, run); box.accept(id, task); await tick(); await tick()
 expect(box.accept(id, task).status).toBe('uncertain')
 expect(run).toHaveBeenCalledTimes(1)
 const fail = new Outbox(dir, async () => { throw new OutboxError(409, 'Approval required') })
 fail.accept('test-message-00000002', task); await tick(); await tick()
 expect(fail.get('test-message-00000002')).toMatchObject({ status: 'failed', error: 'Approval required' })
})

it('persists pre-dispatch provider waits with the same ID/payload and preserves lane order across reload', async () => {
 const start = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(start)
 const run = vi.fn(async () => { throw new OutboxDeferred(start + 60_000, 'Waiting for an available provider') })
 const box = new Outbox(dir, run)
 box.accept(id, task); box.accept('test-message-00000002', { ...task, body: { text: 'second' } })
 await tick(); await tick(); await tick()
 expect(run).toHaveBeenCalledOnce()
 expect(box.get(id)).toMatchObject({ messageId: id, status: 'accepted' })
 box.start(); await tick()
 expect(run).toHaveBeenCalledOnce()
 const identities: string[] = [], delivered = vi.fn(async () => { identities.push(deliveryContext.getStore()!.messageId); return { id: 'claude-existing' } })
 const reload = new Outbox(dir, delivered); reload.start(); await tick()
 expect(delivered).not.toHaveBeenCalled()
 clock.mockReturnValue(start + 60001)
 reload.start(); await tick(); await tick(); await tick()
 expect(identities).toEqual([id, 'test-message-00000002'])
 expect(reload.get(id)).toMatchObject({ status: 'delivered', id: 'claude-existing' })
 expect(reload.get(id)?.error).toBeUndefined()
 clock.mockRestore()
})

it('treats language changes as the same intent while preserving the original dispatch language', async () => {
 const run = vi.fn(async (_task: OutboxTask) => ({})), box = new Outbox(dir, run)
 const action = {url:'/api/foryou/item/act?lang=fr',body:{action:'prepare',eventId:'one'},lane:'main'}
 const key = 'action-'+'a'.repeat(64)
 box.accept(key,action)
 expect(box.accept(key,{...action,url:'/api/foryou/item/act?lang=en'}).status).toBe('accepted')
 await tick();await tick()
 expect(run).toHaveBeenCalledTimes(1)
 expect(run.mock.calls[0][0].url).toBe('/api/foryou/item/act?lang=fr')
})
