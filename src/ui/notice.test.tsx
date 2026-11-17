// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Notice } from './notice'
import { dismissNotice, isNoticeDismissed, resetNotices } from './notice-store'
let host: HTMLDivElement
let root: Root
beforeEach(() => { resetNotices(); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks() })
it('a labeled close button hides only this event, survives a fresh mount, and never opens the underlying action', async () => {
  const open = vi.fn()
  const render = (id: string, text: string) => act(async () => root.render(<div onClick={open}><Notice eventId={id} role="alert">{text}</Notice></div>))
  await render('quota:one', '98%')
  const close = host.querySelector<HTMLButtonElement>('button')!
  expect(close.getAttribute('aria-label')).toMatch(/notification/)
  expect(close.type).toBe('button')
  await act(async () => close.click())
  expect(open).not.toHaveBeenCalled()
  expect(host.querySelector('[role="alert"]')).toBeNull()
  await render('quota:one', '100%, reconnect')
  expect(host.querySelector('[role="alert"]')).toBeNull()
  await act(async () => root.unmount())
  root = createRoot(host)
  await render('quota:one', 'after refresh')
  expect(host.querySelector('[role="alert"]')).toBeNull()
  await render('quota:two', 'new window')
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('new window')
})
it('a dismissal received from another window removes the same visible event', async () => {
  await act(async () => root.render(<Notice eventId="other-tab">question</Notice>))
  await act(async () => {
    localStorage.setItem('weevils-dismissed-notices-v1', JSON.stringify(['other-tab']))
    window.dispatchEvent(new StorageEvent('storage', { key: 'weevils-dismissed-notices-v1' }))
  })
  expect(host.textContent).toBe('')
})
it('storage write failure still closes this event in memory', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full') })
  dismissNotice('offline')
  expect(isNoticeDismissed('offline')).toBe(true)
})
