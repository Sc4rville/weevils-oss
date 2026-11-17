import { afterEach, describe, expect, it } from 'vitest'
import { decide, explicitTiming, setSpeedModeSource, speedMode } from './request-handling.ts'

afterEach(() => setSpeedModeSource(() => undefined))

describe('explicitTiming', () => {
  it('reads now and later in French and English', () => {
    expect(explicitTiming('fais le tout de suite')).toBe('now')
    expect(explicitTiming('URGENT le lien')).toBe('now')
    expect(explicitTiming('do it now please')).toBe('now')
    expect(explicitTiming('plus tard')).toBe('later')
    expect(explicitTiming('this weekend')).toBe('later')
    expect(explicitTiming('ce week-end')).toBe('later')
    expect(explicitTiming('pas urgent')).toBe('later')
    expect(explicitTiming('fix the login page')).toBeUndefined()
  })
})

describe('decide: queue or send', () => {
  const open = (words: string, mode?: Parameters<typeof decide>[0]['mode']) => decide({ state: 'open', kind: 'task', words, mode })
  it('the user’s explicit words win over any mode', () => {
    expect(open('fix it now', 'pause')).toEqual({ handling: 'send', why: 'you-said-now' })
    expect(open('fix it later', 'max')).toEqual({ handling: 'queued', why: 'you-said-later' })
  })
  it('otherwise the speed mode decides', () => {
    expect(open('fix it', 'pause')).toEqual({ handling: 'queued', why: 'mode-pause' })
    expect(open('fix it', 'veille')).toEqual({ handling: 'queued', why: 'mode-veille' })
    expect(open('fix it', 'cruise')).toEqual({ handling: 'queued', why: 'waits-for-weevboss' })
    expect(open('fix it', 'turbo')).toEqual({ handling: 'send', why: 'mode-turbo' })
    expect(open('fix it', 'max')).toEqual({ handling: 'send', why: 'mode-turbo' })
  })
  it('what the turn already did stands: answered, sent', () => {
    expect(decide({ state: 'done', kind: 'question', words: 'why', mode: 'pause' }).handling).toBe('answered')
    expect(decide({ state: 'dispatched', kind: 'task', words: 'fix it later', mode: 'pause' }).handling).toBe('sent')
  })
  it('the mode comes through one pluggable function, cruise until it is live', () => {
    expect(speedMode()).toBe('cruise')
    setSpeedModeSource(() => 'turbo')
    expect(speedMode()).toBe('turbo')
    expect(open('fix it')).toEqual({ handling: 'send', why: 'mode-turbo' })
    setSpeedModeSource(() => { throw new Error('x') })
    expect(speedMode()).toBe('cruise')
  })
})
