// i18n shared by the app and weevilsd. No dependency.
//
// Each area of the code owns a small catalog file (src/i18n/<area>.ts, server/i18n/<area>.ts) built with
// defineMessages(): French and English side by side, same keys, same signatures (checked by TypeScript).
// A value is either a string or a function for interpolation and plurals:
//
//   export default defineMessages({
//     fr: { title: 'Réglages', sessions: (n: number) => `${n} session${n > 1 ? 's' : ''}` },
//     en: { title: 'Settings', sessions: (n: number) => `${n} session${n === 1 ? '' : 's'}` },
//   })
//
// App: `const t = useT(M)` then `t.title`, `t.sessions(3)`. Server: `tr(M).title` (read at call time, never at module load).

export type Lang = 'en' | 'fr'
export const LANGS: readonly Lang[] = ['en', 'fr']
/** Name of each language in itself, for the language picker. */
export const LANG_NAMES: Record<Lang, string> = { en: 'English', fr: 'Français' }
export const DEFAULT_LANG: Lang = 'en'

export const isLang = (v: unknown): v is Lang => typeof v === 'string' && (LANGS as readonly string[]).includes(v)

/**
 * First supported language among preferences: navigator.languages, an Accept-Language header,
 * or a POSIX locale ("fr_FR.UTF-8"). Unknown → fallback (English).
 */
export function pickLang(prefs: readonly string[] | string | null | undefined, fallback: Lang = DEFAULT_LANG): Lang {
  const list = typeof prefs === 'string' ? prefs.split(',').map((p) => p.split(';')[0]) : (prefs ?? [])
  for (const p of list) {
    const base = p.trim().toLowerCase().split(/[-_.]/)[0]
    if (isLang(base)) return base
  }
  return fallback
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Msg = string | ((...args: any[]) => string)
type Same<T> = { [K in keyof T]: T[K] extends string ? string : T[K] }
export type Messages<T extends Record<string, Msg>> = { fr: T; en: Same<T> }

/** A catalog: French and English with exactly the same keys and signatures. */
export function defineMessages<T extends Record<string, Msg>>(m: Messages<T>): Messages<T> {
  return m
}

/** Locale tag for Intl (dates, numbers, relative times). */
export const locale = (lang: Lang) => (lang === 'fr' ? 'fr-FR' : 'en-US')
