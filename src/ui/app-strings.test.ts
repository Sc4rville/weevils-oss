// Startup and upload messages: no raw HTTP status, no internal « bands » vocabulary in weevboss's greeting.
import { afterEach, expect, it } from 'vitest'
import { setLang, tr } from '../i18n'
import A from '../i18n/app'
afterEach(() => setLang(null))
it('a failed upload says to try again, never the HTTP status; the greeting has no permanent help', () => {
  for (const lang of ['en', 'fr'] as const) {
    setLang(lang)
    expect(tr(A).failed(502)).not.toMatch(/502/)
    expect(tr(A).hello).not.toMatch(/bands|bandes/)
  }
  setLang('en')
  expect(tr(A).failed(502)).toBe('that didn’t go through, try again')
})
