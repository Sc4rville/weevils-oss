// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MarkdownEditor, markdownDraftKey } from './markdown-editor'
import { setLang } from '../i18n'
const api=vi.hoisted(()=>({saveFile:vi.fn(),file:vi.fn()}))
vi.mock('../api',()=>({api}))
let host: HTMLDivElement,root: Root
const file={path:'notes.md',content:'Original français',revision:'a'.repeat(64),editable:true,size:17,binary:false,truncated:false}
const saved=vi.fn(),editing=vi.fn()
let repo=''
const render=async()=>{await act(async()=>root.render(<MarkdownEditor file={file} machine="vps" repo={repo} path="notes.md" onSaved={saved} onEditing={editing}/>))}
const click=async(text:string)=>{const b=[...host.querySelectorAll('button')].find(b=>b.textContent===text)!;expect(b).toBeTruthy();await act(async()=>b.click())}
const write=async(text:string)=>{await act(async()=>{const el=host.querySelector('textarea')!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(el,text);el.dispatchEvent(new Event('input',{bubbles:true}))})}
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});setLang('en');sessionStorage.clear();vi.clearAllMocks();repo=crypto.randomUUID();host=document.createElement('div');document.body.append(host);root=createRoot(host)})
afterEach(async()=>{await act(async()=>root.unmount());host.remove();setLang(null)})
it('keeps a conflict draft across closing/reopening and reload without automatic save',async()=>{
 api.saveFile.mockRejectedValueOnce(new Error('File changed elsewhere'))
 await render();await click('Edit Markdown');await write('Mon idée intacte')
 await click('Save')
 expect(host.textContent).toContain('File changed elsewhere')
 expect(saved).not.toHaveBeenCalled()
 expect(JSON.parse(sessionStorage.getItem(markdownDraftKey('vps',repo,'notes.md'))!).content).toBe('Mon idée intacte')
 await click('Close editor');await click('Edit Markdown')
 expect(host.querySelector('textarea')!.value).toBe('Mon idée intacte')
 await act(async()=>root.unmount());root=createRoot(host);await render()
 expect(host.querySelector('textarea')!.value).toBe('Mon idée intacte')
 expect(api.saveFile).toHaveBeenCalledTimes(1)
})
it('freezes one save and clears the retained draft only after exact server confirmation',async()=>{
 let resolve!:(v:unknown)=>void
 api.saveFile.mockImplementationOnce(()=>new Promise(r=>{resolve=r}))
 await render();await click('Edit Markdown');await write('New text')
 await click('Save')
 expect(host.querySelector('textarea')!.disabled).toBe(true)
 expect(api.saveFile).toHaveBeenCalledWith(repo,'notes.md','vps','New text',file.revision)
 await act(async()=>resolve({...file,content:'New text',revision:'b'.repeat(64)}))
 expect(saved).toHaveBeenCalledWith(expect.objectContaining({content:'New text'}))
 expect(sessionStorage.getItem(markdownDraftKey('vps',repo,'notes.md'))).toBeNull()
 expect(host.textContent).toContain('Saved')
})
it('reads latest for review, requires explicit replacement and keeps locale changes independent of text',async()=>{
 api.saveFile.mockRejectedValue(new Error('Conflict'))
 api.file.mockResolvedValue({...file,content:'Other author',revision:'b'.repeat(64)})
 await render();await click('Edit Markdown');await write('Texte utilisateur')
 await click('Save');await click('Read latest version')
 expect(host.querySelector('pre')!.textContent).toBe('Other author')
 expect(api.saveFile).toHaveBeenCalledTimes(1)
 await act(async()=>setLang('fr'))
 expect(host.querySelector('textarea')!.value).toBe('Texte utilisateur')
 await click('Remplacer cette version par mon brouillon')
 expect(api.saveFile).toHaveBeenLastCalledWith(repo,'notes.md','vps','Texte utilisateur','b'.repeat(64))
})
