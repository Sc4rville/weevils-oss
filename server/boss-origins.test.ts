// Where each user message to weevboss came from (server/boss-origins.ts), read back into the journal: the audit trail
// that was missing on 2026-11-14, when nothing said whether « How do you think I should dress tonight? » was the user.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BossJournal } from './boss-view.ts'
import { originKey, originOf, readOrigins, recordOrigin } from './boss-origins.ts'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'boss-origins-'))
const T0 = Date.UTC(2026, 10, 14, 6, 0, 0)
const user = (n: number, text: string, at: number) => ({ type: 'user', uuid: `u${String(n).padStart(7, '0')}-0000-0000-0000-000000000000`, timestamp: new Date(at).toISOString(), message: { role: 'user', content: text } })

describe('origins', () => {
  it('the same words, spaced differently, are the same message', () => {
    expect(originKey(' what are  my\nprojects up to? ')).toBe(originKey('what are my projects up to?'))
    expect(originKey('a')).not.toBe(originKey('b'))
  })

  it('matches the closest record sent shortly before, once each', () => {
    const dir = tmp()
    recordOrigin(dir, 'What my projects up to right now?', 'live', T0)
    recordOrigin(dir, 'What my projects up to right now?', 'device', T0 + 60_000)
    recordOrigin(dir, 'hello', 'server', T0 - 2 * 3600_000) // too old for a message read now
    fs.appendFileSync(path.join(dir, 'origins.jsonl'), '{"torn":')
    const records = readOrigins(dir)
    expect(records).toHaveLength(3)
    const used = new Set<string>()
    expect(originOf(records, 'What my projects up to right now?', T0 + 5_000, used)).toBe('live')
    expect(originOf(records, 'What my projects up to right now?', T0 + 65_000, used)).toBe('device')
    expect(originOf(records, 'What my projects up to right now?', T0 + 70_000, used)).toBeUndefined()
    expect(originOf(records, 'hello', T0, used)).toBeUndefined()
  })

  it('no file, no origin, and a write that fails never throws', () => {
    expect(readOrigins(path.join(tmp(), 'missing'))).toEqual([])
    const file = path.join(tmp(), 'a-file')
    fs.writeFileSync(file, '')
    expect(() => recordOrigin(file, 'x', 'device')).not.toThrow()
  })
})

describe('BossJournal with origins', () => {
  it('each user entry says where it came from; one with no record (a message typed in the terminal) has none', () => {
    const dir = tmp()
    const t = path.join(dir, 't')
    const data = path.join(dir, 'data')
    fs.mkdirSync(t)
    recordOrigin(data, 'what are my projects up to?', 'device', T0)
    recordOrigin(data, 'How do you think I should dress tonight?', 'live', T0 + 60_000)
    fs.writeFileSync(path.join(t, 'a.jsonl'), [
      user(1, 'what are my projects up to? ⟦weevils — hidden context⟧', T0 + 2_000),
      user(2, 'How do you think I should dress tonight?', T0 + 62_000),
      user(3, 'typed in the terminal', T0 + 120_000),
    ].map((o) => JSON.stringify(o)).join('\n') + '\n')
    const j = new BossJournal(t, data)
    j.sync()
    expect(j.entries().map((e) => [e.text, e.origin])).toEqual([
      ['what are my projects up to?', 'device'],
      ['How do you think I should dress tonight?', 'live'],
      ['typed in the terminal', undefined],
    ])
    // Kept on disk: the audit survives a restart.
    expect(new BossJournal(t, data).entries().map((e) => e.origin)).toEqual(['device', 'live', undefined])
  })
})
