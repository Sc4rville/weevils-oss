import { expect, it } from 'vitest'
import { stableTitle, TitleRetry } from './titles.ts'
it('keeps the subject through work steps and changes it only for an explicit new topic', () => {
  expect(stableTitle('Le feed pour toi', 'Déploie le tri')).toBe('Le feed pour toi')
  expect(stableTitle('Le feed pour toi', 'Apparence et réglages', true)).toBe('Apparence et réglages')
  expect(stableTitle(undefined, 'Version open source')).toBe('Version open source')
})

it('blocks repeated title attempts while transcripts keep arriving and resets after success', () => {
  const retry = new TitleRetry()
  expect(retry.ready(0)).toBe(true)
  retry.failed(0)
  for (let at = 8000; at < 300_000; at += 8000) expect(retry.ready(at)).toBe(false)
  expect(retry.ready(300_000)).toBe(true)
  retry.failed(300_000)
  expect(retry.ready(899_999)).toBe(false)
  expect(retry.ready(900_000)).toBe(true)
  retry.succeeded()
  retry.failed(900_000)
  expect(retry.ready(1_200_000)).toBe(true)
})
it('bounds title retry delay at one hour', () => {
  const retry = new TitleRetry()
  for (let i = 0; i < 20; i++) retry.failed(0)
  expect(retry.ready(3_599_999)).toBe(false)
  expect(retry.ready(3_600_000)).toBe(true)
})
