import { describe, expect, it } from 'vitest'
import { lang, tr, withLang } from './i18n.ts'
import M from './i18n/tips.ts'

describe('withLang', () => {
  const other = lang() === 'fr' ? 'en' : 'fr'

  it('reads the catalogs in the given language, then restores the user language', () => {
    const before = lang()
    expect(withLang(other, () => tr(M).noDictation)).toBe(M[other].noDictation)
    expect(lang()).toBe(before)
    expect(tr(M).noDictation).toBe(M[before].noDictation)
  })

  it('ignores a missing or unknown language', () => {
    expect(withLang(null, () => lang())).toBe(lang())
    expect(withLang('de', () => lang())).toBe(lang())
  })

  it('covers the synchronous part of an async function', async () => {
    const before = lang()
    const p = withLang(other, async () => {
      const t = tr(M)
      await Promise.resolve()
      return t.noDictation
    })
    expect(lang()).toBe(before)
    expect(await p).toBe(M[other].noDictation)
  })
})
