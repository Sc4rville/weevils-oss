// server/claude-pump.mjs against a fake `claude -p --input-format stream-json`: handshake, message, question, interrupt.
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'

const FAKE = `
let buf=''
const out=o=>process.stdout.write(JSON.stringify(o)+'\\n')
process.stdin.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\\n'))>=0){const m=JSON.parse(buf.slice(0,i));buf=buf.slice(i+1)
  if(m.type==='control_request'&&m.request.subtype==='initialize')out({type:'control_response',response:{subtype:'success',request_id:m.request_id}})
  else if(m.type==='control_request'&&m.request.subtype==='interrupt')out({type:'result',subtype:'error_during_execution',is_error:true})
  else if(m.type==='user'){out({type:'system',subtype:'init'})
    if(m.message.content==='ask')out({type:'control_request',request_id:'r1',request:{subtype:'can_use_tool',tool_name:'AskUserQuestion',input:{questions:[{question:'Which?',options:[{label:'A'},{label:'B'}]}]}}})
    else if(m.message.content!=='hang'){out({type:'assistant',message:{content:[{type:'text',text:'echo '+m.message.content}]}});out({type:'result',subtype:'success'})}}
  else if(m.type==='control_response'){out({type:'assistant',message:{content:[{type:'text',text:'answer '+JSON.stringify(m.response.response.updatedInput.answers)}]}});out({type:'result',subtype:'success'})}
}})`

let child: ChildProcess | undefined
afterEach(() => child?.kill('SIGKILL'))

const call = (sock: string, req: object) => new Promise<any>((resolve, reject) => {
  const c = net.createConnection(sock); let out = ''
  c.on('connect', () => c.write(JSON.stringify(req) + '\n')); c.on('data', (d) => { out += d }); c.on('end', () => resolve(JSON.parse(out))); c.on('error', reject)
})
const until = async (f: () => boolean) => { for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 30)); expect(f()).toBe(true) }

test('the pump drives a stream-json Claude: ready, message, question and answer, interrupt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pump-'))
  fs.writeFileSync(path.join(dir, 'fake.mjs'), FAKE)
  fs.writeFileSync(path.join(dir, 'first'), 'hello')
  child = spawn(process.execPath, [path.join(import.meta.dirname, 'claude-pump.mjs'), dir, 'wv-t', path.join(dir, 'first'), '--', process.execPath, path.join(dir, 'fake.mjs'), '--session-id', 'S1'], { stdio: ['ignore', 'pipe', 'inherit'] })
  let screen = ''
  child.stdout!.on('data', (d) => { screen += d })
  const state = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'wv-t.json'), 'utf8')) } catch { return {} } }
  await until(() => state().ready && screen.includes('echo hello') && !state().working)
  expect(state().sessionId).toBe('S1')
  expect(fs.existsSync(path.join(dir, 'first'))).toBe(false)

  const sock = path.join(dir, 'wv-t.sock')
  expect((await call(sock, { op: 'send', text: 'ask' })).ok).toBe(true)
  await until(() => !!state().question)
  const q = state().question
  expect(q.question).toBe('Which?')
  expect((await call(sock, { op: 'answer', choice: 'q:stale:0:0' })).ok).toBe(false) // a stale tap is refused
  expect((await call(sock, { op: 'answer', choice: q.options[1].id })).ok).toBe(true)
  await until(() => screen.includes('answer {"Which?":"B"}') && !state().working && !state().question)

  await call(sock, { op: 'send', text: 'hang' })
  await until(() => state().working)
  await call(sock, { op: 'interrupt' })
  await until(() => !state().working)
})
