// Language of what weevilsd writes itself: agent prompts (weevboss, titles, classification), push notifications,
// API errors. It follows the app (POST /api/prefs, stored in prefs.json), otherwise WEEVILS_LANG, otherwise the
// system locale, otherwise English. Catalogs: server/i18n/<area>.ts with defineMessages(); read them with tr(M)
// at call time so a language change applies at once.

import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR, USER_NAME } from './config.ts'
import C from './i18n/config.ts'
import { isLang, pickLang, type Lang, type Messages, type Msg } from '../shared/i18n.ts'

export { defineMessages, type Lang } from '../shared/i18n.ts'

const PREFS_FILE = path.join(DATA_DIR, 'prefs.json')

function readPrefs(): { lang?: string } {
  try {
    return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')) as { lang?: string }
  } catch {
    return {}
  }
}

const fromEnv = (): Lang => pickLang([process.env.WEEVILS_LANG ?? '', process.env.LC_ALL ?? '', process.env.LANG ?? ''].filter(Boolean))

let current: Lang = (() => {
  const p = readPrefs().lang
  return isLang(p) ? p : fromEnv()
})()
const listeners = new Set<(l: Lang) => void>()

export const lang = (): Lang => current

/** Called when the app changes language. Returns true when it changed. */
export function setLang(l: unknown): boolean {
  if (!isLang(l) || l === current) return false
  current = l
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(PREFS_FILE, JSON.stringify({ ...readPrefs(), lang: l }))
  } catch {
    /* kept in memory */
  }
  for (const f of listeners) f(l)
  return true
}

/** Runs when the language changes (e.g. re-render the orchestrator's prompt). */
export const onLangChange = (f: (l: Lang) => void) => listeners.add(f)

/** Runs fn (synchronous part only) with the catalogs in language l — for texts the app shows as-is (tip cards), which
 * follow the app's language even when the user never picked one (the browser's language is not saved server-side). */
export function withLang<T>(l: unknown, fn: () => T): T {
  if (!isLang(l) || l === current) return fn()
  const saved = current
  current = l
  try {
    return fn()
  } finally {
    current = saved
  }
}

/** Messages of a catalog in the user's language, read at call time. */
export function tr<T extends Record<string, Msg>>(m: Messages<T>): T {
  return m[current] as T
}

/** The user's name (WEEVILS_USER_NAME), else « l'utilisateur » / "the user" in the current language. Read at call time. */
export const user = (): string => USER_NAME || tr(C).theUser
