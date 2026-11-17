// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const api=vi.hoisted(()=>({modelControls:vi.fn(),setModelControls:vi.fn()}))
vi.mock('../api',()=>({api}))
vi.mock('./shell',()=>({Shell:({children}:any)=>children}))
import { ModelPicker } from './model-controls'
import { interceptModelControl, MODEL_CONTROL_EVENT } from '../model-controls'
const data={threadId:'existing',tool:'codex',models:[{id:'real',label:'Real model',efforts:['low','high'],defaultEffort:'low'},{id:'other',label:'Other model with a rather long display name',efforts:['medium','high'],defaultEffort:'medium'}],selected:{model:'real',effort:'low'},active:true,appliesTo:'next-turn'}
const deferred=<T,>()=>{let resolve!:(v:T)=>void,reject!:(e:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
let host:HTMLDivElement,root:Root
beforeEach(()=>{api.modelControls.mockReset().mockResolvedValue(data);api.setModelControls.mockReset();host=document.createElement('div');document.body.append(host);root=createRoot(host)})
afterEach(async()=>{await act(async()=>root.unmount());host.remove()})
const render=()=>act(async()=>root.render(<ModelPicker id="existing"/>))
const chip=(label:string)=>[...host.querySelectorAll('button')].find(b=>b.textContent===label)!
const tap=(label:string)=>act(async()=>chip(label).click())

it('opens controls for bare commands without submitting chat or intercepting ordinary text',()=>{
 const listener=vi.fn();window.addEventListener(MODEL_CONTROL_EVENT,listener)
 expect(interceptModelControl('existing',' /model ')).toBe(true)
 expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({id:'existing'})
 expect(interceptModelControl('existing','Explain /model')).toBe(false)
 expect(interceptModelControl('existing','/model',1)).toBe(false)
 window.removeEventListener(MODEL_CONTROL_EVENT,listener)
})

it('tap = applied: one tap sends the setting, nothing else to confirm, readback marks it silently',async()=>{
 const saved=deferred<typeof data>();api.setModelControls.mockReturnValueOnce(saved.promise)
 const before=document.body.childElementCount
 await render()
 expect(chip('Real model').getAttribute('aria-pressed')).toBe('true')
 await tap('high')
 // The tap itself is the whole action: sent at once, no apply/confirm step.
 expect(api.setModelControls).toHaveBeenCalledTimes(1)
 expect(api.setModelControls).toHaveBeenLastCalledWith('existing',{model:'real',effort:'high'})
 expect(chip('high').getAttribute('aria-pressed')).toBe('true')
 expect(chip('high').classList.contains('pending')).toBe(true)
 await act(async()=>saved.resolve({...data,selected:{model:'real',effort:'high'}}))
 expect(chip('high').classList.contains('pending')).toBe(false)
 expect(chip('high').getAttribute('aria-pressed')).toBe('true')
 expect(chip('low').getAttribute('aria-pressed')).toBe('false')
 // No extra prompt of any kind: no select, no apply button, no dialog, toast, banner or status line.
 expect(host.querySelector('select')).toBeNull()
 expect(document.querySelector('[role=dialog],[role=alertdialog],[aria-modal]')).toBeNull()
 expect(host.querySelector('[role=status],[role=alert]')).toBeNull()
 expect([...host.querySelectorAll('button')].map(b=>b.textContent)).toEqual(['Real model','Other model with a rather long display name','low','high'])
 expect(document.body.childElementCount).toBe(before)
})

it('a model tap keeps a supported effort or falls back to the model default, in one call',async()=>{
 api.setModelControls.mockResolvedValueOnce({...data,selected:{model:'other',effort:'medium'}}).mockResolvedValueOnce({...data,selected:{model:'real',effort:'low'}})
 await render()
 await tap('Other model with a rather long display name')
 expect(api.setModelControls).toHaveBeenLastCalledWith('existing',{model:'other',effort:'medium'})
 expect(chip('medium').getAttribute('aria-pressed')).toBe('true')
 await tap('Real model')
 expect(api.setModelControls).toHaveBeenLastCalledWith('existing',{model:'real',effort:'low'})
 await tap('Real model')
 expect(api.setModelControls).toHaveBeenCalledTimes(2)
})

it('taps during a change in flight send only the latest choice, after the first readback',async()=>{
 const first=deferred<typeof data>();api.setModelControls.mockReturnValueOnce(first.promise).mockResolvedValueOnce({...data,selected:{model:'other',effort:'high'}})
 await render()
 await tap('high')
 await tap('Other model with a rather long display name')
 await tap('high')
 expect(api.setModelControls).toHaveBeenCalledTimes(1)
 await act(async()=>first.resolve({...data,selected:{model:'real',effort:'high'}}))
 expect(api.setModelControls).toHaveBeenCalledTimes(2)
 expect(api.setModelControls).toHaveBeenLastCalledWith('existing',{model:'other',effort:'high'})
 expect(chip('Other model with a rather long display name').getAttribute('aria-pressed')).toBe('true')
 expect(host.querySelector('.pending')).toBeNull()
})

it('a failed readback puts the confirmed choice back with one discreet inline line, cleared by the next tap',async()=>{
 api.setModelControls.mockRejectedValueOnce(new Error('Not confirmed')).mockResolvedValueOnce({...data,selected:{model:'real',effort:'high'}})
 await render()
 await tap('high')
 const alert=host.querySelector('[role=alert]')!
 expect(alert.textContent).toContain('Not confirmed')
 expect(alert.closest('.model-controls')).not.toBeNull()
 expect(chip('low').getAttribute('aria-pressed')).toBe('true')
 expect(chip('high').getAttribute('aria-pressed')).toBe('false')
 await tap('high')
 expect(host.querySelector('[role=alert]')).toBeNull()
 expect(chip('high').getAttribute('aria-pressed')).toBe('true')
})

it('layout: the picker stays in the page flow and wraps inside its band (no overlay, no spill)',async()=>{
 await render()
 // Rendered where it is mounted, not portalled over the header, the input field or the bottom bar.
 expect(host.querySelector('.model-controls')!.parentElement).toBe(host)
 for (const el of host.querySelectorAll<HTMLElement>('*')) expect(el.getAttribute('style')??'').not.toMatch(/position|width|transform/)
 // The stylesheet half of this contract is in test/model-picker-layout.test.ts.
})
