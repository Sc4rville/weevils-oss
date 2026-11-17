import { expect, it } from 'vitest'
import type { Snapshot, WorkstreamIdentity } from '../shared/api.ts'
import type { ForYouItem } from '../shared/foryou.ts'
import { projectFeedWorkstream } from './foryou-workstream.ts'
const identity: WorkstreamIdentity = {kind:'self-improvement',installationId:'installation',target:{machineId:'vps',projectId:'weevils',repo:'weevils'},evidence:'repository-identity'}
const automation: WorkstreamIdentity = {...identity,evidence:'automation-target'}
const snap={sessions:[{id:'app',workstream:identity},{id:'marketing'}],projects:[{id:'weevils',workstream:identity}],optimizers:[{id:'job',workstream:automation},{id:'unknown-job'}]} as Snapshot
const base:ForYouItem={id:'existing',kind:'session',tone:'result',at:123,who:'session',text:'The preview is ready.',projectId:'weevils',sessionId:'app',seen:true,actions:[{id:'a',label:'Open'}],media:[{id:'m',type:'image',url:'/media/m',name:'image',bytes:1}]}
it('keeps the classifier proof and all existing records, actions, media, origin and state intact',()=>{
 const original=structuredClone(base), projected=projectFeedWorkstream(base,snap)
 expect(projected).toEqual({...base,workstream:identity})
 expect(base).toEqual(original)
 expect(projectFeedWorkstream({...base,text:'L’aperçu est prêt.'},snap).workstream).toEqual(identity)
})
it('never inherits identity from a broad project when a specific session is unknown or unrelated',()=>{
 for(const sessionId of ['marketing','missing'])expect(projectFeedWorkstream({...base,sessionId},snap).workstream).toBeUndefined()
 expect(projectFeedWorkstream({...base,sessionId:'marketing',workstream:identity},snap).workstream).toBeUndefined()
})
it('resolves explicit automation IDs without asserting an automated sender or completion',()=>{
 const item={...base,sessionId:undefined,projectId:undefined,kind:'boss' as const,tone:'neutral' as const,who:'weevils',open:{page:'auto' as const,id:'job'}}
 expect(projectFeedWorkstream(item,snap)).toEqual({...item,workstream:automation})
 expect(projectFeedWorkstream({...item,projectId:'weevils',open:{page:'auto',id:'unknown-job'}},snap).workstream).toBeUndefined()
})
it('uses the existing work target and leaves unbound intents unknown even when prose names weevils',()=>{
 const work={intentId:'intent',status:'requested' as const}
 expect(projectFeedWorkstream({...base,sessionId:undefined,work,text:'Improve weevils itself.'},snap).workstream).toBeUndefined()
 expect(projectFeedWorkstream({...base,work},snap).workstream).toBeUndefined()
 expect(projectFeedWorkstream({...base,work:{...work,open:{page:'boss'}}},snap).workstream).toBeUndefined()
 expect(projectFeedWorkstream({...base,sessionId:'marketing',work:{...work,open:{page:'session',id:'app'}}},snap).workstream).toEqual(identity)
})
it('allows explicitly classified project-only cards but never title/name guesses',()=>{
 expect(projectFeedWorkstream({...base,sessionId:undefined},snap).workstream).toEqual(identity)
 expect(projectFeedWorkstream({...base,sessionId:undefined,projectId:undefined,title:'weevils self-improvement'},snap).workstream).toBeUndefined()
})
