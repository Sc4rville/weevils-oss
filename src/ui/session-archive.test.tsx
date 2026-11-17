// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Session } from '../../shared/api.ts'
import { setLang } from '../i18n'
import { Ctx } from './app-context'
import { SessionMenu, SessionArchiveAction } from './session-archive'
const net = vi.hoisted(() => ({ archive: vi.fn(async (_id: string, _archived: boolean) => ({ ok: true })), refresh: vi.fn() }))
vi.mock('../api', () => ({ api: { archive: net.archive } }))
let root: Root, host: HTMLDivElement
const s = { id: 's', title: 'work', tool: 'codex', status: 'working' } as Session
const render = async (node: React.ReactNode) => act(async () => root.render(<Ctx.Provider value={{ refresh: net.refresh } as never}>{node}</Ctx.Provider>))
beforeEach(() => { setLang('fr'); net.archive.mockReset(); net.archive.mockResolvedValue({ ok: true }); net.refresh.mockClear(); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove() })
it('discreet menu explicitly leaves active work running and allows restoration', async () => {
  await render(<SessionMenu session={s} />)
  expect(host.querySelector('summary')?.getAttribute('aria-label')).toContain('work')
  expect(host.textContent).toContain('Le travail continue')
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click())
  expect(net.archive.mock.calls).toEqual([['s', true]])
  expect(net.refresh).toHaveBeenCalledOnce()
  expect(host.querySelector('button')?.textContent).toContain('remettre')
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click())
  expect(net.archive.mock.calls).toEqual([['s', true], ['s', false]])
  expect(s.status).toBe('working')
})
it('failure keeps the archive action available and exposes the error for retry', async () => {
  net.archive.mockRejectedValueOnce(new Error('offline'))
  await render(<SessionArchiveAction session={s} />)
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click())
  expect(host.querySelector('[role=alert]')?.textContent).toBe('offline')
  expect(host.querySelector<HTMLButtonElement>('button')!.disabled).toBe(false)
  expect(net.refresh).not.toHaveBeenCalled()
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click())
  expect(net.refresh).toHaveBeenCalledOnce()
  expect(host.querySelector('[role=alert]')).toBeNull()
})
