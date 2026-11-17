// scripts/test-copy.sh: a throwaway weevils is physically apart from the live one. On 2026-11-14 a hand-made script ran
// « tmux -L weevils kill-server » with a TMUX_TMPDIR that did not exist yet: tmux fell back to /tmp and closed every
// live agent session, twice. A copy now runs in a Docker container that mounts only its own folder and the
// dependencies. docker is a fake here that records its arguments.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'

const SCRIPT = path.join(import.meta.dirname, '..', 'scripts', 'test-copy.sh')
let tmp: string, root: string, bin: string, log: string, checkout: string, home: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-'))
  root = path.join(tmp, 'copies')
  bin = path.join(tmp, 'bin')
  log = path.join(tmp, 'docker.log')
  home = path.join(tmp, 'home')
  checkout = path.join(tmp, 'checkout')
  for (const d of [bin, path.join(checkout, 'server'), path.join(checkout, 'node_modules'), path.join(home, '.config', 'weevils')]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(checkout, 'server', 'index.ts'), '\n')
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\necho "$@" >> '${log}'\n`, { mode: 0o755 })
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

const env = (withDocker = true) => ({ PATH: '/usr/bin:/bin', HOME: home, WEEVILS_TEST_COPIES: root, WEEVILS_DOCKER: withDocker ? path.join(bin, 'docker') : path.join(bin, 'no-docker') })
const run = (args: string[], withDocker = true) => spawnSync(SCRIPT, args, { env: env(withDocker), encoding: 'utf8' })
const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [])

it('a copy runs in a container that mounts only its own folder and the dependencies (read-only)', () => {
  expect(run(['up', 'demo', '4490', checkout]).status).toBe(0)
  const start = calls().find((c) => c.startsWith('run '))!
  const mounts = [...start.matchAll(/-v (\S+)/g)].map((m) => m[1])
  expect(mounts).toEqual([`${path.join(root, 'demo')}:/copy`, `${fs.realpathSync(path.join(checkout, 'node_modules'))}:/copy/app/node_modules:ro`])
  expect(start).toContain('-p 127.0.0.1:4490:4490')
  expect(start).toContain('-e HOME=/copy -e TMUX_TMPDIR=/copy')
  expect(start).not.toMatch(/\.config|\.claude|tmux-\d+\/weevils|\/tmp\/tmux-/)
  // The copy gets a copy of the app, never the checkout itself.
  expect(fs.existsSync(path.join(root, 'demo', 'app', 'server', 'index.ts'))).toBe(true)
})

it('no Docker, no copy: it refuses to start next to the live weevils', () => {
  const r = run(['up', 'demo', '4490', checkout], false)
  expect(r.status).not.toBe(0)
  expect(r.stderr).toMatch(/Docker is required/)
  expect(fs.existsSync(path.join(root, 'demo'))).toBe(false)
})

it('tmux inside the copy names its own socket; kill-server, -L and -S are refused', () => {
  expect(run(['tmux', 'demo', 'ls']).status).toBe(0)
  expect(calls()).toContain(`exec weevils-copy-demo tmux -S /copy/tmux-${os.userInfo().uid}/weevils ls`)
  for (const bad of [['kill-server'], ['-L', 'weevils', 'ls'], ['-S', '/tmp/tmux-1000/weevils', 'ls']]) {
    const r = run(['tmux', 'demo', ...bad])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/not allowed/)
  }
  expect(calls().filter((c) => /kill-server|-L /.test(c))).toEqual([])
})

it('refuses the real ports, odd names, an existing folder and a folder inside the live install', () => {
  expect(run(['up', 'x', '4179', checkout]).stderr).toMatch(/real weevils/)
  expect(run(['up', '../x', '4491', checkout]).status).not.toBe(0)
  expect(run(['up', 'demo', '4490', checkout]).status).toBe(0)
  expect(run(['up', 'demo', '4490', checkout]).stderr).toMatch(/already exists/)
  const inside = spawnSync(SCRIPT, ['up', 'w', '4492', checkout], { env: { ...env(), WEEVILS_TEST_COPIES: path.join(home, '.config', 'weevils') }, encoding: 'utf8' })
  expect(inside.stderr).toMatch(/refusing to mount/)
})

it('down removes only the copy’s own container', () => {
  expect(run(['down', 'demo']).status).toBe(0)
  expect(calls().filter((c) => c.startsWith('rm '))).toEqual(['rm -f weevils-copy-demo'])
})
