// @vitest-environment happy-dom
// La langue de l'app est celle de l'installation, que le serveur écrit dans la page (--lang de l'installeur, que la
// page get passe depuis sa propre langue), sinon l'anglais ; jamais celle du navigateur : un weevils installé en
// anglais, ouvert sur un téléphone en français, reste en anglais (retour de Yann, 2026-11-13). Un ancien choix laissé
// par la ligne qui changeait de langue d'un seul tap (bande du bas, 2026-11-10) est oublié ; un tap égaré sur la ligne
// « langue » ne la change pas : il ouvre le choix, seule une langue tapée la change, et sur cet appareil seulement.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./tips', () => ({ TipsLine: () => null }))

// Un téléphone en français, sur un weevils installé en anglais (la page get par défaut).
Object.defineProperty(navigator, 'languages', { value: ['fr-FR', 'fr'], configurable: true })
Object.defineProperty(navigator, 'language', { value: 'fr-FR', configurable: true })
document.documentElement.dataset.installLang = 'en'
// L'ancienne clé, telle que l'a laissée le tap égaré.
localStorage.setItem('weevils-lang', 'fr')
const posted: unknown[] = []
globalThis.fetch = (async (_u: string, init?: RequestInit) => {
  posted.push(JSON.parse(String(init?.body ?? '{}')))
  return new Response('{}')
}) as typeof fetch

const { getLang, langIsChosen, setLang, tr } = await import('../i18n')
const { PrefLines, LanguageButton } = await import('./prefs')
const { default: B } = await import('../i18n/bands')
const { default: S } = await import('../i18n/setup')

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

describe("la langue de l'app", () => {
  it("un téléphone en français sur un weevils installé en anglais : l'interface sort en anglais", () => {
    expect(localStorage.getItem('weevils-lang')).toBeNull()
    expect(getLang()).toBe('en')
    expect(langIsChosen()).toBe(false)
    expect(document.documentElement.lang).toBe('en')
    expect(tr(B).nothingRunning).toBe(B.en.nothingRunning)
    expect(tr(S).chip_mail).toBe(S.en.chip_mail)
    // This device never changes the shared server's language.
    expect(posted).toEqual([])
  })

  it('un tap sur la ligne « langue » ouvre le choix sans rien changer', () => {
    act(() => root.render(<PrefLines />))
    // No « default » / « chosen here » meta on the line: the open choices already show it with a ✓.
    expect(rows()[0].textContent).toBe('language · English')
    tap(rows()[0])
    expect(getLang()).toBe('en')
    expect(posted).toEqual([])
    expect(rows().map((r) => r.textContent)).toEqual(['language · English', 'default (English)', 'English', 'Français'])
    // Un second tap sur la ligne la referme, toujours en anglais.
    tap(rows()[0])
    expect(rows()).toHaveLength(1)
    expect(getLang()).toBe('en')
  })

  it("seule une langue tapée la change, sur cet appareil ; « par défaut » revient à celle de l'installation", () => {
    act(() => root.render(<PrefLines />))
    tap(rows()[0])
    tap(rows().find((r) => r.textContent === 'Français')!)
    expect(getLang()).toBe('fr')
    expect(langIsChosen()).toBe(true)
    expect(posted).toEqual([])
    expect(localStorage.getItem('weevils-language')).toBe('fr')
    tap(rows()[0])
    tap(rows().find((r) => r.textContent?.startsWith('par défaut ('))!)
    expect(getLang()).toBe('en')
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
    expect(trigger.textContent).toBe('English')
    await act(async () => trigger.click())
    expect(el.querySelector('dialog')?.hasAttribute('open')).toBe(true)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const options = [...el.querySelectorAll<HTMLButtonElement>('.language-options button')]
    expect(options.map(b => b.textContent)).toEqual(['default (English)', 'English', 'Français'])
    expect(getLang()).toBe('en')
    expect(document.activeElement?.getAttribute('aria-pressed')).toBe('true')
    await act(async () => options[2].click())
    expect(trigger.textContent).toBe('Français')
    expect(getLang()).toBe('fr')
    expect(document.documentElement.lang).toBe('fr')
    expect(localStorage.getItem('weevils-language')).toBe('fr')
    expect(el.querySelector('dialog')?.hasAttribute('open')).toBe(false)
    expect(posted).toEqual([])
    await act(async () => root.render(<LanguageButton key="remount" />))
    expect(el.querySelector('.language-trigger')?.textContent).toBe('Français')
  })
  it('closing preserves the current language; another tab follows only this device storage', async () => {
    await act(async () => root.render(<LanguageButton />))
    await act(async () => el.querySelector<HTMLButtonElement>('.language-trigger')!.click())
    await act(async () => el.querySelector<HTMLButtonElement>('.language-dialog-head button')!.click())
    expect(getLang()).toBe('en')
    await act(async () => {
      localStorage.setItem('weevils-language', 'fr')
      window.dispatchEvent(new StorageEvent('storage', { key: 'weevils-language', newValue: 'fr' }))
    })
    expect(el.querySelector('.language-trigger')?.textContent).toBe('Français')
    expect(posted).toEqual([])
  })
})
