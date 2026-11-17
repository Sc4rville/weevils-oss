import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { memoryHead, parseHits, readExplain, usageTerm } from './explain.ts'
import { Memory } from './memory.ts'

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
  it('garde le genre memory, refuse un genre inconnu', () => {
    expect(readExplain({ kind: 'memory', path: 'abc' })).toMatchObject({ kind: 'memory', path: 'abc' })
    expect(readExplain({ kind: 'shell' }).kind).toBe('file')
  })
})

describe('explain · mémoire', () => {
  const base = { mode: 'explain' as const, kind: 'memory' as const, repo: '', from: 0, to: 0, selection: '' }
  const mem = () => {
    const m = new Memory(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mem-')), 'memory.json'))
    const a = m.add('wants to ship a mobile game this year', { source: 'answer', q: 'and in ten years?', a: 'a small studio, a game out every year' })
    const b = m.add('climbs on Sundays')
    return { m, a, b }
  }
  it('relit le souvenir, sa question, sa réponse et les autres dans le magasin', () => {
    const { m, a } = mem()
    const head = memoryHead(m, { ...base, path: a.id, around: 'ignored' }, 'mobile game')
    expect(head).toContain('"wants to ship a mobile game this year"')
    expect(head).toContain('"and in ten years?": "a small studio')
    expect(head).toContain('- climbs on Sundays')
    expect(head).toContain('They selected: "mobile game"')
    expect(head).not.toContain('ignored')
  })
  it('un souvenir noté à la main le dit ; sans souvenir ouvert, toute la mémoire', () => {
    const { m, b } = mem()
    expect(memoryHead(m, { ...base, path: b.id, around: '' }, '')).toContain('by hand')
    const all = memoryHead(m, { ...base, path: '', around: '' }, '')
    expect(all).toContain('- wants to ship a mobile game this year')
    expect(all).toContain('- climbs on Sundays')
  })
  it('sans mémoire sur cette machine : ce que l’app a envoyé', () => {
    expect(memoryHead(null, { ...base, path: 'x', around: '- likes tea' }, '')).toContain('- likes tea')
  })
})
