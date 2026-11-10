// App language: chosen in the settings (stored on the device), otherwise the browser's language.
// Components: `const t = useT(M)` (re-renders when the language changes). Plain functions: `tr(M)`.

import { useSyncExternalStore } from 'react'
import { isLang, locale, pickLang, type Lang, type Messages, type Msg } from '../../shared/i18n.ts'

export { defineMessages, LANGS, LANG_NAMES, type Lang } from '../../shared/i18n.ts'

// The language picked in the settings. The old key was written by a language line that switched on a single tap: a
// stray tap left the app in the other language for good. Its value is not a choice anyone made on
// purpose, so it is dropped once and the app follows the browser again until a language is really picked.
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

export const browserLang = (): Lang => pickLang(typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language])

let current: Lang = stored() ?? browserLang()
const listeners = new Set<() => void>()

function apply() {
  if (typeof document !== 'undefined') document.documentElement.lang = current
}
apply()

export const getLang = (): Lang => current
/** True when the user picked a language; false while the app follows the browser. */
export const langIsChosen = (): boolean => stored() !== null

/** Changes this device only (null: follow the browser); shared agent prompts are never rewritten. */
export function setLang(lang: Lang | null) {
  try {
    if (lang) localStorage.setItem(KEY, lang)
    else localStorage.removeItem(KEY)
  } catch {
    /* storage unavailable */
  }
  current = lang ?? browserLang()
  apply()
  for (const l of listeners) l()
}

// Another tab of this device follows its stored preference; other browser profiles stay independent.
if (typeof window !== 'undefined') window.addEventListener('storage', (e) => {
  if (e.key !== KEY && e.key !== null) return
  current = stored() ?? browserLang()
  apply()
  for (const listener of listeners) listener()
})

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

export const useLang = (): Lang => useSyncExternalStore(subscribe, getLang, getLang)

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
