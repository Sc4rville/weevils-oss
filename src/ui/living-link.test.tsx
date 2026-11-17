// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
const nav = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('./app-context', () => ({ useApp: () => ({ push: nav.push }) }))
import { Rich } from './bits'
import { FeedText } from './foryou-links'

it('a page link is a living link in the thread and in For you, and opens the page in the app', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ pages: [{ slug: 'content', kind: 'library', title: 'Content library', path: '/p/library/content', updatedAt: 1 }] }))))
  const host = document.createElement('div'), root = createRoot(host)
  document.body.append(host)
  try {
    await act(async () => { root.render(<><Rich text={`See [this week's leads](http://${location.host}/p/opportunities/leads) and https://example.com/x`} /><FeedText text={`Library: http://${location.host}/p/library/content`} /></>) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const living = [...host.querySelectorAll('a.living')]
    expect(living.map((a) => [a.className, a.textContent])).toEqual([['living lk-opportunities', "this week's leads"], ['living lk-library', 'Content library']])
    expect(host.querySelector('a.url')?.getAttribute('href')).toBe('https://example.com/x')
    await act(async () => { (living[0] as HTMLAnchorElement).click() })
    expect(nav.push).toHaveBeenCalledWith({ kind: 'webpage', path: '/p/opportunities/leads', title: "this week's leads", pageKind: 'opportunities' })
  } finally {
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})
