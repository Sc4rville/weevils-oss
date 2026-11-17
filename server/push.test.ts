import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Push, type PushPayload } from './push.ts'
let dir: string
let send: ReturnType<typeof vi.fn>
const make = () => {
 const p = new Push(path.join(dir,'sent.json'))
 Object.assign(p, {wp:{sendNotification:send},subs:[{endpoint:'https://invalid.test/push',keys:{auth:'test',p256dh:'test'}}]})
 return p
}
const payload: PushPayload = {title:'Shop · Checkout',body:'The checkout is fixed.',tag:'session-one',url:'/#s=session-one',category:'result',sessionId:'session-one'}
beforeEach(()=>{dir=fs.mkdtempSync(path.join(os.tmpdir(),'push-policy-'));send=vi.fn(async()=>{})})
afterEach(()=>fs.rmSync(dir,{recursive:true,force:true}))
it('never pushes editorial cards, automatic handoffs, ACKs or fragments',async()=>{
 const p=make()
 for(const x of [{...payload,tag:'r:one'},{...payload,tag:'relay'},{...payload,body:'Compris.'},{...payload,body:'Corrigé.'},{...payload,category:undefined}])await p.send(x)
 expect(send).not.toHaveBeenCalled()
})
it('groups the same work across restarts and sends a real outcome only once',async()=>{
 await make().send(payload)
 await make().send(payload)
 expect(send).toHaveBeenCalledTimes(1)
 expect(JSON.parse(send.mock.calls[0][1])).toMatchObject({category:'result',sessionId:'session-one'})
 expect(fs.statSync(path.join(dir,'sent.json')).mode&0o777).toBe(0o600)
})
it('keeps actionable cut warnings and explicit relay approval, not warm-up progress',async()=>{
 const p=make()
 await p.send({...payload,category:undefined,tag:'relay-warn',body:'Codex is kept warm.'})
 expect(send).not.toHaveBeenCalled()
 await p.send({...payload,category:undefined,tag:'cut-session-one',body:'Checkout · session interrupted'})
 await p.send({...payload,category:undefined,tag:'relay-plans',body:'Checkout'})
 expect(send).toHaveBeenCalledTimes(2)
 expect(JSON.parse(send.mock.calls[0][1])).toMatchObject({category:'warning',tag:'session-one',sessionId:'session-one'})
 expect(JSON.parse(send.mock.calls[1][1]).category).toBe('question')
})
