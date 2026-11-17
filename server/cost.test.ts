import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { absorb, circles, CostOptimizer, isLoopCommand, orphanLoops, sameTask, simpleTask, TranscriptScan, type CostHost, type FileAgg, type Proc } from './cost.ts'
import { CostLedger, callerOf } from './cost-ledger.ts'
import { claudeAnswer, smartModel } from './fast.ts'
import { MACHINE } from './config.ts'

const agg = (): FileAgg => ({ offset: 0, sid: 's', seen: new Set(), days: {}, hours: {}, lastCtx: 0, lastAt: 0, model: '', cwd: '', compacts: 0, recent: [] })
let n = 0
const line = (at: number, o: { ctx?: number; out?: number; model?: string; tools?: { name: string; input?: any }[] } = {}) =>
  JSON.stringify({ type: 'assistant', timestamp: new Date(at).toISOString(), message: { id: `m${n++}`, model: o.model ?? 'claude-opus-5-5', usage: { input_tokens: 0, cache_read_input_tokens: o.ctx ?? 1000, cache_creation_input_tokens: 0, output_tokens: o.out ?? 100 }, content: (o.tools ?? []).map((t) => ({ type: 'tool_use', name: t.name, input: t.input ?? {} })) } })

describe('reading transcripts', () => {
  it('counts each reply once, its context and its day', () => {
    const a = agg()
    const now = Date.now()
    const l = line(now, { ctx: 200_000, out: 50 })
    absorb(a, [l, l, line(now + 1000, { ctx: 210_000, out: 10 })], 0)
    expect(a.lastCtx).toBe(210_000)
    expect(Object.values(a.days)[0]).toMatchObject({ turns: 2, tokens: 410_060 })
    expect(a.recent).toHaveLength(2)
  })

  it('scans a tree of transcripts with subagents, incrementally', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-'))
    const dir = path.join(root, '-proj')
    fs.mkdirSync(path.join(dir, 'sid1', 'subagents'), { recursive: true })
    const now = Date.now()
    fs.writeFileSync(path.join(dir, 'sid1.jsonl'), line(now, { ctx: 300_000 }) + '\n')
    fs.writeFileSync(path.join(dir, 'sid1', 'subagents', 'agent-a.jsonl'), line(now, { ctx: 100_000 }) + '\n')
    const scan = new TranscriptScan(root)
    await scan.refresh(now)
    expect(scan.main('sid1')?.lastCtx).toBe(300_000)
    expect(scan.subagents('sid1')).toHaveLength(1)
    fs.appendFileSync(path.join(dir, 'sid1.jsonl'), line(now + 5, { ctx: 320_000 }) + '\n')
    await scan.refresh(now)
    expect(scan.main('sid1')?.lastCtx).toBe(320_000)
    expect(Object.values(scan.daily())[0]).toBe(300_100 + 100_100 + 320_100)
  })
})

describe('judging sessions', () => {
  const now = Date.now()
  it('sees a simple task on a heavy model', () => {
    const a = agg()
    absorb(a, Array.from({ length: 20 }, (_, i) => line(now - i * 1000, { out: 120, tools: [{ name: 'Read' }] })), 0)
    a.model = 'claude-opus-5-5'
    expect(simpleTask(a)).toBe(true)
    absorb(a, [line(now + 1, { tools: [{ name: 'Edit' }] })], 0)
    expect(simpleTask(a)).toBe(false)
  })

  it('sees circles: the same command again and again', () => {
    const a = agg()
    absorb(a, Array.from({ length: 14 }, (_, i) => line(now - i * 60_000, { tools: [{ name: 'Bash', input: { command: `curl -s localhost:${4000 + i}/status` } }] })), 0)
    expect(circles(a, now)).toEqual({ times: 14 })
  })

  it('sees duplicates by their titles', () => {
    expect(sameTask('weevils get landing page', 'get landing page weevils')).toBe(true)
    expect(sameTask('weevils get landing page', 'weevils content renders')).toBe(false)
  })
})

describe('orphan loops', () => {
  const snap = "/bin/bash -c -l source /home/u/.claude/shell-snapshots/snapshot-bash-1.sh && eval 'until [ -f /tmp/x ]; do sleep 5; done' < /dev/null"
  const now = Date.now()
  it('recognises Claude Code wait loops only', () => {
    expect(isLoopCommand(snap)).toBe(true)
    expect(isLoopCommand("bash -c 'until [ -f x ]; do sleep 5; done'")).toBe(false)
    expect(isLoopCommand("/bin/bash -c -l source /h/.claude/shell-snapshots/s.sh && eval 'npm run build'")).toBe(false)
    // A watcher launched to outlive the call (the night render saver): never.
    expect(isLoopCommand("/bin/bash -c source /h/.claude/shell-snapshots/s.sh && eval 'cd x && nohup tools/save-renders.sh watch a --interval 90 > l 2>&1 & echo watch $!; sleep 30; tail -5 l' < /dev/null")).toBe(false)
    expect(isLoopCommand("/bin/bash -c source /h/.claude/shell-snapshots/s.sh && eval 'while true; do ./render.sh & sleep 60; done'")).toBe(false)
  })
  it('stops them only when their claude process is gone', () => {
    const procs: Proc[] = [
      { pid: 10, ppid: 1, comm: 'claude', cmdline: 'claude', startedAt: 0 },
      { pid: 11, ppid: 10, comm: 'bash', cmdline: snap, startedAt: now - 3600_000 },
      { pid: 12, ppid: 1, comm: 'bash', cmdline: snap, startedAt: now - 3600_000 },
      { pid: 13, ppid: 1, comm: 'bash', cmdline: snap, startedAt: now - 60_000 },
    ]
    expect(orphanLoops(procs, now).map((p) => p.pid)).toEqual([12])
    // A loop with real work running under it: left alone.
    expect(orphanLoops([...procs, { pid: 20, ppid: 12, comm: 'node', cmdline: 'node render.js', startedAt: now }], now)).toEqual([])
  })
})

describe('internal calls', () => {
  it('reads usage from claude -p JSON and keeps plain answers working', () => {
    const json = JSON.stringify({ type: 'result', result: ' hello ', usage: { input_tokens: 2, cache_read_input_tokens: 10, output_tokens: 3 } })
    expect(claudeAnswer(json, undefined, 'titles', 'haiku')).toBe('hello')
    expect(claudeAnswer(JSON.stringify({ type: 'result', result: '', structured_output: { a: 1 } }), {}, 'x', 'haiku')).toBe('{"a":1}')
    expect(claudeAnswer('plain answer', undefined, 'x', 'haiku')).toBe('plain answer')
    expect(() => claudeAnswer(JSON.stringify({ type: 'result', is_error: true, result: 'usage limit' }), undefined, 'x', 'haiku')).toThrow()
  })
  it('never writes a small generation with Opus or Fable', () => {
    expect(smartModel('short', 'opus')).toBe('sonnet')
    expect(smartModel('x'.repeat(9000), 'opus')).toBe('opus')
    expect(smartModel('short', undefined)).toBe('sonnet')
  })
  it('caches identical requests and counts per caller', () => {
    const l = new CostLedger(null)
    const k = CostLedger.key('haiku', 'p')
    expect(l.get(k)).toBeUndefined()
    l.put(k, 'answer')
    expect(l.get(k)).toBe('answer')
    expect(l.get(k, Date.now() + 3600_000)).toBeUndefined()
    l.record('titles', 'haiku', { input_tokens: 1, output_tokens: 1 })
    l.hit('titles', 'haiku')
    expect(Object.values(Object.values(l.days(1))[0])[0]).toMatchObject({ calls: 1, cached: 1, tokens: 2 })
    expect(callerOf('Error\n    at x (file:///a/server/fast.ts:1:1)\n    at y (file:///a/server/titles.ts:9:2)')).toBe('titles')
  })
})

describe('the optimiser', () => {
  it('compacts a heavy session at rest, never a working one, and posts its gain', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-'))
    fs.mkdirSync(path.join(root, '-p'))
    const now = Date.now()
    for (const id of ['rest', 'busy']) fs.writeFileSync(path.join(root, '-p', `${id}.jsonl`), line(now - 30 * 60_000, { ctx: 400_000 }) + '\n')
    const session = (id: string, status: string) => ({ id, title: id, projectId: 'p', machineId: MACHINE.id, tool: 'claude', live: true, controllable: true, hasScreen: true, status, background: 0, queued: 0, lastActivityAt: now - 30 * 60_000 })
    const commands: string[] = []
    const posts: any[] = []
    const host: CostHost = {
      snapshot: () => ({ sessions: [session('rest', 'idle'), session('busy', 'working')], mainWorking: false }) as any,
      fileOf: () => undefined,
      bossId: () => null,
      command: async (id, cmd) => void commands.push(`${id} ${cmd}`),
      commandMain: async () => undefined,
      key: async () => undefined,
      autoTasks: () => [],
      ledger: () => ({}),
      post: (i) => void posts.push(i),
      procs: () => [],
    }
    const c = new CostOptimizer(host, { file: path.join(root, 'cost.json'), root })
    const r = await c.run(now)
    expect(commands).toEqual(['rest /compact'])
    expect(r.note).toMatch(/compact/i)
    expect(posts[0]).toMatchObject({ kind: 'stat', who: 'weevils' })
    expect(posts[0].gauges).toHaveLength(7)
    expect(posts[0].text).toMatch(/^I compacted 1 idle session/)
    // Not twice for the same rest.
    commands.length = 0
    await c.run(now + 60_000)
    expect(commands).toEqual([])
  })
})
