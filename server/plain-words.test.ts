// User-visible server strings never send the user to a terminal or name keys (Esc, Enter, « answer 1 »).
import { expect, it } from 'vitest'
import CO from './i18n/core.ts'
import TI from './i18n/tips.ts'
import SE from './i18n/setup.ts'
import type { SetupState } from './setup.ts'

const NO = /terminal|écran|screen|\bEsc\b|Échap|Enter|Entrée|réponds 1|answer 1/i

it('session refusals and receipts speak plain words, in both languages', () => {
  for (const lang of ['en', 'fr'] as const) {
    const t = CO[lang]
    for (const s of [t.unmanaged, t.noScreen, t.escWouldClose, t.noConfirmation, t.hello]) expect(s).not.toMatch(NO)
    expect(TI[lang].idleUnmanaged(2, true)).not.toMatch(NO)
    expect(TI[lang].idleUnmanagedAsk(2, '- x')).not.toMatch(/terminal/i)
    const security = { security: { exposedHttp: false, https: true, safe: true } } as unknown as SetupState
    expect(SE[lang].securityAsk(security)).not.toMatch(/terminal/i)
    expect(SE[lang].phoneAsk({ reach: 'local' } as unknown as SetupState)).not.toMatch(/localhost/i)
  }
  // src/ui/outbox-status.tsx recognises the « read-only session » refusal by its opening words.
  expect(CO.en.unmanaged).toMatch(/^This session was opened elsewhere,/)
  expect(CO.fr.unmanaged).toMatch(/^Cette session a été ouverte ailleurs,/)
})
