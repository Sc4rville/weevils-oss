// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { demoPage } from '../../server/demo.ts'

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
function boot() {
  const html = demoPage('fr-FR')
  document.body.innerHTML = html.replace(/<script>[\s\S]*?<\/script>/, '')
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]
  new Function(script)()
  return html
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren() })
describe('isolated demo', () => {
  it('runs the fictional request, result, memory and reset without any network call', () => {
    vi.useFakeTimers()
    const fetch = vi.fn(() => { throw new Error('demo must not call a server') })
    vi.stubGlobal('fetch', fetch)
    boot()
    expect(document.body.textContent).toContain('DÉMO — aucune IA appelée')
    el<HTMLTextAreaElement>('prompt').value = '<img src=x onerror=alert(1)>'
    el('request').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    expect(el('request-text').textContent).toBe('<img src=x onerror=alert(1)>')
    expect(el('request-text').querySelector('img')).toBeNull()
    vi.advanceTimersByTime(700)
    expect(el('choices').hidden).toBe(false)
    document.querySelector<HTMLButtonElement>('[data-style="bright"]')!.click()
    expect(el('result').hidden).toBe(false)
    el<HTMLInputElement>('note').value = 'A fictional note'
    el('notes').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    expect(el('note-list').textContent).toContain('A fictional note')
    el<HTMLInputElement>('memory-note').value = 'A fictional preference'
    el('memory').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    el('auto').click()
    expect(el('auto-result').textContent).toContain('fictive')
    el('reset').click()
    expect(el('result').hidden).toBe(true)
    expect(el('note-list').children).toHaveLength(0)
    expect(el('memory-saved').textContent).toBe('')
    expect(el('auto-result').textContent).toBe('')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('never claims a real provider login and only leaves the demo by an explicit link', () => {
    boot()
    document.querySelector<HTMLButtonElement>('[data-provider="Claude"]')!.click()
    expect(el('provider-status').textContent).toContain('Claude · connecté pour la démo uniquement')
    expect([...document.querySelectorAll('a')].every(a => a.getAttribute('href') === '/?real=1')).toBe(true)
    expect(demoPage('en-US')).toContain('DEMO — no AI requests')
    expect(demoPage('en-US')).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket|EventSource|localStorage|sessionStorage/)
  })
})
