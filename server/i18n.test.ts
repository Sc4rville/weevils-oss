import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DATA_DIR } from './config.ts'
import { lang, requestLang, setLang, tr, withInstallLang, withLang } from './i18n.ts'
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

  it('keeps the caller locale unchanged while an async function runs', async () => {
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

describe('the installation language (prefs.json) changes only by choice', () => {
  // HOME is a throwaway dir (test/setup-env.ts): prefs.json is written there, never in the developer's data.
  const file = path.join(DATA_DIR, 'prefs.json')
  const saved = () => JSON.parse(fs.readFileSync(file, 'utf8')) as { lang: string; from: string }
  const fresh = async () => {
    vi.resetModules()
    return (await import('./i18n.ts')).installationLang()
  }

  it("never takes a browser's language: a weevils installed in English, opened on a French phone, stays English", () => {
    fs.rmSync(file, { force: true })
    expect(lang()).toBe('en') // WEEVILS_LANG of the tests
    expect(setLang('fr')).toBe(false)
    expect(lang()).toBe('en')
    expect(fs.existsSync(file)).toBe(false)
    expect(tr(S).mailAsk).toBe(S.en.mailAsk)
  })

  it('changes only for a language picked in the settings', () => {
    expect(setLang('fr', true)).toBe(true)
    expect(lang()).toBe('fr')
    expect(saved()).toEqual({ lang: 'fr', from: 'choice' })
    expect(setLang('en')).toBe(false) // a browser in English
    expect(lang()).toBe('fr')
    expect(setLang('en', true)).toBe(true)
    expect(lang()).toBe('en')
    expect(saved()).toEqual({ lang: 'en', from: 'choice' })
  })

  it("at start, a file a browser wrote (or an older one) gives way to the installer's language", async () => {
    for (const prefs of [{ lang: 'fr', from: 'browser' }, { lang: 'fr' }]) {
      fs.writeFileSync(file, JSON.stringify(prefs))
      expect(await fresh()).toBe('en')
    }
    fs.writeFileSync(file, JSON.stringify({ lang: 'fr', from: 'choice' }))
    expect(await fresh()).toBe('fr')
    fs.writeFileSync(file, JSON.stringify({ lang: 'en', from: 'choice' })) // back to this module's state
  })

  it("without WEEVILS_LANG, English: never the machine's locale", async () => {
    const env = { WEEVILS_LANG: process.env.WEEVILS_LANG, LANG: process.env.LANG, LC_ALL: process.env.LC_ALL }
    const kept = fs.readFileSync(file, 'utf8')
    try {
      fs.rmSync(file) // nothing picked in an app
      delete process.env.WEEVILS_LANG
      process.env.LANG = process.env.LC_ALL = 'fr_FR.UTF-8'
      expect(await fresh()).toBe('en')
      process.env.WEEVILS_LANG = 'fr' // --lang fr, or the get page in French
      expect(await fresh()).toBe('fr')
    } finally {
      for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v)
      fs.writeFileSync(file, kept)
    }
  })

  it("writes the installation's language in the app's page, for the devices that picked none", () => {
    expect(withInstallLang('<!doctype html>\n<html lang="en" data-theme="light">')).toBe('<!doctype html>\n<html data-install-lang="en" lang="en" data-theme="light">')
  })
})

it('isolates concurrent request locales across awaits without changing stored preferences',async()=>{
 const baseline=lang()
 const before=fs.existsSync(path.join(DATA_DIR,'prefs.json')) ? fs.readFileSync(path.join(DATA_DIR,'prefs.json'),'utf8') : ''
 const result=await Promise.all(['en','fr'].map(l=>withLang(l,async()=>{
  await new Promise(resolve=>setTimeout(resolve,l==='en'?10:1))
  return [lang(),tr(S).mailAsk]
 })))
 expect(result).toEqual([['en',S.en.mailAsk],['fr',S.fr.mailAsk]])
 expect(lang()).toBe(baseline)
 expect(fs.readFileSync(path.join(DATA_DIR,'prefs.json'),'utf8')).toBe(before)
})

it('uses only explicit app locale, with legacy query support and no browser/chat inference',()=>{
 expect(requestLang({headers:{'x-weevils-locale':'en','accept-language':'fr'},url:'/api/main?lang=fr'})).toBe('en')
 expect(requestLang({headers:{},url:'/api/foryou?lang=fr'})).toBe('fr')
 expect(withLang('en',()=>requestLang({headers:{'accept-language':'fr'},url:'/api/main?text=bonjour'}))).toBe('en')
})
