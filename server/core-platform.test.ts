// What the daemon does differently without Linux's /proc, systemd and long PATH (a Mac): finding the claude process a
// hook came from and the automation band without timers (server/core.ts), commands found where installers put them
// (server/fast.ts). Run here on Linux with the reader, the platform and the PATH passed in.
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { H24Activity } from '../shared/api.ts'

// Every command core.ts starts with execFile, and what it gets back (an error by default, as on a Mac).
const sh = vi.hoisted(() => ({ calls: [] as { cmd: string; args: string[] }[], answer: (_cmd: string, _args: string[]): string | null => null }))
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFile: (cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    sh.calls.push({ cmd, args })
    const out = sh.answer(cmd, args)
    queueMicrotask(() => (out === null ? cb(Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' }), '', '') : cb(null, out, '')))
    return { stdin: { end() {} } }
  },
}))

const { Weevils, findClaudePid, parsePsParent, psReader } = await import('./core.ts')
type ProcRead = import('./core.ts').ProcRead
const { HOME } = await import('./config.ts')
const { edgeTts, toolCommand } = await import('./fast.ts')

/** A process table: pid → [parent, argv]. Read the way /proc gives it (arguments separated by NUL). */
const table = (rows: Record<number, [number, string[]]>, seen: number[] = []): ProcRead => ({
  cmd: (pid) => {
    seen.push(pid)
    if (!rows[pid]) throw new Error('ENOENT')
    return rows[pid][1].join('\0') + '\0'
  },
  ppid: (pid) => {
    if (!rows[pid]) throw new Error('ENOENT')
    return rows[pid][0]
  },
})

describe('findClaudePid', () => {
  it('the hook’s parent is claude itself', () => {
    expect(findClaudePid(500, table({ 500: [400, ['claude', '--dangerously-skip-permissions']], 400: [1, ['tmux']] }))).toBe(500)
  })

  it('climbs from the hook’s shell to claude: by name, by path, or as node running claude-code', () => {
    const sh1: [number, string[]] = [500, ['/bin/sh', '-c', '/home/u/.local/bin/weevils-hook']]
    expect(findClaudePid(600, table({ 600: sh1, 500: [1, ['claude']] }))).toBe(500)
    expect(findClaudePid(600, table({ 600: sh1, 500: [1, ['/Users/u/.local/bin/claude', '--resume', 'abc']] }))).toBe(500)
    expect(findClaudePid(600, table({ 600: sh1, 500: [1, ['node', '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js']] }))).toBe(500)
    expect(findClaudePid(700, table({ 700: [600, ['sh']], 600: [500, ['bash', '-lc', 'x']], 500: [1, ['claude']] }))).toBe(500)
  })

  it('a folder or a word that only holds « claude » is not the process', () => {
    const rows = { 600: [500, ['/bin/sh', '/home/u/.claude/hooks/run.sh']], 500: [400, ['vim', '/home/u/claude/notes.md']], 400: [1, ['claudette', '--x']] } as Record<number, [number, string[]]>
    expect(findClaudePid(600, table(rows))).toBeUndefined()
  })

  it('stops at pid 1, at a process that is gone, and after 8 parents', () => {
    expect(findClaudePid(1, table({ 1: [0, ['claude']] }))).toBeUndefined()
    expect(findClaudePid(600, table({ 600: [1, ['sh']] }))).toBeUndefined()
    expect(findClaudePid(600, table({ 600: [555, ['sh']] }))).toBeUndefined()
    const deep: Record<number, [number, string[]]> = { 99: [1, ['claude']] }
    for (let p = 100; p < 110; p++) deep[p] = [p - 1, ['sh']]
    const seen: number[] = []
    expect(findClaudePid(109, table(deep, seen))).toBeUndefined()
    expect(seen).toHaveLength(8)
    expect(findClaudePid(106, table(deep))).toBe(99)
  })

  it.skipIf(process.platform !== 'linux')('Linux, by default: /proc (this very process is not claude, a dead pid is nothing)', () => {
    expect(findClaudePid(999_999_999)).toBeUndefined()
    const mine = findClaudePid(process.pid)
    expect(mine === undefined || mine > 1).toBe(true)
  })
})

describe('parsePsParent (`ps -o ppid= -o command= -p <pid>` on a Mac)', () => {
  it('the parent, then the command line with its arguments separated as /proc does', () => {
    expect(parsePsParent('  501 claude --dangerously-skip-permissions --session-id 1b2c\n')).toEqual({ ppid: 501, cmd: 'claude\0--dangerously-skip-permissions\0--session-id\x001b2c' })
    expect(parsePsParent('    1 /Users/u/.local/bin/claude\n')).toEqual({ ppid: 1, cmd: '/Users/u/.local/bin/claude' })
    expect(parsePsParent('71234 /bin/sh  -c   /Users/u/.local/bin/weevils-hook  \n')?.cmd).toBe('/bin/sh\0-c\0/Users/u/.local/bin/weevils-hook')
  })

  it('no such process (ps prints nothing), or a line that is not ps’s: null', () => {
    expect(parsePsParent('')).toBeNull()
    expect(parsePsParent('\n')).toBeNull()
    expect(parsePsParent('ps: illegal option')).toBeNull()
    expect(parsePsParent('  501 \n')).toBeNull()
  })
})

describe('psReader (macOS)', () => {
  /** A fake ps over a table, counting its runs; a missing pid fails as ps does (exit 1). */
  function ps(rows: Record<number, [number, string]>) {
    const runs: number[] = []
    const run = (pid: number) => {
      runs.push(pid)
      if (!rows[pid]) throw new Error('Command failed: ps')
      return `${String(rows[pid][0]).padStart(5)} ${rows[pid][1]}\n`
    }
    return { runs, run }
  }
  const rows: Record<number, [number, string]> = {
    700: [600, '/bin/sh /Users/u/.local/bin/weevils-hook'],
    600: [500, '/bin/zsh -c /Users/u/.local/bin/weevils-hook'],
    500: [400, 'claude --dangerously-skip-permissions'],
    400: [1, 'tmux -u -L weevils new-session'],
  }

  it('findClaudePid over ps: the same climb as on Linux', () => {
    const { run, runs } = ps(rows)
    expect(findClaudePid(700, psReader(run, () => 0))).toBe(500)
    expect(runs).toEqual([700, 600, 500])
    expect(findClaudePid(400, psReader(run, () => 0))).toBeUndefined()
    expect(findClaudePid(12345, psReader(run, () => 0))).toBeUndefined()
  })

  it('one ps per process, then kept 10 s: a burst of hooks from the same claude starts none', () => {
    const { run, runs } = ps(rows)
    let now = 1_000_000
    const read = psReader(run, () => now)
    for (let i = 0; i < 50; i++) expect(findClaudePid(500, read)).toBe(500)
    expect(runs).toEqual([500])
    // A hook whose parent is a fresh shell each time: one ps for that shell, claude is already known.
    rows[701] = [500, '/bin/sh /Users/u/.local/bin/weevils-hook']
    expect(findClaudePid(701, read)).toBe(500)
    expect(runs).toEqual([500, 701])
    now += 9_999
    expect(findClaudePid(500, read)).toBe(500)
    expect(runs).toHaveLength(2)
    now += 2
    expect(findClaudePid(500, read)).toBe(500)
    expect(runs).toEqual([500, 701, 500])
    delete rows[701]
  })

  it('a process that is gone is remembered as gone for as long (no ps per hook for it), then asked again', () => {
    const { run, runs } = ps({ ...rows })
    let now = 0
    const read = psReader(run, () => now)
    for (let i = 0; i < 5; i++) expect(findClaudePid(4242, read)).toBeUndefined()
    expect(runs).toEqual([4242])
    now += 10_000
    expect(findClaudePid(4242, read)).toBeUndefined()
    expect(runs).toEqual([4242, 4242])
  })

  it('at most 8 ps in a second: beyond that the process is unreadable for now, and readable again the next second', () => {
    const many: Record<number, [number, string]> = {}
    for (let p = 2000; p < 2020; p++) many[p] = [500, 'sh hook']
    const { run, runs } = ps({ ...rows, ...many })
    let now = 5_000
    const read = psReader(run, () => now)
    expect(findClaudePid(2000, read)).toBe(500) // 2 ps: the shell, then claude
    for (let p = 2001; p < 2007; p++) expect(findClaudePid(p, read)).toBe(500) // 6 more
    expect(runs).toHaveLength(8)
    expect(findClaudePid(2007, read)).toBeUndefined()
    expect(findClaudePid(2008, read)).toBeUndefined()
    expect(runs).toHaveLength(8)
    // What is already known still answers.
    expect(findClaudePid(2003, read)).toBe(500)
    now += 1000
    expect(findClaudePid(2007, read)).toBe(500)
    expect(runs).toHaveLength(9)
  })

  it('what was seen is dropped once 512 processes are held: the table never grows without end', () => {
    const { run, runs } = ps({})
    const read = psReader(run, () => 0, 10_000, 1_000_000)
    findClaudePid(2, read)
    findClaudePid(2, read)
    expect(runs).toEqual([2])
    for (let p = 3; p < 600; p++) findClaudePid(p, read)
    runs.length = 0
    findClaudePid(2, read)
    expect(runs).toEqual([2])
  })

  it.skipIf(!fs.existsSync('/bin/ps'))('with the real /bin/ps: this process’s parent and command line are read', () => {
    const read = psReader()
    expect(read.ppid(process.pid)).toBe(process.ppid)
    expect(read.cmd(process.pid).split('\0')[0]).toContain('node')
    expect(() => read.cmd(999_999_999)).toThrow()
  })
})

describe('commands found under a service’s short PATH (server/fast.ts)', () => {
  const exe = (dir: string, name: string) => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, name), '#!/bin/sh\n', { mode: 0o755 })
    return path.join(dir, name)
  }

  it('toolCommand: the bare name while the PATH has the command, exactly as before', () => {
    expect(toolCommand('claude', '/usr/local/bin:/usr/bin:/bin', () => '/usr/bin/claude')).toBe('claude')
    expect(toolCommand('codex', '/home/u/.local/bin:/usr/bin', () => '/home/u/.local/bin/codex')).toBe('codex')
  })

  it('toolCommand: found only where installers put it (launchd’s PATH on a Mac): its full path', () => {
    const launchd = '/usr/bin:/bin:/usr/sbin:/sbin'
    expect(toolCommand('claude', launchd, () => '/Users/u/.local/bin/claude')).toBe('/Users/u/.local/bin/claude')
    expect(toolCommand('codex', launchd, () => '/opt/homebrew/bin/codex')).toBe('/opt/homebrew/bin/codex')
    expect(toolCommand('claude', '', () => '/Users/u/.claude/local/claude')).toBe('/Users/u/.claude/local/claude')
  })

  it('toolCommand: not installed anywhere: the bare name, so the failure is the usual « command not found »', () => {
    expect(toolCommand('claude', '/usr/bin:/bin', () => null)).toBe('claude')
  })

  it('toolCommand, for real: a command of ~/.local/bin that the PATH lacks is given by its path; in the PATH, by its name', () => {
    const bin = exe(path.join(HOME, '.local', 'bin'), 'wv-fake-agent')
    vi.stubEnv('PATH', '/usr/bin:/bin')
    try {
      expect(toolCommand('wv-fake-agent')).toBe(bin)
      vi.stubEnv('PATH', `/usr/bin:${path.dirname(bin)}`)
      expect(toolCommand('wv-fake-agent')).toBe('wv-fake-agent')
      expect(toolCommand('wv-no-such-agent')).toBe('wv-no-such-agent')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('edgeTts: in the PATH, else in ~/.local/bin (pipx); a file that cannot be run does not count; null when absent', () => {
    vi.stubEnv('PATH', path.join(HOME, 'empty-bin'))
    try {
      const local = path.join(HOME, '.local', 'bin', 'edge-tts')
      fs.rmSync(local, { force: true })
      expect(edgeTts()).toBeNull()
      exe(path.dirname(local), 'edge-tts')
      fs.chmodSync(local, 0o644)
      expect(edgeTts()).toBeNull()
      fs.chmodSync(local, 0o755)
      expect(edgeTts()).toBe(local)
      const first = exe(path.join(HOME, 'empty-bin'), 'edge-tts')
      expect(edgeTts()).toBe(first)
    } finally {
      vi.unstubAllEnvs()
      fs.rmSync(path.join(HOME, 'empty-bin'), { recursive: true, force: true })
      fs.rmSync(path.join(HOME, '.local', 'bin', 'edge-tts'), { force: true })
    }
  })
})

describe('the automation band without systemd (a Mac)', () => {
  /** A Weevils that only knows how to publish its jobs: no constructor (it would start every watcher). */
  function band() {
    const w = Object.create(Weevils.prototype) as InstanceType<typeof Weevils>
    Object.assign(w, { h24: [], bump: vi.fn(), timerSvc: new Map(), timerRunsCache: new Map(), timerRunsLoading: new Map(), timerEvery: null })
    return w as InstanceType<typeof Weevils> & { bump: ReturnType<typeof vi.fn> }
  }
  const settle = () => new Promise((r) => setTimeout(r, 20))
  const timers = JSON.stringify([
    { next: 1794700800000000, left: 1, last: 1794614400000000, passed: 1, unit: 'wv-nightly.timer', activates: 'wv-nightly.service' },
    { next: 1794700800000000, left: 1, last: null, passed: null, unit: 'apt-daily.timer', activates: 'apt-daily.service' },
  ])

  beforeEach(() => {
    sh.calls.length = 0
    sh.answer = () => null
    fs.rmSync(path.join(HOME, 'logs'), { recursive: true, force: true })
    fs.mkdirSync(path.join(HOME, 'logs'), { recursive: true })
    fs.writeFileSync(path.join(HOME, 'logs', 'site-build.log'), 'step 1\nstep 2 done\n')
  })

  it('macOS: the jobs of ~/logs are published at once, and systemctl or journalctl is never started', async () => {
    const w = band()
    w.refreshH24('darwin')
    // Published before any callback could run: nothing was waited for.
    expect(w.h24.map((a: H24Activity) => a.id)).toEqual(['job:site-build'])
    expect(w.h24[0]).toMatchObject({ kind: 'job', runState: 'running', lastEvent: 'step 2 done', canToggle: false })
    expect(w.bump).toHaveBeenCalledTimes(1)
    await settle()
    expect(sh.calls).toEqual([])
    // Pass after pass: still nothing started, and nothing republished while nothing changed.
    for (let i = 0; i < 5; i++) w.refreshH24('darwin')
    await settle()
    expect(sh.calls).toEqual([])
    expect(w.bump).toHaveBeenCalledTimes(1)
  })

  it('macOS with no job at all: an empty band, still no command', async () => {
    fs.rmSync(path.join(HOME, 'logs'), { recursive: true, force: true })
    const w = band()
    w.refreshH24('darwin')
    await settle()
    expect(w.h24).toEqual([])
    expect(sh.calls).toEqual([])
  })

  it('macOS: nothing there can be paused, and a timer’s page is nothing, without a command either', async () => {
    const w = band()
    w.refreshH24('darwin')
    await expect(w.toggleH24('job:site-build')).rejects.toThrow()
    await expect(w.toggleH24('timer:wv-nightly.timer')).rejects.toThrow()
    expect(await w.h24Detail('timer:wv-nightly.timer')).toBeNull()
    expect(await w.h24Run('timer:wv-nightly.timer', 1)).toBeNull()
    expect(await w.h24Detail('job:site-build')).toMatchObject({ id: 'job:site-build', runs: [] })
    await settle()
    expect(sh.calls).toEqual([])
  })

  it('Linux: unchanged, systemctl lists the timers and the wv-* ones join the jobs', async () => {
    sh.answer = (cmd, args) => (cmd === 'systemctl' && args.includes('list-timers') ? timers : cmd === 'systemctl' && args.includes('show') ? '' : null)
    const w = band()
    w.refreshH24('linux')
    expect(w.h24).toEqual([]) // nothing is published before systemctl answered
    await settle()
    expect(sh.calls[0]).toEqual({ cmd: 'systemctl', args: ['--user', 'list-timers', '--all', '--output=json'] })
    expect(sh.calls[1].cmd).toBe('systemctl')
    expect(sh.calls[1].args.slice(0, 4)).toEqual(['--user', 'show', 'wv-nightly.timer', 'wv-nightly.service'])
    expect(w.h24.map((a: H24Activity) => a.id).sort()).toEqual(['job:site-build', 'timer:wv-nightly.timer'])
    expect(w.h24.find((a: H24Activity) => a.kind === 'timer')).toMatchObject({ title: 'nightly', canToggle: true, enabled: true })
  })

  it('Linux without systemd --user (a container): the jobs are still published', async () => {
    const w = band()
    w.refreshH24('linux')
    await settle()
    expect(sh.calls.map((c) => c.cmd)).toEqual(['systemctl'])
    expect(w.h24.map((a: H24Activity) => a.id)).toEqual(['job:site-build'])
  })
})
