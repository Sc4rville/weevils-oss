import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DATA_DIR, LOGS_DIR, LOGS_DIRS, hostSlug } from './config.ts'

describe('hostSlug', () => {
  it('reduces a hostname like install.sh does', () => {
    expect(hostSlug('srv1234567')).toBe('srv1234567')
    expect(hostSlug('My-Laptop.local')).toBe('my-laptop')
    expect(hostSlug('_weird host_')).toBe('weird-host')
    expect(hostSlug('a-very-long-hostname-for-a-box')).toBe('a-very-long-hostname')
    expect(hostSlug('...')).toBe('main')
  })
})

describe('LOGS_DIRS', () => {
  // Les agents lancent leurs jobs longs en « nohup … > ~/logs/<nom>.log » : sans WEEVILS_LOGS_DIR, le rail 24/7 les voit.
  it('sans réglage : ~/logs, puis le dossier de weevils (où s’écrit le job de démo)', () => {
    expect(LOGS_DIR).toBe(path.join(DATA_DIR, 'jobs'))
    expect(LOGS_DIRS).toEqual([path.join(os.homedir(), 'logs'), LOGS_DIR])
  })
})
