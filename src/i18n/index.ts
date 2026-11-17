// App language: chosen in the settings (stored on the device), otherwise this installation's language, which the server
// writes in the page (the installer's --lang, the get page's language, or a pick in the settings), English without it.
// Never the browser's: an English weevils opened on a French phone stays English until someone picks French.
// Components: `const t = useT(M)` (re-renders when the language changes). Plain functions: `tr(M)`.

import { useSyncExternalStore } from 'react'
import { DEFAULT_LANG, isLang, locale, type Lang, type Messages, type Msg } from '../../shared/i18n.ts'

export { defineMessages, LANGS, LANG_NAMES, type Lang } from '../../shared/i18n.ts'

// The language picked in the settings. The old key was written by a language line that switched on a single tap: a
// stray tap left the app in the other language for good. Its value is not a choice anyone made on
// purpose, so it is dropped once and the app follows the installation's language until one is really picked.
const KEY = 'weevils-language'
const LEGACY_KEY = 'weevils-lang'

try {
  localStorage.removeItem(LEGACY_KEY)
} catch {
  /* storage unavailable */
}

function stored(): Lang | null {
  try {
    const v = localStorage.getItem(KEY)
    return isLang(v) ? v : null
  } catch {
    return null
  }
}

/** This installation's language (`data-install-lang`, written by the server in the page); English without it. */
export const installLang = (): Lang => {
  const v = typeof document === 'undefined' ? null : document.documentElement.dataset.installLang
  return isLang(v) ? v : DEFAULT_LANG
}

// A language link applies only to the device opening it. Preserve navigation/login hashes.
function linked(): Lang | null {
  if (typeof window === 'undefined') return null
  try {
    const url = new URL(window.location.href)
    const selected = url.searchParams.get('appLocale')
    if (!isLang(selected)) return null
    localStorage.setItem(KEY, selected)
    url.searchParams.delete('appLocale')
    history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`)
    return selected
  } catch { return null }
}

let current: Lang = linked() ?? stored() ?? installLang()
const listeners = new Set<() => void>()

function apply() {
  if (typeof document !== 'undefined') document.documentElement.lang = current
}
apply()

export const getLang = (): Lang => current
/** True when the user picked a language on this device; false while the app follows the installation's. */
export const langIsChosen = (): boolean => stored() !== null

/** Changes this device only (null: follow the installation's language); shared agent prompts are never rewritten. */
export function setLang(lang: Lang | null) {
  try {
    if (lang) localStorage.setItem(KEY, lang)
    else localStorage.removeItem(KEY)
  } catch {
    /* storage unavailable */
  }
  current = lang ?? installLang()
  apply()
  for (const l of listeners) l()
}

// Another tab of this device follows its stored preference; other browser profiles stay independent.
if (typeof window !== 'undefined') window.addEventListener('storage', (e) => {
  if (e.key !== KEY && e.key !== null) return
  current = stored() ?? installLang()
  apply()
  for (const listener of listeners) listener()
})

export const subscribeLang = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

export const useLang = (): Lang => useSyncExternalStore(subscribeLang, getLang, getLang)

/** Messages of a catalog in the current language; the component re-renders when the language changes. */
export function useT<T extends Record<string, Msg>>(m: Messages<T>): Messages<T>['fr'] {
  return m[useLang()] as T
}

/** Same as useT, outside components (read at call time). */
export function tr<T extends Record<string, Msg>>(m: Messages<T>): T {
  return m[current] as T
}

/** Intl locale of the current language. */
export const intlLocale = () => locale(current)

/** Explicit app locale; never infer interface language from chat content. */
export const localeHeaders = (lang: Lang = getLang()) => ({ 'X-Weevils-Locale': lang })
