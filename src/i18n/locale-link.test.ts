// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
afterEach(()=>{history.replaceState(null,'','/');localStorage.clear();vi.resetModules()})
it('an explicit English link persists on this device and preserves the recording route',async()=>{
 localStorage.setItem('weevils-language','fr')
 history.replaceState({keep:true},'', '/?appLocale=en#formats')
 vi.resetModules()
 const {getLang}=await import('./index')
 expect(getLang()).toBe('en')
 expect(localStorage.getItem('weevils-language')).toBe('en')
 expect(location.hash).toBe('#formats')
 expect(location.search).toBe('')
 expect(history.state).toEqual({keep:true})
})
it('ordinary entry keeps an explicit French preference',async()=>{
 localStorage.setItem('weevils-language','fr')
 vi.resetModules()
 const {getLang}=await import('./index')
 expect(getLang()).toBe('fr')
})
it("a device that picked nothing follows the installation's language in the page, never its browser",async()=>{
 const page=document.documentElement
 Object.defineProperty(navigator,'languages',{value:['fr-FR','fr'],configurable:true})
 Object.defineProperty(navigator,'language',{value:'fr-FR',configurable:true})
 try{
  delete page.dataset.installLang
  vi.resetModules()
  expect((await import('./index')).getLang()).toBe('en') // no language in the page: English, not the phone's French
  page.dataset.installLang='en' // installed in English (the get page's default)
  vi.resetModules()
  expect((await import('./index')).getLang()).toBe('en')
  page.dataset.installLang='fr' // installed in French (FR picked on the get page: --lang fr)
  vi.resetModules()
  const m=await import('./index')
  expect([m.getLang(),m.langIsChosen(),page.lang]).toEqual(['fr',false,'fr'])
  m.setLang('en')
  expect(m.getLang()).toBe('en')
  m.setLang(null)
  expect(m.getLang()).toBe('fr')
 }finally{
  delete page.dataset.installLang
  delete (navigator as unknown as Record<string,unknown>).languages
  delete (navigator as unknown as Record<string,unknown>).language
 }
})
