import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { FeedLocalization } from './foryou-localization.ts'
import { titlePresentation } from './title-presentation.ts'
import type { Titled } from './titles.ts'
let dir: string
beforeEach(()=>{dir=fs.mkdtempSync(path.join(os.tmpdir(),'title-locale-'))})
afterEach(()=>fs.rmSync(dir,{recursive:true,force:true}))
it('keeps translated titles stable through activity changes, locale switches and reload',async()=>{
 const file=path.join(dir,'translations.json')
 const cache=new FeedLocalization(file)
 const source:Titled={title:'Le café de TLO',titleLang:'fr',now:'Prépare le café',nowLang:'fr',at:1,messageCount:4}
 const pending=titlePresentation('a',source,'en',cache,['TLO'])
 expect(pending.title).toBe(source.title)
 await cache.translate(async strings=>Object.fromEntries(Object.entries(strings).map(([k,v])=>[k,v==='Le café de TLO'?'The TLO café':'Prepares the café'])))
 const english=titlePresentation('a',source,'en',cache,['TLO'])
 expect(english).toEqual({title:'The TLO café',now:'Prepares the café'})
 expect(titlePresentation('a',source,'fr',cache,['TLO']).title).toBe(source.title)
 expect(titlePresentation('a',{...source,now:'Le test est prêt',at:2},'en',cache,['TLO']).title).toBe(english.title)
 expect(titlePresentation('a',source,'en',new FeedLocalization(file),['TLO'])).toEqual(english)
 expect(source.title).toBe('Le café de TLO')
})

it('queues legacy generated titles with unknown source language instead of silently leaving short French names',async()=>{
 const cache=new FeedLocalization(path.join(dir,'translations.json'))
 const source:Titled={title:'Gestion dossiers',now:'',at:1,messageCount:1}
 expect(titlePresentation('legacy',source,'en',cache).title).toBe('Gestion dossiers')
 expect(cache.job()).not.toBeNull()
 await cache.translate(async strings=>Object.fromEntries(Object.keys(strings).map(k=>[k,'Folder management'])))
 expect(titlePresentation('legacy',source,'en',cache).title).toBe('Folder management')
})
