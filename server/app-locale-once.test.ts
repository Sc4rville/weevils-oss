// The app-locale block rides on a session's first brief only, and never names a session.
import { describe, expect, it, vi } from 'vitest'
vi.mock('./voicepipe.ts', () => ({ keepWarm() {}, warmCues() {} }))
const { withAppLocale } = await import('./core.ts')
const { withLang } = await import('./i18n.ts')
const { titleOf, digestOf, realTitle, borrowedTitle } = await import('./transcripts.ts')

const BLOCK = ' ⟦weevils — Explicit app locale: English (en). Write UI labels, generated session and project titles…⟧'

describe('the app-locale block', () => {
  it('only on a first brief, never on a slash command, never twice', () => {
    withLang('en', () => {
      expect(withAppLocale('fix the login page', true)).toContain('Explicit app locale')
      expect(withAppLocale('fix the login page', false)).toBe('fix the login page')
      expect(withAppLocale('/effort high', true)).toBe('/effort high')
      expect(withAppLocale('  /model opus', true)).toBe('  /model opus')
      const once = withAppLocale('fix it', true)
      expect(withAppLocale(once, true)).toBe(once)
    })
    // Outside a request with an explicit locale: nothing.
    expect(withAppLocale('fix the login page', true)).toBe('fix the login page')
  })

  it('never material for a title: stripped from the first prompt and the digest, its titles ignored', () => {
    const t = { title: 'Weevils app locale', customTitle: undefined, firstPrompt: `[from:agent] Fix the usage page${BLOCK}`, messages: [{ id: 'u', role: 'user', text: `/effort high${BLOCK}`, at: 1 }] } as any
    expect(titleOf(t)).toBe('Fix the usage page')
    const d = digestOf(t)
    expect(d.debut).toBe('Fix the usage page')
    expect(d.recents.join(' ')).not.toContain('locale')
    expect(realTitle('weevils app locale')).toBeUndefined()
    expect(realTitle('Langue de l’app')).toBeUndefined()
    expect(realTitle('weevils usage rate limit')).toBe('weevils usage rate limit')
    // A slash command first: the title comes from the first real brief.
    const slash = { firstPrompt: `/effort high${BLOCK}`, messages: [{ id: 'a', role: 'user', text: '/effort high', at: 1 }, { id: 'b', role: 'user', text: `Fix the reply cards${BLOCK}`, at: 2 }] } as any
    expect(titleOf(slash)).toBe('Fix the reply cards')
    expect(digestOf(slash).debut).toBe('Fix the reply cards')
    expect(borrowedTitle(slash, 'weevils locale setup')).toBe(true)
    expect(borrowedTitle({ messages: [{ id: 'x', role: 'user', text: 'add a French locale', at: 1 }] } as any, 'weevils locale setup')).toBe(false)
  })
})
