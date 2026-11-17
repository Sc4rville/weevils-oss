// @vitest-environment happy-dom
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MotionGlobalConfig } from 'motion/react'
import { expect,it,vi } from 'vitest'
import { TranscriptStore } from '../server/transcripts.ts'
import { Messages } from '../src/ui/bits'
import { setLang } from '../src/i18n'
import recorded from './fixtures/codex-recorded-wrapper.json'
vi.mock('../src/ui/app-context',()=>({useApp:()=>({snap:{config:{authors:[]},projects:[],machines:[]},push:vi.fn()})}))
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true})
it('opens the actual recorded orchestration command and output through the normal transcript and Messages components',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'recorded-wrapper-'))
 const codex=path.join(dir,'codex');fs.mkdirSync(codex)
 const now=Date.now()
 const today=new Date(now)
 const day=path.join(codex,String(today.getFullYear()),String(today.getMonth()+1).padStart(2,'0'),String(today.getDate()).padStart(2,'0'));fs.mkdirSync(day,{recursive:true})
 const lines=[{type:'response_item',timestamp:new Date(now-3000).toISOString(),payload:{type:'message',role:'user',content:[{type:'input_text',text:'Check the repository'}]}},...recorded.map((r,i)=>({...r,timestamp:new Date(now-2000+i).toISOString()}))]
 fs.writeFileSync(path.join(day,'rollout-11111111-2222-4333-8444-555555555555.jsonl'),lines.map(l=>JSON.stringify(l)).join('\n')+'\n')
 const store=new TranscriptStore(path.join(dir,'claude'),codex,86400000)
 store.scan(now)
 const message=store.all()[0].messages.find(m=>m.role==='event')!
 // Same serializable Message contract returned by the session API.
 const apiMessage=JSON.parse(JSON.stringify(message))
 expect(apiMessage.toolDetails.commands).toEqual(['git status --short; git log -3 --oneline'])
 expect(apiMessage.toolDetails.summaryCommands).toEqual(['git status','git log'])
 expect(apiMessage.toolDetails.calls).toEqual([{name:'exec_command'}])
 expect(apiMessage.toolDetails.output).toContain(' M src/i18n/foryou-formats.ts')
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 try{
  setLang('en');MotionGlobalConfig.skipAnimations=true
  await act(async()=>root.render(<Messages session messages={[apiMessage]} author="codex"/>))
  expect(host.querySelector('.step-detail')).toBeNull()
  await act(async()=>host.querySelector<HTMLButtonElement>('.steps-head')!.click())
  const detail=host.querySelector<HTMLDetailsElement>('.step-detail')!
  expect(detail.open).toBe(false)
  await act(async()=>{detail.querySelector('summary')!.click()})
  expect(detail.open).toBe(true)
  expect(detail.querySelectorAll('pre')[0].textContent).toBe('git status --short; git log -3 --oneline')
  expect(detail.querySelectorAll('pre')[1].textContent).toBe(apiMessage.toolDetails.output)
 }finally{await act(async()=>root.unmount());host.remove();setLang(null);fs.rmSync(dir,{recursive:true,force:true})}
})
