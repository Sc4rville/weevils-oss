import { describe, expect, it } from 'vitest'
import { hostSlug } from './config.ts'

describe('hostSlug', () => {
  it('reduces a hostname like install.sh does', () => {
    expect(hostSlug('srv1234567')).toBe('srv1234567')
    expect(hostSlug('My-Laptop.local')).toBe('my-laptop')
    expect(hostSlug('_weird host_')).toBe('weird-host')
    expect(hostSlug('a-very-long-hostname-for-a-box')).toBe('a-very-long-hostname')
    expect(hostSlug('...')).toBe('main')
  })
})
