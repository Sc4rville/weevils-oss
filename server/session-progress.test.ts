import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { SessionProgressReader } from './session-progress.ts'
let dir:string, file:string
const now = Date.now()
beforeEach(()=>{dir=fs.mkdtempSync(path.join(os.tmpdir(),'wv-progress-'));file=path.join(dir,'build/production-20261110/live.json');fs.mkdirSync(path.dirname(file),{recursive:true})})
afterEach(()=>fs.rmSync(dir,{recursive:true,force:true}))
const write=(count:number,at:number,stage='review-running')=>fs.writeFileSync(file,JSON.stringify({observedUtc:new Date(at).toISOString(),framesReportedByBlender:count,framesVerifiedAndDownloaded:10,controller:{stage,pod:'private-id'},lastFrameObserved:'/private/path.png'}))
it('distinguishes a live observer from measured rendering progress and then staleness',()=>{
 const r=new SessionProgressReader()
 write(10,now);expect(r.read(dir,now)?.state).toBe('waiting')
 write(10,now+20_000);expect(r.read(dir,now+20_000)?.state).toBe('waiting')
 write(11,now+40_000);expect(r.read(dir,now+40_000)).toMatchObject({state:'working',completed:11,lastProgressAt:now+40_000})
 expect(r.read(dir,now+110_000)).toMatchObject({state:'waiting',updatedAt:now+40_000})
 expect(JSON.stringify(r.read(dir,now+110_000))).not.toMatch(/private|pod/)
})
it('does not invent progress after restart, exposes actual completion, and ignores broken input',()=>{
 write(100,now);expect(new SessionProgressReader().read(dir,now)?.lastProgressAt).toBeUndefined()
 write(100,now,'review-ready-needs-human-review');expect(new SessionProgressReader().read(dir,now)?.state).toBe('done')
 fs.writeFileSync(file,'partial');expect(new SessionProgressReader().read(dir,now)).toBeUndefined()
})
it('keeps the last heartbeat after a read failure and resets progress on counter rollback',()=>{
 const r=new SessionProgressReader()
 write(10,now);r.read(dir,now)
 write(11,now+20_000);expect(r.read(dir,now+20_000)?.state).toBe('working')
 fs.writeFileSync(file,'partial');expect(r.read(dir,now+90_000)?.updatedAt).toBe(now+20_000)
 write(0,now+100_000);expect(r.read(dir,now+100_000)?.lastProgressAt).toBeUndefined()
})

it('exposes a stable pause reason and verified count instead of relying on localized prose',()=>{
 write(306,now,'failed-pod-removed')
 expect(new SessionProgressReader().read(dir,now)).toMatchObject({kind:'render',state:'error',pauseReason:'worker-stopped',completed:306,verified:10})
 write(306,now,'account-limit')
 expect(new SessionProgressReader().read(dir,now)?.pauseReason).toBe('capacity')
 write(306,now,'other-pod-no-retry')
 expect(new SessionProgressReader().read(dir,now)?.pauseReason).toBe('retry-stopped')
})
