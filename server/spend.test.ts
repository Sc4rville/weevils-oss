import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { claudeEntry, entries, priceOf, resetSpend, summarize } from './spend.ts'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-'))
  resetSpend()
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const H = 3600_000
const line = (at: number, id: string, model: string, usage: object) =>
  JSON.stringify({ type: 'assistant', timestamp: new Date(at).toISOString(), sessionId: 's1', requestId: `r${id}`, message: { id, model, usage } })

it('prices an answer like ccusage: 5 min and 1 h cache writes apart, fast mode doubled', () => {
  const e = claudeEntry(JSON.parse(line(Date.now(), 'm', 'claude-opus-5-5', { input_tokens: 1e6, output_tokens: 1e6, cache_creation_input_tokens: 2e6, cache_read_input_tokens: 1e6, cache_creation: { ephemeral_1h_input_tokens: 1e6 } })))!
  // 4 + 20 + 1M×4×1.25 + 1M×4×2 + 0.2
  expect(e.cost).toBeCloseTo(4 + 20 + 5 + 8 + 0.2)
  const fast = claudeEntry(JSON.parse(line(Date.now(), 'm', 'claude-opus-5-5', { output_tokens: 1e6, speed: 'fast' })))!
  expect(fast.cost).toBeCloseTo(40)
  expect(priceOf('claude-fable-5-2')).toEqual([8, 40, 0.2])
  expect(priceOf('claude-haiku-5-5')?.[0]).toBe(0.1)
})

it('counts an answer written on several lines once, and reads workflow agents five folders down', () => {
  const now = Date.now()
  const deep = path.join(dir, 'proj', 'sess', 'subagents', 'workflows', 'wf_1')
  fs.mkdirSync(deep, { recursive: true })
  const u = { output_tokens: 1e6 }
  fs.writeFileSync(path.join(dir, 'proj', 'a.jsonl'), [line(now - H, 'x', 'claude-sonnet-5-5', u), line(now - H, 'x', 'claude-sonnet-5-5', u)].join('\n') + '\n')
  fs.writeFileSync(path.join(deep, 'agent-1.jsonl'), line(now - H, 'y', 'claude-sonnet-5-5', u) + '\n')
  const es = entries(now, { claude: dir, codex: path.join(dir, 'none') })
  expect(es.length).toBe(2)
  expect(es.reduce((s, e) => s + e.cost, 0)).toBeCloseTo(20)
})

it('learns $ per point from the quota and forecasts when the week runs out', () => {
  const now = Date.parse('2026-11-15T00:00:00Z')
  const resets = now + 3 * 24 * H
  // $10 an hour for the last 50 hours: $500 by the reading, which says 50 %.
  const es = Array.from({ length: 50 }, (_, i) => ({ at: now - (i + 0.5) * H, sid: 's', model: 'claude-opus-5-5', tokens: 1, cost: 10, tool: 'claude' as const }))
  const q = { ok: true, windows: [{ kind: 'week' as const, percent: 50, resetsAt: resets }], source: 't', at: now }
  const s = summarize(es, q, now)
  expect(s.perPercent).toBeCloseTo(10)
  expect(s.pctPerHour?.fiveHours).toBeCloseTo(1)
  // 50 points left at 1 point an hour: 50 h, before the reset in 72 h.
  expect(s.limitAt).toBeCloseTo(now + 50 * H, -3)
  // A reset that comes first: the week lasts.
  expect(summarize(es, { ...q, windows: [{ kind: 'week', percent: 50, resetsAt: now + 10 * H }] }, now).limitAt).toBeNull()
  // Marginal rate from an earlier reading: $200 spent since it while the percent rose 10 points.
  const m = summarize(es, q, now, { quotaAt: now - 20 * H, weekPct: 40 })
  expect(m.perPercent).toBeCloseTo(20)
  // No quota: no forecast, burn still there.
  const n = summarize(es, undefined, now)
  expect(n.perPercent).toBeNull()
  expect(n.burn.hour).toBeCloseTo(10)
})
