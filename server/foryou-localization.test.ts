import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FeedLocalization, sameNumericFacts } from './foryou-localization.ts'
import type { ForYouItem } from '../shared/foryou.ts'
let dir:string, file:string, now:number
beforeEach(()=>{dir=fs.mkdtempSync(path.join(os.tmpdir(),'feed-loc-'));file=path.join(dir,'translations.json');now=1000})
afterEach(()=>fs.rmSync(dir,{recursive:true,force:true}))
const item=():ForYouItem=>({id:'i:one',at:42,kind:'insight',tone:'neutral',who:'weevils',text:'Le café est prêt pour TLO.',seen:true,media:[{id:'pic',name:'café.png',url:'/api/media/pic',type:'image',bytes:42}],actions:[{id:'a1',label:'Ouvrir le café'}]})
const run=async(s:Record<string,string>)=>Object.fromEntries(Object.entries(s).map(([k,v])=>[k,v==='Le café est prêt pour TLO.'?'The café is ready for TLO.':v==='Ouvrir le café'?'Open the café':v]))
it('retains originals, identities, read state, media and actions through FR EN FR, reload and cache reuse',async()=>{
 const c=new FeedLocalization(file,()=>now),source=item()
 expect(c.project(source,'fr','fr')).toEqual(source)
 const pending=c.project(source,'en','fr',['TLO']);expect(pending.localization?.status).toBe('pending');expect(pending.text).toBe(source.text)
 await c.translate(run)
 const en=c.project(source,'en','fr',['TLO']);expect(en.text).toBe('The café is ready for TLO.');expect(en.actions).toEqual([{id:'a1',label:'Open the café'}]);expect(en.media).toEqual(source.media);expect(en.seen).toBe(true);expect(en.at).toBe(42);expect(en.id).toBe(source.id)
 expect(c.project(source,'fr','fr')).toEqual(source)
 expect(new FeedLocalization(file).project(source,'en','fr',['TLO'])).toEqual(en)
 expect(c.job()).toBeNull();expect(source).toEqual(item())
})
it('rejects provider failure and wrong shapes, retains original and retries after backoff',async()=>{
 const c=new FeedLocalization(file,()=>now),s=item();c.project(s,'en','fr')
 await c.translate(async()=>{throw new Error('offline')})
 expect(c.project(s,'en','fr')).toMatchObject({text:s.text,localization:{status:'failed'}});expect(c.job()).toBeNull()
 now+=300001;await c.translate(async()=>({}));expect(c.project(s,'en','fr').localization?.status).toBe('failed')
 now+=300001;await c.translate(run);expect(c.project(s,'en','fr').localization?.status).toBe('translated')
})
it('keys variants by source revision and never installs a stale answer on edited content',async()=>{
 const c=new FeedLocalization(file,()=>now),old=item();c.project(old,'en','fr')
 let resolve!:(v:Record<string,string>)=>void
 const work=c.translate(()=>new Promise(r=>resolve=r));const edited={...old,text:'Le jardin est prêt pour TLO.'}
 const next=c.project(edited,'en','fr');resolve(await run({'0/text':old.text,'0/actions.0.label':old.actions![0].label}));await work
 expect(c.project(edited,'en','fr').localization?.status).toBe('pending');expect(c.project(edited,'en','fr').localization?.revision).toBe(next.localization?.revision)
 expect(c.project(old,'fr','fr')).toEqual(old)
})
it('protects quotes, proper names, numeric facts and authoritative instructions',async()=>{
 const c=new FeedLocalization(file,()=>now),s={...item(),text:'TLO propose 3 images : « garde mon café ».',visualProposal:{question:'Quel rythme ?',recommendation:'Garder le rythme.',caveat:'Aucun rendu.',frames:[],options:[{id:'B',label:'Garder',description:'Les mêmes images.',instruction:'Ne rien publier.'}],selected:'B'}} satisfies ForYouItem
 c.project(s,'en','fr',['TLO']);await c.translate(async source=>Object.fromEntries(Object.keys(source).map(k=>[k,'The new 4 pictures are ready.'])))
 const projected=c.project(s,'en','fr',['TLO']);expect(projected.localization?.status).toBe('failed');expect(projected.visualProposal?.selected).toBe('B');expect(s.visualProposal.options[0].instruction).toBe('Ne rien publier.')
})
it('batches several cards in one budgeted call, without merging their identities',async()=>{
 const c=new FeedLocalization(file,()=>now);for(let n=0;n<5;n++)c.project({...item(),text:`Le café est prêt pour TLO. ${n}`},'en','fr')
 const provider=vi.fn(async(s:Record<string,string>)=>Object.fromEntries(Object.entries(s).map(([k,v])=>[k,v.replace('Le café est prêt pour','The café is ready for').replace('Ouvrir le café','Open the café')])))
 await c.translate(provider);expect(provider).toHaveBeenCalledTimes(1);expect(c.job()).toBeNull()
})
it('protects a project name only as a name, not inside ordinary words, and accepts valid peers of a rejected card',async()=>{
 const c=new FeedLocalization(file,()=>now)
 const good={...item(),text:'Ces changements sont importants pour le café.'}
 const bad={...item(),text:'Le café contient 3 images.'}
 c.project(good,'en','fr',['ants']);c.project(bad,'en','fr')
 await c.translate(async s=>Object.fromEntries(Object.entries(s).map(([k,v])=>[k,v===good.text?'These changes are important for the café.':v===bad.text?'The café has 4 images.':'Open the café'])))
 expect(c.project(good,'en','fr',['ants']).localization?.status).toBe('translated')
 expect(c.project(bad,'en','fr').localization?.status).toBe('failed')
})
it('translates requested feed cards before background legacy title history',async()=>{
 const c=new FeedLocalization(file,()=>now)
 for(let n=0;n<12;n++)c.project({...item(),text:`Le titre du projet ${n}`},'en','fr')
 const visible={...item(),text:'Le café est prêt pour TLO.'}
 c.project(visible,'en','fr',[],true)
 const provider=vi.fn(async(s:Record<string,string>)=>Object.fromEntries(Object.entries(s).map(([k,v])=>[k,v.replace('Le titre du projet','The project title').replace('Le café est prêt pour','The café is ready for').replace('Ouvrir le café','Open the café')])))
 await c.translate(provider)
 expect(c.project(visible,'en','fr',[],true).localization?.status).toBe('translated')
 expect(Object.values(provider.mock.calls[0][0])).toContain(visible.text)
})

it('accepts faithful written counts without accepting invented or changed counts',()=>{
 expect(sameNumericFacts('Deux retours annoncent un correctif.', '2 updates announce a fix.')).toBe(true)
 expect(sameNumericFacts('Il y a 3 images.', 'There are three images.')).toBe(true)
 expect(sameNumericFacts('Il y a 3 images.', 'There are four images.')).toBe(false)
 expect(sameNumericFacts('Le café est prêt.', 'The café has 4 rooms.')).toBe(false)
 expect(sameNumericFacts('Deux retours.', '2 updates with 2 fixes.')).toBe(false)
 expect(sameNumericFacts('1,4 seconde', '1.4 seconds')).toBe(true)
})

it('accepts an equivalent whole-hour notation without changing the hour',()=>{
 expect(sameNumericFacts('Le 9 novembre vers 13 h.', 'Around 13:00 on November 9.')).toBe(true)
 expect(sameNumericFacts('Le 9 novembre vers 13 h.', 'Around 14:00 on November 9.')).toBe(false)
})
it('revalidates actual cached provider candidates after a validator fix, without a provider call',()=>{
 fs.writeFileSync(file,JSON.stringify({cached:{source:{text:'Deux retours weevils.'},target:'en',protected:['weevils'],failedAt:1,failure:'translation changed numbers',rejected:{text:'2 weevils updates.'}}}))
 expect(new FeedLocalization(file).recovered).toBe(1)
 expect(new FeedLocalization(file).recovered).toBe(0)
 const entry=JSON.parse(fs.readFileSync(file,'utf8')).cached
 expect(entry.variant).toEqual({text:'2 weevils updates.'});expect(entry.rejected).toBeUndefined();expect(entry.failedAt).toBeUndefined()
})

it('compares localized grouping and decimal separators without confusing the quantities',()=>{
 expect(sameNumericFacts('Il y a 1 216 tests.', 'There are 1,216 tests.')).toBe(true)
 expect(sameNumericFacts('Il y a 1 216 tests.', 'There are 1,217 tests.')).toBe(false)
 expect(sameNumericFacts('The 1,216 checks passed.', 'All 1,216 checks passed.')).toBe(true)
 expect(sameNumericFacts('La mesure est 1,216 seconde.', 'The measurement is 1.216 seconds.')).toBe(true)
 expect(sameNumericFacts('There are 1,216 tests.', 'Il y a 1 216 tests.', 'fr')).toBe(true)
})
it('does not mistake an English summary for an entirely English card when its historical body is French',async()=>{
 const c=new FeedLocalization(file,()=>now)
 const mixed={...item(),text:'The café is ready for your visit.',body:'Le passage vers le café est prêt.',actions:undefined}
 expect(c.project(mixed,'en','en').localization?.status).toBe('pending')
 await c.translate(async s=>Object.fromEntries(Object.entries(s).map(([k,v])=>[k,v===mixed.body?'The passage to the café is ready.':v])))
 expect(c.project(mixed,'en','en').body).toBe('The passage to the café is ready.')
})

it('localizes authored composition copy through the same revision cache without changing layout or media references',async()=>{
 const c=new FeedLocalization(file,()=>now),s:ForYouItem={...item(),composition:{layout:'split',panels:[{mediaId:'pic',title:'Le café',text:'Le café est prêt pour TLO.'}]}}
 c.project(s,'en','fr',['TLO'])
 await c.translate(async fields=>Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,v==='Le café'?'The café':v==='Le café est prêt pour TLO.'?'The café is ready for TLO.':v==='Ouvrir le café'?'Open the café':v])))
 const en=c.project(s,'en','fr',['TLO'])
 expect(en.composition).toEqual({layout:'split',panels:[{mediaId:'pic',title:'The café',text:'The café is ready for TLO.'}]})
 expect(en.media).toEqual(s.media);expect(en.id).toBe(s.id)
 const changed={...s,composition:{...s.composition!,panels:[{...s.composition!.panels[0],text:'Le café sera prêt demain.'}]}}
 expect(c.project(changed,'en','fr',['TLO']).localization?.status).toBe('pending')
 expect(new FeedLocalization(file).project(s,'en','fr',['TLO']).composition).toEqual(en.composition)
})
