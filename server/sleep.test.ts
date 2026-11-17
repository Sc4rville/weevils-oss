import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Session } from '../shared/api.ts'
import { Sleep, nightRecap, recapWorth, sleepAllowsPush, RECAP_LINES, RECAP_MIN_MS } from './sleep.ts'

const T0 = new Date('2026-11-13T22:30:00Z').getTime()
const MIN = 60_000
const s = (over: Partial<Session>): Session => ({ id: 'x', projectId: 'p', repo: 'p', machineId: 'm', tool: 'claude', title: 'Session', status: 'idle', openedAt: T0 - 60 * MIN, lastActivityAt: T0 + 60 * MIN, messageCount: 4, ...over }) as Session

describe('sleep mode', () => {
  it('is a real state: persisted, told once per change, the night kept on wake', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sleep-')), 'sleep.json')
    const sleep = new Sleep(file)
    const seen = vi.fn()
    sleep.onChange(seen)
    expect(sleep.state()).toEqual({ on: false, since: null })
    sleep.set(true, T0)
    sleep.set(true, T0 + MIN)
    expect(seen).toHaveBeenCalledTimes(1)
    expect(new Sleep(file).state()).toEqual({ on: true, since: T0 })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const woke = sleep.set(false, T0 + 8 * 60 * MIN)
    expect(woke).toEqual({ on: false, since: null, last: { from: T0, to: T0 + 8 * 60 * MIN } })
    expect(seen).toHaveBeenLastCalledWith(false, { from: T0, to: T0 + 8 * 60 * MIN }, T0 + 8 * 60 * MIN)
    expect(new Sleep(file).on).toBe(false)
  })

  it('asleep, only real blockers reach the phone', () => {
    expect(sleepAllowsPush(true, 'question')).toBe(true)
    expect(sleepAllowsPush(true, 'warning')).toBe(true)
    expect(sleepAllowsPush(true, 'result')).toBe(false)
    expect(sleepAllowsPush(true, 'milestone')).toBe(false)
    expect(sleepAllowsPush(false, 'result')).toBe(true)
  })

  it('the morning recap tells only what the states prove, blockers first', () => {
    const night = { from: T0, to: T0 + 8 * 60 * MIN }
    const { recap, counts } = nightRecap({
      ...night,
      sessions: [
        s({ id: 'a', title: 'Fix the login', lastMessage: 'The login page is fixed and works on iPhone.' }),
        s({ id: 'b', title: 'Explore ideas', lastMessage: 'I looked at three options.' }),
        s({ id: 'c', title: 'Long refactor', status: 'working' }),
        s({ id: 'd', title: 'Deploy', status: 'needs_user', attention: 'Allow the deploy?' }),
        s({ id: 'old', title: 'Yesterday', lastActivityAt: T0 - 10 * MIN }),
        s({ id: 'auto-sess', title: 'Night lens session' }),
        s({ id: 'arch', archived: true }),
      ],
      autos: [{ id: 'n1', title: 'Night lens', state: 'queued', runs: [{ at: T0 + 90 * MIN, startedAt: T0 + 10 * MIN, ok: true, note: 'Report: 3 findings', sessionId: 'auto-sess' }, { at: T0 - DAYMS, startedAt: T0 - DAYMS, ok: true }] }],
    })
    expect(recap.lines.map((l) => [l.state, l.title])).toEqual([
      ['waiting', 'Deploy'],
      ['done', 'Night lens'],
      ['done', 'Fix the login'],
      ['working', 'Long refactor'],
      ['ended', 'Explore ideas'],
    ])
    // An unclear last message is never turned into a result: shown as it is, as an ended turn.
    expect(recap.lines.find((l) => l.title === 'Explore ideas')!.detail).toBe('I looked at three options.')
    expect(recap.lines.find((l) => l.title === 'Night lens')).toMatchObject({ src: 'auto', open: { page: 'auto', id: 'n1' }, detail: 'Report: 3 findings' })
    expect(counts).toEqual({ done: 2, working: 1, waiting: 1, failed: 0, retried: 0 })
    const many = nightRecap({ ...night, sessions: Array.from({ length: RECAP_LINES + 3 }, (_, i) => s({ id: `s${i}` })), autos: [] })
    expect(many.recap.lines).toHaveLength(RECAP_LINES)
    expect(many.recap.more).toBe(3)
  })
  it('a short nap gets a card only when something reached an outcome, a real night always does', () => {
    const nap = { from: T0, to: T0 + 40_000 }
    expect(recapWorth({ ...nap, lines: [] })).toBe(false)
    expect(recapWorth({ ...nap, lines: [{ state: 'working' }, { state: 'ended' }] })).toBe(false)
    for (const state of ['done', 'failed', 'waiting', 'stopped']) expect(recapWorth({ ...nap, lines: [{ state: 'working' }, { state }] })).toBe(true)
    expect(recapWorth({ from: T0, to: T0 + RECAP_MIN_MS, lines: [] })).toBe(true)
  })
})
const DAYMS = 24 * 60 * MIN
