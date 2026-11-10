// @vitest-environment happy-dom
// La langue de l'app reste celle de l'utilisateur : un navigateur en français donne une app en français, même avec un
// ancien choix « en » laissé par la ligne qui changeait de langue d'un seul tap (bande du bas, 2026-11-10) ; et un tap
// égaré sur la ligne « langue » ne la change plus : il ouvre le choix, seule une langue tapée la change.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./tour', () => ({ TourLine: () => null }))
vi.mock('./tips', () => ({ TipsLine: () => null }))

Object.defineProperty(navigator, 'languages', { value: ['fr-FR', 'fr'], configurable: true })
Object.defineProperty(navigator, 'language', { value: 'fr-FR', configurable: true })
// L'ancienne clé, telle que l'a laissée le tap égaré.
localStorage.setItem('weevils-lang', 'en')
const posted: unknown[] = []
globalThis.fetch = (async (_u: string, init?: RequestInit) => {
  posted.push(JSON.parse(String(init?.body ?? '{}')))
  return new Response('{}')
}) as typeof fetch

const { getLang, langIsChosen, setLang, tr } = await import('../i18n')
const { PrefLines, LanguageButton } = await import('./prefs')
const { default: B } = await import('../i18n/bands')
const { default: S } = await import('../i18n/setup')
const { default: H } = await import('../i18n/h24')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let el: HTMLElement
beforeEach(() => {
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
  posted.length = 0
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})

const rows = () => [...el.querySelectorAll('button.row')] as HTMLButtonElement[]
const tap = (b: HTMLElement) => act(() => b.dispatchEvent(new MouseEvent('click', { bubbles: true })))

describe("la langue de l'utilisateur", () => {
  it("un navigateur en français : l'interface sort en français, jamais en anglais", () => {
    expect(localStorage.getItem('weevils-lang')).toBeNull()
    expect(getLang()).toBe('fr')
    expect(langIsChosen()).toBe(false)
    expect(document.documentElement.lang).toBe('fr')
    // Les textes de la capture du 10 novembre (bande des projets, 24/7, pont e-mail).
    expect(tr(B).nothingRunning).toBe('rien ne tourne')
    expect(tr(H).nothing).not.toMatch(/nothing running/)
    expect(tr(S).chip_mail).toBe('brancher le pont e-mail')
    expect(tr(S).q_mail_gmail).toBe('ton adresse Gmail')
    // This device never changes the shared server's language.
    expect(posted).toEqual([])
  })

  it('un tap sur la ligne « langue » ouvre le choix sans rien changer', () => {
    act(() => root.render(<PrefLines />))
    expect(rows()[0].textContent).toContain('langue · Français')
    expect(rows()[0].textContent).toContain('comme le navigateur')
    tap(rows()[0])
    expect(getLang()).toBe('fr')
    expect(posted).toEqual([])
    expect(rows().map((r) => r.textContent)).toEqual(['langue · Françaiscomme le navigateur', 'comme le navigateur (Français)', 'English', 'Français'])
    // Un second tap sur la ligne la referme, toujours en français.
    tap(rows()[0])
    expect(rows()).toHaveLength(1)
    expect(getLang()).toBe('fr')
  })

  it('seule une langue tapée la change localement sans requête au serveur ; « comme le navigateur » revient au français', () => {
    act(() => root.render(<PrefLines />))
    tap(rows()[0])
    tap(rows().find((r) => r.textContent === 'English')!)
    expect(getLang()).toBe('en')
    expect(langIsChosen()).toBe(true)
    expect(posted).toEqual([])
    expect(localStorage.getItem('weevils-language')).toBe('en')
    tap(rows()[0])
    tap(rows().find((r) => r.textContent?.startsWith('same as the browser ('))!)
    expect(getLang()).toBe('fr')
    expect(langIsChosen()).toBe(false)
    expect(posted).toEqual([])
    expect(localStorage.getItem('weevils-language')).toBeNull()
    setLang(null)
  })
})


describe('bottom language button', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
    HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new Event('close')) }
    setLang(null)
  })
  it('opens the real supported choices without switching; choosing is immediate, local and persistent', async () => {
    await act(async () => root.render(<LanguageButton />))
    const trigger = el.querySelector<HTMLButtonElement>('.language-trigger')!
    expect(trigger.textContent).toBe('Français')
    await act(async () => trigger.click())
    expect(el.querySelector('dialog')?.hasAttribute('open')).toBe(true)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const options = [...el.querySelectorAll<HTMLButtonElement>('.language-options button')]
    expect(options.map(b => b.textContent)).toEqual(['comme le navigateur (Français)', 'English', 'Français'])
    expect(getLang()).toBe('fr')
    expect(document.activeElement?.getAttribute('aria-pressed')).toBe('true')
    await act(async () => options[1].click())
    expect(trigger.textContent).toBe('English')
    expect(getLang()).toBe('en')
    expect(document.documentElement.lang).toBe('en')
    expect(localStorage.getItem('weevils-language')).toBe('en')
    expect(el.querySelector('dialog')?.hasAttribute('open')).toBe(false)
    expect(posted).toEqual([])
    await act(async () => root.render(<LanguageButton key="remount" />))
    expect(el.querySelector('.language-trigger')?.textContent).toBe('English')
  })
  it('closing preserves the current language; another tab follows only this device storage', async () => {
    await act(async () => root.render(<LanguageButton />))
    await act(async () => el.querySelector<HTMLButtonElement>('.language-trigger')!.click())
    await act(async () => el.querySelector<HTMLButtonElement>('.language-dialog-head button')!.click())
    expect(getLang()).toBe('fr')
    await act(async () => {
      localStorage.setItem('weevils-language', 'en')
      window.dispatchEvent(new StorageEvent('storage', { key: 'weevils-language', newValue: 'en' }))
    })
    expect(el.querySelector('.language-trigger')?.textContent).toBe('English')
    expect(posted).toEqual([])
  })
})
