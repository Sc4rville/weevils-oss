import { describe, expect, it } from 'vitest'
import type { TipCard } from '../../shared/tips.ts'
import { COOLDOWN_MS, DAY_MAX, DEBUG_IDLE_MS, IDLE_MS, emptyState, markShown, parseState, pick, ready, type Moment } from './tips-schedule'

const NOW = 1_800_000_000_000
const idle = (over: Partial<Moment> = {}): Moment => ({ now: NOW, lastInput: NOW - IDLE_MS - 1, showing: false, blocked: false, debug: false, ...over })
const card = (id: string, personal = false): TipCard => ({ id, rule: id, text: id, personal })

describe('tips — scheduling', () => {
  it('waits for the user to sit idle on the feed', () => {
    expect(ready(emptyState(), idle())).toBe(true)
    expect(ready(emptyState(), idle({ lastInput: NOW - IDLE_MS + 1000 }))).toBe(false)
  })

  it('one card at a time', () => {
    expect(ready(emptyState(), idle({ showing: true }))).toBe(false)
  })

  it('never over a page, a focused field, the intro or a hidden app', () => {
    expect(ready(emptyState(), idle({ blocked: true }))).toBe(false)
  })

  it('the settings toggle turns them off', () => {
    expect(ready({ ...emptyState(), off: true }, idle())).toBe(false)
    expect(ready({ ...emptyState(), off: true }, idle({ debug: true }))).toBe(false)
    expect(parseState(JSON.stringify({ off: true })).off).toBe(true)
  })

  it('a long cooldown between two cards', () => {
    const s = markShown(emptyState(), 'a', NOW - COOLDOWN_MS + 60_000)
    expect(ready(s, idle())).toBe(false)
    expect(ready(s, idle({ now: NOW + 60_000, lastInput: NOW }))).toBe(true)
  })

  it(`at most ${DAY_MAX} a day`, () => {
    let s = emptyState()
    for (let k = 0; k < DAY_MAX; k++) s = markShown(s, `t${k}`, NOW - (k + 1) * (COOLDOWN_MS + 60_000))
    expect(ready(s, idle())).toBe(false)
    // A day later, the oldest ones no longer count.
    expect(ready(s, idle({ now: NOW + 24 * 3600_000, lastInput: NOW }))).toBe(true)
  })

  it('never the same card twice, personalized cards first', () => {
    const cards = [card('tip:a'), card('tip:b'), card('idle:1', true)]
    let s = emptyState()
    expect(pick(cards, s)?.id).toBe('idle:1')
    s = markShown(s, 'idle:1', NOW)
    const next = pick(cards, s, () => 0)!
    expect(next.id).toBe('tip:a')
    s = markShown(s, next.id, NOW)
    expect(pick(cards, s, () => 0.99)?.id).toBe('tip:b')
    s = markShown(s, 'tip:b', NOW)
    expect(pick(cards, s)).toBeNull()
    // Seen ids survive a reload.
    expect(parseState(JSON.stringify(s)).seen).toEqual(['idle:1', 'tip:a', 'tip:b'])
  })

  it('debug: 5 s idle, no cooldown, but still one at a time and never twice', () => {
    const s = markShown(emptyState(), 'a', NOW - 1000)
    expect(ready(s, idle({ debug: true, lastInput: NOW - DEBUG_IDLE_MS - 1 }))).toBe(true)
    expect(ready(s, idle({ debug: true, showing: true }))).toBe(false)
    expect(pick([card('a')], s)).toBeNull()
  })

  it('a broken store starts afresh', () => {
    expect(parseState('{nope')).toEqual(emptyState())
    expect(parseState(null)).toEqual(emptyState())
  })
})
