// What differs between Linux and macOS (server/platform.ts). The macOS branches run here on Linux: the platform and
// whatever would be run are passed in, nothing depends on the host.
import type { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BREW_DIRS, availableMem, keepAwake, macHasBattery, parseVmStat, servicePath, toolDirs, which, type Exec } from './platform.ts'

const HOME = process.env.HOME!
afterEach(() => vi.unstubAllEnvs())

/** An executable file (or a non-executable one) in a folder of the throwaway HOME. */
function tool(dir: string, name: string, mode = 0o755): string {
  fs.mkdirSync(dir, { recursive: true })
  const f = path.join(dir, name)
  fs.writeFileSync(f, '#!/bin/sh\n', { mode })
  fs.chmodSync(f, mode)
  return f
}

describe('servicePath', () => {
  const launchd = '/usr/bin:/bin:/usr/sbin:/sbin'

  it('Linux: the PATH is returned as it is, whatever it holds', () => {
    expect(servicePath(launchd, 'linux', '/home/u')).toBe(launchd)
    expect(servicePath('', 'linux', '/home/u')).toBe('')
    expect(servicePath('/a::/b', 'linux', '/home/u')).toBe('/a::/b')
  })

  it('a Mac started by launchd: ~/.local/bin and Homebrew (Apple Silicon, then Intel) are added after what is there', () => {
    expect(servicePath(launchd, 'darwin', '/Users/u')).toBe(`${launchd}:/Users/u/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin`)
  })

  it('a Mac: nothing is added twice, the order already there is kept, empty entries go', () => {
    const full = '/opt/homebrew/bin:/Users/u/.local/bin:/usr/bin:/bin'
    expect(servicePath(full, 'darwin', '/Users/u')).toBe(`${full}:/opt/homebrew/sbin:/usr/local/bin`)
    const done = servicePath(launchd, 'darwin', '/Users/u')
    expect(servicePath(done, 'darwin', '/Users/u')).toBe(done)
    expect(servicePath('', 'darwin', '/Users/u')).toBe('/Users/u/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin')
    expect(servicePath('/usr/bin::/bin:', 'darwin', '/Users/u').startsWith('/usr/bin:/bin:/Users/u/.local/bin')).toBe(true)
  })
})

describe('toolDirs', () => {
  it('the installers’ folders of the home, then /usr/local/bin; Homebrew’s folders on a Mac, none listed twice', () => {
    const mac = toolDirs('darwin', '/Users/u')
    expect(mac.slice(0, 4)).toEqual(['/Users/u/.local/bin', '/Users/u/.claude/local', '/Users/u/.npm-global/bin', '/usr/local/bin'])
    for (const d of BREW_DIRS) expect(mac).toContain(d)
    expect(new Set(mac).size).toBe(mac.length)
    const linux = toolDirs('linux', '/home/u')
    expect(linux).toEqual(['/home/u/.local/bin', '/home/u/.claude/local', '/home/u/.npm-global/bin', '/usr/local/bin', '/opt/homebrew/bin'])
  })
})

describe('which', () => {
  it('a command of the PATH is found there first, before the installers’ folders', () => {
    const inPath = tool(path.join(HOME, 'w1', 'bin'), 'wv-tool-a')
    tool(path.join(HOME, 'w1', 'home', '.local', 'bin'), 'wv-tool-a')
    vi.stubEnv('PATH', `${path.join(HOME, 'w1', 'nowhere')}:${path.join(HOME, 'w1', 'bin')}`)
    expect(which('wv-tool-a', 'linux', path.join(HOME, 'w1', 'home'))).toBe(inPath)
  })

  it('a bare PATH (launchd): found where installers put it, in the home it is given', () => {
    const home = path.join(HOME, 'w2')
    vi.stubEnv('PATH', '/usr/bin:/bin')
    const local = tool(path.join(home, '.local', 'bin'), 'wv-tool-b')
    const npm = tool(path.join(home, '.npm-global', 'bin'), 'wv-tool-c')
    const claude = tool(path.join(home, '.claude', 'local'), 'wv-tool-d')
    for (const platform of ['darwin', 'linux'] as const) {
      expect(which('wv-tool-b', platform, home)).toBe(local)
      expect(which('wv-tool-c', platform, home)).toBe(npm)
      expect(which('wv-tool-d', platform, home)).toBe(claude)
    }
    expect(which('wv-tool-b', 'darwin', path.join(HOME, 'elsewhere'))).toBeNull()
  })

  it('not installed, not executable, or a folder of that name: null', () => {
    const home = path.join(HOME, 'w3')
    vi.stubEnv('PATH', '')
    expect(which('wv-tool-none', 'darwin', home)).toBeNull()
    tool(path.join(home, '.local', 'bin'), 'wv-tool-e', 0o644)
    expect(which('wv-tool-e', 'darwin', home)).toBeNull()
    fs.mkdirSync(path.join(home, '.local', 'bin', 'wv-tool-f'), { recursive: true })
    expect(which('wv-tool-f', 'darwin', home)).toBeNull()
  })

  it('an unset PATH does not throw', () => {
    vi.stubEnv('PATH', undefined as unknown as string)
    expect(which('wv-tool-none', 'linux', path.join(HOME, 'w4'))).toBeNull()
  })
})

// `vm_stat` on an Apple Silicon Mac (16 KiB pages) and on an Intel one (4 KiB pages).
const VM_ARM = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                3521.
Pages active:                            268123.
Pages inactive:                          254871.
Pages speculative:                         2710.
Pages throttled:                              0.
Pages wired down:                        152342.
Pages purgeable:                           5318.
"Translation faults":                 941223345.
Pages copy-on-write:                   35164412.
Pages zero filled:                    512316787.
Pages reactivated:                     11203318.
Pages purged:                           4031127.
File-backed pages:                       195422.
Anonymous pages:                         330282.
Pages stored in compressor:              702114.
Pages occupied by compressor:            297301.
Decompressions:                        19331240.
Compressions:                          27811993.
Pageins:                               10477713.
Pageouts:                                 91004.
Swapins:                                 512330.
Swapouts:                                733121.
`
const VM_INTEL = `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free:                              102400.
Pages active:                           1200000.
Pages inactive:                          409600.
Pages speculative:                        51200.
Pages wired down:                        600000.
Pages purgeable:                          25600.
`

describe('parseVmStat', () => {
  it('free + inactive + speculative + purgeable pages, times the page size of the header', () => {
    expect(parseVmStat(VM_ARM)).toBe((3521 + 254871 + 2710 + 5318) * 16384)
    expect(parseVmStat(VM_INTEL)).toBe((102400 + 409600 + 51200 + 25600) * 4096)
  })

  it('« Pages purged », « Pages active » and the compressor’s lines are not counted', () => {
    const only = 'Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages active: 500.\nPages purged: 700.\nPages stored in compressor: 900.\nPages free: 10.\n'
    expect(parseVmStat(only)).toBe(10 * 4096)
  })

  it('not vm_stat’s text, no page size, or no page at all: null', () => {
    expect(parseVmStat('')).toBeNull()
    expect(parseVmStat('vm_stat: command not found')).toBeNull()
    expect(parseVmStat('Pages free: 10.\nPages inactive: 10.\n')).toBeNull()
    expect(parseVmStat('Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages active: 500.\n')).toBeNull()
  })
})

describe('availableMem', () => {
  const free = () => 123_456

  it('Linux: what the system reports, vm_stat is never run', async () => {
    const run = vi.fn<Exec>(async () => VM_ARM)
    expect(await availableMem('linux', run, free)).toBe(123_456)
    expect(run).not.toHaveBeenCalled()
  })

  it('a Mac: read from /usr/bin/vm_stat', async () => {
    const run = vi.fn<Exec>(async () => VM_ARM)
    expect(await availableMem('darwin', run, free)).toBe((3521 + 254871 + 2710 + 5318) * 16384)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0].slice(0, 2)).toEqual(['/usr/bin/vm_stat', []])
  })

  it('a Mac where vm_stat fails or says nothing readable: what the system reports', async () => {
    expect(await availableMem('darwin', async () => Promise.reject(new Error('ENOENT')), free)).toBe(123_456)
    expect(await availableMem('darwin', async () => 'garbage', free)).toBe(123_456)
  })
})

describe('macHasBattery', () => {
  it('a laptop lists an InternalBattery, a desktop Mac does not', () => {
    expect(macHasBattery("Now drawing from 'AC Power'\n -InternalBattery-0 (id=23855203)\t100%; charged; 0:00 remaining present: true\n")).toBe(true)
    expect(macHasBattery("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=4653155)\t62%; discharging; 4:12 remaining present: true\n")).toBe(true)
    expect(macHasBattery("Now drawing from 'AC Power'\n")).toBe(false)
    expect(macHasBattery("Now drawing from 'UPS Power'\n -Back-UPS ES 700G (id=1234)\t100%; charged; present: true\n")).toBe(false)
    expect(macHasBattery('')).toBe(false)
  })
})

describe('keepAwake', () => {
  type Call = { file: string; args: string[]; options: unknown }
  /** A spawn that starts nothing: it notes what it was asked and hands back a child with a pid. */
  function fake(o: { pid?: number; fail?: Error } = { pid: 4242 }) {
    const calls: Call[] = []
    const { fail } = o
    const child = { pid: o.pid, on: vi.fn(), unref: vi.fn() }
    const start = ((file: string, args: string[], options: unknown) => {
      calls.push({ file, args, options })
      if (fail) throw fail
      return child
    }) as unknown as typeof spawn
    return { calls, child, start }
  }

  it('a Mac: caffeinate -s tied to our pid (it leaves with us), never waited for', () => {
    const f = fake()
    expect(keepAwake('darwin', {}, f.start, 777)).toBe(4242)
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0].file).toBe('/usr/bin/caffeinate')
    expect(f.calls[0].args).toEqual(['-s', '-w', '777'])
    expect(f.calls[0].options).toMatchObject({ stdio: 'ignore' })
    expect(f.child.unref).toHaveBeenCalledTimes(1)
    // A missing caffeinate is an « error » event, not a throw: someone must listen or weevilsd would stop.
    expect(f.child.on).toHaveBeenCalledWith('error', expect.any(Function))
  })

  it('Linux: nothing is started', () => {
    const f = fake()
    expect(keepAwake('linux', {}, f.start, 777)).toBeUndefined()
    expect(f.calls).toHaveLength(0)
  })

  it('WEEVILS_KEEP_AWAKE=0 (spaces around it or not): nothing is started; any other value keeps it on', () => {
    const f = fake()
    expect(keepAwake('darwin', { WEEVILS_KEEP_AWAKE: '0' }, f.start, 777)).toBeUndefined()
    expect(keepAwake('darwin', { WEEVILS_KEEP_AWAKE: ' 0 ' }, f.start, 777)).toBeUndefined()
    expect(f.calls).toHaveLength(0)
    expect(keepAwake('darwin', { WEEVILS_KEEP_AWAKE: '1' }, f.start, 777)).toBe(4242)
    expect(keepAwake('darwin', { WEEVILS_KEEP_AWAKE: '' }, f.start, 777)).toBe(4242)
    expect(f.calls).toHaveLength(2)
  })

  it('a spawn that throws, or a child that never got a pid: undefined, no throw', () => {
    expect(keepAwake('darwin', {}, fake({ pid: 4242, fail: new Error('EAGAIN') }).start, 777)).toBeUndefined()
    expect(keepAwake('darwin', {}, fake({}).start, 777)).toBeUndefined()
  })

  it('the real spawn of a command that does not exist does not throw either', async () => {
    const errors: unknown[] = []
    const onError = (e: unknown) => errors.push(e)
    process.on('uncaughtException', onError)
    try {
      const { spawn: real } = await import('node:child_process')
      const start = ((_file: string, args: string[], options: object) => real(path.join(HOME, 'no-such-caffeinate'), args, options)) as unknown as typeof spawn
      expect(keepAwake('darwin', {}, start, process.pid)).toBeUndefined()
      await new Promise((r) => setTimeout(r, 100))
      expect(errors).toEqual([])
    } finally {
      process.off('uncaughtException', onError)
    }
  })
})
