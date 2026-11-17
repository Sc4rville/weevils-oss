// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MotionGlobalConfig } from 'motion/react'
import { expect, it, vi } from 'vitest'
vi.mock('./app-context', async (original) => ({ ...await original<typeof import('./app-context')>(), useApp: () => ({ back: vi.fn(), theme: 'light' }) }))
import { Shell } from './shell'
MotionGlobalConfig.skipAnimations = true
it('keeps back navigation fixed while session title, metadata and all messages share the scroll container', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<Shell slot="agent" kicker="tlo" title="TLO — création du monde" meta="Long session context" scrollHeading foot={<input aria-label="message" />}><p>First complete message</p><p>Last complete message</p></Shell>))
    expect(host.querySelector('.page-head .back')).not.toBeNull()
    expect(host.querySelector('.page-head h1')).toBeNull()
    expect(host.querySelector('.page-body h1')?.textContent).toBe('TLO — création du monde')
    expect(host.querySelector('.page-body')?.textContent).toContain('First complete message')
    expect(host.querySelector('.page-body')?.textContent).toContain('Last complete message')
    expect(host.querySelector('.page-foot input')).not.toBeNull()
  } finally { await act(async () => root.unmount()); host.remove() }
})

it('keeps compact session controls and voice in the header without a dock covering the thread',async()=>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 const model=vi.fn(),voice=vi.fn()
 try{
  await act(async()=>root.render(<Shell slot="agent" kicker="tlo" title="A long complete session title" sessionLayout scrollHeading headerControls={<button onClick={model}>Model and reasoning</button>} dock={<div className="page-voice"><button className="voice-logo" onClick={voice}>Voice</button></div>} foot={<input aria-label="message"/>}><p>Last complete message</p></Shell>))
  expect(host.querySelector('.page-head .back')).not.toBeNull()
  expect(host.querySelector('.session-header-controls button')).not.toBeNull()
  expect(host.querySelectorAll('.voice-logo')).toHaveLength(1)
  expect(host.querySelector('.session-header-voice .voice-logo')).not.toBeNull()
  expect(host.querySelector('.page-dock')).toBeNull()
  expect(host.querySelector('.page-body')?.textContent).toContain('Last complete message')
  expect(host.querySelector('.page-foot input')).not.toBeNull()
  await act(async()=>{host.querySelector<HTMLButtonElement>('.session-header-controls button')!.click();host.querySelector<HTMLButtonElement>('.voice-logo')!.click()})
  expect(model).toHaveBeenCalledOnce();expect(voice).toHaveBeenCalledOnce()
 }finally{await act(async()=>root.unmount());host.remove()}
})
it('session header: the live note sits in the title row (header does not grow), the title stays the title', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<Shell slot="agent" kicker="weevils" title="weevils voice mode" sessionLayout scrollHeading liveNote={<span className="session-now" role="status">running the full check</span>}><p>msg</p></Shell>))
    const row = host.querySelector('.page-head .session-context-row')!
    expect(row.querySelector('.session-context')!.textContent).toBe('weevils voice mode')
    expect(row.querySelector('.session-now')!.textContent).toBe('running the full check')
    expect(host.querySelectorAll('.page-head .session-now')).toHaveLength(1)
  } finally {
    await act(async () => root.unmount()); host.remove()
  }
})
