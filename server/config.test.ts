import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { DATA_DIR, LOGS_DIR, LOGS_DIRS, hostSlug, insideRoots } from './config.ts'

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

describe('insideRoots (where weevils may answer folder trust)', () => {
  it('a root and its subfolders only, never a sibling with the same prefix or a parent', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'roots-'))
    const root = path.join(base, 'projects')
    fs.mkdirSync(path.join(root, 'app', 'src'), { recursive: true })
    fs.mkdirSync(path.join(base, 'projects-evil'))
    expect(insideRoots(root, [root])).toBe(true)
    expect(insideRoots(path.join(root, 'app', 'src'), [root])).toBe(true)
    expect(insideRoots(path.join(base, 'projects-evil'), [root])).toBe(false)
    expect(insideRoots(base, [root])).toBe(false)
    expect(insideRoots(path.join(root, '..', 'projects-evil'), [root])).toBe(false)
    expect(insideRoots(undefined, [root])).toBe(false)
    // A symbolic link inside the root that points outside it is outside.
    fs.symlinkSync(path.join(base, 'projects-evil'), path.join(root, 'link'))
    expect(insideRoots(path.join(root, 'link'), [root])).toBe(false)
  })
  it('by default: the project roots and weevils\' own data folder, not the home folder', () => {
    expect(insideRoots(path.join(DATA_DIR, 'orchestrator'))).toBe(true)
    expect(insideRoots(os.homedir())).toBe(false)
    expect(insideRoots('/tmp')).toBe(false)
  })
})
