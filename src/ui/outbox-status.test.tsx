// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { setLang } from '../i18n'
const state = vi.hoisted(() => ({ rows: [] as any[], copied: vi.fn(async () => true), push: vi.fn(), retry: vi.fn(async () => undefined) }))
vi.mock('../outbox', () => ({ useOutbox: () => state.rows, forgetReceipt: vi.fn(), retryReceipt: state.retry }))
vi.mock('./copy', () => ({ copyText: state.copied }))
vi.mock('./app-context', () => ({ useApp: () => ({ push: state.push }) }))
import { OutboxStatus } from './outbox-status'
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let host: HTMLDivElement, root: Root
beforeEach(() => { setLang('en'); host = document.createElement('div'); document.body.append(host); root = createRoot(host); state.rows = []; state.copied.mockClear(); state.push.mockClear(); state.retry.mockClear() })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); setLang(null) })
it('distinguishes acceptance from delivery and scopes the notice to the current conversation', async () => {
 state.rows = [{messageId:'a',url:'/api/main',status:'accepted'}, {messageId:'b',url:'/api/sessions/other/send',status:'delivered'}]
 await act(async () => root.render(<OutboxStatus scope="/api/main" />))
 expect(host.textContent).toContain('received'); expect(host.textContent).not.toMatch(/sending…|forwarded to the agent/)
 state.rows = [{...state.rows[0],status:'delivered',result:{id:'target'}}]
 await act(async () => root.render(<OutboxStatus scope="/api/main" />))
 expect(host.textContent).toBe('')
 expect(host.querySelector('button')).toBeNull()
})
it('an uncertain receipt offers recovery, never a button that reinjects the message', async () => {
 state.rows = [{messageId:'a',url:'/api/main',status:'uncertain',text:'original draft'}]
 await act(async () => root.render(<OutboxStatus scope="/api/main" />))
 expect(host.textContent).toContain('not sure it arrived')
 const buttons = host.querySelectorAll('button'); expect(buttons).toHaveLength(2)
 await act(async () => buttons[0].click()); expect(state.copied).toHaveBeenCalledWith('original draft')
})

it('contextual delivery hides completed and older-event receipts without forgetting their identity',async()=>{
 state.rows=[{messageId:'old',url:'/api/foryou/a/act',status:'accepted',eventId:'previous'}, {messageId:'current',url:'/api/foryou/a/act',status:'accepted',eventId:'current'}, {messageId:'elsewhere',url:'/api/foryou/b/reply',status:'uncertain'}]
 await act(async()=>root.render(<OutboxStatus scope="/api/foryou/a/" eventId="current"/>))
 expect(host.querySelectorAll('[data-delivery]')).toHaveLength(1)
 expect(host.textContent).toContain('received')
 state.rows[1]={...state.rows[1],status:'delivered',result:{id:'target'}}
 await act(async()=>root.render(<OutboxStatus scope="/api/foryou/a/" eventId="current"/>))
 expect(host.textContent).toBe('')
 expect(state.rows).toHaveLength(3)
})
it.each(['/api/main','/api/foryou/card/reply','/api/sessions/tlo/send'])('never renders a delivered success block in %s, but keeps a recoverable failure',async scope=>{
 state.rows=[{messageId:'done',url:scope,status:'delivered',result:{id:'tlo'}}]
 await act(async()=>root.render(<OutboxStatus scope={scope}/>))
 expect(host.querySelector('.outbox-status')).toBeNull()
 state.rows.push({messageId:'failed',url:scope,status:'failed',text:'Original message',error:'Not connected'})
 await act(async()=>root.render(<OutboxStatus scope={scope}/>))
 expect(host.textContent).toContain('Not connected')
 expect(host.textContent).not.toMatch(/forwarded to the agent|open conversation|dismiss this status/)
 expect([...host.querySelectorAll('button')].map(b=>b.textContent)).toEqual(['try again','copy the text','close this notice'])
})

it('a confirmed retry of the exact payload hides the old failure, but a different message does not', async()=>{
 state.rows=[{messageId:'old',url:'/api/main',fingerprint:'same',status:'failed',updatedAt:1,text:'Original message'}, {messageId:'new',url:'/api/main',fingerprint:'different',status:'delivered',updatedAt:2}]
 await act(async()=>root.render(<OutboxStatus scope="/api/main"/>))
 expect(host.querySelector('[data-delivery="failed"]')).not.toBeNull()
 expect(host.querySelector('details')?.open).toBe(false)
 state.rows[1].fingerprint='same'
 await act(async()=>root.render(<OutboxStatus scope="/api/main"/>))
 expect(host.textContent).toBe('')
 expect(state.rows).toHaveLength(2)
})

it('speaks plain words: "sending…" only until the server has it, then "received", "not sent", no tracking jargon', async () => {
 state.rows=[{messageId:'s',url:'/api/main',status:'sending'},{messageId:'a',url:'/api/main',status:'accepted'},{messageId:'d',url:'/api/main',status:'delivering'},{messageId:'f',url:'/api/main',status:'failed',text:'hello',trackingLost:true},{messageId:'w',url:'/api/main',status:'accepted',error:'Waiting for an available provider',retryAt:Date.now()+60_000}]
 await act(async()=>root.render(<OutboxStatus scope="/api/main"/>))
 expect([...host.querySelectorAll('summary')].map(s=>s.firstChild?.textContent)).toEqual(['sending…','received','received','not sent','received, waiting for its turn'])
 expect(host.textContent).not.toMatch(/forwarding|confirmation|tracking/)
 // Recovery stays: the text can still be copied back.
 expect([...host.querySelectorAll('button')].some(b=>b.textContent==='copy the text')).toBe(true)
})

it('a send the server never took reads "not sent yet" with "try again", never an endless "sending…"', async () => {
 state.rows=[{messageId:'lost',url:'/api/sessions/s/send',status:'sending',trackingLost:true,text:'hello'}]
 await act(async()=>root.render(<OutboxStatus scope="/api/sessions/s/"/>))
 expect(host.querySelector('summary')?.firstChild?.textContent).toBe('not sent yet')
 expect(host.textContent).not.toContain('sending…')
 const retry=[...host.querySelectorAll('button')].find(b=>b.textContent==='try again')!
 await act(async()=>retry.click())
 expect(state.retry).toHaveBeenCalledWith('lost')
 // Gave up resuming by itself: the notice can also be closed.
 state.rows=[{...state.rows[0],stuck:true}]
 await act(async()=>root.render(<OutboxStatus scope="/api/sessions/s/"/>))
 expect([...host.querySelectorAll('button')].map(b=>b.textContent)).toEqual(['try again','copy the text','close this notice'])
})
it('an uncertain or still-sending message never offers "try again"', async () => {
 state.rows=[{messageId:'u',url:'/api/main',status:'uncertain',text:'a'},{messageId:'s',url:'/api/main',status:'sending',text:'b'}]
 await act(async()=>root.render(<OutboxStatus scope="/api/main"/>))
 expect(host.textContent).not.toContain('try again')
})
