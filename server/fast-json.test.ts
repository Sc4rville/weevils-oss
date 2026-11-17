import { expect, it } from 'vitest'
import { parseJson, ModelError } from './fast.ts'
it('extracts a complete payload around prose, fences, and another JSON block', () => {
  expect(parseJson('Note [FYI]. ```json\n{"items":[{"text":"a } and [ in a string"}]}\n```\n{"debug":true}')).toEqual({ items: [{ text: 'a } and [ in a string' }] })
})
it('repairs only trailing commas, without changing quoted punctuation', () => {
  expect(parseJson('{"items":[{"text":"keep ,} and ,]",},],}')).toEqual({ items: [{ text: 'keep ,} and ,]' }] })
})
it('never turns a truncated outer payload into a valid inner object', () => {
  expect(parseJson('{"items":[{"text":"partial"}')).toBe(null)
  expect(parseJson('{"items":[{"text":"unterminated')).toBe(null)
  expect(parseJson('No content available.')).toBe(null)
})
it('keeps provider quota, auth and disk failures distinct without logging prompts', () => {
  expect(new ModelError({ code: 1 }, 'You hit your usage limit').kind).toBe('quota')
  expect(new ModelError({ code: 1 }, 'Authentication required').kind).toBe('auth')
  const e = new ModelError({ code: 'EDQUOT', message: 'command contains private prompt' })
  expect(e.kind).toBe('io')
  expect(e.message).not.toContain('private prompt')
})
