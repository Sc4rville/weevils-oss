// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { setLang } from '../i18n'
const api=vi.hoisted(()=>({file:vi.fn(),saveFile:vi.fn()}))
vi.mock('../api',()=>({api,ApiError:class extends Error{}}))
vi.mock('./app-context',()=>({useApp:()=>({snap:{projects:[{id:'content',where:{content:'vps'}}],machines:[{id:'vps'}],config:{},main:[]},colors:{},push:vi.fn()})}))
vi.mock('./shell',()=>({Shell:({children}:{children:ReactNode})=><main>{children}</main>,FootError:()=>null,swapPage:()=>{}}))
vi.mock('./ask',()=>({useAsk:()=>({}),AskVoice:()=>null,AskPanel:()=>null}))
const {PageView}=await import('./pages')
it('normal file entry edits Markdown and reopens from a fresh server read rather than stale cache',async()=>{
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});setLang('en')
 const host=document.createElement('div');document.body.append(host)
 let root=createRoot(host)
 let current={path:'ideas.md',content:'Original',revision:'a'.repeat(64),editable:true,binary:false,truncated:false,size:8}
 api.file.mockImplementation(async()=>({...current}))
 api.saveFile.mockImplementation(async(_repo,_path,_machine,content)=>{current={...current,content,revision:'b'.repeat(64)};return {...current}})
 const show=async()=>{await act(async()=>root.render(<PageView page={{kind:'file',projectId:'content',repo:'content',path:'ideas.md'}}/>))}
 const click=async(text:string)=>{await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent===text)!.click())}
 try {
  await show();expect(api.file).toHaveBeenLastCalledWith('content','ideas.md','vps')
  await click('Edit Markdown')
  await act(async()=>{const e=host.querySelector('textarea')!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(e,'Edited');e.dispatchEvent(new Event('input',{bubbles:true}))})
  await click('Save');await click('Close editor')
  expect(host.querySelector('.ct')!.textContent).toBe('Edited')
  await act(async()=>root.unmount());root=createRoot(host)
  current={...current,content:'New external edit',revision:'c'.repeat(64)}
  await show();expect(host.querySelector('.ct')!.textContent).toBe('New external edit')
  expect(api.file).toHaveBeenCalledTimes(2)
  expect(api.saveFile).toHaveBeenCalledTimes(1)
 } finally {await act(async()=>root.unmount());host.remove();setLang(null)}
})
