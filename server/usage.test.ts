import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionTokens, usageOfLine, rate } from './usage.ts'

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

it('Codex cumulative snapshots: duplicates, increments, reset, truncation and separate sessions', () => {
 const f=path.join(dir,'cx.jsonl'), other=path.join(dir,'other.jsonl')
 const line=(n:number)=>JSON.stringify({type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:n,output_tokens:0,total_tokens:n},last_token_usage:{input_tokens:100,total_tokens:100}}}})+'\n'
 fs.writeFileSync(f,line(100)+line(100)+line(160))
 expect(sessionTokens(f,'codex')).toBe(160)
 fs.appendFileSync(f,line(160)+line(200))
 expect(sessionTokens(f,'codex')).toBe(200)
 fs.appendFileSync(f,line(10)+line(25))
 expect(sessionTokens(f,'codex')).toBe(225)
 fs.writeFileSync(other,line(50));expect(sessionTokens(other,'codex')).toBe(50)
 fs.writeFileSync(f,line(5));expect(sessionTokens(f,'codex')).toBe(5)
})

it('discovers active Codex files under old year/month directories and uses deltas for the live rate', async () => {
 const { CODEX_DIR } = await import('./config.ts')
 const parent=path.join(CODEX_DIR,'2026','11','10');fs.mkdirSync(parent,{recursive:true})
 const now=new Date().toISOString()
 const event=(n:number)=>JSON.stringify({timestamp:now,type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:n,total_tokens:n}}}})
 fs.writeFileSync(path.join(parent,'active.jsonl'),[event(100),event(100),event(150),''].join('\n'))
 for(const p of [CODEX_DIR,path.dirname(path.dirname(parent)),path.dirname(parent),parent])fs.utimesSync(p,new Date('2020-01-01'),new Date('2020-01-01'))
 const r=rate();expect(r.available).toBe(true);expect(r.buckets.reduce((a,b)=>a+b,0)).toBe(150)
})
