// @vitest-environment happy-dom
import {act} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {beforeEach,afterEach,it,expect,vi} from 'vitest'
import {emptyBoard,type ThinkBoard} from '../../shared/think'
const state=vi.hoisted(()=>({saved:null as ThinkBoard|null, payloads:new Map<string,unknown>(),sends:[] as unknown[],failSend:false,failRead:false,reads:0,chrome:0,saves:[] as ThinkBoard[],layoutCalls:0,polls:0,storeGate:null as Promise<void>|null,storeKind:'board',saveGate:null as Promise<void>|null,sendGate:null as Promise<void>|null,layoutGate:null as Promise<void>|null}))
vi.mock('../api',()=>({ApiError:class extends Error{status:number;constructor(status:number,m:string){super(m);this.status=status}},api:{think:async()=>{state.reads++;if(state.failRead)throw Error('offline');return structuredClone(state.saved)},saveThink:async(b:ThinkBoard)=>{const copy=structuredClone(b);state.saves.push(copy);await state.saveGate;state.saved={...copy,revision:copy.revision+1};return structuredClone(state.saved)},thinkLayout:async()=>{state.layoutCalls++;await state.layoutGate;return{positions:[{id:'memory',x:500,y:600}]}},session:async()=>{state.polls++;return{messages:[]}},send:async(...args:unknown[])=>{state.sends.push(args);await state.sendGate;if(state.failSend)throw Error('offline')}}}))
vi.mock('../outbox-payload',()=>({loadPayload:async(k:string)=>state.payloads.get(k),storePayload:async(k:string,b:unknown)=>{const copy=structuredClone(b);if(k.endsWith(':request')===(state.storeKind==='request'))await state.storeGate;state.payloads.set(k,copy)},removePayload:async(k:string)=>{state.payloads.delete(k)}}))
vi.mock('./app-context',()=>({useApp:()=>({back:()=>{},snap:{config:{},sessions:[{id:'existing-session',title:'Existing session',tool:'codex'}]},push:()=>{},theme:'light'})}))
vi.mock('./shell',async()=>{const {useEffect}=await import('react');return{usePageChrome:()=>{useEffect(()=>{state.chrome++;return()=>{state.chrome--}},[])}}})
vi.mock('./outbox-status',()=>({OutboxStatus:()=>null}))
import {ThinkPage} from './think'
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true})
let root:Root,host:HTMLElement
beforeEach(()=>{state.saved=emptyBoard();state.payloads.clear();state.sends=[];state.failSend=false;state.failRead=false;state.reads=0;state.chrome=0;state.saves=[];state.layoutCalls=0;state.polls=0;state.storeGate=null;state.saveGate=null;state.sendGate=null;state.layoutGate=null;state.storeKind='board';localStorage.clear();sessionStorage.clear();host=document.createElement('div');document.body.append(host);root=createRoot(host);vi.useFakeTimers()})
afterEach(()=>{act(()=>root.unmount());host.remove();vi.useRealTimers()})
const render=async(enabled=true)=>{await act(async()=>{root.render(<ThinkPage enabled={enabled}/>);await Promise.resolve()})}
const click=async(text:string)=>{let b=[...host.querySelectorAll('button')].find(b=>b.textContent===text||b.getAttribute('aria-label')===text);if(!b){await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Canvas options"]')!.click());b=[...host.querySelectorAll('button')].find(b=>b.textContent===text||b.getAttribute('aria-label')===text)};expect(b).toBeTruthy();await act(async()=>b!.click())}
it('creates, saves, reloads and undoes a note without sending an action',async()=>{
 await render();await click('＋');let input=host.querySelector('textarea')!;expect(input).toBeTruthy()
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,'A durable thought');input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}))})
 await act(async()=>{await vi.advanceTimersByTimeAsync(900)})
 expect(state.saved?.objects[0].content).toBe('A durable thought');expect(state.saved?.objects).toHaveLength(1);expect(state.payloads.size).toBe(0);expect(state.sends).toEqual([])
 await click('Undo');await click('Undo');await act(async()=>{await vi.advanceTimersByTimeAsync(900)});expect(state.saved?.objects).toHaveLength(0)
 await click('Redo');await act(async()=>{await vi.advanceTimersByTimeAsync(900)});expect(state.saved?.objects).toHaveLength(1)
 act(()=>root.unmount());root=createRoot(host);await render();expect(host.querySelectorAll('.think-object')).toHaveLength(1);expect(state.sends).toEqual([])
})
it('previews layout without moving originals and restores positions in one undo',async()=>{
 state.saved={...emptyBoard(),objects:[{id:'a',type:'text',x:-400,y:200,width:280,height:150,content:'Original text',source:'https://example.com',updatedAt:1}]};await render();await click('Preview layout');expect(host.querySelector('.think-ghost')).toBeTruthy();expect(host.querySelector<HTMLElement>('.think-object')!.style.left).toBe('-400px');await click('Apply layout');expect(host.querySelector<HTMLElement>('.think-object')!.style.left).not.toBe('-400px');await click('Undo');expect(host.querySelector<HTMLElement>('.think-object')!.style.left).toBe('-400px');expect(host.textContent).toContain('Original text')
})
it('opens an existing note after pointer capture and pinches without creating another note',async()=>{
 state.saved={...emptyBoard(),objects:[{id:'a',type:'text',x:0,y:0,width:280,height:150,content:'Tap to edit',source:'',updatedAt:1}]};await render()
 const canvas=host.querySelector<HTMLElement>('.think-canvas')!;canvas.setPointerCapture=()=>{}
 const text=host.querySelector('.think-text')!
 await act(async()=>{text.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:1,button:0,clientX:100,clientY:100}));canvas.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:1,button:0,clientX:100,clientY:100}))})
 expect(host.querySelector('textarea')?.value).toBe('Tap to edit')
 await act(async()=>{canvas.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:2,button:0,clientX:10,clientY:10}));canvas.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:3,button:0,clientX:110,clientY:10}));canvas.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:3,clientX:210,clientY:10}));canvas.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:2}));canvas.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:3,clientX:220,clientY:20}));canvas.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:3}))})
 await click('Canvas options');expect(host.textContent).toContain('200%');expect(host.querySelectorAll('.think-object')).toHaveLength(1);expect(state.sends).toEqual([])
})
it('uses the normal composer and freezes the destination and viewport across a failed send',async()=>{
 state.saved={...emptyBoard(),objects:[{id:'memory',type:'text',x:0,y:0,width:280,height:150,content:'Keep this decision',source:'',updatedAt:1}]};await render();host.querySelector<HTMLElement>('.think-canvas')!.getBoundingClientRect=()=>new DOMRect(0,0,800,600);await click('Ask about this view');expect(state.sends).toEqual([])
 const select=host.querySelector('select')!;await act(async()=>{select.value='existing-session';select.dispatchEvent(new Event('change',{bubbles:true}))})
 const input=host.querySelector<HTMLInputElement>('input[aria-label="Send request"]')!;expect(input).toBeTruthy()
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'Explain these notes');input.dispatchEvent(new Event('input',{bubbles:true}))})
 state.failSend=true
 await act(async()=>{host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await Promise.resolve();await Promise.resolve()})
 expect(state.sends).toHaveLength(1);const original=state.sends[0] as string[];expect(original[0]).toBe('existing-session');expect(original[1]).toContain('Keep this decision');expect(original[1]).toContain('No viewport screenshot supplied');expect([...state.payloads.keys()].some(k=>k.endsWith(':request'))).toBe(true)
 await click('−');state.failSend=false
 await act(async()=>{host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await Promise.resolve();await Promise.resolve()})
 expect(state.sends).toHaveLength(2);expect(state.sends[1]).toEqual(original);expect([...state.payloads.keys()].some(k=>k.endsWith(':request'))).toBe(false)
})
it('recovers the local draft when reload happens offline',async()=>{
 sessionStorage.setItem('think-client','recovery');state.failRead=true
 state.payloads.set('think-draft-v1:recovery',{...emptyBoard(),objects:[{id:'offline',type:'text',x:0,y:0,width:280,height:150,content:'Do not lose this draft',source:'',updatedAt:1}]})
 await render();expect(host.textContent).toContain('Do not lose this draft');expect(host.querySelectorAll('.think-object')).toHaveLength(1);expect(state.sends).toEqual([])
})
it('keeps a stale recovered draft without overwriting the remote revision',async()=>{
 sessionStorage.setItem('think-client','conflict');state.saved={...emptyBoard(),revision:4}
 state.payloads.set('think-draft-v1:conflict',{...emptyBoard(),revision:2,objects:[{id:'local',type:'text',x:0,y:0,width:280,height:150,content:'Local concurrent edit',source:'',updatedAt:1}]})
 await render();await act(async()=>{await vi.advanceTimersByTimeAsync(1800)});expect(host.textContent).toContain('Local concurrent edit');expect(host.textContent).toContain('Another device changed Think');expect(state.saved.revision).toBe(4);expect(state.saved.objects).toHaveLength(0);expect(state.payloads.size).toBe(1)
})
it('edits the reported 7330 note without permanent frames or metadata controls and preserves IME text',async()=>{
 const text='yo et enft il faudrait faire ça faudrait faire le truc. cvvvc.'
 state.saved={...emptyBoard(),objects:[{id:'7330',type:'text',x:0,y:0,width:280,height:150,content:text,source:'https://example.com/original',updatedAt:1}]};await render()
 expect(host.querySelectorAll('.think-topbar button')).toHaveLength(4);expect(host.querySelector('.think-object-tools')).toBeNull();expect(host.querySelector('input[aria-label="Source URL"]')).toBeNull();expect(host.textContent).not.toContain('Preview layout')
 await act(async()=>host.querySelector<HTMLElement>('.think-text')!.click());const input=host.querySelector<HTMLTextAreaElement>('.think-native-editor')!;expect(input.value).toBe(text)
 const composed=text+'\n日本語 — dictée française. '.repeat(60)
 await act(async()=>{input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,composed);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',isComposing:true,bubbles:true}));input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}))})
 expect(host.querySelector('.think-native-editor')).not.toBeNull();await act(async()=>{await vi.advanceTimersByTimeAsync(900)});expect(state.saved?.objects[0]).toMatchObject({id:'7330',content:composed,source:'https://example.com/original'})
 await click('Done');await click('Note options');expect(host.querySelector('input[type="range"]')).not.toBeNull();expect(host.querySelector('a')?.getAttribute('href')).toBe('https://example.com/original');await click('Move');expect(host.textContent).toContain('Drag anywhere on the canvas')
})

const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r});return{promise,resolve}}
const type=async(text:string,selector='textarea')=>{await act(async()=>{const el=host.querySelector<HTMLInputElement|HTMLTextAreaElement>(selector)!;Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value')!.set!.call(el,text);el.dispatchEvent(new Event('input',{bubbles:true}))})}
const tick=async(ms=900)=>{await act(async()=>{await vi.advanceTimersByTimeAsync(ms)})}
const memory=()=>{state.saved={...emptyBoard(),objects:[{id:'memory',type:'text',x:0,y:0,width:280,height:150,content:'Keep this decision',source:'https://example.com',updatedAt:1}]}}
const compose=async()=>{await click('Ask about this view');await act(async()=>{const select=host.querySelector('select')!;select.value='existing-session';select.dispatchEvent(new Event('change',{bubbles:true}))});await type('Explain these notes','input[aria-label="Send request"]')}
const submit=async()=>{await act(async()=>{host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await Promise.resolve()})}
it('does not load a disabled canvas and preserves the editor, draft and undo across pause',async()=>{
 await render(false);await tick();expect(state.reads).toBe(0);expect(state.chrome).toBe(0);expect(state.saves).toEqual([])
 await render();await click('＋');await type('Unsent thought');const editor=host.querySelector('textarea')!;await render(false)
 expect(state.chrome).toBe(0);expect(host.querySelector('section')?.hidden).toBe(true);expect(host.querySelector('section')?.hasAttribute('inert')).toBe(true);expect(host.querySelector<HTMLElement>('section')?.style.display).toBe('none')
 await tick(5000);expect(state.saves).toEqual([]);expect([...state.payloads.values()].some(b=>(b as ThinkBoard).objects?.[0]?.content==='Unsent thought')).toBe(true)
 await render();expect(state.chrome).toBe(1);expect(host.querySelector('textarea')).toBe(editor);expect(editor.value).toBe('Unsent thought');expect(state.reads).toBe(1)
 await click('Done');await click('Undo');expect(host.querySelector('.think-text')?.textContent).toBe('');await click('Redo');expect(host.querySelector('.think-text')?.textContent).toBe('Unsent thought');await tick();expect(state.saved?.objects[0].content).toBe('Unsent thought')
})
it('does not start a save prepared before off/on while IndexedDB is pending',async()=>{
 await render();const gate=deferred();state.storeGate=gate.promise;await click('＋');await type('Queued locally');await tick();expect(state.saves).toEqual([])
 await render(false);await render();await act(async()=>{gate.resolve();await Promise.resolve()});expect(state.saves).toEqual([])
 await tick();expect(state.saves).toHaveLength(1);expect(state.saved?.objects[0].content).toBe('Queued locally')
})
it('finishes a dispatched save while paused without deleting newer local edits',async()=>{
 await render();await click('＋');await type('First version');const gate=deferred();state.saveGate=gate.promise;await tick();expect(state.saves).toHaveLength(1)
 await type('Newer draft');await render(false);await act(async()=>{gate.resolve();await Promise.resolve()});await tick(5000)
 expect(state.saves).toHaveLength(1);expect(state.saved?.objects[0].content).toBe('First version')
 const draft=[...state.payloads.values()].find(b=>(b as ThinkBoard).objects) as ThinkBoard;expect(draft.objects[0].content).toBe('Newer draft');expect(draft.revision).toBe(1)
 await render();await tick();expect(state.saves).toHaveLength(2);expect(state.saved?.objects[0].content).toBe('Newer draft');expect(state.saved?.revision).toBe(2);expect(state.payloads.size).toBe(0)
})
it('retains a dispatched AI proposal through pause but cannot request or apply one while paused',async()=>{
 memory();await render();host.querySelector<HTMLElement>('.think-canvas')!.getBoundingClientRect=()=>new DOMRect(0,0,800,600);await click('Ask about this view')
 const gate=deferred();state.layoutGate=gate.promise;await click('Ask AI to organise this view');expect(state.layoutCalls).toBe(1);await render(false)
 await act(async()=>{gate.resolve();await Promise.resolve()});expect(host.querySelector('.think-ghost')).not.toBeNull();await click('Apply layout');await click('Ask AI to organise this view');expect(state.layoutCalls).toBe(1);expect(state.saves).toEqual([])
 await render();await click('Apply layout');await tick();expect(state.saved?.objects[0]).toMatchObject({x:500,y:600,content:'Keep this decision'});await click('Undo');expect(host.querySelector<HTMLElement>('.think-object')?.style.left).toBe('0px')
})
it('keeps request text and frozen context when paused during preparation, requiring explicit retry',async()=>{
 memory();await render();await compose();const gate=deferred();state.storeKind='request';state.storeGate=gate.promise;await submit();await render(false);await render();await act(async()=>{gate.resolve();await Promise.resolve()})
 expect(state.sends).toEqual([]);expect(host.querySelector<HTMLInputElement>('input[aria-label="Send request"]')?.value).toBe('Explain these notes');const frozen=[...state.payloads.values()].find(v=>(v as {body?:string}).body) as {body:string};expect(frozen.body).toContain('Explain these notes')
 await submit();expect(state.sends).toHaveLength(1);expect((state.sends[0] as string[])[1]).toBe(frozen.body)
})
it('allows an already dispatched request to finish but stops polling and new sends while paused',async()=>{
 memory();await render();await compose();const gate=deferred();state.sendGate=gate.promise;await submit();expect(state.sends).toHaveLength(1);await render(false);const polls=state.polls
 await act(async()=>{gate.resolve();await Promise.resolve()});await tick(6000);expect(state.polls).toBe(polls);await submit();expect(state.sends).toHaveLength(1);expect([...state.payloads.keys()].some(k=>k.endsWith(':request'))).toBe(false)
 await render();expect(state.sends).toHaveLength(1);expect(state.polls).toBeGreaterThan(polls)
})
it('keeps the last drag position locally when paused before pointerup and releases the gesture',async()=>{
 memory();await render();const canvas=host.querySelector<HTMLElement>('.think-canvas')!;canvas.setPointerCapture=()=>{}
 await act(async()=>host.querySelector<HTMLElement>('.think-text')!.click());await click('Done');await click('Note options');await click('Move')
 await act(async()=>{canvas.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:1,button:0,clientX:10,clientY:10}));canvas.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:1,clientX:70,clientY:50}))});await render(false);await tick();expect(state.saves).toEqual([])
 const draft=[...state.payloads.values()].find(b=>(b as ThinkBoard).objects) as ThinkBoard;expect(draft.objects[0]).toMatchObject({x:60,y:40});await render();await tick();expect(state.saved?.objects[0]).toMatchObject({x:60,y:40});await click('Undo');expect(host.querySelector<HTMLElement>('.think-object')?.style.left).toBe('0px')
})
it('the chat panel shows no raw JSON context dump, only one short line about what sending shares',async()=>{
 state.saved={...emptyBoard(),objects:[{id:'n',type:'text',x:0,y:0,width:280,height:150,content:'Keep this decision',source:'',updatedAt:1}]};await render();await click('Ask about this view')
 const panel=host.querySelector('.think-chat')!
 expect(panel.querySelector('details')).toBeNull();expect(panel.querySelector('pre')).toBeNull()
 expect(panel.textContent).not.toMatch(/Context to share|"objects"|"camera"/)
 expect(panel.textContent).toContain('Sending shares this view with the session you pick.')
 expect(panel.querySelector('select')).not.toBeNull()
})
