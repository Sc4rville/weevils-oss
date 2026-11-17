// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { setLang } from '../i18n'
import type { ForYouItem } from '../../shared/foryou'
import type { ForYouStore } from './foryou-store'
const state = vi.hoisted(() => ({ push: vi.fn(), send: vi.fn(async () => {}), pending: false }))
vi.mock('./app-context', () => ({ useApp: () => ({ push: state.push }) }))
vi.mock('./foryou-store', () => ({ useForYou: vi.fn() }))
vi.mock('./shell', () => ({ Shell: ({ children }: any) => children }))
vi.mock('./outbox-status', () => ({ OutboxStatus: () => null }))
vi.mock('../api', () => ({ api: { foryouFormats: vi.fn() } }))
import { api } from '../api'
import { useForYou } from './foryou-store'
import { ProposalView, PictureJourney, FullImage, PreviewClip, FormatsPage, InlineMediaFormats } from './foryou-formats'
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let host: HTMLDivElement, root: Root
const item: ForYouItem = { id: 'visual:demo', kind: 'media', tone: 'neutral', at: 1, who: 'session', title: 'A real journey', text: 'Three existing views', media: [0,1,2].map(n => ({id: String(n), type:'image', url:`/image/${n}`,name:`View ${n}`,bytes:1})), visualProposal: {question:'Which pace?', recommendation:'Slower at the threshold',caveat:'Existing blur remains',frames:[0,1,2].map(n=>({title:`View ${n}`,description:`Description ${n}`})),options:[{id:'A',label:'Keep pace',description:'1.4 seconds',instruction:'Keep existing pace'},{id:'B',label:'Slower pace',description:'1.9 seconds',instruction:'Private preview only; no render'}]} }
const fy = { act: state.send, acting: () => state.pending, leftAs: () => undefined, error: () => undefined } as unknown as ForYouStore
beforeEach(() => {setLang('en');state.pending=false;state.push.mockClear();state.send.mockClear();host=document.createElement('div');document.body.append(host);root=createRoot(host)})
afterEach(async()=>{await act(async()=>root.unmount());host.remove();setLang(null)})
it('keeps instructions and explicit transmission separate from selection at phone and desktop widths', async()=>{
 for (const width of [320,390,1440]) {
  window.innerWidth=width
  await act(async()=>root.render(<ProposalView key={width} item={item} fy={fy}/>))
  const send=()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='Send my choice to TLO')!
  expect(send().disabled).toBe(true)
  expect(host.querySelectorAll('img')).toHaveLength(3)
  await act(async()=>host.querySelectorAll<HTMLInputElement>('input')[1].click())
  expect(state.send).not.toHaveBeenCalled()
  expect(host.querySelector('details')?.textContent).toContain('Private preview only; no render')
  expect(send().disabled).toBe(false)
  await act(async()=>send().click())
  expect(state.send).toHaveBeenCalledWith('visual:demo','choice:B')
  state.send.mockClear()
 }
})
it('opens complete images and changes the story without publishing or dispatching',async()=>{
 await act(async()=>root.render(<PictureJourney media={item.media!} frames={item.visualProposal!.frames}/>))
 await act(async()=>[...host.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Next view')!.click())
 expect(host.querySelector('.fy-rail-slide[aria-current="true"] img')?.getAttribute('src')).toBe('/image/1')
 await act(async()=>host.querySelector<HTMLButtonElement>('.fy-rail-slide[aria-current="true"] .formats-image')!.click())
 expect(state.push).toHaveBeenCalledWith({kind:'media',url:'/image/1',type:'image',name:'Description 1'})
 expect(state.send).not.toHaveBeenCalled()
})
it('a completed proposal cannot be sent again after reloading',async()=>{
 await act(async()=>root.render(<ProposalView item={{...item,visualProposal:{...item.visualProposal!,selected:'B'}}} fy={fy}/>))
 expect(host.querySelector('fieldset')?.disabled).toBe(true)
 expect([...host.querySelectorAll('button')].find(b=>b.textContent==='Choice sent to TLO')?.disabled).toBe(true)
})

it('recovers the actual image component after a 404 and opens the original URL',async()=>{
 const fetchMedia=vi.fn().mockResolvedValueOnce(new Response('',{status:404})).mockResolvedValueOnce(new Response('image',{status:200}))
 await act(async()=>root.render(<FullImage media={item.media![0]} description="Existing view"/>))
 const first=host.querySelector('img')!
 expect((await fetchMedia(first.getAttribute('src'))).status).toBe(404)
 await act(async()=>first.dispatchEvent(new Event('error')))
 expect(host.querySelector('[role="alert"]')?.textContent).toContain('did not load')
 await act(async()=>host.querySelector('button')!.click())
 const retried=host.querySelector('img')!
 expect(retried.getAttribute('src')).toContain('retry=1')
 expect((await fetchMedia(retried.getAttribute('src'))).status).toBe(200)
 await act(async()=>retried.dispatchEvent(new Event('load')))
 expect(host.querySelector('[role="alert"]')).toBeNull()
 await act(async()=>host.querySelector('button')!.click())
 expect(state.push).toHaveBeenCalledWith({kind:'media',url:'/image/0',type:'image',name:'Existing view'})
})
it('clears a failed media state when its source changes',async()=>{
 await act(async()=>root.render(<FullImage media={item.media![0]} description="View"/>))
 await act(async()=>host.querySelector('img')!.dispatchEvent(new Event('error')))
 await act(async()=>root.render(<FullImage media={item.media![1]} description="View"/>))
 expect(host.querySelector('img')?.getAttribute('src')).toBe('/image/1')
})
it('retries the clip without starting playback automatically',async()=>{
 const play=vi.spyOn(HTMLMediaElement.prototype,'play').mockResolvedValue()
 await act(async()=>root.render(<PreviewClip media={{...item.media![0],type:'video'}} title="Clip"/>))
 let video=host.querySelector('video')!
 expect(video.controls).toBe(true)
 expect(video.autoplay).toBe(false)
 expect(video.preload).toBe('none')
 await act(async()=>video.dispatchEvent(new Event('error')))
 await act(async()=>host.querySelector('button')!.click())
 video=host.querySelector('video')!
 expect(video.getAttribute('src')).toContain('retry=1')
 expect(play).not.toHaveBeenCalled()
 play.mockRestore()
})
it('limits navigation to available frames and images',async()=>{
 await act(async()=>root.render(<PictureJourney media={item.media!.slice(0,1)} frames={item.visualProposal!.frames}/>))
 expect(host.querySelectorAll('.fy-rail-slide')).toHaveLength(1)
 expect(host.querySelector('.fy-rail-controls')).toBeNull()
})
it('reflects server confirmation and disables a pending submission',async()=>{
 await act(async()=>root.render(<ProposalView item={item} fy={fy}/>))
 await act(async()=>host.querySelectorAll<HTMLInputElement>('input')[0].click())
 state.pending=true
 await act(async()=>root.render(<ProposalView item={item} fy={fy}/>))
 expect(host.querySelector('fieldset')?.disabled).toBe(true)
 state.pending=false
 await act(async()=>root.render(<ProposalView item={{...item,visualProposal:{...item.visualProposal!,selected:'B'}}} fy={fy}/>))
 expect(host.querySelectorAll<HTMLInputElement>('input')[1].checked).toBe(true)
 expect(host.querySelector('details')?.textContent).toContain('Private preview only')
 expect(state.send).not.toHaveBeenCalled()
})

it('renders all four formats and persists a local preference without sending a choice',async()=>{
 vi.mocked(api.foryouFormats).mockResolvedValue({proposal:item})
 vi.mocked(useForYou).mockReturnValue({...fy,feed:{items:[item,{...item,id:'assets',visualProposal:undefined,media:[{...item.media![0],id:'b442c5405b86603a'},{...item.media![0],id:'241bbd0062433326',type:'video'}]}]}} as ForYouStore)
 localStorage.removeItem('weevils:format-choice')
 for(const width of [320,390,1440]) {
  window.innerWidth=width
  await act(async()=>root.render(<FormatsPage key={width}/>))
  expect(host.querySelectorAll('.formats-section')).toHaveLength(4)
  expect(host.querySelectorAll('video')).toHaveLength(1)
  await act(async()=>host.querySelectorAll<HTMLButtonElement>('.formats-keep')[1].click())
  expect(localStorage.getItem('weevils:format-choice')).toBe('story')
 }
 expect(host.querySelectorAll('.formats-keep')[1].getAttribute('aria-pressed')).toBe('true')
 expect(state.send).not.toHaveBeenCalled()
})

it('language switches preserve selection, open instructions and the clip element',async()=>{
 vi.mocked(api.foryouFormats).mockResolvedValue({proposal:item})
 vi.mocked(useForYou).mockReturnValue({...fy,feed:{items:[item,{...item,id:'clip',visualProposal:undefined,media:[{...item.media![0],id:'241bbd0062433326',type:'video'}]}]}} as ForYouStore)
 await act(async()=>{setLang('fr');root.render(<FormatsPage/>)})
 await act(async()=>host.querySelectorAll<HTMLInputElement>('input')[1].click())
 const video=host.querySelector('video')!
 const details=host.querySelector('details')!;details.open=true
 for(const locale of ['en','fr'] as const){
  await act(async()=>setLang(locale))
  expect(host.querySelector('video')).toBe(video)
  expect(host.querySelector('details')).toBe(details)
  expect(details.open).toBe(true)
  expect(host.querySelectorAll<HTMLInputElement>('input')[1].checked).toBe(true)
 }
 expect(state.send).not.toHaveBeenCalled()
})

it('shows translation progress and original wording without changing the selected option',async()=>{
 const localization={target:'en' as const,source:'fr' as const,revision:'same-source',original:{text:'Le texte original reste disponible.'}}
 for(const status of ['pending','failed','translated'] as const){
  await act(async()=>root.render(<ProposalView item={{...item,localization:{...localization,status}}} fy={fy}/>))
  if(status==='pending')await act(async()=>host.querySelectorAll<HTMLInputElement>('input')[1].click())
  expect(host.querySelectorAll<HTMLInputElement>('input')[1].checked).toBe(true)
  if(status==='translated'){
   const original=[...host.querySelectorAll('details')].find(d=>d.querySelector('summary')?.textContent==='original')!
   expect(original).toBeTruthy()
   expect(original.open).toBe(false)
   expect(original.querySelector('[lang="fr"]')?.textContent).toBe(localization.original.text)
  }else expect(host.querySelector('[role="status"]')?.textContent).toContain(status==='pending'?'not translated yet':'couldn’t translate')
 }
 expect(state.send).not.toHaveBeenCalled()
})

it('uses the gallery components directly inside existing feed cards without sending or autoplay',async()=>{
 const media:ForYouItem={...item,visualProposal:undefined,media:[{id:'341ba5be815fb245',type:'image',url:'/street',name:'street.png',bytes:1},{id:'b3fdac9f32927919',type:'image',url:'/cafe',name:'cafe.png',bytes:1},{id:'video',type:'video',url:'/clip',name:'clip.mp4',bytes:1}]}
 await act(async()=>root.render(<InlineMediaFormats item={media}/>))
 expect(host.textContent).toContain('Outside the café')
 await act(async()=>[...host.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Next view')!.click())
 expect(host.querySelector('.fy-rail-slide[aria-current="true"] img')?.getAttribute('src')).toBe('/cafe')
 expect(host.querySelector('video')?.controls).toBe(true)
 expect(host.querySelector('video')?.autoplay).toBe(false)
 expect(state.send).not.toHaveBeenCalled()
 expect(host.textContent).not.toContain('Try visual formats')
})

it.each(['split','rail'] as const)('renders authored %s panels once, retaining unmatched media and stable video across locale refresh',async layout=>{
 const composed:ForYouItem={...item,visualProposal:undefined,media:[...item.media!,{id:'clip',type:'video',url:'/clip',name:'Existing clip',bytes:1}],composition:{layout,panels:[{mediaId:'0',title:'First panel',text:'Existing source'},{mediaId:'clip',title:'Video panel',text:'Watch at your pace'},{mediaId:'0',title:'Duplicate reference',text:'Not a new source'},{mediaId:'missing',title:'Missing source',text:'Do not invent a media'}]}}
 await act(async()=>root.render(<InlineMediaFormats item={composed}/>))
 expect(host.querySelectorAll('img')).toHaveLength(4)
 expect(host.querySelectorAll('video')).toHaveLength(1)
 expect(host.textContent).toContain('Duplicate reference');expect(host.textContent).toContain('Missing source')
 expect(host.querySelector('[role="status"]')?.textContent).toContain('did not load')
 const video=host.querySelector('video')!;video.currentTime=8
 expect(video.controls).toBe(true);expect(video.autoplay).toBe(false)
 await act(async()=>setLang('fr'))
 await act(async()=>root.render(<InlineMediaFormats item={{...composed,composition:{layout,panels:composed.composition!.panels.map(p=>({...p,title:'Vue existante'}))}}}/>))
 expect(host.querySelector('video')).toBe(video);expect(video.currentTime).toBe(8)
 expect(state.send).not.toHaveBeenCalled()
})
