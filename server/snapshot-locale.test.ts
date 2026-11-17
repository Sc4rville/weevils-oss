import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Session } from '../shared/api.ts'
import type { Transcript } from './transcripts.ts'
const generated = vi.hoisted(() => vi.fn(async () => [] as { id:string;title:string;now:string;topicChanged?:boolean }[]))
vi.mock('./voicepipe.ts', () => ({ keepWarm() {}, warmCues() {} }))
vi.mock('./fast.ts', () => ({ setCartesiaVoice() {} }))
vi.mock('./titles.ts', async orig => ({ ...(await orig<typeof import('./titles.ts')>()), llmTitles: generated }))
const { Weevils } = await import('./core.ts')
const { DATA_DIR, HOME } = await import('./config.ts')
const { lang, withLang, installationLang } = await import('./i18n.ts')
let w: InstanceType<typeof Weevils>
beforeEach(() => {
 vi.useFakeTimers()
 fs.rmSync(path.join(DATA_DIR, 'state.json'), { force:true })
 fs.rmSync(path.join(DATA_DIR, 'session-names.json'), { force:true })
 generated.mockReset();generated.mockResolvedValue([])
 w = new Weevils()
})

it('keeps an intentional shared topic through retitle, locale switches, handoff names and process reload',async()=>{
 const now=Date.now(),id='stored-topic'
 fs.mkdirSync(DATA_DIR,{recursive:true})
 fs.writeFileSync(path.join(DATA_DIR,'session-names.json'),JSON.stringify([[id,'Interface and navigation']]))
 const t={id,tool:'codex',file:'/fixture/topic.jsonl',cwd:path.join(HOME,'projects','fixture'),originator:'codex-tui',delegationSources:new Map([['u','sender']]),openedAt:now-60000,lastActivityAt:now,workStartedAt:null,phase:'idle',firstPrompt:'Corrige l’espace vide mobile',customTitle:'Older transcript name',messages:[{id:'u',role:'user',text:'Original exact user text',at:now}],subagents:[],queued:[],offset:0,partial:''} as Transcript
 w=new Weevils();w.store.byFile.set(t.file,t)
 t.messages.push({id:'a',role:'assistant',text:'Existing progress',at:now})
 ;(w as any).relay={relayOf:()=> 'source',relayedBy:()=>undefined,view:()=>undefined,bossOn:()=>false}
 w.titles.set('source',{title:'Old handoff topic',now:'',at:now,messageCount:1})
 w.titles.set(id,{title:'Translated old topic',titleLang:'en',now:'Previous activity',nowLang:'en',at:now-600000,messageCount:0})
 generated.mockResolvedValue([{id,title:'Another micro-action',now:'Checks the current layout',topicChanged:true}])
 await withLang('en',()=>w.retitle())
 expect(generated).toHaveBeenCalledOnce()
 for(const locale of ['en','fr','en'] as const){
  const s=withLang(locale,()=>w.snapshot()).sessions.find(s=>s.id===id)!
  expect(s.title).toBe('Interface and navigation')
  expect(s.now).toBe('Checks the current layout')
 }
 const reloaded=new Weevils();reloaded.store.byFile.set(t.file,t)
 expect(withLang('en',()=>reloaded.snapshot()).sessions.find(s=>s.id===id)?.title).toBe('Interface and navigation')
 expect(t.firstPrompt).toBe('Corrige l’espace vide mobile')
 expect(t.messages[0].text).toBe('Original exact user text')
})

it('preserves a Claude custom title while refreshing its separate activity',async()=>{
 const now=Date.now(),id='claude-topic'
 const t={id,tool:'claude',file:'/fixture/claude.jsonl',cwd:path.join(HOME,'projects','fixture'),openedAt:now-60000,lastActivityAt:now,workStartedAt:null,phase:'idle',firstPrompt:'Old first request',customTitle:'Claude and Codex handoff',messages:[{id:'u',role:'user',text:'Original user text',at:now}],subagents:[],queued:[],offset:0,partial:''} as Transcript
 w.store.byFile.set(t.file,t)
 t.messages.push({id:'a',role:'assistant',text:'Existing progress',at:now})
 ;(w as any).panes=[{name:'wv-fixture',sessionId:id,tool:'claude',cwd:t.cwd,title:t.customTitle,createdAt:now-60000}]
 generated.mockResolvedValue([{id,title:'A single command',now:'Checks delivery',topicChanged:true}])
 await withLang('en',()=>w.retitle())
 expect(w.sessions()[0].title).toBe('Claude and Codex handoff')
 expect(w.sessions()[0].now).toBe('Checks delivery')
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks() })
it('serves titles in each explicit locale before any event invalidates the snapshot, preserving identity and source', async () => {
 const source = { id:'handoff', title:'Relais Claude ↔ Codex', now:'Le passage est prêt', projectId:'weevils', machineId:'test', tool:'codex', status:'done', lastActivityAt:1000 } as Session
 const original=structuredClone(source)
 const sessions=vi.spyOn(w,'sessions').mockImplementation(() => [{...source,title:lang()==='en'?'Claude ↔ Codex handoff':source.title,now:lang()==='en'?'The handoff is ready':source.now}])
 const pref=installationLang()
 const en=withLang('en',()=>w.snapshot())
 expect(withLang('en',()=>w.snapshot())).toBe(en)
 const fr=await withLang('fr',async()=>{ await Promise.resolve(); return w.snapshot() })
 const again=withLang('en',()=>w.snapshot())
 expect([en.sessions[0].title,fr.sessions[0].title,again.sessions[0].title]).toEqual(['Claude ↔ Codex handoff','Relais Claude ↔ Codex','Claude ↔ Codex handoff'])
 expect([en,fr,again].map(s=>[s.sessions[0].id,s.sessions[0].status,s.sessions[0].lastActivityAt])).toEqual(Array(3).fill(['handoff','done',1000]))
 expect(source).toEqual(original);expect(installationLang()).toBe(pref)
 expect(sessions).toHaveBeenCalledTimes(3)
})
it('keeps empty feeds empty across locales and invalidates cached content on a real event',()=>{
 const sessions=vi.spyOn(w,'sessions').mockReturnValue([])
 for(const l of ['en','fr','en'] as const) expect(withLang(l,()=>w.snapshot()).sessions).toEqual([])
 w.bump()
 withLang('en',()=>w.snapshot())
 expect(sessions).toHaveBeenCalledTimes(4)
})
