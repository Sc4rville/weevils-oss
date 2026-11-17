import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach,expect,it } from 'vitest'
import { TranscriptStore } from './transcripts.ts'
import { MessageOrigins,originTextHash,type RecordedOrigin } from './message-origins.ts'
const roots:string[]=[]
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true})})
it('repairs only the proven target ID, survives reload, and can undo projection without rewriting raw history',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'wv-origins-'));roots.push(root)
 const now=Date.now(),source='01a1c624-8308-7321-9492-bfc0924fd135',target='01a1d4a3-4424-7502-8312-d2b4dae610d5'
 const messageId='msg_01a1d54e-b163-7662-afca-975b2b331d1f',text='Hook27c8ee2 intégré45e005f. Browser de ton côté.'
 const dir=path.join(root,'codex',new Date(now).toISOString().slice(0,10).replaceAll('-','/'))
 fs.mkdirSync(dir,{recursive:true})
 const file=path.join(dir,`rollout-${target}.jsonl`)
 // Recorded response_item shape from incident 7335. Same prose with another ID is still the real user.
 const input=(id:string)=>({timestamp:new Date(now-1000).toISOString(),type:'response_item',payload:{type:'message',id,role:'user',content:[{type:'input_text',text}]}})
 fs.writeFileSync(file,[{type:'session_meta',payload:{id:target,cwd:'/project'}},input(messageId),input('genuine-user')].map(x=>JSON.stringify(x)+'\n').join(''))
 const raw=fs.readFileSync(file,'utf8'),registry=path.join(root,'message-origins.json'),origins=new MessageOrigins(registry)
 const entry:RecordedOrigin={threadId:target,messageId,sourceThreadId:source,sourceCallId:'call_b09e2112d5c246bfa7ab3aa0b811f1cb',author:'codex',textHash:originTextHash(text),verifiedAt:now,evidence:'recorded-helper-dispatch'}
 const load=()=>{
  const store=new TranscriptStore(path.join(root,'claude'),path.join(root,'codex'),86400000)
  let snapshot=origins.snapshot();store.refreshOrigins=()=>{snapshot=origins.snapshot()}
  store.originOfMessage=(id,message)=>snapshot(id,message)
  store.scan(now);return store
 }
 const store=load()
 expect(store.get(target)?.messages[0].role).toBe('user')
 origins.record({...entry,textHash:originTextHash('Different payload')})
 store.scan(now)
 expect(store.get(target)?.messages[0].role).toBe('user')
 origins.record(entry)
 expect(store.scan(now)).toBe(true)
 expect(store.get(target)?.messages[0]).toMatchObject({id:messageId,role:'orchestrator',author:'codex',sourceThreadId:source,coordination:true,text})
 expect(store.get(target)?.messages[1]).toMatchObject({role:'user',id:'genuine-user',text})
 expect(store.scan(now)).toBe(false)
 expect(load().get(target)?.messages).toEqual(store.get(target)?.messages)
 expect(fs.statSync(registry).mode&0o777).toBe(0o600)
 fs.unlinkSync(registry)
 expect(store.scan(now)).toBe(true)
 expect(store.get(target)?.messages[0]).toMatchObject({role:'user',text})
 expect(store.get(target)?.messages[0]).not.toHaveProperty('sourceThreadId')
 expect(store.scan(now)).toBe(false)
 expect(fs.readFileSync(file,'utf8')).toBe(raw)
})
it('fails closed on malformed history and never overwrites an unreadable registry',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'wv-origin-invalid-'));roots.push(root)
 const file=path.join(root,'registry.json');fs.writeFileSync(file,'not json')
 const registry=new MessageOrigins(file)
 expect(registry.snapshot()('thread',{id:'message',role:'user',text:'hi',at:1})).toBeUndefined()
 expect(()=>registry.record({} as RecordedOrigin)).toThrow()
 expect(fs.readFileSync(file,'utf8')).toBe('not json')
})
