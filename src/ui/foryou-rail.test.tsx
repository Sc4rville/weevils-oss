// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FeedRail, type FeedSlide } from './foryou-rail'
import { setLang } from '../i18n'
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true})
let host:HTMLDivElement,root:Root,scroll:ReturnType<typeof vi.spyOn>
const slides:FeedSlide[]=[{id:'a',label:'First view',content:<div><input aria-label="Draft" defaultValue="Keep my draft"/><video controls src="/clip.mp4"/></div>},{id:'b',label:'Second view',content:<button type="button">Open picture</button>},{id:'c',label:'Third view',content:<p>Third view content</p>}]
beforeEach(()=>{setLang('en');host=document.createElement('div');document.body.append(host);root=createRoot(host);scroll=vi.spyOn(HTMLElement.prototype,'scrollTo').mockImplementation(()=>{})})
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();setLang(null)})
const render=(items=slides)=>act(async()=>root.render(<FeedRail slides={items} label="Project views"/>))
const track=()=>host.querySelector<HTMLElement>('.fy-rail-track')!
const key=async(target:HTMLElement,value:string)=>{await act(async()=>target.dispatchEvent(new KeyboardEvent('keydown',{key:value,bubbles:true,cancelable:true})))}
it('claims horizontal gesture starts including the screen edge, without cancelling native scroll or media events',async()=>{
 const pageGesture=vi.fn();host.addEventListener('pointerdown',pageGesture)
 await render()
 for(const x of [0,10,200]){
  const event=new PointerEvent('pointerdown',{bubbles:true,cancelable:true,clientX:x,pointerType:'touch'})
  track().querySelector('video')!.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(false)
 }
 host.querySelector('.fy-rail-controls')!.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:0}))
 expect(pageGesture).not.toHaveBeenCalled()
})
it('offers local keyboard navigation but never intercepts an input or video control',async()=>{
 await render()
 await key(track(),'End');expect(host.querySelector('[aria-live]')?.getAttribute('aria-label')).toBe('View 3 of 3')
 await key(track(),'Home');expect(host.querySelector('[aria-live]')?.getAttribute('aria-label')).toBe('View 1 of 3')
 await key(track(),'ArrowRight');expect(host.querySelector('[aria-live]')?.getAttribute('aria-label')).toBe('View 2 of 3')
 scroll.mockClear()
 await key(host.querySelector('input')!,'ArrowLeft');await key(host.querySelector('video')!,'ArrowRight')
 expect(scroll).not.toHaveBeenCalled();expect(host.querySelector('[aria-live]')?.getAttribute('aria-label')).toBe('View 2 of 3')
})
it('preserves mounted video, draft, selected view and focus through locale and content refreshes',async()=>{
 await render();await key(track(),'ArrowRight')
 const video=host.querySelector('video')!,input=host.querySelector('input')!
 input.value='Still editing';input.focus();video.currentTime=12
 await act(async()=>setLang('fr'))
 await render(slides.map(s=>({...s,label:'Vue '+s.id})))
 expect(host.querySelector('video')).toBe(video);expect(video.currentTime).toBe(12)
 expect(host.querySelector('input')).toBe(input);expect(input.value).toBe('Still editing');expect(document.activeElement).toBe(input)
 expect(host.querySelector('[aria-live]')?.getAttribute('aria-label')).toBe('Vue 2 sur 3')
})
it('claims the rail when media arrives after an empty response and removes the listener on unmount',async()=>{
 await render([]);await render()
 const pageGesture=vi.fn();host.addEventListener('pointerdown',pageGesture)
 track().dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));expect(pageGesture).not.toHaveBeenCalled()
 await act(async()=>root.render(null));host.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));expect(pageGesture).toHaveBeenCalledOnce()
})
it('uses reduced motion and keeps navigation actions inside the card',async()=>{
 vi.stubGlobal('matchMedia',()=>({matches:true}))
 try{await render();await act(async()=>host.querySelector<HTMLButtonElement>('.fy-rail-controls button:last-child')!.click());expect(scroll).toHaveBeenLastCalledWith(expect.objectContaining({behavior:'instant'}));expect(host.querySelector('[aria-live]')?.getAttribute('aria-label')).toBe('View 2 of 3')}finally{vi.unstubAllGlobals()}
})
it('controls are short: chevrons and « 2 / 3 », the words only for screen readers',async()=>{
 await render();await key(track(),'ArrowRight')
 const controls=host.querySelector('.fy-rail-controls')!
 expect(controls.textContent).toBe('2 / 3')
 expect(controls.textContent).not.toMatch(/Previous view|Next view|View 2 of 3/)
 const [prev,next]=[...controls.querySelectorAll('button')]
 expect(prev.getAttribute('aria-label')).toBe('Previous view');expect(next.getAttribute('aria-label')).toBe('Next view')
 await act(async()=>next.click());expect(controls.textContent).toBe('3 / 3')
})
