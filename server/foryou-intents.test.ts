import { OutboxError } from './outbox.ts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkIntents } from './foryou-intents.ts'
let dir: string, file: string
const brief = 'Build a Think canvas with text notes, images and undoable arrangements.'
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intents-')); file = path.join(dir, 'intents.json') })
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))
it('double acceptance across cards reserves before dispatch and survives reload', async () => {
  const registry = new WorkIntents(file)
  let finish!: (result: {id:string}) => void
  const send = vi.fn(() => new Promise<{id:string}>(r => finish = r))
  const a = registry.dispatch(brief, 'weevils', 'card:a', send)
  const b = registry.dispatch(brief, 'weevils', 'card:b', send)
  await Promise.resolve()
  expect(send).toHaveBeenCalledTimes(1)
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))[0].status).toBe('dispatching')
  finish({id:'think'})
  expect(await a).toMatchObject({existing:false,open:{page:'session',id:'think'}})
  expect(await b).toMatchObject({existing:true,open:{page:'session',id:'think'}})
  expect(await new WorkIntents(file).dispatch(brief, 'weevils', 'card:c', send)).toMatchObject({existing:true,open:{id:'think'}})
  expect(send).toHaveBeenCalledTimes(1)
})
it.each(['direct-first','card-first'])('%s concurrent direct request and proposal uses the same intent', async order => {
  const registry = new WorkIntents(file), send = vi.fn(async () => ({id:'same-session'}))
  const calls = order === 'direct-first' ? [ ['weevils','direct'], [undefined,'card'] ] : [ [undefined,'card'], ['weevils','direct'] ]
  await Promise.all(calls.map(([scope,id]) => registry.dispatch(brief,scope,id!,send)))
  expect(send).toHaveBeenCalledTimes(1)
})
it.each(['requested','queued','running','completed'] as const)('routes %s explicit provenance even when copy and locale differ', async status => {
  const registry = new WorkIntents(file), send = vi.fn(async () => ({id:'wrong'}))
  registry.observe({id:'request:source',brief,status,scope:'weevils',open:{page:'session',id:'think'}})
  expect(await registry.dispatch('Préparer les notes spatiales de Think.', 'weevils', 'another-card', send, 'request:source')).toMatchObject({existing:true,open:{id:'think'}})
  expect(send).not.toHaveBeenCalled()
})
it('does not merge another task or another project merely because they share words', async () => {
  const registry = new WorkIntents(file), send = vi.fn(async () => ({id:'new'}))
  registry.observe({id:'request:source',brief,status:'running',scope:'weevils',open:{page:'session',id:'think'}})
  await registry.dispatch('Export Think notes as a portable archive with their images.', 'weevils', 'card:b', send)
  await registry.dispatch(brief, 'other-project', 'card:c', send)
  expect(send).toHaveBeenCalledTimes(2)
})
it('uncertain delivery is not retried, including a restart while dispatching', async () => {
  const registry = new WorkIntents(file), send = vi.fn(async () => {throw new Error('transport lost')})
  await expect(registry.dispatch(brief, undefined, 'a', send)).rejects.toThrow('transport lost')
  await new WorkIntents(file).dispatch(brief, undefined, 'b', send)
  expect(send).toHaveBeenCalledTimes(1)
  const entries = JSON.parse(fs.readFileSync(file, 'utf8')); entries[0].status = 'dispatching'
  fs.writeFileSync(file, JSON.stringify(entries))
  const recovered = new WorkIntents(file)
  expect(recovered.list()[0].status).toBe('uncertain')
  await recovered.dispatch(brief, undefined, 'c', send)
  expect(send).toHaveBeenCalledTimes(1)
})
it('allows retry after an explicit refusal before dispatch, but not a lost acknowledgement', async () => {
  const registry=new WorkIntents(file)
  const send=vi.fn().mockRejectedValueOnce(new OutboxError(409,'not controllable')).mockResolvedValue({id:'target'})
  await expect(registry.dispatch(brief,undefined,'a',send)).rejects.toThrow('not controllable')
  expect(await registry.dispatch(brief,undefined,'b',send)).toMatchObject({existing:false,open:{id:'target'}})
  expect(send).toHaveBeenCalledTimes(2)
})
it('refuses an ambiguous match instead of choosing a project or dispatching duplicate work', async () => {
  const registry=new WorkIntents(file),send=vi.fn(async()=>({id:'wrong'}))
  registry.observe({id:'one',brief,scope:'one',status:'running',open:{page:'session',id:'one'}})
  registry.observe({id:'two',brief,scope:'two',status:'running',open:{page:'session',id:'two'}})
  await expect(registry.dispatch(brief,undefined,'card',send)).rejects.toThrow()
  expect(send).not.toHaveBeenCalled()
  expect(await registry.dispatch(brief,'two','card',send)).toMatchObject({existing:true,open:{id:'two'}})
})
