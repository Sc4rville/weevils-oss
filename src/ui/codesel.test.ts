import { describe, expect, it } from 'vitest'
import { around, lineRange, selText, spanLines, spanWords, wordAt } from './codesel'

const L = ['const fooBar = await quick(prompt)', '', '  return x !== y', 'été déjà_vu']

describe('wordAt', () => {
  it('prend l’identifiant entier, signes à part, jamais un espace', () => {
    expect(wordAt(L[0], 8)).toEqual([6, 12])
    expect(wordAt(L[0], 6)).toEqual([6, 12])
    expect(wordAt(L[0], 5)).toBeNull()
    expect(wordAt(L[2], 11)).toEqual([11, 14])
    expect(wordAt(L[0], 99)).toBeNull()
    expect(wordAt(L[3], 1)).toEqual([0, 3])
    expect(wordAt(L[3], 6)).toEqual([4, 11])
  })
})

describe('spanWords', () => {
  it('étend aux mots entiers, vers l’avant comme vers l’arrière', () => {
    const fwd = spanWords(L, { line: 0, col: 8 }, { line: 0, col: 22 })
    expect(selText(L, fwd)).toBe('fooBar = await quick')
    const back = spanWords(L, { line: 0, col: 22 }, { line: 0, col: 8 })
    expect(selText(L, back)).toBe('fooBar = await quick')
  })
  it('traverse les lignes', () => {
    const s = spanWords(L, { line: 0, col: 28 }, { line: 2, col: 4 })
    expect(selText(L, s)).toBe('prompt)\n\n  return')
  })
})

describe('lignes entières', () => {
  it('dans n’importe quel ordre', () => {
    const s = spanLines(L, 2, 0)
    expect(s.lines).toBe(true)
    expect(selText(L, s)).toBe(L.slice(0, 3).join('\n'))
    expect(lineRange(s, 1, 0)).toEqual([0, 0])
    expect(lineRange(s, 3, 11)).toBeNull()
  })
})

describe('around', () => {
  it('numérote à partir de 1 et borne la fenêtre', () => {
    const many = Array.from({ length: 200 }, (_, i) => `l${i}`)
    const a = around(many, 100, 100, 2).split('\n')
    expect(a).toEqual(['99│ l98', '100│ l99', '101│ l100', '102│ l101', '103│ l102'])
    expect(around(many, 0, 199).split('\n')).toHaveLength(80)
  })
})
