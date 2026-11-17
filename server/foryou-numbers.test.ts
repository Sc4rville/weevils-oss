import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { change, ForYouNumbers } from './foryou-numbers.ts'

const DAY = 86_400_000
describe('figures that moved', () => {
  it('says the change, or nothing when it did not move', () => {
    expect(change(5, 2)).toBe('vs 2 last week')
    expect(change(3, 0)).toBe('none last week')
    expect(change(4, 4)).toBe('')
  })
  it('goal requests closed this week vs last, from the ledger', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fyn-'))
    const file = path.join(dir, 'ledger.json')
    const now = 100 * DAY
    const ask = (goal: string, closedAt: number, status = 'done') => ({ goal, status, closedAt })
    fs.writeFileSync(file, JSON.stringify({
      goals: [{ id: 'g1', title: 'Ship weevils as open source with a public link anyone can test.', status: 'active' }, { id: 'g2', title: 'Flat', status: 'active' }],
      asks: [ask('g1', now - DAY), ask('g1', now - 2 * DAY), ask('g1', now - 3 * DAY), ask('g1', now - 9 * DAY), ask('g1', 0, 'open'), ask('g2', now - DAY), ask('g2', now - 8 * DAY)],
    }))
    const items = new ForYouNumbers({ ledgerFile: file, roots: [] }).items(now)
    expect(items.map((i) => i.text)).toEqual(['3 requests closed this week toward “Ship weevils as open source with a public link”, vs 1 last week, 1 still open.'])
  })
})
