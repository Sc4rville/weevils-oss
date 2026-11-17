// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Optimizer } from '../../shared/api'
import { setLang } from '../i18n'
import { useTalks, type Talks } from './auto-talk'
const api = vi.hoisted(() => ({ acceptOptimizer: vi.fn(async () => ({})), refuseOptimizer: vi.fn(async () => ({})) }))
vi.mock('../api', () => ({ api, ApiError: class extends Error {} }))
vi.mock('./app-context', () => ({ useApp: () => ({ refresh: () => {} }) }))
let current: Talks, root: Root, host: HTMLDivElement
function Probe({ items }: { items: Optimizer[] }) {
  current = useTalks(items)
  return <>{items.filter(o => !current.deleted.has(o.id) && !current.decided.has(o.id)).map(o => <p key={o.id}>{o.title}{o.talk?.map(line => line.text).join(' ')}</p>)}</>
}
const item = (extra: Partial<Optimizer> = {}): Optimizer => ({ id: 'original', title: 'Original draft', why: '', repo: null, kind: 'other', heavy: false, state: 'proposed', createdAt: 1, userCreated: true, talk: [{ who: 'user', text: 'Preserve this exchange', at: 2 }], ...extra })
const render = async (o: Optimizer) => { await act(async () => root.render(<Probe items={[o]} />)) }
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); localStorage.clear(); vi.clearAllMocks(); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); setLang(null) })
it('reconciles an old optimistic decline from the explicit recovered snapshot without a refused intermediate snapshot', async () => {
  const old = item()
  await render(old)
  await act(async () => { current.answer(old, false) })
  expect(current.decided.get(old.id)).toBe('no')
  await render(item({ draft: true }))
  expect(current.decided.get(old.id)).toBe('no')
  await render(item({ draft: true, recoveredAt: 100 }))
  expect(current.decided.has(old.id)).toBe(false)
  expect(host.textContent).toContain('Preserve this exchange')
  expect(api.refuseOptimizer).toHaveBeenCalledTimes(1)
  expect(api.acceptOptimizer).not.toHaveBeenCalled()
})
it('does not overwrite Delete, acceptance, or a later genuine decline with an old marker', async () => {
  const old = item({ recoveredAt: 100 })
  await render(old)
  await act(async () => { current.answer(old, false) })
  await render(item({ draft: true, recoveredAt: 100 }))
  expect(current.decided.get(old.id)).toBe('no')
  await act(async () => current.forget(old.id))
  await render(item({ draft: true, recoveredAt: 200 }))
  expect(current.deleted.has(old.id)).toBe(true)
  expect(current.decided.get(old.id)).toBe('no')
  expect(host.textContent).toBe('')
})
it('never accepts or refuses a draft from a new client', async () => {
  const draft = item({ draft: true })
  await render(draft)
  expect(current.answer(draft, false)).toBe(false)
  expect(current.answer(draft, true)).toBe(false)
  expect(api.refuseOptimizer).not.toHaveBeenCalled(); expect(api.acceptOptimizer).not.toHaveBeenCalled()
})
it('keeps a recovered original visible after reload, locale and theme changes', async () => {
  const recovered = item({ draft: true, recoveredAt: 100 })
  await render(recovered)
  for (const lang of ['en', 'fr'] as const) for (const theme of ['light', 'dark', 'zen', 'graphite']) {
    await act(async () => { setLang(lang); document.documentElement.dataset.theme = theme })
    await act(async () => root.unmount()); root = createRoot(host)
    await render(JSON.parse(JSON.stringify(recovered)))
    expect(host.textContent).toContain('Original draftPreserve this exchange')
    expect(current.deleted.size).toBe(0)
  }
  expect(api.refuseOptimizer).not.toHaveBeenCalled(); expect(api.acceptOptimizer).not.toHaveBeenCalled()
})
it('does not clear an optimistic acceptance from a restored snapshot', async () => {
  const proposal = item()
  await render(proposal)
  await act(async () => { current.answer(proposal, true) })
  await render(item({ draft: true, recoveredAt: 100 }))
  expect(current.decided.get(proposal.id)).toBe('yes')
  expect(api.acceptOptimizer).toHaveBeenCalledTimes(1)
})

it('locks a version while approval is pending, preventing a second approval or competing refusal',async()=>{
 const proposal=item({draft:false,rev:7})
 let finish!:(value:object)=>void
 api.acceptOptimizer.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}))
 await render(proposal)
 await act(async()=>{
  expect(current.answer(proposal,true)).toBe(true)
  expect(current.answer(proposal,true)).toBe(false)
  expect(current.answer(proposal,false)).toBe(false)
 })
 expect(current.busy.has(proposal.id)).toBe(true)
 expect(api.acceptOptimizer).toHaveBeenCalledTimes(1)
 expect(api.refuseOptimizer).not.toHaveBeenCalled()
 await act(async()=>finish({}))
 expect(current.busy.has(proposal.id)).toBe(false)
})

it('restores the unchanged proposal and exposes the error when approval fails',async()=>{
 const proposal=item({draft:false,rev:7})
 const before=structuredClone(proposal)
 api.acceptOptimizer.mockRejectedValueOnce(new Error('Connection unavailable'))
 await render(proposal)
 await act(async()=>{expect(current.answer(proposal,true)).toBe(true)})
 expect(current.busy.has(proposal.id)).toBe(false)
 expect(current.decided.has(proposal.id)).toBe(false)
 expect(current.notes.get(proposal.id)).toBe('Connection unavailable')
 expect(host.textContent).toContain('Preserve this exchange')
 expect(proposal).toEqual(before)
 expect(api.acceptOptimizer).toHaveBeenCalledTimes(1)
 expect(api.refuseOptimizer).not.toHaveBeenCalled()
})

it('blocks approval from fresh source policy even with an older visible proposal, preserving discussion and allowing refusal', async () => {
 const old = item({ rev: 3 })
 const restricted = item({ rev: 3, sourceAccess: { repo: 'source', machineId: 'm', canExecute: false, reason: 'not-owned' } })
 await render(restricted)
 await act(async () => { expect(current.answer(old, true)).toBe(false) })
 expect(api.acceptOptimizer).not.toHaveBeenCalled()
 expect(current.decided.size).toBe(0)
 expect(host.textContent).toContain('Preserve this exchange')
 await act(async () => { expect(current.answer(restricted, false)).toBe(true) })
 expect(api.refuseOptimizer).toHaveBeenCalledOnce()
})
