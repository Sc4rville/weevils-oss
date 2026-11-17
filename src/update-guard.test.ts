// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { updateIsBusy } from './update-guard'
afterEach(() => { document.body.replaceChildren(); document.getSelection()?.removeAllRanges(); vi.restoreAllMocks() })
it('waits for a draft, pending send, media playback or text selection before updating', () => {
 const composer = document.createElement('form')
 composer.className = 'composer'
 document.body.append(composer)
 expect(updateIsBusy()).toBe(false)
 composer.dataset.draft = 'true'
 expect(updateIsBusy()).toBe(true)
 delete composer.dataset.draft
 composer.setAttribute('aria-busy', 'true')
 expect(updateIsBusy()).toBe(true)
 composer.removeAttribute('aria-busy')
 const audio = document.createElement('audio')
 document.body.append(audio)
 const playing = vi.spyOn(audio, 'paused', 'get').mockReturnValue(false)
 expect(updateIsBusy()).toBe(true)
 playing.mockReturnValue(true)
 expect(updateIsBusy()).toBe(false)
 const text = document.createTextNode('Keep this selection')
 document.body.append(text)
 const range = document.createRange()
 range.selectNodeContents(text)
 document.getSelection()!.addRange(range)
 expect(updateIsBusy()).toBe(true)
 document.getSelection()!.removeAllRanges()
 expect(updateIsBusy()).toBe(false)
})
it.each(['rec','wait'])('never navigates away during voice %s', phase => {
 const microphone=document.createElement('button');microphone.className=`voice-logo ${phase}`;document.body.append(microphone)
 expect(updateIsBusy()).toBe(true)
 microphone.className='voice-logo idle'
 expect(updateIsBusy()).toBe(false)
})
it('protects microphone permission and a recoverable recording error',()=>{
 const voice=document.createElement('div');voice.className='voice';voice.dataset.voiceBusy='true';document.body.append(voice)
 expect(updateIsBusy()).toBe(true)
 voice.dataset.voiceBusy='false'
 expect(updateIsBusy()).toBe(false)
})

it('keeps Markdown drafts and pending file saves safe from automatic updates',()=>{
 const editor=document.createElement('section');editor.className='markdown-editor';document.body.append(editor)
 editor.dataset.draft='true';expect(updateIsBusy()).toBe(true)
 delete editor.dataset.draft;editor.setAttribute('aria-busy','true');expect(updateIsBusy()).toBe(true)
 editor.removeAttribute('aria-busy');expect(updateIsBusy()).toBe(false)
})
