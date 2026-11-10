import { describe, expect, it } from 'vitest'
import { fmtLocal, inWindow, minuteOfDay, nextRun, nextStart, parseEvery, parseLocal, parseWindow, validTz, windowText } from './auto-time.ts'

const T0 = Date.parse('2026-11-10T09:00:00Z') // 10:00 in Paris (CET), 09:00 UTC
const H = 3600_000
const P = 'Europe/Paris'

describe('auto — when a task may start', () => {
  it('reads and writes local times in the user zone, not the server one', () => {
    expect(fmtLocal(T0, P)).toBe('2026-11-10 10:00')
    expect(fmtLocal(T0, 'UTC')).toBe('2026-11-10 09:00')
    expect(parseLocal('2026-11-11 01:00', P)).toBe(Date.parse('2026-11-11T00:00:00Z'))
    expect(parseLocal('2026-11-11T01:00', 'UTC')).toBe(Date.parse('2026-11-11T01:00:00Z'))
    // Summer time (CEST, UTC+2).
    expect(parseLocal('2026-07-01 08:30', P)).toBe(Date.parse('2026-07-01T06:30:00Z'))
    expect(parseLocal('tomorrow', P)).toBeNull()
    expect(parseLocal('2026-13-01 08:00', P)).toBeNull()
    expect(minuteOfDay(T0, P)).toBe(600)
    expect(validTz('Europe/Paris')).toBe('Europe/Paris')
    expect(validTz('Mars/Olympus')).toBeNull()
    expect(validTz(42)).toBeNull()
  })

  it('a daily window: written several ways, 30 min at least, may wrap past midnight', () => {
    expect(parseWindow('01:00-06:00')).toEqual({ from: 60, to: 360 })
    expect(parseWindow('1h-6h')).toEqual({ from: 60, to: 360 })
    expect(parseWindow('22:30–05:00')).toEqual({ from: 1350, to: 300 })
    expect(parseWindow('01:00-01:10')).toBeNull()
    expect(parseWindow('nights')).toBeNull()
    expect(parseWindow('25:00-06:00')).toBeNull()
    expect(windowText({ from: 1350, to: 300 })).toBe('22:30-05:00')
    const night = { from: 1320, to: 360 }
    expect(inWindow(Date.parse('2026-11-10T23:00:00Z'), night, P)).toBe(true) // 00:00 Paris
    expect(inWindow(T0, night, P)).toBe(false)
  })

  it('a period: 1 h to 90 days, named or as a span', () => {
    expect(parseEvery('1d')).toBe(24 * H)
    expect(parseEvery('7d')).toBe(7 * 24 * H)
    expect(parseEvery('weekly')).toBe(7 * 24 * H)
    expect(parseEvery('12h')).toBe(12 * H)
    expect(parseEvery('1 semaine')).toBe(7 * 24 * H)
    expect(parseEvery('10min')).toBeNull()
    expect(parseEvery('365d')).toBeNull()
    expect(parseEvery('whenever')).toBeNull()
    expect(parseEvery(2 * H)).toBe(2 * H)
  })

  it('the next start: not before, then the next opening of its window', () => {
    const night = { from: 60, to: 360 }
    // 10:00 in Paris: tonight at 01:00 Paris = 00:00 UTC.
    expect(nextStart({ window: night }, T0, P)).toBe(Date.parse('2026-11-11T00:00:00Z'))
    // Inside the window: now.
    const in2 = Date.parse('2026-11-11T02:00:00Z')
    expect(nextStart({ window: night }, in2, P)).toBe(in2)
    // Not before Friday 03:00 Paris, which is inside the window: then.
    const fri = parseLocal('2026-11-13 03:00', P)!
    expect(nextStart({ notBefore: fri, window: night }, T0, P)).toBe(fri)
    // Not before Friday 08:00: the window opens again Saturday 01:00.
    expect(fmtLocal(nextStart({ notBefore: parseLocal('2026-11-13 08:00', P)!, window: night }, T0, P), P)).toBe('2026-11-14 01:00')
    expect(nextStart({}, T0, P)).toBe(T0)
  })

  it('the next run of a recurring task: one period after its last start, never in the past', () => {
    expect(nextRun(T0, 24 * H, T0 + H)).toBe(T0 + 24 * H)
    expect(nextRun(T0, 2 * H, T0 + 5 * H)).toBe(T0 + 6 * H)
  })
})
