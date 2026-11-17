import { expect, it } from 'vitest'
import type { Snapshot } from '../shared/api.ts'
import type { ForYouItem } from '../shared/foryou.ts'
import type { Software } from '../shared/softwares.ts'
import { softwareResult } from './foryou-software.ts'
const item={id:'s:real',kind:'session',tone:'result',who:'session',at:1,text:'It’s back online',sessionId:'s',projectId:'project'} as ForYouItem
const snap={sessions:[{id:'s',repo:'actual-repo',machineId:'vps'}],projects:[{id:'project',name:'Unrelated display name',repos:['actual-repo']}]} as Snapshot
const sw={id:'vps:software',name:'Actual software',repo:'actual-repo',repos:['actual-repo'],machine:'vps',kind:'web',run:'running',url:'https://deployed.example/current/'} as Software
it('links both a result and a URL-only recap through actual deployment metadata',()=>{
 const catalog={at:1000,items:[sw]}
 expect(softwareResult(item,snap,catalog,1100)).toEqual({id:sw.id,name:sw.name,state:'running',url:sw.url})
 expect(softwareResult({...item,kind:'boss',tone:'neutral',sessionId:undefined,projectId:undefined,text:'It is live at https://deployed.example/current/.'},snap,catalog,1100)?.id).toBe(sw.id)
 expect(softwareResult({...item,text:'Le résultat est en ligne.'},snap,catalog,1100)?.url).toBe(sw.url)
})
it('follows current deployment version without changing the card identity or actions',()=>{
 const source={...item,actions:[{id:'a1',label:'Review'}],seen:true},copy=structuredClone(source)
 expect(softwareResult(source,snap,{at:1000,items:[{...sw,url:'https://deployed.example/version-two/'}]},1100)?.url).toBe('https://deployed.example/version-two/')
 expect(source).toEqual(copy)
})
it('does not advertise stopped, missing, stale or private network previews as live',()=>{
 for(const stopped of [{...sw,run:'idle'},{...sw,run:'failed'},{...sw,url:undefined},{...sw,url:'http://localhost:4173'}] as Software[]){
  expect(softwareResult(item,snap,{at:1000,items:[stopped]},1100)).toEqual({id:sw.id,name:sw.name,state:'unavailable'})
 }
 expect(softwareResult(item,snap,{at:1,items:[sw]},100000)?.state).toBe('unavailable')
 expect(softwareResult(item,snap,{at:1000,items:[]},1100)).toBeUndefined()
})
it('keeps authenticated static previews inside the software viewer without exposing capability tokens',()=>{
 const result=softwareResult(item,snap,{at:1000,items:[{...sw,url:'/api/site/private-capability/actual-repo/'}]},1100)
 expect(result).toEqual({id:sw.id,name:sw.name,state:'running'})
 expect(JSON.stringify(result)).not.toContain('private-capability')
})
it('does not guess by project name, an unknown URL, wrong machine or ambiguous deployments',()=>{
 const unknown={...item,projectId:undefined,sessionId:undefined,text:'Open https://unknown.example/.'}
 expect(softwareResult(unknown,snap,{at:1000,items:[sw]},1100)).toBeUndefined()
 expect(softwareResult(item,snap,{at:1000,items:[{...sw,machine:'another-machine'}]},1100)).toBeUndefined()
 expect(softwareResult(item,snap,{at:1000,items:[sw,{...sw,id:'vps:another',url:'https://other.example/'}]},1100)).toBeUndefined()
})
it('does not add software buttons to unrelated images, questions or pending approvals',()=>{
 const catalog={at:1000,items:[sw]}
 expect(softwareResult({...item,kind:'media'},snap,catalog,1100)).toBeUndefined()
 expect(softwareResult({...item,tone:'question'},snap,catalog,1100)).toBeUndefined()
 expect(softwareResult({...item,work:{intentId:'request',status:'requested'}},snap,catalog,1100)).toBeUndefined()
})

it('retains the unavailable association for a URL-only historical recap after its preview stops',()=>{
 const recap={...item,kind:'boss' as const,tone:'neutral' as const,sessionId:undefined,projectId:undefined,text:'Live at https://deployed.example/current/.'}
 expect(softwareResult(recap,snap,{at:1000,items:[{...sw,run:'idle',url:undefined,deploymentUrls:[sw.url!]}]},1100)).toEqual({id:sw.id,name:sw.name,state:'unavailable'})
})
