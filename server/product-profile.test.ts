import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { TIPS } from './setup.ts'

describe('shipped product profile', () => {
  it('does not advertise an unprovided delegation workflow', () => {
    expect(TIPS.some(([id]) => id === 'ultracode')).toBe(false)
    for (const lang of ['en', 'fr']) {
      const prompt = readFileSync(new URL(`./orchestrator.${lang}.md`, import.meta.url), 'utf8')
      expect(prompt).toContain('weevils')
      expect(prompt).toContain('v1')
      expect(prompt).not.toMatch(/session then runs a multi-agent workflow|session déploie alors un workflow/)
    }
  })
})
