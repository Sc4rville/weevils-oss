// @vitest-environment happy-dom
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MotionGlobalConfig } from 'motion/react'
import { expect, it, vi } from 'vitest'
import { TranscriptStore } from '../server/transcripts'
import { Messages } from '../src/ui/bits'
vi.mock('../src/ui/app-context',()=>({useApp:()=>({snap:{config:{authors:[]},projects:[],machines:[]},push:vi.fn()})}))
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true})
const css=fs.readFileSync('src/styles.css','utf8').replace(/\/\*[\s\S]*?\*\//g,'')
const brief='Check the result and preserve the existing work.'
it.each(['light','dark','zen','graphite'])('preserves the same signed brief from Claude and Codex history through the %s session presentation',async theme=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boss-presentation-'))
 const claude=path.join(dir,'claude'),codex=path.join(dir,'codex'),now=Date.now(),d=new Date(now)
 const cf=path.join(claude,'project','aaaaaaaa-1111-4111-8111-111111111111.jsonl')
 const xf=path.join(codex,String(d.getFullYear()),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0'),'rollout-bbbbbbbb-2222-4222-8222-222222222222.jsonl')
 for(const f of [cf,xf])fs.mkdirSync(path.dirname(f),{recursive:true})
 fs.writeFileSync(cf,JSON.stringify({type:'user',uuid:'brief',timestamp:d.toISOString(),message:{role:'user',content:'[from:weevboss] '+brief}})+'\n')
 fs.writeFileSync(xf,JSON.stringify({type:'response_item',timestamp:d.toISOString(),payload:{type:'message',role:'user',content:[{type:'input_text',text:'[from:weevboss] '+brief}]}})+'\n')
 const host=document.createElement('div');host.className='session-thread';document.body.append(host)
 document.documentElement.dataset.theme=theme
 const root=createRoot(host);MotionGlobalConfig.skipAnimations=true
 try {
  for(let read=0;read<2;read++){
   const store=new TranscriptStore(claude,codex,86400000);store.scan(now)
   expect(store.all()).toHaveLength(2)
   for(const transcript of store.all()){
    expect(transcript.messages).toHaveLength(1)
    expect(transcript.messages[0]).toMatchObject({role:'orchestrator',author:'weevboss',text:brief})
    await act(async()=>root.render(<Messages session author={transcript.tool} messages={transcript.messages}/>))
    const bubble=host.querySelector('.msg.orch')!
    expect(bubble).not.toBeNull()
    expect(bubble.closest('details')).toBeNull()
    expect(bubble.querySelector('.who')?.textContent).toBe('weevboss')
    expect(bubble.textContent).toContain(brief)
    expect(bubble.textContent).not.toContain('[from:')
    // Check the session-specific cascade: continuous reading must not erase author colour again.
    const rules=[...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m=>m[1].includes('.session-thread') && m[1].trim().split(',').some(s=>{try{return bubble.matches(s.trim())}catch{return false}}))
    const backgrounds=rules.map(m=>m[2].match(/background:\s*([^;]+)/)?.[1]).filter(Boolean)
    expect(backgrounds.at(-1)).toContain('var(--who-c, var(--agent))')
    expect(rules.some(m=>m[2].includes('border-inline-start: 3px solid currentColor'))).toBe(true)
   }
  }
 }finally{await act(async()=>root.unmount());host.remove();delete document.documentElement.dataset.theme;MotionGlobalConfig.skipAnimations=false;fs.rmSync(dir,{recursive:true,force:true})}
})
