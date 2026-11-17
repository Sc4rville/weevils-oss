// Isolated integration: real session host, optimizer, bwrap, tmux and plan subprocess.
// The only substituted boundary is the model CLI; no account or production data is used.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

if (!process.env.WV_RELAY_SMOKE_CHILD) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-relay-smoke-'))
  try {
    fs.mkdirSync(path.join(root, 'bin'))
    fs.writeFileSync(path.join(root, 'bin/codex'), `#!/bin/sh
if [ "$1" = exec ]; then
  while [ "$#" -gt 0 ]; do
    if [ "$1" = -o ]; then shift; printf 'Done: inspection. Remaining: write smoke-result. Risks: none.' > "$1"; exit 0; fi
    shift
  done
  exit 2
fi
printf '%s\\n' "$@" > smoke-result
sleep 45
`, { mode: 0o755 })
    const r = spawnSync(process.execPath, [import.meta.filename], {
      stdio: 'inherit', timeout: 60_000,
      env: { HOME: root, PATH: `${root}/bin:/usr/local/bin:/usr/bin:/bin`, LANG: 'C.UTF-8',
        WV_RELAY_SMOKE_CHILD: '1', WEEVILS_CONFIG: '/dev/null', WEEVILS_ORCHESTRATOR: '0',
        WEEVILS_REMOTES: '', WEEVILS_PROJECTS: `${root}/projects`,
        TMUX_TMPDIR: `${root}/tmux`, WEEVILS_TMUX_SOCKET: 'relay-smoke' },
    })
    process.exitCode = r.status ?? 1
  } finally {
    // Only sessions on this test's private socket; never touch the live tmux server.
    const env = { ...process.env, TMUX_TMPDIR: `${root}/tmux` }
    const list = spawnSync('tmux', ['-L', 'relay-smoke', 'list-sessions', '-F', '#{session_name}'], { env, encoding: 'utf8' })
    for (const name of (list.stdout ?? '').trim().split('\n').filter(Boolean))
      spawnSync('tmux', ['-L', 'relay-smoke', 'kill-session', '-t', `=${name}`], { env })
    fs.rmSync(root, { recursive: true, force: true })
  }
} else {
  const { Weevils } = await import('../server/core.ts')
  const { Relay, defaultDeps } = await import('../server/relay.ts')
  const { Optimizers } = await import('../server/optimizers.ts')
  const { spawnWv, listWv } = await import('../server/mux.ts')
  const { Memory } = await import('../server/memory.ts')
  const root = process.env.HOME
  const data = path.join(root, '.local/share/weevils')
  fs.mkdirSync(data, { recursive: true })
  const now = Date.now()
  const w = new Weevils()
  const file = path.join(data, 'relay.json')
  fs.writeFileSync(file, JSON.stringify({ mode: 'auto', plans: [] }))
  const taskFile = path.join(data, 'optimizers.json')
  fs.writeFileSync(taskFile, JSON.stringify({ items: [{ id: 'smoke-auto', title: '[test] relay auto smoke',
    state: 'queued', sessionId: 'cut-auto', repo: null, kind: 'watch', prompt: 'Write smoke-result.',
    createdAt: now, acceptedAt: now, priority: 1, est: 1, heavy: false }] }))
  const o = new Optimizers(w, new Memory(path.join(data, 'memory.json')), { file: taskFile })
  w.optimizers = o
  for (const [id, cwd] of [['cut-auto', o.workspace({ id: 'smoke-auto', repo: null })], ['cut-manual', `${root}/projects/manual`]]) {
    fs.mkdirSync(cwd, { recursive: true })
    await spawnWv(`wv-${id}`, cwd, 'claude', '[test] stopped Claude', ['sleep', '45'], id)
    w.panes = await listWv()
    w.store.byFile.set(`${root}/${id}.jsonl`, { id, tool: 'claude', file: `${root}/${id}.jsonl`, cwd,
      openedAt: now - 60000, lastActivityAt: now, workStartedAt: null, phase: 'idle',
      firstPrompt: '[test] write smoke-result', messages: [{ id: `${id}-1`, role: 'user', text: '[test] write smoke-result', at: now }],
      subagents: [], offset: 0, partial: '', queued: [],
      stopError: { at: now, reason: 'quota', text: 'usage limit reached · resets in 1h' } })
  }
  const deps = defaultDeps(async () => ({ ok: true, source: 'smoke', at: now,
    windows: [{ kind: 'session', percent: 100, resetsAt: now + 3600000 }] }), () => true)
  const relay = new Relay(w.relayHost(), deps, file)
  w.relay = relay
  try {
    for (let i = 0; i < 100; i++) {
      await relay.tick()
      await new Promise(r => setTimeout(r, 100))
      if (fs.existsSync(`${root}/projects/manual/smoke-result`) && fs.existsSync(`${o.workspace({ id: 'smoke-auto', repo: null })}/smoke-result`)) break
    }
    assert.ok(fs.existsSync(`${root}/projects/manual/smoke-result`), 'normal relay executed in tmux')
    const autoCwd = o.workspace({ id: 'smoke-auto', repo: null })
    assert.ok(fs.existsSync(`${autoCwd}/smoke-result`), 'auto relay executed through bwrap and tmux')
    assert.match(fs.readFileSync(`${autoCwd}/smoke-result`, 'utf8'), /never push|ne pousse jamais/)
    assert.equal(o.list()[0].state, 'running')
    assert.equal(relay.view().plans.filter(p => p.relayTo).length, 2)
    const before = relay.view().plans.map(p => p.relayTo)
    const restarted = new Relay(w.relayHost(), deps, file)
    await restarted.tick()
    assert.deepEqual(restarted.view().plans.map(p => p.relayTo), before)
    console.log('PASS: automatic relay, auto task in bwrap, persisted links after restart; isolated HOME and tmux.')
  } finally { process.exitCode ??= 0 }
  // createIn's trust polling would otherwise keep the integration process alive.
  process.exit(process.exitCode)
}
