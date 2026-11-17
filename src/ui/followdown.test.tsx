// @vitest-environment happy-dom
// « Du nouveau en bas » : visible seulement quand quelque chose est arrivé sous l'écran ; un tap redescend (toEnd).
// Et une erreur d'action s'affiche au-dessus de la saisie (FootError), pas en haut du fil.
import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// happy-dom rejette chaque animation native annulée (AbortError non rattrapé) : motion repasse alors par ses animations JS.
for (let p: object | null = HTMLElement.prototype; p; p = Object.getPrototypeOf(p)) if (Object.hasOwn(p, 'animate')) delete (p as { animate?: unknown }).animate

const { FollowDown, lastBand } = await import('./followdown')
const { FootError } = await import('./shell')

let root: Root
let host: HTMLElement

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('FollowDown', () => {
  it('caché tant que rien n’est arrivé en bas, puis un tap redescend', () => {
    const toEnd = vi.fn()
    const body = createRef<HTMLDivElement>()
    act(() => root.render(<FollowDown show={false} body={body} toEnd={toEnd} />))
    expect(host.querySelector('.follow-down')).toBeNull()
    act(() => root.render(<FollowDown show body={body} toEnd={toEnd} />))
    const b = host.querySelector<HTMLButtonElement>('.follow-down')!
    expect(b.getAttribute('aria-label')).toBeTruthy()
    expect(b.classList.contains('urgent')).toBe(false)
    act(() => b.click())
    expect(toEnd).toHaveBeenCalledOnce()
  })

  it('la session attend : un « ? » doux, plus de « ! »', () => {
    act(() => root.render(<FollowDown show urgent body={createRef()} toEnd={() => {}} />))
    const b = host.querySelector('.follow-down')!
    expect(b.classList.contains('urgent')).toBe(true)
    expect(b.textContent).not.toContain('!')
    expect(b.querySelector('svg')).toBeTruthy()
  })

  it('met en avant la question qui attend, sinon le dernier message (pas l’indicateur de travail)', () => {
    const body = document.createElement('div')
    body.innerHTML = '<div class="msg" id="a"></div><div class="msg" id="b"></div><div class="msg working" id="w"></div>'
    expect(lastBand(body)?.id).toBe('b')
    body.insertAdjacentHTML('afterbegin', '<div class="msg band tone ask" id="q"></div>')
    expect(lastBand(body)?.id).toBe('q')
  })
})

describe('FootError', () => {
  it('rien sans erreur ; l’erreur s’affiche en alerte', () => {
    act(() => root.render(<FootError text={null} />))
    expect(host.querySelector('[role="alert"]')).toBeNull()
    act(() => root.render(<FootError text="boom" />))
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('boom')
  })
})
