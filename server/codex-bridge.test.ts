import { expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CodexBridge } from './codex-bridge.ts'
const fixture = (active = false) => {
  const queue: any[] = []
  const calls: string[] = []
  const rpc = vi.fn(async (method: string, p: any = {}) => {
    calls.push(method)
    if (method === 'thread/loaded/list') return { data: ['existing'], nextCursor: null }
    if (method === 'thread/read') return { thread: { status: { type: active ? 'active' : 'idle' } } }
    if (method === 'thread/queue/list') return { data: queue }
    if (method === 'thread/queue/add') { const q = { id: 'queued', ...p }; queue.push(q); return { queuedSubmission: q } }
    if (method === 'thread/queue/start') { queue.shift(); return {} }
    throw new Error('unexpected method')
  })
  const transport = async <T>(_socket: string, run: (rpc: any) => Promise<T>) => run(rpc)
  return { queue, calls, rpc, transport, idle: () => { active = false } }
}

it('persists shared names for unloaded threads across restart and outages without starting or queuing work',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-names-')),file=path.join(dir,'names.json')
 const calls:string[]=[];let name:string|null='Interface and navigation'
 const transport=async<T>(_socket:string,run:(rpc:any)=>Promise<T>)=>run(async(method:string,p:any)=>{
  calls.push(method)
  if(method==='thread/loaded/list')return{data:[]}
  if(method==='thread/read'){expect(p).toEqual({threadId:'stored-thread',includeTurns:false});return{thread:{name,preview:'Old French first prompt'}}}
  throw new Error('Unexpected model or queue operation')
 })
 try{
  const bridge=new CodexBridge('/test/socket',transport,()=>{},file,()=>['stored-thread'])
  await bridge.refresh()
  expect(bridge.nameOf('stored-thread')).toBe('Interface and navigation')
  expect(bridge.can('stored-thread')).toBe(false)
  const offline=new CodexBridge('/test/socket',async()=>{throw new Error('offline')},()=>{},file)
  expect(offline.nameOf('stored-thread')).toBe('Interface and navigation')
  await offline.refresh();expect(offline.nameOf('stored-thread')).toBe('Interface and navigation')
  const again=new CodexBridge('/test/socket',transport,()=>{},file,()=>['stored-thread'])
  await again.refresh();expect(again.nameOf('stored-thread')).toBe('Interface and navigation')
  name=null
  const cleared=new CodexBridge('/test/socket',transport,()=>{},file,()=>['stored-thread'])
  await cleared.refresh();expect(cleared.nameOf('stored-thread')).toBeUndefined()
  expect(new CodexBridge('',transport,()=>{},file).nameOf('stored-thread')).toBeUndefined()
  expect(calls.every(x=>['thread/loaded/list','thread/read'].includes(x))).toBe(true)
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
})
it('queues while active and starts the same durable entry only after idle', async () => {
  const f = fixture(true), bridge = new CodexBridge('/test/socket', f.transport)
  await bridge.refresh()
  expect(bridge.can('existing')).toBe(true)
  await bridge.send('existing', 'a user answer')
  expect(f.queue).toHaveLength(1)
  expect(bridge.queuedOf('existing')).toBe(1)
  expect(f.calls).not.toContain('thread/queue/start')
  const input = f.rpc.mock.calls.find(c => c[0] === 'thread/queue/add')![1].input
  expect(input[0].text).toBe('a user answer')
  f.idle()
  // A fresh weevils instance recovers the queue from the existing daemon.
  const recovered=new CodexBridge('/test/socket', f.transport)
  await recovered.refresh()
  expect(recovered.queuedOf('existing')).toBe(0)
  expect(f.queue).toHaveLength(0)
  expect(f.calls.filter(c => c === 'thread/queue/add')).toHaveLength(1)
  expect(f.calls.some(c => /resume|interrupt|steer|thread\/start/.test(c))).toBe(false)
})
it('never loads missing threads, and a disabled bridge never connects', async () => {
  const f = fixture(), bridge = new CodexBridge('/test/socket', f.transport)
  await expect(bridge.send('missing', 'hello')).rejects.toThrow()
  expect(f.calls).toEqual(['thread/loaded/list'])
  f.calls.length = 0
  await new CodexBridge('', f.transport).refresh()
  expect(f.calls).toEqual([])
})
it('keeps an acknowledged message queued if starting fails without resending', async () => {
  const f = fixture()
  const transport = async <T>(_s: string, run: (rpc: any) => Promise<T>) => run((m: string, p: any) => m === 'thread/queue/start' ? Promise.reject(new Error('offline')) : f.rpc(m, p))
  await new CodexBridge('/test/socket', transport).send('existing', 'hello')
  expect(f.queue).toHaveLength(1)
  expect(f.calls.filter(c => c === 'thread/queue/add')).toHaveLength(1)
})
it('uses the real Unix WebSocket transport and acknowledges a queued user message', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path')
  const { createServer } = await import('node:http')
  const { WebSocketServer } = await import('ws')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-bridge-'))
  const socket = path.join(dir, 'rpc.sock'), http = createServer(), server = new WebSocketServer({ server: http })
  const f = fixture()
  server.on('connection', ws => ws.on('message', async data => {
    const m = JSON.parse(data.toString())
    if (!m.id) return
    const result = m.method === 'initialize' ? {} : await f.rpc(m.method, m.params)
    ws.send(JSON.stringify({ id: m.id, result }))
  }))
  await new Promise<void>(resolve => http.listen(socket, resolve))
  try {
    const bridge = new CodexBridge(socket)
    await bridge.refresh()
    expect(bridge.can('existing')).toBe(true)
    await bridge.send('existing', 'Exact user wording')
    expect(f.calls.filter(m => m === 'thread/queue/add')).toHaveLength(1)
    expect(f.calls.filter(m => m === 'thread/queue/start')).toHaveLength(1)
  } finally {
    for (const client of server.clients) client.terminate()
    await new Promise<void>(resolve => server.close(() => http.close(() => resolve())))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

it('keeps other loaded threads writable when one queued delivery cannot start yet', async () => {
 const f = fixture()
 const transport = async <T>(_s: string, run: (rpc: any) => Promise<T>) => run((m: string, p: any) => m === 'thread/read' ? Promise.reject(new Error('thread changed')) : f.rpc(m, p))
 const bridge = new CodexBridge('/test/socket', transport)
 await bridge.refresh()
 expect(bridge.can('existing')).toBe(true)
})

it('changes only future settings on an existing active thread and verifies readback', async()=>{
 const calls:string[]=[]
 let selected={model:'real-model',reasoningEffort:'low'}
 const rpc=async(method:string,p:any)=>{
  calls.push(method)
  if(method==='thread/loaded/list')return{data:['existing']}
  if(method==='model/list')return{data:[{model:'real-model',displayName:'Real model',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]}]}
  if(method==='thread/settings/update'){expect(p).toEqual({threadId:'existing',model:'real-model',effort:'high'});selected={model:p.model,reasoningEffort:p.effort};return{}}
  if(method==='thread/read')return{thread:{...selected,status:{type:'active'}}}
  throw new Error('Unexpected operation')
 }
 const bridge=new CodexBridge('/test/socket',async(_s,run)=>run(rpc))
 const result=await bridge.modelControls('existing',{model:'real-model',effort:'high'})
 expect(result.selected).toEqual({model:'real-model',effort:'high'})
 expect(result.active).toBe(true)
 expect(result.appliesTo).toBe('next-turn')
 expect(calls).toEqual(['thread/loaded/list','model/list','thread/settings/update','thread/read'])
 await expect(bridge.modelControls('existing',{model:'invented',effort:'high'})).rejects.toThrow()
 expect(calls.filter(m=>m==='thread/settings/update')).toHaveLength(1)
})
it('does not claim success when daemon readback disagrees',async()=>{
 const rpc=async(method:string)=>method==='thread/loaded/list'?{data:['existing']}:method==='model/list'?{data:[{model:'real',displayName:'Real',supportedReasoningEfforts:[{reasoningEffort:'high'}]}]}:method==='thread/read'?{thread:{model:'real',reasoningEffort:'low'}}:{}
 const bridge=new CodexBridge('/test/socket',async(_s,run)=>run(rpc))
 await expect(bridge.modelControls('existing',{model:'real',effort:'high'})).rejects.toThrow()
})

it('reads an explicit shared thread name independently of model state and never guesses it from prompt text',async()=>{
 let name:string|null='Think'
 const rpc=async(method:string)=>{
  if(method==='thread/loaded/list')return{data:['existing']}
  if(method==='thread/read')return{thread:{name,status:{type:'active'}}}
  if(method==='thread/queue/list')return{data:[]}
  throw new Error(method)
 }
 const bridge=new CodexBridge('/test/socket',async(_socket,run)=>run(rpc))
 await bridge.refresh()
 expect(bridge.nameOf('existing')).toBe('Think')
 expect(bridge.nameOf('unknown')).toBeUndefined()
 name='Think renamed';await bridge.refresh();expect(bridge.nameOf('existing')).toBe('Think renamed')
 name=null;await bridge.refresh();expect(bridge.nameOf('existing')).toBeUndefined()
})

it('checks an existing daemon owner on demand without sending, starting or draining anything',async()=>{
 const f=fixture(true),bridge=new CodexBridge('/test/socket',f.transport)
 expect(bridge.can('existing')).toBe(false)
 expect(await bridge.reachable('existing')).toBe(true)
 expect(bridge.can('existing')).toBe(true)
 expect(await bridge.reachable('missing')).toBe(false)
 expect(f.calls).toEqual(['thread/loaded/list','thread/loaded/list'])
})
