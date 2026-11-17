// @vitest-environment happy-dom
// First-tap hints: once each, never during the intro, all seen at once for a device that knew weevils before them,
// and a device forgets the old server when the install id changes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Server = { seen: string[]; touched: boolean; install: string }
let server: Server
let posts: unknown[]

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  posts = []
  server = { seen: [], touched: false, install: 'A' }
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') posts.push(JSON.parse(String(init.body)))
    return new Response(JSON.stringify(server), { status: 200 })
  })
})
afterEach(() => vi.unstubAllGlobals())

const load = async () => {
  const m = await import('./hints')
  await m.loadHints()
  return m
}
const el = () => document.createElement('button')

describe('hints', () => {
  it('a newcomer: each hint once, after the intro', async () => {
    const m = await load()
    expect(posts).toEqual([{ seen: [] }])
    // The intro is not finished: the tap acts as usual, the hint waits.
    expect(m.tapHint('voice', el())).toBe(false)
    localStorage.setItem('weevils-onboarded', '1')
    expect(m.tapHint('voice', el())).toBe(true)
    expect(posts.at(-1)).toEqual({ seen: ['voice'] })
    expect(m.tapHint('voice', el())).toBe(false)
    expect(m.tapHint('star', el())).toBe(true)
  })

  it('hints the server already saw are not shown again, on any device', async () => {
    server = { seen: ['voice'], touched: true, install: 'A' }
    localStorage.setItem('weevils-onboarded', '1')
    const m = await load()
    expect(posts).toEqual([])
    expect(m.tapHint('voice', el())).toBe(false)
    expect(m.tapHint('star', el())).toBe(true)
  })

  it('a device that went through the intro before hints existed: all marked seen', async () => {
    localStorage.setItem('weevils-onboarded', '1')
    const m = await load()
    expect(posts).toEqual([{ seen: m.HINT_IDS }])
    for (const id of m.HINT_IDS) expect(m.tapHint(id, el())).toBe(false)
  })

  it('nothing before the server answered', async () => {
    localStorage.setItem('weevils-onboarded', '1')
    const m = await import('./hints')
    expect(m.tapHint('voice', el())).toBe(false)
  })

  it('a new install id: the device forgets the old server and reloads', async () => {
    localStorage.setItem('weevils-install', 'old')
    localStorage.setItem('weevils-onboarded', '1')
    localStorage.setItem('weevils-theme', 'dark')
    localStorage.setItem('other-app', 'kept')
    const reload = vi.fn()
    vi.stubGlobal('location', { ...window.location, reload })
    await load()
    expect(reload).toHaveBeenCalledOnce()
    expect(localStorage.getItem('weevils-install')).toBe('A')
    expect(localStorage.getItem('weevils-onboarded')).toBeNull()
    expect(localStorage.getItem('weevils-theme')).toBeNull()
    expect(localStorage.getItem('other-app')).toBe('kept')
  })
})
