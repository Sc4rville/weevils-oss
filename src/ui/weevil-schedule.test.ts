import { describe, expect, it } from 'vitest'
import { DAY_MAX, DEBUG_MS, FIRST_MS, GAP_MAX_MS, GAP_MIN_MS, QUIET_MS, calm, gap, markFlown, nextAt, parseState, type Calm } from './weevil-schedule'

const NOW = 1_800_000_000_000
const MIN = 60_000
const quiet = (over: Partial<Calm> = {}): Calm => ({ now: NOW, page: false, drawer: false, overlay: false, visible: true, typing: false, lastKey: 0, voice: false, ...over })

describe('flying weevils — schedule', () => {
  it('never in the first minutes after the app opens', () => {
    expect(nextAt({ flights: [] }, NOW, NOW)).toBe(NOW + FIRST_MS)
    expect(nextAt({ flights: [] }, NOW - 10 * MIN, NOW)).toBe(NOW)
  })

  it('a random gap of 12 to 25 minutes between two flights', () => {
    expect(gap(() => 0)).toBe(GAP_MIN_MS)
    expect(gap(() => 0.9999)).toBeLessThan(GAP_MAX_MS)
    const s = { flights: [NOW - 5 * MIN] }
    expect(nextAt(s, NOW - 60 * MIN, NOW, false, () => 0)).toBe(NOW - 5 * MIN + GAP_MIN_MS)
    expect(nextAt(s, NOW - 60 * MIN, NOW, false, () => 0.5)).toBeGreaterThan(NOW + 10 * MIN)
  })

  it('at most six a day', () => {
    let s = { flights: [] as number[] }
    for (let i = 0; i < DAY_MAX; i++) s = markFlown(s, NOW - (10 - i) * 60 * MIN)
    const oldest = NOW - 10 * 60 * MIN
    expect(nextAt(s, NOW - 24 * 60 * MIN, NOW, false, () => 0)).toBe(oldest + 24 * 60 * MIN)
    // One more day: the old flights are forgotten.
    expect(markFlown(s, NOW + 30 * 60 * MIN).flights).toHaveLength(1)
  })

  it('the test hook flies at once, cap ignored', () => {
    let s = { flights: [] as number[] }
    for (let i = 0; i < 10; i++) s = markFlown(s, NOW - i * MIN)
    expect(nextAt(s, NOW, NOW, true)).toBe(NOW + DEBUG_MS)
  })

  it('only when the home screen is calm', () => {
    expect(calm(quiet())).toBe(true)
    expect(calm(quiet({ page: true }))).toBe(false)
    expect(calm(quiet({ drawer: true }))).toBe(false)
    expect(calm(quiet({ overlay: true }))).toBe(false)
    expect(calm(quiet({ visible: false }))).toBe(false)
    expect(calm(quiet({ typing: true }))).toBe(false)
    expect(calm(quiet({ voice: true }))).toBe(false)
    expect(calm(quiet({ lastKey: NOW - QUIET_MS + 1000 }))).toBe(false)
    expect(calm(quiet({ lastKey: NOW - QUIET_MS }))).toBe(true)
  })

  it('reads a broken state as empty', () => {
    expect(parseState(null)).toEqual({ flights: [] })
    expect(parseState('{"flights":[1,"x",null,2]}')).toEqual({ flights: [1, 2] })
    expect(parseState('nope')).toEqual({ flights: [] })
  })
})
