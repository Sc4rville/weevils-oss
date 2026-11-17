// The machine page on macOS (server/infra.ts): no /proc, no ss. Memory comes from vm_stat and the listening servers
// from lsof. Run on Linux: the platform and the command runner are injected, the outputs are canned (written from
// lsof's documented field format, not captured on a Mac).
import { describe, expect, it, vi } from 'vitest'
import { HOME } from './config.ts'
import { macCwds, macListeners, memUsage, parseLsofCwd, parseLsofListeners, refreshMem, servers } from './infra.ts'
import { availableMem } from './platform.ts'

// `lsof -nP -iTCP -sTCP:LISTEN -F pcn`: one block per process; lsof adds an f<fd> line before each name.
const LISTEN = [
  'p412',
  'cControlCenter',
  'f10',
  'n*:7000',
  'f11',
  'n*:7000',
  'f12',
  'n*:5000',
  'p61234',
  'cnode',
  'f23',
  'n127.0.0.1:5173',
  'p61300',
  'cPython',
  'f3',
  'n[::1]:8000',
  'f4',
  'n127.0.0.1:8000',
  'p61377',
  'cnode',
  'f19',
  'n[fe80::1%lo0]:9000',
  '',
].join('\n')

// `lsof -a -p 412,61234,61300,61377 -d cwd -Fn`: the pid, the descriptor (cwd), its folder.
const cwd = (home: string) => ['p412', 'fcwd', 'n/', 'p61234', 'fcwd', `n${home}/projects/my game`, 'p61300', 'fcwd', `n${home}/projects/site`, ''].join('\n')

describe('macOS — listening servers (lsof)', () => {
  it('reads every listening socket with its process, whatever the address form', () => {
    expect(parseLsofListeners(LISTEN)).toEqual([
      { port: 7000, addr: '*', pid: 412, name: 'ControlCenter' },
      { port: 7000, addr: '*', pid: 412, name: 'ControlCenter' },
      { port: 5000, addr: '*', pid: 412, name: 'ControlCenter' },
      { port: 5173, addr: '127.0.0.1', pid: 61234, name: 'node' },
      { port: 8000, addr: '::1', pid: 61300, name: 'Python' },
      { port: 8000, addr: '127.0.0.1', pid: 61300, name: 'Python' },
      { port: 9000, addr: 'fe80::1', pid: 61377, name: 'node' },
    ])
    expect(parseLsofListeners('')).toEqual([])
    // A name that is no address:port (a warning, a socket without a port) is skipped, never a crash.
    expect(parseLsofListeners('p1\ncx\nn/private/tmp/sock\nnlsof: WARNING\n')).toEqual([])
  })

  it('reads the working folder of each process, spaces included', () => {
    expect([...parseLsofCwd(cwd('/Users/sam'))]).toEqual([
      [412, '/'],
      [61234, '/Users/sam/projects/my game'],
      [61300, '/Users/sam/projects/site'],
    ])
    // No folder given for a process (not ours, or gone): no entry.
    expect(parseLsofCwd('p9\nfcwd\np10\nfcwd\nn/Users/sam\n')).toEqual(new Map([[10, '/Users/sam']]))
  })

  it('servers(): one line per port, the process name and its folder under ~, sorted; two lsof calls, never ss', async () => {
    const run = vi.fn(async (_file: string, args: string[]) => (args.includes('-iTCP') ? LISTEN : cwd(HOME)))
    expect(await servers('darwin', run)).toEqual([
      { port: 5000, name: 'ControlCenter', dir: '/', url: undefined },
      { port: 5173, name: 'node', dir: '~/projects/my game', url: undefined },
      { port: 7000, name: 'ControlCenter', dir: '/', url: undefined },
      { port: 8000, name: 'Python', dir: '~/projects/site', url: undefined },
      // Its process went away between the two calls: listed, without a folder.
      { port: 9000, name: 'node', dir: undefined, url: undefined },
    ])
    expect(run.mock.calls).toEqual([
      ['/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn']],
      ['/usr/sbin/lsof', ['-a', '-p', '412,61234,61300,61377', '-d', 'cwd', '-Fn']],
    ])
  })

  it('nothing listening, or lsof unable to run: an empty list and no second call', async () => {
    const run = vi.fn(async () => '')
    expect(await servers('darwin', run)).toEqual([])
    expect(await macListeners(run)).toEqual([])
    expect((await macCwds([], run)).size).toBe(0)
    expect(run).toHaveBeenCalledTimes(2)
  })
})

describe('macOS — memory (vm_stat)', () => {
  const GB = 1024 ** 3
  const VM_STAT = [
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
    'Pages free:                                3204.',
    'Pages active:                            262144.',
    'Pages inactive:                          196608.',
    'Pages speculative:                         2048.',
    'Pages wired down:                        131072.',
    'Pages purgeable:                           4096.',
    'Pages occupied by compressor:             65536.',
  ].join('\n')

  it('used = total minus what vm_stat says is available, not minus os.freemem()', async () => {
    const free = () => 3204 * 16384
    const avail = await refreshMem('darwin', (p) => availableMem(p, async () => VM_STAT, free))
    expect(avail).toBe((3204 + 196608 + 2048 + 4096) * 16384)
    const m = memUsage('', 16 * GB, avail!)
    expect(m).toEqual({ total: 16 * GB, used: 16 * GB - avail!, swapTotal: 0, swapUsed: 0 })
    // 80 % here; os.freemem() alone would read 100 % (and the machine would look saturated all day).
    expect(Math.round((m.used / m.total) * 100)).toBe(80)
    expect(Math.round((memUsage('', 16 * GB, free()).used / (16 * GB)) * 100)).toBe(100)
  })

  it('vm_stat failing keeps the last value; Linux never reads it', async () => {
    const before = await refreshMem('darwin', async () => 5 * GB)
    expect(before).toBe(5 * GB)
    expect(
      await refreshMem('darwin', async () => {
        throw new Error('no vm_stat')
      }),
    ).toBe(5 * GB)
    const read = vi.fn(async () => 1)
    expect(await refreshMem('linux', read)).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })

  it('Linux: /proc/meminfo as before (MemAvailable, swap)', () => {
    const txt = ['MemTotal:       16000000 kB', 'MemFree:          200000 kB', 'MemAvailable:    6000000 kB', 'SwapTotal:       2000000 kB', 'SwapFree:        1500000 kB'].join('\n')
    expect(memUsage(txt, 1, 1)).toEqual({ total: 16000000 * 1024, used: 10000000 * 1024, swapTotal: 2000000 * 1024, swapUsed: 500000 * 1024 })
  })
})
