import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DATA_DIR } from './config.ts'
import { lang, setLang, tr, withLang } from './i18n.ts'
import M from './i18n/tips.ts'
import S from './i18n/setup.ts'

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

describe('the user language (prefs.json) is stable', () => {
  // HOME is a throwaway dir (test/setup-env.ts): prefs.json is written there, never in the developer's data.
  const file = path.join(DATA_DIR, 'prefs.json')
  const saved = () => JSON.parse(fs.readFileSync(file, 'utf8')) as { lang: string; from: string }

  it("takes the first app's browser language, then ignores other browsers: weevboss keeps speaking French", () => {
    fs.rmSync(file, { force: true })
    expect(lang()).toBe('en') // WEEVILS_LANG of the tests
    expect(setLang('fr')).toBe(true)
    expect(lang()).toBe('fr')
    expect(saved()).toEqual({ lang: 'fr', from: 'browser' })
    // A test browser, an old app or a borrowed phone in English.
    expect(setLang('en')).toBe(false)
    expect(lang()).toBe('fr')
    expect(tr(S).mailAsk).toBe(S.fr.mailAsk)
    expect(tr(S).mailPitch).not.toMatch(/Plug in the e-mail bridge/)
  })

  it('changes only for a language picked in the settings', () => {
    expect(setLang('en', true)).toBe(true)
    expect(lang()).toBe('en')
    expect(setLang('fr')).toBe(false)
    expect(lang()).toBe('en')
    expect(saved()).toEqual({ lang: 'en', from: 'choice' })
    expect(setLang('fr', true)).toBe(true)
    expect(saved()).toEqual({ lang: 'fr', from: 'choice' })
  })

  it('a file written before (no « from », switched by a stray tap) gives way to the next app that opens', () => {
    fs.writeFileSync(file, JSON.stringify({ lang: 'en' }))
    expect(setLang('fr')).toBe(false) // already French in memory, but the file is fixed
    expect(saved()).toEqual({ lang: 'fr', from: 'browser' })
    expect(setLang('en')).toBe(false)
    expect(lang()).toBe('fr')
  })
})
