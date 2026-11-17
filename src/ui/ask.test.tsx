// @vitest-environment happy-dom
// Le regard suit l'action : la barre de mots ouverte en bas de l'écran (ou sous le logo flottant) y est amenée d'un
// glissé ; la ligne touchée reste à sa place quand la barre change de ligne (anchorRow).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({ api: {} }))
vi.mock('./voice', () => ({ VoiceLogo: () => null }))

const { AskPanel } = await import('./ask')
const { anchorRow } = await import('./textpick')
type Ask = import('./ask').Ask

const ask = (over: Partial<Ask> = {}): Ask =>
  ({
    answer: null,
    asking: false,
    draft: '',
    setDraft: () => {},
    setAsking: () => {},
    ask: async () => {},
    submit: () => {},
    open: () => {},
    reset: () => {},
    voiceText: () => {},
    voiceSend: () => {},
    shown: undefined,
    waiting: false,
    replyKey: undefined,
    ...over,
  }) as Ask

let root: Root
let host: HTMLElement
const frame = () => act(() => new Promise((r) => setTimeout(r, 40)))
const rect = (top: number, h: number) => ({ top, bottom: top + h, left: 0, right: 300, width: 300, height: h, x: 0, y: top, toJSON: () => ({}) }) as DOMRect

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

describe('AskPanel : ce qui s’ouvre vient sous les yeux', () => {
  it('une barre ouverte sous le bas de l’écran y est amenée, sans mise en avant', async () => {
    const into = vi.fn()
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(into)
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return this.classList.contains('qa') ? rect(window.innerHeight - 20, 60) : rect(0, 0)
    })
    act(() => root.render(<AskPanel a={ask()} text="useFollow" onHit={() => {}} />))
    await frame()
    expect(into).toHaveBeenCalledWith(expect.objectContaining({ block: 'nearest' }))
    expect(host.querySelector('.qa')!.classList.contains('wv-flash')).toBe(false)
  })

  it('déjà visible : rien ne bouge ; pendant un glissé : rien non plus', async () => {
    const into = vi.fn()
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(into)
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => rect(100, 60))
    act(() => root.render(<AskPanel a={ask()} text="x" onHit={() => {}} />))
    await frame()
    act(() => root.render(<AskPanel a={ask()} text="x" held onHit={() => {}} />))
    await frame()
    expect(into).not.toHaveBeenCalled()
  })
})

describe('anchorRow : la ligne touchée garde sa place', () => {
  it('recale la fenêtre de ce dont la ligne a bougé', () => {
    const row = document.createElement('div')
    document.body.appendChild(row)
    let top = 500
    vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => rect(top, 20))
    const by = vi.spyOn(window, 'scrollBy').mockImplementation(() => {})
    const fix = anchorRow(row)
    top = 180 // la réponse au-dessus s'est refermée
    fix()
    expect(by).toHaveBeenCalledWith(0, -320)
    row.remove()
  })

  it('dans une page, c’est son corps qui défile, jamais la fenêtre (le flux caché dessous)', () => {
    const body = document.createElement('div')
    body.setAttribute('data-scroll', '')
    const row = document.createElement('div')
    body.appendChild(row)
    document.body.appendChild(body)
    let top = 300
    vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => rect(top, 20))
    const by = vi.spyOn(window, 'scrollBy').mockImplementation(() => {})
    const fix = anchorRow(row)
    top = 200
    fix()
    expect(by).not.toHaveBeenCalled()
    body.remove()
  })
})
