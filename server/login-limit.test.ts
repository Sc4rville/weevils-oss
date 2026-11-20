import { describe, expect, it } from 'vitest'
import { GLOBAL, PER_ADDRESS, WINDOW_MS, loginLimiter } from './login-limit.ts'

describe('login limit', () => {
  it('stops one address, then every address, and forgets after the window', () => {
    let t = 0
    const l = loginLimiter(() => t)
    for (let i = 0; i < PER_ADDRESS; i++) l.failed('a')
    expect(l.allowed('a')).toBe(false)
    expect(l.allowed('b')).toBe(true)
    for (let i = 0; i < GLOBAL; i++) l.failed(`x${i}`)
    expect(l.allowed('fresh')).toBe(false)
    t += WINDOW_MS + 1
    expect(l.allowed('a')).toBe(true)
    expect(l.allowed('fresh')).toBe(true)
  })
})
