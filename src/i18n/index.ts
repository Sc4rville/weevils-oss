// App language: chosen in the settings (stored on the device), otherwise the browser's language.
// Components: `const t = useT(M)` (re-renders when the language changes). Plain functions: `tr(M)`.

import { useSyncExternalStore } from 'react'
import { isLang, locale, pickLang, type Lang, type Messages, type Msg } from '../../shared/i18n.ts'

export { defineMessages, LANGS, LANG_NAMES, type Lang } from '../../shared/i18n.ts'

const KEY = 'weevils-lang'

function stored(): Lang | null {
  try {
    const v = localStorage.getItem(KEY)
    return isLang(v) ? v : null
  } catch {
    return null
  }
}

const browserLang = (): Lang => pickLang(typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language])

let current: Lang = stored() ?? browserLang()
const listeners = new Set<() => void>()

function apply() {
  if (typeof document !== 'undefined') document.documentElement.lang = current
}
apply()

export const getLang = (): Lang => current
/** True when the user picked a language; false while the app follows the browser. */
export const langIsChosen = (): boolean => stored() !== null

/** Changes the language (null: follow the browser again). Tells weevilsd so its agents and notifications follow. */
export function setLang(lang: Lang | null) {
  try {
    if (lang) localStorage.setItem(KEY, lang)
    else localStorage.removeItem(KEY)
  } catch {
    /* storage unavailable */
  }
  current = lang ?? browserLang()
  apply()
  syncServer()
  for (const l of listeners) l()
}

/** weevilsd keeps the user's language for what it writes itself (agent prompts, push notifications, errors). */
export function syncServer() {
  void fetch('/api/prefs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ lang: current }),
    credentials: 'same-origin',
  }).catch(() => undefined)
}

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
