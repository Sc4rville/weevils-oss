import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionTokens, usageOfLine } from './usage.ts'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const claude = (id: string, u: Record<string, number>, model = 'claude-sonnet') =>
  JSON.stringify({ type: 'assistant', sessionId: 's1', cwd: '/w', timestamp: '2026-11-10T09:00:00Z', message: { id, model, usage: u } })

describe('usage — a session transcript', () => {
  it('one line: tokens, weight, the message id (claude), nothing on a line without usage', () => {
    const u = usageOfLine(JSON.parse(claude('m1', { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 4, cache_read_input_tokens: 100 })), 'claude')
    expect(u).toMatchObject({ id: 'm1', tokens: 116, weight: 10 + 10 + 5 + 10, sid: 's1', cwd: '/w' })
    expect(usageOfLine({ type: 'user', message: { content: 'hi' } }, 'claude')).toBeNull()
    expect(usageOfLine({ payload: { info: { last_token_usage: { input_tokens: 50, cached_input_tokens: 40, output_tokens: 5, total_tokens: 55 } } } }, 'codex')).toMatchObject({ tokens: 55 })
    expect(usageOfLine({ payload: { type: 'message' } }, 'codex')).toBeNull()
  })

  it('the tokens of a whole run: each message once (claude writes one response on several lines), read incrementally', () => {
    const f = path.join(dir, 's1.jsonl')
    fs.writeFileSync(
      f,
      [
        JSON.stringify({ type: 'user', message: { content: 'go' } }),
        claude('m1', { input_tokens: 100, output_tokens: 20 }),
        claude('m1', { input_tokens: 100, output_tokens: 20 }),
        claude('m2', { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 1000 }),
        '{broken',
        '',
      ].join('\n'),
    )
    expect(sessionTokens(f)).toBe(1126)
    // Appended (a half-written last line waits for its end).
    fs.appendFileSync(f, `${claude('m2', { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 1000 })}\n${claude('m3', { input_tokens: 4, output_tokens: 0 })}`)
    expect(sessionTokens(f)).toBe(1126)
    fs.appendFileSync(f, '\n')
    expect(sessionTokens(f)).toBe(1130)
    expect(sessionTokens(path.join(dir, 'none.jsonl'))).toBe(0)
  })

  it('codex: every token_count line', () => {
    const f = path.join(dir, 'rollout.jsonl')
    const line = (n: number) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: n, output_tokens: 1, total_tokens: n + 1 } } } })
    fs.writeFileSync(f, `${line(10)}\n${line(20)}\n`)
    expect(sessionTokens(f, 'codex')).toBe(32)
  })
})
