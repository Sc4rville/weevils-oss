// @vitest-environment happy-dom
// Setup buttons and questions speak in plain words: no raw variable names (OPENAI_API_KEY), no « empty: root », no
// « siri address ». The same actions stay: the masked field opens, the Siri word still installs the Shortcut.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ shortcut: 0 }))
vi.mock('../api', () => ({
  api: {
    voices: async () => ({ voices: [{ id: 'v1', name: 'Ada' }], current: 'v1' }),
    shortcut: async () => (calls.shortcut++, { token: 't', url: '' }),
    setVoice: async () => ({}),
  },
}))

const { setLang, tr } = await import('../i18n')
const S = (await import('../i18n/setup')).default
const { KeyChip, SetupComposer, Chip } = await import('./setup')
const { VoicePicker } = await import('./voice')
const { chipLabel } = await import('./format')

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root, host: HTMLDivElement
beforeEach(() => {
  setLang('en')
  calls.shortcut = 0
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  setLang(null)
})
const render = async (node: React.ReactNode) => {
  await act(async () => root.render(node))
  await act(async () => new Promise((r) => setTimeout(r, 10)))
}

it('a requested secret is named by its brand, never by its variable, and still opens the masked field', async () => {
  await render(
    <>
      <KeyChip name="OPENAI_API_KEY" />
      <SetupComposer />
    </>,
  )
  const chip = host.querySelector('button')!
  expect(chip.textContent?.trim()).toBe('paste your OpenAI key')
  await act(async () => chip.click())
  const form = host.querySelector('form.setup-form')!
  expect(form.textContent).toContain('your OpenAI key')
  expect(host.textContent).not.toContain('OPENAI_API_KEY')
  expect(chipLabel('key:GITHUB_TOKEN')).toBe('paste your GitHub token')
  setLang('fr')
  expect(chipLabel('key:GITHUB_TOKEN')).toBe('colle ton jeton GitHub')
  expect(chipLabel('key:OPENAI_API_KEY')).toBe('colle ta clé OpenAI')
})

it('machine and domain questions say what leaving them empty means, without shorthand', () => {
  for (const lang of ['en', 'fr'] as const) {
    setLang(lang)
    const t = tr(S)
    for (const q of [t.q_machine_user, t.q_machine_password, t.q_reach_domain]) {
      expect(q).not.toMatch(/\((empty|vide) ?: root\)|my key|ma clé/)
    }
  }
})

it('the Siri buttons say « add to Siri » and still install the Shortcut', async () => {
  await render(<Chip brick="shortcut" />)
  expect(host.textContent).toContain('add to Siri')
  expect(host.textContent).not.toMatch(/address/)
  await render(<VoicePicker userName="" />)
  const word = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('add to Siri'))!
  expect(word).toBeTruthy()
  await act(async () => word.click())
  expect(calls.shortcut).toBe(1)
})
