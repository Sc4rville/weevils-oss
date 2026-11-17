import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RunArchive, blobPath, extractLinks, gitFiles, headOf, journalRuns, mtimeFiles, parseDiff, unitDescriptions } from './auto-runs.ts'

let dir: string
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'auto-runs-')))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const write = (f: string, text = 'x\n', mtime?: number) => {
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, text)
  if (mtime !== undefined) fs.utimesSync(f, mtime / 1000, mtime / 1000)
  return f
}

describe('auto runs — what a run left', () => {
  it('links of a report and a message: once each, in order, trailing punctuation off', () => {
    expect(extractLinks('See https://example.com/a. And (https://x.org/b?c=1), https://example.com/a', 'last: https://gh.io/z!')).toEqual(['https://example.com/a', 'https://x.org/b?c=1', 'https://gh.io/z'])
    expect(extractLinks(undefined, 'no link here')).toEqual([])
  })

  it('a git diff -z: counts and statuses, a rename, a binary file', () => {
    const num = ['3\t1\tsrc/a.ts', '-\t-\tshot.png', '0\t0\t', 'old.md', 'new.md', ''].join('\0')
    const names = ['M', 'src/a.ts', 'A', 'shot.png', 'R100', 'old.md', 'new.md', 'D', 'gone.txt', ''].join('\0')
    expect(parseDiff(num, names, '/w')).toEqual([
      { path: 'src/a.ts', abs: '/w/src/a.ts', status: 'M', add: 3, del: 1 },
      { path: 'shot.png', abs: '/w/shot.png', status: 'A', add: 0, del: 0 },
      { path: 'new.md', abs: '/w/new.md', status: 'R', add: 0, del: 0 },
      { path: 'gone.txt', abs: '/w/gone.txt', status: 'D', add: 0, del: 0 },
    ])
  })

  /** A repo with one commit, and a task's worktree of it (git worktree add): what the runner diffs. */
  const repoAndWorktree = () => {
    const repo = path.join(dir, 'repo')
    const wt = path.join(dir, '.auto', 'repo', 'task1')
    const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-C', cwd, ...a], { stdio: 'pipe' }).toString().trim()
    fs.mkdirSync(repo, { recursive: true })
    g(repo, 'init', '-q')
    write(path.join(repo, 'a.ts'), 'one\n')
    write(path.join(repo, 'old.ts'), 'old\n')
    g(repo, 'add', '.')
    g(repo, 'commit', '-qm', 'base')
    fs.mkdirSync(path.dirname(wt), { recursive: true })
    g(repo, 'worktree', 'add', '-q', wt, '-b', 'auto/t')
    return { repo, wt, g, base: g(wt, 'rev-parse', 'HEAD') }
  }

  it('the files of a run in a worktree: its commits and what it wrote since it started, not what an earlier run left', async () => {
    const { repo, wt, g, base } = repoAndWorktree()
    expect(await headOf(repo, wt)).toBe(base)
    const before = Date.now() - 3600_000
    // Left by an earlier run: an uncommitted change and an untracked file, both older than this run.
    write(path.join(wt, 'old.ts'), 'old\nchanged\n', before)
    write(path.join(wt, 'stale.md'), 'stale\n', before)
    const start = Date.now() - 60_000
    // This run: a commit, an uncommitted change, a new file.
    write(path.join(wt, 'a.ts'), 'one\ntwo\nthree\n')
    g(wt, 'commit', '-qm', 'run', 'a.ts')
    write(path.join(wt, 'b.ts'), 'b\nb\n')
    write(path.join(wt, 'shot.png'), 'PNG')
    const files = await gitFiles(repo, wt, base, start)
    expect(files!.map((f) => [f.path, f.status, f.add, f.del])).toEqual([
      ['a.ts', 'M', 2, 0],
      ['b.ts', 'A', 2, 0],
      ['shot.png', 'A', 1, 0],
    ])
    expect(files![0].abs).toBe(path.join(wt, 'a.ts'))
    // Without a start, everything since the base.
    expect((await gitFiles(repo, wt, base))!.map((f) => f.path).sort()).toEqual(['a.ts', 'b.ts', 'old.ts', 'shot.png', 'stale.md'])
    // Not a worktree of that repo: git is not asked.
    expect(await gitFiles(repo, path.join(dir, 'nope'), base)).toBeNull()
    expect(await gitFiles(path.join(dir, 'nope'), wt, base)).toBeNull()
  })

  it('a worktree that points git at a config of its own: the server never runs its filter (nor its fsmonitor)', async () => {
    const { repo, wt, base } = repoAndWorktree()
    const pwned = path.join(dir, 'pwned')
    const evil = path.join(wt, 'evil')
    // What a jailed agent can write: the worktree's .git file, the admin dir's commondir, attributes.
    fs.mkdirSync(evil)
    execFileSync('git', ['init', '-q', '--bare', evil])
    execFileSync('git', ['--git-dir', evil, 'config', 'core.bare', 'false'])
    fs.writeFileSync(path.join(evil, 'objects', 'info', 'alternates'), path.join(repo, '.git', 'objects'))
    const cmd = `touch ${pwned}`
    fs.appendFileSync(path.join(evil, 'config'), `[filter "e"]\n\tclean = ${cmd} && cat\n[core]\n\tfsmonitor = ${cmd}\n`)
    const admin = fs.readFileSync(path.join(wt, '.git'), 'utf8').replace(/^gitdir:\s*/, '').trim()
    fs.writeFileSync(path.join(admin, 'commondir'), evil)
    fs.copyFileSync(path.join(admin, 'index'), path.join(evil, 'index'))
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${evil}\n`)
    write(path.join(wt, '.gitattributes'), '* filter=e\n')
    write(path.join(wt, 'a.ts'), 'one\nchanged\n')
    await headOf(repo, wt)
    const files = await gitFiles(repo, wt, base)
    expect(fs.existsSync(pwned)).toBe(false)
    expect(files?.map((f) => f.path)).toContain('a.ts')
    // The trap is armed: git left to find its own dirs from the worktree runs it.
    execFileSync('git', ['-c', 'core.fsmonitor=false', '-C', wt, 'diff', '-z', '--no-ext-diff', '--no-textconv', '--numstat', base], { stdio: 'pipe' })
    expect(fs.existsSync(pwned)).toBe(true)
  })

  it('the files of a run without a repo: written during the run, hidden ones and the report left out', () => {
    const t = Date.now()
    write(path.join(dir, 'notes.md'), 'a\nb\n', t - 30_000)
    write(path.join(dir, 'sub', 'shot.png'), 'PNG', t - 20_000)
    write(path.join(dir, 'report.md'), 'r', t - 10_000)
    write(path.join(dir, '.hidden'), 'h', t - 10_000)
    write(path.join(dir, 'before.md'), 'b', t - 3600_000)
    const files = mtimeFiles(dir, t - 60_000, t, [path.join(dir, 'report.md')])
    expect(files.map((f) => f.path)).toEqual(['notes.md', 'sub/shot.png'])
    expect(files[0]).toMatchObject({ status: 'A', add: 2 })
  })
})

describe('auto runs — images served', () => {
  it('only an image under its roots, real path checked: no « .. », no link out, no other file', () => {
    const ws = path.join(dir, 'ws')
    const arch = path.join(dir, 'arch')
    const outside = write(path.join(dir, 'secret.png'), 'PNG')
    const shot = write(path.join(ws, 'shots', 'a.png'), 'PNG')
    const kept = write(path.join(arch, '1', '0-b.webp'), 'WEBP')
    write(path.join(ws, 'notes.txt'), 'text')
    fs.symlinkSync(outside, path.join(ws, 'link.png'))
    fs.symlinkSync(dir, path.join(ws, 'up'))
    const roots = [ws, arch]
    expect(blobPath(shot, roots)).toBe(shot)
    expect(blobPath('shots/a.png', roots)).toBe(shot)
    expect(blobPath(kept, roots)).toBe(kept)
    expect(blobPath(outside, roots)).toBeNull()
    expect(blobPath('../secret.png', roots)).toBeNull()
    expect(blobPath(`${ws}/shots/../../secret.png`, roots)).toBeNull()
    expect(blobPath('link.png', roots)).toBeNull()
    expect(blobPath('up/secret.png', roots)).toBeNull()
    expect(blobPath('notes.txt', roots)).toBeNull()
    expect(blobPath('shots', roots)).toBeNull()
    expect(blobPath('missing.png', roots)).toBeNull()
    expect(blobPath('a\0.png', roots)).toBeNull()
    expect(blobPath(42, roots)).toBeNull()
    expect(blobPath(shot, [])).toBeNull()
  })
})

describe('auto runs — the archive', () => {
  it('writes, reads, copies the images beside, prunes with the runs', () => {
    const a = new RunArchive(path.join(dir, 'auto'))
    const img = write(path.join(dir, 'ws', 'shot.png'), 'PNG')
    const files = [
      { path: 'shot.png', abs: img, status: 'A' as const, add: 0, del: 0 },
      { path: 'gone.png', abs: path.join(dir, 'ws', 'gone.png'), status: 'D' as const, add: 0, del: 0 },
    ]
    const images = a.copyImages('t1', 100, files)
    expect(images).toEqual([path.join(dir, 'auto', 't1', '100', '0-shot.png')])
    a.write('t1', { run: { at: 200, startedAt: 100, ok: true }, report: 'r', files, links: [], images })
    a.write('t1', { run: { at: 400, startedAt: 300, ok: false }, files: [], links: [], images: [] })
    expect(a.read('t1', 100)).toMatchObject({ report: 'r', images })
    a.prune('t1', [300])
    expect(a.read('t1', 100)).toBeNull()
    expect(fs.existsSync(path.join(dir, 'auto', 't1', '100'))).toBe(false)
    expect(a.read('t1', 300)).toMatchObject({ run: { ok: false } })
    expect(() => a.home('../x')).toThrow()
  })
})

describe('auto runs — systemd timers', () => {
  it('one run per invocation in the journal: first and last line, failed on a non-zero exit', () => {
    const line = (inv: string, us: number, extra: Record<string, unknown> = {}) => JSON.stringify({ _SYSTEMD_INVOCATION_ID: inv, __REALTIME_TIMESTAMP: String(us * 1000), MESSAGE: `m${us}`, ...extra })
    const out = [
      line('b', 5_000),
      line('a', 1_000),
      line('a', 3_000),
      JSON.stringify({ USER_INVOCATION_ID: 'a', __REALTIME_TIMESTAMP: '4000000', MESSAGE: 'Finished.' }),
      line('b', 9_000, { EXIT_STATUS: '1' }),
      JSON.stringify({ __REALTIME_TIMESTAMP: '9500000', MESSAGE: 'condition failed' }),
      'not json',
    ].join('\n')
    const runs = journalRuns(out)
    expect(runs.map(({ inv, startedAt, at, ok, lines }) => ({ inv, startedAt, at, ok, lines }))).toEqual([
      { inv: 'a', startedAt: 1_000, at: 4_000, ok: true, lines: ['m1000', 'm3000'] },
      { inv: 'b', startedAt: 5_000, at: 9_000, ok: false, lines: ['m5000', 'm9000'] },
    ])
  })

  it('the Description= of each unit', () => {
    const show = 'Id=wv-digest.timer\nDescription=Daily digest\nTimersCalendar=x\n\nId=wv-digest.service\nDescription=Write the digest\n\nId=wv-x.timer\nDescription=\n'
    expect([...unitDescriptions(show)]).toEqual([
      ['wv-digest.timer', 'Daily digest'],
      ['wv-digest.service', 'Write the digest'],
    ])
  })
})
