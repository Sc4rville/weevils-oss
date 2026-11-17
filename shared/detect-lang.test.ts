import { describe, expect, it } from 'vitest'
import { detectLang } from './detect-lang.ts'

describe('detectLang : la voix parle la langue du message', () => {
  it('français', () => {
    for (const t of [
      'remonte le weevil et le diable comme ça',
      "J'ai envoyé ta demande à la session weevils.",
      'Tout tourne, deux sessions travaillent sur mygame.',
      'ok fais le point',
      "c'est bon, lance le build",
    ])
      expect(detectLang(t), t).toBe('fr')
  })
  it('anglais', () => {
    for (const t of ["I'm on it, the build is running.", 'what is the status of the sessions?', 'Let me look at that for you.']) expect(detectLang(t), t).toBe('en')
  })
  it('rien pour trancher : null (on garde la langue réglée)', () => {
    expect(detectLang('ok')).toBeNull()
    expect(detectLang('npm run build')).toBeNull()
    expect(detectLang('')).toBeNull()
  })
  it('les noms de fichiers et URL ne font pas pencher', () => {
    expect(detectLang('Regarde https://example.com/the/and/is pour voir')).toBe('fr')
  })
})
