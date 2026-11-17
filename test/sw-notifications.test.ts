import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { expect, it, vi } from 'vitest'
function worker(notifications: unknown[] = [], sessions: unknown[] = []) {
 const listeners: Record<string, (e: unknown) => void> = {}
 const show = vi.fn(async () => {})
 const context=vm.createContext({self:{addEventListener:(name:string,fn:(e:unknown)=>void)=>{listeners[name]=fn},registration:{showNotification:show,getNotifications:async()=>notifications}},fetch:async()=>({ok:true,json:async()=>({sessions})}),AbortSignal:{timeout:()=>undefined}})
 vm.runInContext(readFileSync('public/sw.js','utf8'),context)
 const dispatch=async(name:string, data:unknown)=>{let done:Promise<unknown>=Promise.resolve();listeners[name]({data:name==='push'?{json:()=>data}:data,waitUntil:(p:Promise<unknown>)=>{done=p}});await done}
 return {show,dispatch}
}
it('never turns editorial pushes or unclassified legacy payloads into visible notifications',async()=>{
 const w=worker()
 await w.dispatch('push',{category:'result',tag:'r:one',body:'The result is ready.'})
 await w.dispatch('push',{tag:'old',body:'Got it.'})
 expect(w.show).not.toHaveBeenCalled()
})
it('checks a delayed question against live state and preserves a real current question',async()=>{
 const w=worker([], [{id:'s1',status:'working'},{id:'s2',status:'needs_user'}])
 await w.dispatch('push',{category:'question',sessionId:'s1',tag:'s1',title:'Project needs you',body:'Which colour?'})
 await w.dispatch('push',{category:'question',sessionId:'s2',tag:'s2',title:'Project needs you',body:'Which colour?'})
 expect(w.show).toHaveBeenCalledTimes(1)
 expect(w.show).toHaveBeenCalledWith('Project needs you',expect.objectContaining({renotify:false,tag:'s2'}))
})
it('removes legacy noise and resolved requests while keeping useful results and current warnings',async()=>{
 const cards=[
  {tag:'r:old',body:'An idea',data:{}},
  {tag:'s1',title:'Project needs you',body:'Which colour?',data:{category:'question',sessionId:'s1'}},
  {tag:'s2',body:'Work interrupted',data:{category:'warning',sessionId:'s2'}},
  {tag:'s3',body:'The checkout is fixed.',data:{category:'result',sessionId:'s3'}},
 ].map(n=>({...n,close:vi.fn()}))
 const w=worker(cards)
 await w.dispatch('message',{type:'notification-state',sessions:[{id:'s1',status:'working'},{id:'s2',status:'interrupted'},{id:'s3',status:'done'}]})
 expect(cards.map(n=>n.close.mock.calls.length)).toEqual([1,1,0,0])
})
