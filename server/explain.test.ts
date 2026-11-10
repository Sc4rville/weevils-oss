import { describe, expect, it } from 'vitest'
import { parseHits, readExplain, usageTerm } from './explain.ts'

describe('explain', () => {
  it('lit les occurrences de git grep', () => {
    expect(parseHits('src/a.ts:12:  const x = foo()\n./b.md:3:foo: bar\n')).toEqual([
      { path: 'src/a.ts', line: 12, text: 'const x = foo()' },
      { path: 'b.md', line: 3, text: 'foo: bar' },
    ])
  })
  it('ne cherche qu’une sélection sur une ligne', () => {
    expect(usageTerm('  quick ')).toBe('quick')
    expect(usageTerm('a\nb')).toBeNull()
    expect(usageTerm('')).toBeNull()
  })
  it('assainit le corps reçu', () => {
    const r = readExplain({ mode: 'rm -rf', repo: 3, from: 'x', selection: 'y'.repeat(9000) })
    expect(r.mode).toBe('explain')
    expect(r.repo).toBe('3')
    expect(r.from).toBe(1)
    expect(r.selection).toHaveLength(4000)
  })
})
