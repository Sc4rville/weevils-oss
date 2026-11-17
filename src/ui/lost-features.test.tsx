// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { Snapshot } from '../../shared/api'
import { setLang } from '../i18n'
import { lostFeaturesKey, readThinkEnabled, setThinkEnabled } from './lost-features-store'
const state = vi.hoisted(() => ({ snap: null as unknown as Snapshot, push: vi.fn(), mounts: 0 }))
vi.mock('./app-context', () => ({ useApp: () => ({ snap: state.snap, push: state.push, colors: { __foot: 'p3' }, back: vi.fn(), theme: 'light' }) }))
vi.mock('./shell', () => ({ Shell: ({ children, title }: { children: React.ReactNode; title: string }) => <section><h1>{title}</h1>{children}</section> }))
vi.mock('./think', () => ({ ThinkPage: ({ enabled }: { enabled: boolean }) => {
  const [value] = useState(() => { state.mounts++; return 'Original board, images and undo history' })
  return <article data-active={enabled}>{value}</article>
} }))
import { LostFeaturesPage, ThinkGate } from './lost-features'
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root, host: HTMLDivElement
beforeEach(() => {
  localStorage.clear(); setLang('en'); state.push.mockClear(); state.mounts = 0
  state.snap = { machines: [{ id: 'personal-machine' }], setup: { welcomed: false } } as Snapshot
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); setLang(null); vi.restoreAllMocks() })
const render = async (page: React.ReactNode) => { await act(async () => root.render(page)) }
const toggle = async () => { await act(async () => host.querySelector<HTMLButtonElement>('[role=switch]')!.click()) }
it('starts a clean profile off', async () => {
  await render(<LostFeaturesPage />)
  expect(host.querySelector('h1')?.textContent).toBe('experiments')
  expect(host.querySelector('[role=switch]')?.getAttribute('aria-checked')).toBe('false')
  expect(host.textContent).not.toContain('Open Think')
  state.snap.setup!.welcomed = true
  await render(<LostFeaturesPage />)
  expect(readThinkEnabled('personal-machine')).toBe(false)
})
it('preserves existing enabled profiles, persists off across remount and keeps other installation preferences', async () => {
  state.snap.setup!.welcomed = true
  setThinkEnabled('another-machine', true)
  localStorage.setItem('think-camera', JSON.stringify({ x: 3, y: 5, zoom: 2 }))
  await render(<LostFeaturesPage />)
  expect(host.querySelector('[role=switch]')?.getAttribute('aria-checked')).toBe('true')
  await toggle()
  await act(async () => root.unmount()); root = createRoot(host)
  await render(<LostFeaturesPage />)
  expect(host.querySelector('[role=switch]')?.getAttribute('aria-checked')).toBe('false')
  expect(readThinkEnabled('another-machine')).toBe(true)
  expect(JSON.parse(localStorage.getItem('think-camera')!).zoom).toBe(2)
  await toggle()
  await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Open Think')!.click())
  expect(state.push).toHaveBeenCalledWith({ kind: 'think' })
})
it('blocks disabled deep links, pauses a mounted board across tabs, and resumes the same instance', async () => {
  await render(<ThinkGate />)
  expect(state.mounts).toBe(0)
  await toggle()
  expect(state.mounts).toBe(1)
  await act(async () => {
    localStorage.setItem(lostFeaturesKey('personal-machine'), JSON.stringify({ think: false }))
    window.dispatchEvent(new StorageEvent('storage', { key: lostFeaturesKey('personal-machine') }))
  })
  expect(host.querySelector('article')?.getAttribute('data-active')).toBe('false')
  expect(host.querySelector('article')?.closest('[hidden]')).not.toBeNull()
  expect(host.textContent).toContain('Original board, images and undo history')
  await toggle()
  expect(state.mounts).toBe(1)
  expect(host.querySelector('article')?.getAttribute('data-active')).toBe('true')
})
it('keeps state when the app language changes and reports a storage failure honestly', async () => {
  await render(<LostFeaturesPage />)
  await act(async () => setLang('fr'))
  expect(host.textContent).toContain('expériences')
  expect(host.textContent).toContain('Désactivé')
  const originalStorage = localStorage
  vi.stubGlobal('localStorage', { getItem: originalStorage.getItem.bind(originalStorage), setItem: () => { throw new Error('blocked') } })
  await toggle()
  expect(host.querySelector('[role=alert]')).not.toBeNull()
  expect(host.querySelector('[role=switch]')?.getAttribute('aria-checked')).toBe('false')
})

it('keeps a new machine scope off despite a legacy camera after the first scoped migration', async () => {
  state.snap.setup!.welcomed = true
  await render(<LostFeaturesPage />)
  expect(readThinkEnabled('personal-machine')).toBe(true)
  localStorage.setItem('think-camera', JSON.stringify({ x: 9, y: 8, zoom: 1 }))
  state.snap = { machines: [{ id: 'new-personal-machine' }], setup: { welcomed: false } } as Snapshot
  await render(<LostFeaturesPage />)
  expect(host.querySelector('[role=switch]')?.getAttribute('aria-checked')).toBe('false')
  expect(readThinkEnabled('personal-machine')).toBe(true)
})
