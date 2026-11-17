import { describe, it, expect } from 'vitest'
import { ALCOVE_SOURCE, ALCOVE_PORTRAIT, ALCOVE_FINAL_AT, groupAlcove, alcoveFinal } from './foryou-results.ts'
import type { ForYouItem, ForYouMedia } from '../shared/foryou.ts'
const media = (id:string,name:string):ForYouMedia => ({ id,name,type:'image',url:`/media/${id}`,bytes:1 })
const portrait = media(ALCOVE_PORTRAIT,'alcove_p.png')
const studio = media('studio','studio_p.png')
const final = media('landscape','alcove_l.png')
const anchor:ForYouItem = { id:ALCOVE_SOURCE,kind:'media',tone:'result',at:ALCOVE_FINAL_AT-1000,who:'session',projectId:'tlo',sessionId:'01a1c64d-6a79-78a3-b213-dbf5841b5d18',text:'',title:'The alcove',seen:true,media:[studio,portrait],actions:[{id:'a',label:'Keep'}] }
describe('verified alcove result projection',()=>{
 it('leads with the verified landscape, preserves every original field and separates studio',()=>{
  const sources=structuredClone([anchor]);const before=JSON.stringify(sources)
  const [result]=groupAlcove(sources,final)
  expect(JSON.stringify(sources)).toBe(before)
  expect(result.id).toBe(anchor.id);expect(result.seen).toBe(true);expect(result.actions).toEqual(anchor.actions)
  expect(result.resultGroup?.final).toEqual(final)
  expect(result.resultGroup?.history[0].media).toEqual([portrait])
  expect(result.resultGroup?.otherMedia).toEqual([studio])
 })
 it('folds a later alcove regression without promoting it or hiding another room that mentions alcove',()=>{
  const update={...anchor,id:'later',at:ALCOVE_FINAL_AT+100,text:'The lighting regressed; work in progress.',seen:false,media:[portrait]}
  const crypte={...anchor,id:'crypte',title:'Crypte leads to alcove',media:[media('crypte','crypte_p.png')]}
  const input=[update,crypte,anchor]
  const out=groupAlcove(input,final)
  expect(out.map(i=>i.id)).toEqual(['crypte',ALCOVE_SOURCE])
  const group=out[1].resultGroup!
  expect(group.final).toEqual(final);expect(group.newerUpdate).toBe(true)
  expect(group.history.map(i=>[i.id,i.seen,i.actions])).toEqual([[update.id,false,update.actions],[anchor.id,true,anchor.actions]])
  expect(groupAlcove(JSON.parse(JSON.stringify(input)),final)).toEqual(out)
 })
 it('retains history when the final or earlier media disappears',()=>{
  const [item]=groupAlcove([{...anchor,media:undefined}])
  expect(item.resultGroup?.final).toBeUndefined()
  expect(item.resultGroup?.history[0].id).toBe(anchor.id)
  expect(item.actions).toEqual(anchor.actions)
 })
 it('does not resurrect an absent anchor or infer membership from text',()=>{
  expect(groupAlcove([{...anchor,id:'other',text:'alcove'}],final)[0].resultGroup).toBeUndefined()
  expect(groupAlcove([{...anchor,projectId:'other'}],final)[0].resultGroup).toBeUndefined()
 })
 it('never trusts an unavailable unverified final',()=>expect(alcoveFinal(null,'/missing')).toBeUndefined())
})
