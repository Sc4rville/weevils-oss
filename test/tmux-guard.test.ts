// server/tmux-guard (installed as ~/.local/bin/tmux): nothing but the weevils server closes the live weevils sessions.
// The first case replays the 2026-11-14 09:01 script exactly: « TMUX_TMPDIR=$H tmux -L weevils kill-server » with an $H
// that does not exist yet, which made tmux fall back to /tmp and close every live agent session.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const GUARD = path.join(import.meta.dirname, '..', 'server', 'tmux-guard')
const uid = os.userInfo().uid
let tmp: string, data: string, fallback: string, live: string, log: string, fake: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-'))
  data = path.join(tmp, 'data')
  fallback = path.join(tmp, 'fallback')
  live = path.join(fallback, `tmux-${uid}`, 'weevils')
  log = path.join(tmp, 'real.log')
  fake = path.join(tmp, 'real-tmux')
  fs.mkdirSync(data, { recursive: true })
  fs.mkdirSync(path.dirname(live), { recursive: true })
  fs.writeFileSync(path.join(data, 'tmux-token'), 'secret-token\n')
  fs.writeFileSync(fake, `#!/bin/sh\necho "$@" >> '${log}'\n`, { mode: 0o755 })
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function guard(args: string[], env: Record<string, string> = {}, real = fake) {
  const base = { PATH: process.env.PATH!, HOME: tmp, WEEVILS_GUARD_DATA: data, WEEVILS_GUARD_FALLBACK: fallback, WEEVILS_REAL_TMUX: real }
  return spawnSync(GUARD, args, { env: { ...base, ...env }, encoding: 'utf8' })
}
const reached = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [])

describe('the 09:01 script', () => {
  it('« TMUX_TMPDIR=<missing> tmux -L weevils kill-server » never reaches tmux, says why and is logged', () => {
    const r = guard(['-L', 'weevils', 'kill-server'], { TMUX_TMPDIR: path.join(tmp, 'not-created-yet') })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/refused/)
    expect(reached()).toEqual([])
    expect(fs.readFileSync(path.join(data, 'tmux-guard.log'), 'utf8')).toMatch(/refused: tmux -L weevils kill-server/)
  })
})

describe('what is refused without the server token', () => {
  const cases: [string, string[], Record<string, string>][] = [
    ['kill-server on the default live socket', ['-L', 'weevils', 'kill-server'], {}],
    ['an abbreviated command', ['-L', 'weevils', 'kill-ser'], {}],
    ['kill-session of one live session', ['-L', 'weevils', 'kill-session', '-t', '=wv-app-1:'], {}],
    ['kill-server chained after another command', ['-L', 'weevils', 'ls', ';', 'kill-server'], {}],
    ['the live socket by its path', ['-S', '__LIVE__', 'kill-server'], {}],
    ['from inside a live pane, no -L', ['kill-server'], { TMUX: '__LIVE__,4242,0' }],
  ]
  for (const [what, args, env] of cases)
    it(what, () => {
      const fix = (v: string) => v.replace('__LIVE__', live)
      const r = guard(args.map(fix), Object.fromEntries(Object.entries(env).map(([k, v]) => [k, fix(v)])))
      expect(r.status).toBe(1)
      expect(reached()).toEqual([])
    })
  it('a socket the server lists as live (tmux-live)', () => {
    const other = path.join(tmp, 'other', `tmux-${uid}`, 'weevils')
    fs.mkdirSync(path.dirname(other), { recursive: true })
    fs.writeFileSync(path.join(data, 'tmux-live'), other + '\n')
    expect(guard(['-L', 'weevils', 'kill-server'], { TMUX_TMPDIR: path.join(tmp, 'other') }).status).toBe(1)
    expect(reached()).toEqual([])
  })
})

describe('what goes through', () => {
  it('the weevils server with its token', () => {
    expect(guard(['-L', 'weevils', 'kill-session', '-t', '=wv-app-1:'], { WEEVILS_TMUX_TOKEN: 'secret-token' }).status).toBe(0)
    expect(reached()).toEqual(['-L weevils kill-session -t =wv-app-1:'])
  })
  it('a wrong token is no token', () => {
    expect(guard(['-L', 'weevils', 'kill-server'], { WEEVILS_TMUX_TOKEN: 'guess' }).status).toBe(1)
  })
  it('everything that does not close sessions, and a test copy on its own socket', () => {
    const own = path.join(tmp, 'copy')
    fs.mkdirSync(own)
    expect(guard(['-L', 'weevils', 'list-sessions']).status).toBe(0)
    expect(guard(['-L', 'weevils', 'kill-server'], { TMUX_TMPDIR: own }).status).toBe(0)
    expect(guard(['-S', path.join(own, 'sock'), 'kill-server']).status).toBe(0)
    expect(reached()).toEqual(['-L weevils list-sessions', '-L weevils kill-server', `-S ${path.join(own, 'sock')} kill-server`])
  })
})

const realTmux = spawnSync('sh', ['-c', 'command -v tmux']).stdout?.toString().trim()
describe.skipIf(!realTmux)('with a real tmux server standing in for the live one', () => {
  it('its sessions survive every refused attempt', () => {
    const sock = path.join(tmp, 's', 'weevils')
    fs.mkdirSync(path.dirname(sock), { recursive: true })
    fs.writeFileSync(path.join(data, 'tmux-live'), sock + '\n')
    const t = (...a: string[]) => spawnSync(realTmux!, ['-S', sock, ...a], { encoding: 'utf8', env: { ...process.env, TMUX: '' } })
    expect(t('new-session', '-d', '-s', 'wv-live-1', 'sleep 60').status).toBe(0)
    try {
      for (const args of [['-S', sock, 'kill-server'], ['-S', sock, 'kill-session', '-t', '=wv-live-1:']])
        expect(guard(args, {}, realTmux!).status).toBe(1)
      expect(guard(['kill-server'], { TMUX: `${sock},1,0` }, realTmux!).status).toBe(1)
      expect(t('has-session', '-t', '=wv-live-1:').status).toBe(0)
    } finally {
      t('kill-server')
    }
  })
})
