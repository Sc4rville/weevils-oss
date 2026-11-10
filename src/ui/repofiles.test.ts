import { describe, expect, it } from 'vitest'
import { matchFile, parsePath } from './repofiles'
import { pathAt, pathOrWord } from './textpick'

describe('chemins dans un message', () => {
  it('prend le chemin entier, sans la ponctuation de fin', () => {
    const t = 'écrit · ~/projects/weevils/server/mime.ts.'
    expect(t.slice(...pathAt(t, 25)!)).toBe('~/projects/weevils/server/mime.ts')
    const u = 'voir src/ui/ask.tsx:42, puis'
    expect(u.slice(...pathAt(u, 8)!)).toBe('src/ui/ask.tsx:42')
    expect(pathAt('fast.ts est rapide', 1)).toEqual([0, 7])
  })
  it('laisse les mots ordinaires au mot', () => {
    expect(pathAt('process.env.HOME', 3)).toBeNull()
    expect(pathAt('bonjour toi', 2)).toBeNull()
    const t = 'c.stdin?.end()'
    expect(t.slice(...pathOrWord(t, 3)!)).toBe('stdin')
  })
  it('retrouve le repo, le fichier et la ligne', () => {
    expect(parsePath('~/projects/weevils/server/mime.ts', 'autre')).toEqual({ repo: 'weevils', rel: 'server/mime.ts', line: undefined })
    expect(parsePath('./src/a.ts:12', 'weevils')).toEqual({ repo: 'weevils', rel: 'src/a.ts', line: 12 })
    expect(parsePath('/etc/passwd', 'weevils')).toBeNull()
    expect(parsePath('src/a.ts')).toBeNull()
  })
  it('associe un nom court à un seul fichier', () => {
    const files = ['server/core.ts', 'src/ui/core.ts', 'server/mime.ts']
    expect(matchFile(files, 'server/core.ts')).toBe('server/core.ts')
    expect(matchFile(files, 'mime.ts')).toBe('server/mime.ts')
    expect(matchFile(files, 'core.ts')).toBeNull()
  })
})
