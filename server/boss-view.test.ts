import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BossJournal, BossSummaries, budgetParts, buildView, entriesOfLine, recall, tokensOf, type Entry } from './boss-view.ts'
import { BossTurns, peelContext } from './boss-turns.ts'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'boss-view-'))
const iso = (n: number) => new Date(Date.UTC(2026, 10, 10, 8, 0, 0) + n * 60_000).toISOString()
const user = (n: number, text: string) => ({ type: 'user', uuid: `u${String(n).padStart(7, '0')}-0000-0000-0000-000000000000`, timestamp: iso(n), message: { role: 'user', content: text } })
const reply = (n: number, text: string, tool?: string) => ({
  type: 'assistant', uuid: `a${String(n).padStart(7, '0')}-0000-0000-0000-000000000000`, timestamp: iso(n),
  message: { role: 'assistant', content: [{ type: 'text', text }, ...(tool ? [{ type: 'tool_use', name: 'Bash', input: { command: tool } }] : [])] },
})
const lines = (objs: object[]) => objs.map((o) => JSON.stringify(o)).join('\n') + '\n'

describe('entriesOfLine', () => {
  it('keeps what was said, without the hidden block, and folds tool calls to one line', () => {
    expect(entriesOfLine(user(1, 'fais le point ⟦weevils — secret context⟧'))).toMatchObject([{ role: 'user', text: 'fais le point' }])
    expect(entriesOfLine(user(2, '[from:agent] build is green'))).toMatchObject([{ role: 'agent', author: 'agent', text: 'build is green' }])
    expect(entriesOfLine(reply(3, 'Sent.', 'weevils send abc "go"')).map((e) => e.role)).toEqual(['assistant', 'event'])
    expect(entriesOfLine(user(4, '<command-name>/compact</command-name>'))).toEqual([])
    expect(entriesOfLine({ ...user(5, 'x'), isSidechain: true })).toEqual([])
  })
})

describe('BossJournal', () => {
  it('reads the transcripts incrementally and keeps the entries on disk', () => {
    const dir = tmp()
    const t = path.join(dir, 't')
    fs.mkdirSync(t)
    fs.writeFileSync(path.join(t, 'a.jsonl'), lines([user(1, 'hello'), reply(2, 'hi')]))
    const j = new BossJournal(t, path.join(dir, 'data'))
    expect(j.sync()).toBe(2)
    expect(j.sync()).toBe(0)
    fs.appendFileSync(path.join(t, 'a.jsonl'), lines([user(3, 'again')]))
    fs.writeFileSync(path.join(t, 'b.jsonl'), lines([reply(4, 'second turn')]))
    expect(j.sync()).toBe(2)
    expect(new BossJournal(t, path.join(dir, 'data')).entries().map((e) => e.text)).toEqual(['hello', 'hi', 'again', 'second turn'])
  })
})

const history = (n: number, size = 400): Entry[] =>
  Array.from({ length: n }, (_, i) => ({ id: `m${String(i).padStart(7, '0')}-x`, at: Date.UTC(2026, 10, 1) + i * 20 * 60_000, role: i % 2 ? 'assistant' : 'user', text: `message ${i} ` + 'lorem ipsum '.repeat(size / 12) }) as Entry)

describe('buildView', () => {
  const noModel = async () => { throw new Error('offline') }

  it('stays within its budget and keeps the stable prefix byte for byte until the recent part outgrows its share', async () => {
    const dir = tmp()
    const summaries = new BossSummaries(dir, noModel)
    const state = {}
    const budget = 20_000
    const entries = history(600)
    const a = await buildView({ entries, summaries, state, budget, dataDir: dir, head: 'HEAD', summaryMs: 0 })
    expect(a.rebuilt).toBe(true)
    expect(a.stableTokens).toBeLessThan(budget * 0.5)
    expect(a.recentTokens).toBeLessThanOrEqual(budgetParts(budget).recentTarget + 1000)
    const stable = fs.readFileSync(a.stableFile, 'utf8')
    expect(stable).toContain('## Days')
    expect(stable).toContain('## Groups of messages')
    expect(stable).toContain('## Messages')
    // A few more exchanges: same prefix, longer recent part.
    const b = await buildView({ entries: [...entries, ...history(606).slice(600)], summaries, state, budget, dataDir: dir, head: 'HEAD', summaryMs: 0 })
    expect(b.rebuilt).toBe(false)
    expect(b.stableFile).toBe(a.stableFile)
    expect(b.recentTokens).toBeGreaterThan(a.recentTokens)
    // Far more: the ladder is rebuilt and the whole view stays the same size.
    const more = history(700)
    const c = await buildView({ entries: more, summaries, state, budget, dataDir: dir, head: 'HEAD', summaryMs: 0 })
    expect(c.rebuilt).toBe(true)
    expect(c.stableTokens + c.recentTokens).toBeLessThan(budget)
  })

  it('uses the Haiku lines once written, and recall opens the original', async () => {
    const dir = tmp()
    let calls = 0
    const summaries = new BossSummaries(dir, async (prompt) => {
      calls++
      const n = (prompt.match(/^\d+\. /gm) ?? []).length
      return JSON.stringify({ lines: Array.from({ length: n }, (_, i) => `summary ${i}`) })
    })
    const entries = history(120, 800)
    await buildView({ entries, summaries, state: {}, budget: 12_000, dataDir: dir, head: '', summaryMs: 10_000 })
    expect(calls).toBeGreaterThan(0)
    const before = calls
    await buildView({ entries, summaries, state: {}, budget: 12_000, dataDir: dir, head: '', summaryMs: 10_000 })
    expect(calls).toBe(before)
    expect(recall(entries, summaries, entries[3].id.slice(0, 8))).toContain(entries[3].text)
    expect(recall(entries, summaries, 'g0')?.split('\n')).toHaveLength(8)
    expect(recall(entries, summaries, 'nothing')).toBeNull()
  })
})

describe('BossTurns', () => {
  it('peels the hidden blocks off a message', () => {
    expect(peelContext('hi ⟦weevils — a⟧ ⟦weevils — b⟧')).toEqual({ text: 'hi', parts: ['a', 'b'] })
    expect(peelContext('plain')).toEqual({ text: 'plain', parts: [] })
  })

  it('prepares a turn: the message and the recent exchanges go through a file, the ladder through the system prompt', async () => {
    const dir = tmp()
    const t = path.join(dir, 't')
    fs.mkdirSync(path.join(t, 'memory'), { recursive: true })
    fs.writeFileSync(path.join(t, 'old.jsonl'), lines([user(1, 'first request'), reply(2, 'done', 'weevils send x "go"')]))
    fs.writeFileSync(path.join(t, 'memory', 'handoff-2026-11-14.md'), '---\nname: x\n---\n\nKeep the repo private.\n')
    const turns = new BossTurns(async () => '{}', path.join(dir, 'boss'), t, 20_000)
    turns.enqueue('what now? ⟦weevils — app locale en⟧')
    const p = await turns.prepare({ id: 'turn-1', claude: ['claude', '--dangerously-skip-permissions'], memory: 'likes flat colours' })
    const file = p.command[p.command.indexOf('weevboss-turn') + 1]
    const prompt = fs.readFileSync(file, 'utf8')
    expect(prompt.startsWith('what now? ⟦weevils — app locale en — the latest exchanges')).toBe(true)
    expect(prompt).toContain('first request')
    expect(prompt.match(/⟧/g)).toHaveLength(1)
    const stable = fs.readFileSync(p.command[p.command.indexOf('--append-system-prompt-file') + 1], 'utf8')
    expect(stable).toContain('Keep the repo private.')
    expect(stable).toContain('likes flat colours')
    expect(p.command).toContain('--session-id')
    turns.started(p)
    expect(turns.queue).toHaveLength(0)
    expect(turns.isTurn('turn-1')).toBe(true)
    expect(tokensOf(prompt)).toBeLessThan(20_000)
    // No choice made: Opus at medium effort, never the global Claude Code model.
    expect(p.command.slice(p.command.indexOf('--model'), p.command.indexOf('--model') + 2)).toEqual(['--model', 'opus'])
    expect(p.command.slice(p.command.indexOf('--effort'), p.command.indexOf('--effort') + 2)).toEqual(['--effort', 'medium'])
  })

  it('keeps the model and effort chosen in the app, read back from disk, and refuses unknown ones', () => {
    const dir = tmp()
    const turns = new BossTurns(async () => '{}', path.join(dir, 'boss'), path.join(dir, 't'), 20_000)
    expect(turns.choose('fable', 'high')).toEqual({ model: 'fable', effort: 'high' })
    expect(() => turns.choose('gpt-9', 'high')).toThrow()
    expect(() => turns.choose('opus', 'ultra')).toThrow()
    const again = new BossTurns(async () => '{}', path.join(dir, 'boss'), path.join(dir, 't'), 20_000)
    expect([again.model, again.effort]).toEqual(['fable', 'high'])
  })
})
