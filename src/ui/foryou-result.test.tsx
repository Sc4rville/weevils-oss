// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { setLang } from '../i18n'
import type { ForYouItem } from '../../shared/foryou'
const push=vi.hoisted(()=>vi.fn())
vi.mock('./app-context',()=>({useApp:()=>({push})}))
import { ResultCard } from './foryou-result'
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true})
let host:HTMLDivElement,root:Root
const source:ForYouItem={id:'source',kind:'media',tone:'result',at:1000,who:'session',text:'Earlier portrait',media:[{id:'portrait',name:'alcove_p.png',url:'/portrait',type:'image',bytes:1}],seen:true,actions:[{id:'choose',label:'Keep'}]}
const item:ForYouItem={...source,resultGroup:{key:'tlo-alcove',final:{id:'final',name:'alcove_l.png',url:'/final',type:'image',bytes:1},finalAt:2000,history:[source],otherMedia:[],newerUpdate:false}}
const controls=vi.fn((s:ForYouItem)=><button data-action={s.actions?.[0].id}>Source action</button>)
beforeEach(()=>{setLang('en');localStorage.clear();push.mockClear();host=document.createElement('div');document.body.append(host);root=createRoot(host)})
afterEach(async()=>{await act(async()=>root.unmount());host.remove()})
it('opens the final directly, leaves history collapsed, and retains source action identity',async()=>{
 await act(async()=>root.render(<ResultCard item={item} sourceControls={controls}/>))
 expect(host.querySelector('img')?.getAttribute('src')).toBe('/final')
 expect(host.querySelector('details')?.open).toBe(false)
 await act(async()=>host.querySelector<HTMLButtonElement>('.formats-image')!.click())
 expect(push).toHaveBeenCalledWith({kind:'media',url:'/final',type:'image',name:'TLO · The alcove'})
 expect(host.querySelector('[data-source-id="source"] [data-action="choose"]')).toBeTruthy()
})
it('retains disclosure across reload and locale change without changing the source or opening media',async()=>{
 localStorage.setItem('weevils-result-history:tlo-alcove','open')
 await act(async()=>root.render(<ResultCard item={item} sourceControls={controls}/>))
 expect(host.querySelector('details')?.open).toBe(true)
 await act(async()=>setLang('fr'))
 expect(host.querySelector('summary')?.textContent).toContain('Vues et mises à jour')
 expect(host.querySelector('[data-source-id]')?.getAttribute('data-source-id')).toBe('source')
 expect(push).not.toHaveBeenCalled()
})
it('keeps history available on missing media and flags later updates without replacing final',async()=>{
 await act(async()=>root.render(<ResultCard item={{...item,resultGroup:{...item.resultGroup!,final:undefined,newerUpdate:true}}} sourceControls={controls}/>))
 expect(host.textContent).toContain('verified render is unavailable')
 expect(host.textContent).toContain('later update')
 expect(host.querySelector('details img')?.getAttribute('src')).toBe('/portrait')
})
