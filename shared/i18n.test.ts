import { describe, expect, it } from 'vitest'
import { pickLang } from './i18n.ts'

describe('pickLang', () => {
  it('reads navigator.languages, Accept-Language and POSIX locales', () => {
    expect(pickLang(['fr-FR', 'en'])).toBe('fr')
    expect(pickLang(['de-DE', 'en-GB'])).toBe('en')
    expect(pickLang('fr-CA,fr;q=0.9,en;q=0.8')).toBe('fr')
    expect(pickLang('fr_FR.UTF-8')).toBe('fr')
    expect(pickLang(['de', 'ja'])).toBe('en')
    expect(pickLang(undefined)).toBe('en')
  })
})
