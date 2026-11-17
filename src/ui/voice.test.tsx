// @vitest-environment happy-dom
import { act } from 'react'
import { MotionGlobalConfig } from 'motion/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const api=vi.hoisted(()=>({voiceChunk:vi.fn(),voiceFinish:vi.fn(),transcribe:vi.fn()}))
const journal=vi.hoisted(()=>({volatileVoiceRecordings:new Map(),splitVoiceChunk:(blob:Blob)=>blob.size?[blob]:[],saveRecording:vi.fn(),saveVoiceChunk:vi.fn(),voiceRecordings:vi.fn(),recordedChunks:vi.fn()}))
vi.mock('../voice-recordings',()=>journal)
vi.mock('../api',()=>({api}))
vi.mock('./app-context',()=>({useApp:()=>({snap:{setup:{voice:true,dictation:true}}})}))
vi.mock('./hints',()=>({tapHint:()=>false}))
vi.mock('./setup',()=>({askSetup:vi.fn()}))
import { VoiceLogo } from './voice'
import { setLang } from '../i18n'
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true})
let root:Root,host:HTMLDivElement,permission:ReturnType<typeof vi.fn>,stopTrack:ReturnType<typeof vi.fn>,onText:ReturnType<typeof vi.fn<(text:string)=>void>>,onSend:ReturnType<typeof vi.fn<()=>void>>
let recorder:Recorder
class Recorder {
 static isTypeSupported(){return true}
 stream:MediaStream;state='inactive';mimeType='audio/mp4'
 ondataavailable:((event:{data:Blob})=>void)|null=null
 onstop:(()=>Promise<void>)|null=null
 constructor(stream:MediaStream){this.stream=stream;recorder=this}
 start(){this.state='recording'}
 stop(){this.state='inactive';void this.onstop?.()}
}
beforeEach(()=>{
 setLang('en');vi.clearAllMocks();journal.volatileVoiceRecordings.clear();MotionGlobalConfig.skipAnimations=true
 journal.saveRecording.mockResolvedValue(undefined);journal.saveVoiceChunk.mockResolvedValue(undefined);journal.voiceRecordings.mockResolvedValue([])
 permission=vi.fn();stopTrack=vi.fn();onText=vi.fn();onSend=vi.fn()
 vi.stubGlobal('navigator',{mediaDevices:{getUserMedia:permission}})
 vi.stubGlobal('MediaRecorder',Recorder)
 vi.spyOn(HTMLMediaElement.prototype,'play').mockResolvedValue()
 vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('',{status:404}))
 host=document.createElement('div');document.body.append(host);root=createRoot(host)
})
afterEach(async()=>{
 await act(async()=>root.unmount());host.remove();document.documentElement.removeAttribute('data-theme')
 vi.restoreAllMocks();vi.unstubAllGlobals();MotionGlobalConfig.skipAnimations=false;setLang(null)
})
const stream=()=>({getTracks:()=>[{stop:stopTrack}]} as unknown as MediaStream)
const render=()=>act(async()=>root.render(<VoiceLogo take={()=>''} onText={onText} onSend={onSend} working={false}/>))
const click=()=>act(async()=>host.querySelector<HTMLButtonElement>('.voice-logo')!.click())
const coloured=()=>!!host.querySelector('feFlood[result="recordingColour"]')
it.each(['light','dark','zen','graphite'])('uses recording colour only after microphone acceptance and clears it on stop in %s',async theme=>{
 document.documentElement.dataset.theme=theme
 let accept!:(stream:MediaStream)=>void
 permission.mockReturnValue(new Promise(resolve=>{accept=resolve}))
 await render();await click()
 expect(coloured()).toBe(false)
 expect(host.querySelector('button')!.getAttribute('aria-pressed')).toBe('false')
 await act(async()=>accept(stream()))
 expect(coloured()).toBe(true)
 expect(host.querySelector('button')!.getAttribute('aria-label')).toBe('stop and transcribe')
 expect(host.querySelector('button')!.classList.contains('rec')).toBe(true)
 await click()
 expect(coloured()).toBe(false)
 expect(stopTrack).toHaveBeenCalledOnce()
 expect(onSend).not.toHaveBeenCalled()
})
it('does not colour the logo when permission is denied',async()=>{
 permission.mockRejectedValue(new DOMException('Permission denied','NotAllowedError'))
 await render();await click()
 expect(coloured()).toBe(false)
 expect(host.querySelector('button')!.getAttribute('aria-pressed')).toBe('false')
 expect(host.textContent).toContain('mic blocked')
 expect(onText).not.toHaveBeenCalled();expect(onSend).not.toHaveBeenCalled()
})
it('returns to normal during transcription and sends only on the existing third tap',async()=>{
 let now=1000;vi.spyOn(Date,'now').mockImplementation(()=>now)
 permission.mockResolvedValue(stream());api.voiceChunk.mockResolvedValue({})
 let finish!:(value:{text:string})=>void
 api.voiceFinish.mockReturnValue(new Promise(resolve=>{finish=resolve}))
 await render();await click()
 await act(async()=>{recorder.ondataavailable?.({data:new Blob(['a'.repeat(1024)])});await new Promise(resolve=>setTimeout(resolve,10))})
 now=2000
 await click()
 expect(coloured()).toBe(false)
 expect(host.querySelector('button')!.getAttribute('aria-label')).toBe('send once transcribed')
 await act(async()=>finish({text:'A real transcript fixture'}))
 expect(onText).toHaveBeenCalledWith('A real transcript fixture')
 expect(onSend).not.toHaveBeenCalled()
 await click()
 expect(onSend).toHaveBeenCalledOnce()
 expect(coloured()).toBe(false)
})
it('clears recording on a recorder stop outside the button and releases tracks on unmount',async()=>{
 permission.mockResolvedValue(stream())
 await render();await click()
 expect(coloured()).toBe(true)
 await act(async()=>recorder.stop())
 expect(coloured()).toBe(false)
 await click()
 expect(coloured()).toBe(true)
 await act(async()=>root.render(null))
 expect(stopTrack.mock.calls.length).toBeGreaterThanOrEqual(2)
})

it('retains a five-minute recording after a failed finish and retries the same ID without sending',async()=>{
 let now=1000;vi.spyOn(Date,'now').mockImplementation(()=>now)
 const rows=new Map<string,any>()
 journal.saveRecording.mockImplementation(async item=>{rows.set(item.id,{...item})})
 journal.voiceRecordings.mockImplementation(async()=>[...rows.values()])
 permission.mockResolvedValue(stream());api.voiceChunk.mockResolvedValue({ok:true})
 api.voiceFinish.mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValueOnce({text:'Recovered words'})
 await render();await click()
 await act(async()=>{
  for(let n=0;n<20;n++) recorder.ondataavailable?.({data:new Blob(['a'.repeat(1024)])})
  await new Promise(resolve=>setTimeout(resolve,30))
 })
 now=301000;await click()
 await act(async()=>{await vi.waitFor(()=>expect(api.voiceFinish).toHaveBeenCalledTimes(1),{timeout:3000})})
 const first=api.voiceFinish.mock.calls[0]
 expect(first[2]).toBe(20)
 expect(journal.saveVoiceChunk).toHaveBeenCalledTimes(20)
 expect(rows.get(first[0]).stoppedAt-rows.get(first[0]).startedAt).toBe(300000)
 expect(host.textContent).toContain('Connection lost')
 expect(onText).not.toHaveBeenCalled();expect(onSend).not.toHaveBeenCalled()
 expect(host.querySelector('details,.voice-recovery')).toBeNull()
 // No button: the next time the bar mounts, the stopped recording is transcribed again by itself.
 journal.recordedChunks.mockResolvedValue(Array.from({length:20},()=>new Blob(['a'.repeat(1024)])))
 await act(async()=>root.render(null));await render()
 await act(async()=>{await vi.waitFor(()=>expect(api.voiceFinish).toHaveBeenCalledTimes(2))})
 expect(api.voiceFinish.mock.calls[1]).toEqual(first)
 expect(rows.get(first[0]).type).toBe('audio/mp4')
 expect(api.voiceChunk).toHaveBeenCalledTimes(40)
 // Recovered blobs may have no MIME of their own: use the original recording metadata.
 expect(api.voiceChunk.mock.calls.every(([id, , type])=>id===first[0] && type==='audio/mp4')).toBe(true)
 expect(onText).toHaveBeenCalledExactlyOnceWith('Recovered words')
 expect(onSend).not.toHaveBeenCalled()
 expect(rows.get(first[0]).text).toBe('Recovered words')
})

it('puts a saved, never-inserted transcript into the draft by itself, without a visible list and without sending',async()=>{
 const item={id:'saved-id',scope:'page:/',type:'audio/mp4',lang:'en',startedAt:1000,stoppedAt:301000,count:1,text:'Original transcript'}
 journal.voiceRecordings.mockResolvedValue([item])
 await render()
 await act(async()=>{await vi.waitFor(()=>expect(onText).toHaveBeenCalledExactlyOnceWith('Original transcript'))})
 expect(host.textContent).not.toContain('transcript retained')
 expect(host.querySelector('details')).toBeNull()
 expect(api.voiceFinish).not.toHaveBeenCalled();expect(onSend).not.toHaveBeenCalled()
})

it('keeps the final recorder callbacks on unmount and never inserts into a departed conversation',async()=>{
 permission.mockResolvedValue(stream());api.voiceChunk.mockResolvedValue({ok:true})
 await render();await click()
 const r=recorder
 await act(async()=>root.render(null))
 expect(r.ondataavailable).toBeTypeOf('function')
 await act(async()=>{r.ondataavailable?.({data:new Blob(['final audio'.repeat(200)])});await r.onstop?.();await vi.waitFor(()=>expect(api.voiceChunk).toHaveBeenCalled())})
 expect(journal.saveVoiceChunk).toHaveBeenCalled()
 expect(onText).not.toHaveBeenCalled();expect(onSend).not.toHaveBeenCalled()
 expect(api.voiceFinish).not.toHaveBeenCalled()
})

it('does not start an unprotected recording when local storage is unavailable',async()=>{
 journal.saveRecording.mockRejectedValue(new Error('Quota exceeded'))
 permission.mockResolvedValue(stream())
 await render();await click()
 expect(recorder.state).toBe('inactive')
 expect(stopTrack).toHaveBeenCalled()
 expect(host.textContent).toContain('recording didn’t start')
 expect(api.voiceChunk).not.toHaveBeenCalled()
})

it('keeps an interrupted recording in the journal, invisible and never transcribed on its own',async()=>{
 journal.voiceRecordings.mockResolvedValue([{id:'interrupted-id',scope:'page:/',type:'audio/mp4',lang:'en',startedAt:1000,count:3}])
 await render()
 expect(host.textContent).not.toContain('only retained audio')
 expect(host.querySelector('details')).toBeNull()
 expect(api.voiceFinish).not.toHaveBeenCalled();expect(onText).not.toHaveBeenCalled();expect(onSend).not.toHaveBeenCalled()
})

it('a failed earlier recording retried after a reload never puts a note on the logo',async()=>{
 // Regression: the background retry failed (e.g. iOS could not read the stored audio) and the note stuck forever.
 journal.voiceRecordings.mockResolvedValue([{id:'old-id',scope:'page:/',type:'audio/mp4',lang:'en',startedAt:1000,stoppedAt:5000,count:2}])
 journal.recordedChunks.mockResolvedValue([new Blob(['a'.repeat(1024)]),new Blob(['b'.repeat(1024)])])
 api.voiceChunk.mockRejectedValue(new Error('couldn’t read the audio'))
 await render()
 await act(async()=>{await vi.waitFor(()=>expect(api.voiceChunk).toHaveBeenCalled());await new Promise(resolve=>setTimeout(resolve,20))})
 expect(host.querySelector('.voice-err')).toBeNull()
 expect(host.textContent).not.toContain('read the audio')
 expect(onText).not.toHaveBeenCalled();expect(onSend).not.toHaveBeenCalled()
})

it('says nothing for a too-short recording',async()=>{
 let now=1000;vi.spyOn(Date,'now').mockImplementation(()=>now)
 permission.mockResolvedValue(stream())
 await render();await click()
 now=1200;await click()
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20))})
 expect(host.querySelector('.voice-err')).toBeNull()
 expect(api.voiceFinish).not.toHaveBeenCalled()
})

it('a real failed recording shows its note briefly, then it fades by itself',async()=>{
 let now=1000;vi.spyOn(Date,'now').mockImplementation(()=>now)
 permission.mockResolvedValue(stream());api.voiceChunk.mockResolvedValue({ok:true})
 api.voiceFinish.mockRejectedValue(new Error('couldn’t read the audio'))
 await render();await click()
 await act(async()=>{recorder.ondataavailable?.({data:new Blob(['a'.repeat(2048)])});await new Promise(resolve=>setTimeout(resolve,10))})
 now=3000;await click()
 await act(async()=>{await vi.waitFor(()=>expect(host.querySelector('.voice-err')).not.toBeNull())})
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,2400))})
 expect(host.querySelector('.voice-err')).toBeNull()
})
