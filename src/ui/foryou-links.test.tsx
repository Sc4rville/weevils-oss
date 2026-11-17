// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { ForYouItem } from '../../shared/foryou'
const nav = vi.hoisted(() => ({ push: vi.fn(), conversation: vi.fn() }))
vi.mock('./app-context', () => ({ useApp: () => ({ push: nav.push }) }))
vi.mock('./foryou-open', () => ({ useForYouOpen: () => nav.conversation }))
import { FeedText, SoftwareResultLink } from './foryou-links'
import { setLang } from '../i18n'
const base: ForYouItem = { id: 'd:mwf42vcp', kind: 'boss', tone: 'neutral', at: 1, who: 'weevboss', text: 'It’s live at https://tlo.scarville.tech.', open: { page: 'boss' }, software: { id: 'vps:tlo', name: 'TLO', state: 'running', url: 'https://tlo.scarville.tech/' } }
it('both real-card shapes open the software; the conversation remains separate across languages', async () => {
 const host = document.createElement('div'), root = createRoot(host)
 document.body.append(host)
 try {
  for (const lang of ['en','fr','en'] as const) {
   await act(async () => { setLang(lang); root.render(<><FeedText text={base.text} item={base}/><SoftwareResultLink item={base}/></>) })
   const link=host.querySelector('a')!
   expect(link.href).toBe('https://tlo.scarville.tech/')
   await act(async () => { link.click() })
   expect(nav.push).toHaveBeenLastCalledWith({ kind: 'software', id: 'vps:tlo' })
   expect(host.querySelector('button')!.textContent).toBe(lang==='en'?'Open TLO':'Ouvrir TLO')
   await act(async () => { host.querySelector('button')!.click() })
   expect(nav.push).toHaveBeenLastCalledWith({ kind: 'software', id: 'vps:tlo' })
  }
  const result: ForYouItem = { ...base, id: 's:01a1c64d-6a79-78a3-b213-dbf5841b5d18', kind:'session', tone:'result', text:'It’s back online', open:{page:'session',id:'01a1c64d-6a79-78a3-b213-dbf5841b5d18'} }
  await act(async()=>root.render(<SoftwareResultLink item={result}/>))
  await act(async()=>host.querySelector('button')!.click())
  expect(nav.push).toHaveBeenLastCalledWith({kind:'software',id:'vps:tlo'})
  await act(async()=>host.querySelectorAll('button')[1].click())
  expect(nav.conversation).toHaveBeenLastCalledWith(result.open,undefined)
  await act(async()=>root.render(<SoftwareResultLink item={{...result,software:{...result.software!,state:'unavailable',url:undefined}}}/>))
  expect(host.querySelector('[role=status]')?.textContent).toContain('unavailable')
  expect(host.querySelectorAll('button')).toHaveLength(1)
 } finally { await act(async()=>root.unmount()); host.remove() }
})
it('only safe public URLs become links and arbitrary text remains escaped',async()=>{
 const host=document.createElement('div'),root=createRoot(host)
 try {
  await act(async()=>root.render(<FeedText text={'<img src=x> https://example.com/path. http://localhost:4179 https://example.com/?token=secret javascript:alert(1)'}/>))
  expect(host.querySelectorAll('a')).toHaveLength(1)
  expect(host.querySelector('a')?.getAttribute('target')).toBe('_blank')
  expect(host.querySelector('img')).toBeNull()
 } finally { await act(async()=>root.unmount()) }
})
