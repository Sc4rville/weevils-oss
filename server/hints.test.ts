import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Hints } from './hints.ts'

const dirs: string[] = []
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'weevils-hints-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('hints', () => {
  it('a blank data dir: nothing seen, never written, a new install id', () => {
    const d = tmp()
    const h = new Hints(d)
    expect(h.get()).toEqual({ seen: [], touched: false })
    expect(h.install).toMatch(/^[\w-]{8,}$/)
    expect(new Hints(d).install).toBe(h.install)
    expect(new Hints(tmp()).install).not.toBe(h.install)
  })

  it('remembers seen ids across restarts, once each, and drops junk', () => {
    const d = tmp()
    new Hints(d).mark(['devil', 'devil', 'quota', 'Bad Id', 42, '../x', 'newSession'])
    const again = new Hints(d)
    expect(again.get()).toEqual({ seen: ['devil', 'quota', 'newSession'], touched: true })
    expect(again.mark(['voice']).seen).toEqual(['devil', 'quota', 'newSession', 'voice'])
  })

  it('an empty write only marks the store as touched; reset forgets everything', () => {
    const d = tmp()
    const h = new Hints(d)
    expect(h.mark([])).toEqual({ seen: [], touched: true })
    h.mark(['devil'])
    expect(h.mark([], true).seen).toEqual([])
    expect(new Hints(d).get()).toEqual({ seen: [], touched: true })
  })
})
