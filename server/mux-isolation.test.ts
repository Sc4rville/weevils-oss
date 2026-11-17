import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'

it('an absent test socket directory is created; named and legacy panes survive daemon exit and rediscovery', () => {
  const home = process.env.HOME!
  const tmp = path.join(home, 'initially-missing-tmux')
  const cwd = process.cwd()
  const env = { ...process.env, HOME: home, TMUX_TMPDIR: tmp, WEEVILS_TMUX_SOCKET: 'restart-proof' }
  const run = (script: string) => execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd, env, encoding: 'utf8' }).trim()
  const load = `const m = await import('./server/mux.ts');`
  const name = 'wv-restart-proof'
  const old = 'wv-legacy-proof'
  try {
    expect(fs.existsSync(tmp)).toBe(false)
    expect(JSON.parse(run(`${load} console.log(JSON.stringify(await m.listWv()))`))).toEqual([])
    expect(fs.statSync(tmp).isDirectory()).toBe(true)
    execFileSync('tmux', ['new-session', '-d', '-s', old, 'sleep', '120'], { env })
    run(`${load} await m.spawnWv('${name}', '${home}', 'codex', 'proof', ['sleep', '120']);`)
    expect(execFileSync('tmux',['-L','restart-proof','show-environment','-t',name,'WEEVILS_FROM'],{env,encoding:'utf8'}).trim()).toBe('WEEVILS_FROM=codex')
    const first = JSON.parse(run(`${load} console.log(JSON.stringify(await m.listWv()));`))
    const afterRestart = JSON.parse(run(`${load} console.log(JSON.stringify(await m.listWv()));`))
    expect(first.map((p: { name: string }) => p.name).sort()).toEqual([old, name].sort())
    expect(afterRestart).toEqual(first)
    for (const p of afterRestart) expect(() => process.kill(p.pid, 0)).not.toThrow()
  } finally {
    // Only the two exact test sessions on their private socket directory; never kill-server.
    for (const args of [['-L', 'restart-proof', 'kill-session', '-t', `=${name}:`], ['kill-session', '-t', `=${old}:`]]) {
      try { execFileSync('tmux', args, { env, stdio: 'ignore' }) } catch { /* already exited */ }
    }
  }
})
