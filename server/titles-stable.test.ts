import { expect, it } from 'vitest'
import { stableTitle } from './titles.ts'
it('keeps the subject through work steps and changes it only for an explicit new topic', () => {
  expect(stableTitle('Le feed pour toi', 'Déploie le tri')).toBe('Le feed pour toi')
  expect(stableTitle('Le feed pour toi', 'Apparence et réglages', true)).toBe('Apparence et réglages')
  expect(stableTitle(undefined, 'Version open source')).toBe('Version open source')
})
