// weevils-update on a git clone of the repository: it moves only to the exact main commit named in a release
// manifest signed with weevils' release key (get/sign-main.sh), checked against get/release-key.pub of the version
// installed now. Real git, real ssh-keygen, the manifest served from a file:// "setup service", a stub installer.
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const UPDATE = path.join(import.meta.dirname, 'weevils-update')
const SIGN_MAIN = path.join(import.meta.dirname, '..', 'get', 'sign-main.sh')
const haveTools = spawnSync('ssh-keygen', ['-?']).error === undefined && spawnSync('git', ['--version']).status === 0
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-update-'))
const gitEnv = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: { ...process.env, ...gitEnv }, encoding: 'utf8' }).trim()
// weevilsd stand-in, in its own process (spawnSync blocks this one): answers /api/me and /api/snapshot.
let server: ChildProcess | undefined
let port = 0
const commits: Record<string, string> = {}
const key = path.join(root, 'release')
const otherKey = path.join(root, 'other')

beforeAll(async () => {
  if (!haveTools) return
  server = spawn(process.execPath, ['-e', `const s=require('http').createServer((q,r)=>r.writeHead(200,{'content-type':'application/json'}).end('{"sessions":[]}'));s.listen(0,'127.0.0.1',()=>console.log(s.address().port))`], { stdio: ['ignore', 'pipe', 'inherit'] })
  port = await new Promise<number>((r) => server!.stdout!.once('data', (d) => r(Number(String(d).trim()))))
  for (const k of [key, otherKey]) execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'weevils-release', '-f', k])
  // History: c0 (no release key yet), c1 (the key), c2, c3 — origin/main is at c3.
  const seed = path.join(root, 'seed')
  fs.mkdirSync(path.join(seed, 'server'), { recursive: true })
  git(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git')
  git(root, 'init', '-q', '-b', 'main', 'seed')
  fs.writeFileSync(path.join(seed, 'install.sh'), '#!/bin/sh\necho status=ok\n', { mode: 0o755 })
  fs.writeFileSync(path.join(seed, 'server', 'install.sh'), '#!/bin/sh\n', { mode: 0o755 })
  const commit = (name: string, change: () => void) => {
    change()
    git(seed, 'add', '-A')
    git(seed, 'commit', '-q', '-m', name)
    commits[name] = git(seed, 'rev-parse', 'HEAD')
  }
  commit('c0', () => fs.writeFileSync(path.join(seed, 'v'), '0'))
  commit('c1', () => { fs.mkdirSync(path.join(seed, 'get')); fs.copyFileSync(key + '.pub', path.join(seed, 'get', 'release-key.pub')) })
  commit('c2', () => fs.writeFileSync(path.join(seed, 'v'), '2'))
  commit('c3', () => fs.writeFileSync(path.join(seed, 'v'), '3'))
  git(seed, 'push', '-q', path.join(root, 'origin.git'), 'main')
})
afterAll(() => {
  server?.kill()
  fs.rmSync(root, { recursive: true, force: true })
})

/** A fresh install: HOME with a clone at <at>, a "setup service" folder with a manifest naming <names>, signed by <by>. */
function install(at: string, names: string, by: string = key) {
  const home = fs.mkdtempSync(path.join(root, 'home-'))
  const dir = path.join(home, 'weevils')
  git(root, 'clone', '-q', path.join(root, 'origin.git'), dir)
  git(dir, 'reset', '-q', '--hard', commits[at])
  fs.mkdirSync(path.join(home, '.config', 'weevils'), { recursive: true })
  fs.writeFileSync(path.join(home, '.config', 'weevils', 'env'), `WEEVILS_PORT=${port}\n`)
  const get = path.join(home, 'get')
  fs.mkdirSync(get)
  execFileSync('bash', [SIGN_MAIN, commits[names], path.join(get, 'main.txt')], { env: { ...process.env, WEEVILS_RELEASE_KEY: by, WEEVILS_RELEASE_SIGNER: '' } })
  return { home, dir, get }
}
function update(i: { home: string; get: string }) {
  spawnSync('bash', [UPDATE, '--now'], { env: { PATH: process.env.PATH, HOME: i.home, WEEVILS_UPDATE_URL: `file://${i.get}`, ...gitEnv }, encoding: 'utf8', timeout: 60_000 })
  return fs.readFileSync(path.join(i.home, '.local', 'share', 'weevils', 'update.log'), 'utf8')
}

describe.skipIf(!haveTools)('weevils-update, a git clone: only the signed commit', { timeout: 30_000 }, () => {
  it('the manifest is one signed line naming the commit', () => {
    const i = install('c1', 'c2')
    expect(fs.readFileSync(path.join(i.get, 'main.txt'), 'utf8')).toBe(`weevils-release main ${commits.c2}\n`)
    expect(fs.readFileSync(path.join(i.get, 'main.txt.sig'), 'utf8')).toContain('BEGIN SSH SIGNATURE')
  })
  it('valid: fast-forwards to exactly the signed commit, not to the newer one on GitHub', () => {
    const i = install('c1', 'c2')
    const log = update(i)
    expect(git(i.dir, 'rev-parse', 'HEAD')).toBe(commits.c2)
    expect(log).toMatch(/updated to/)
  })
  it('a signature by another key: nothing changes', () => {
    const i = install('c1', 'c3', otherKey)
    expect(update(i)).toMatch(/signature does not check/)
    expect(git(i.dir, 'rev-parse', 'HEAD')).toBe(commits.c1)
  })
  it('a manifest changed after it was signed: nothing changes', () => {
    const i = install('c1', 'c2')
    fs.writeFileSync(path.join(i.get, 'main.txt'), `weevils-release main ${commits.c3}\n`)
    expect(update(i)).toMatch(/signature does not check/)
    expect(git(i.dir, 'rev-parse', 'HEAD')).toBe(commits.c1)
  })
  it('no manifest at all: nothing changes (fails closed)', () => {
    const i = install('c1', 'c2')
    fs.rmSync(path.join(i.get, 'main.txt.sig'))
    expect(update(i)).toMatch(/no signed release manifest/)
    expect(git(i.dir, 'rev-parse', 'HEAD')).toBe(commits.c1)
  })
  it('no release key in the version installed now: nothing changes', () => {
    const i = install('c0', 'c2')
    expect(update(i)).toMatch(/no release key/)
    expect(git(i.dir, 'rev-parse', 'HEAD')).toBe(commits.c0)
  })
  it('a signed commit that is not a descendant (an older manifest served again): nothing changes', () => {
    const i = install('c2', 'c1')
    expect(update(i)).toMatch(/not a descendant/)
    expect(git(i.dir, 'rev-parse', 'HEAD')).toBe(commits.c2)
  })
})
