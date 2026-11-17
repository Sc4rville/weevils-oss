#!/usr/bin/env node
// Structured Claude session (WEEVILS_STRUCTURED=1, new sessions only). Runs inside the session's tmux pane, so tmux stays
// the registry and the session outlives weevilsd restarts. It owns `claude -p --input-format stream-json` and:
//  - takes orders from weevilsd on a unix socket (<dir>/<name>.sock), one JSON line per request:
//      {op:'send', text}  {op:'interrupt'}  {op:'answer', choice:<option id>}  {op:'model', model}  {op:'state'}
//  - writes its state to <dir>/<name>.json at every change (working, the open question, queued messages);
//  - prints a readable log in the pane (what `screen` shows), never something weevils has to parse.
// When claude exits, the pump exits with its code and the tmux session closes like an ordinary one.
// Usage: node claude-pump.mjs <dir> <name> <first-message-file|-> -- claude <args…>
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import crypto from 'node:crypto'

const [dir, name, firstFile, sep, ...cmd] = process.argv.slice(2)
if (!dir || !name || sep !== '--' || !cmd.length) { console.error('usage: claude-pump <dir> <name> <first|-> -- claude …'); process.exit(2) }
fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
const sockPath = path.join(dir, `${name}.sock`)
const stateFile = path.join(dir, `${name}.json`)
const sessionId = cmd[cmd.indexOf('--session-id') + 1] || cmd[cmd.indexOf('--resume') + 1] || ''

const state = { pid: process.pid, sessionId, ready: false, working: false, queued: 0, question: null, exited: null, at: Date.now() }
function save() {
  state.at = Date.now()
  const tmp = stateFile + '.tmp'
  try { fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 }); fs.renameSync(tmp, stateFile) } catch { /* disk full: memory still answers {op:'state'} */ }
}
const log = (s) => process.stdout.write(s.replace(/\s+$/, '') + '\n')

const child = spawn(cmd[0], cmd.slice(1), { stdio: ['pipe', 'pipe', 'inherit'], env: process.env })
const write = (o) => { if (child.stdin.writable) child.stdin.write(JSON.stringify(o) + '\n') }
const userMessage = (text) => write({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: sessionId })

/** Pending permission/question: the claude request, and for AskUserQuestion the answers collected so far. */
let pending = null
function ask(m) {
  const input = m.request.input ?? {}
  const tool = m.request.tool_name
  if (tool === 'AskUserQuestion' && Array.isArray(input.questions) && input.questions.length) {
    pending = { requestId: m.request_id, input, tool, index: 0, answers: {} }
  } else pending = { requestId: m.request_id, input, tool }
  showQuestion()
}
function showQuestion() {
  if (!pending) { state.question = null; save(); return }
  if (pending.tool === 'AskUserQuestion') {
    const q = pending.input.questions[pending.index]
    state.question = { id: `${pending.requestId}:${pending.index}`, name: 'choice', question: q.question, options: (q.options ?? []).map((o, i) => ({ id: `q:${pending.requestId}:${pending.index}:${i}`, label: o.label })) }
  } else {
    const detail = pending.input.command ?? pending.input.file_path ?? pending.input.url ?? undefined
    state.question = {
      id: pending.requestId, name: 'permission', question: `Allow ${pending.tool}?`, ...(detail ? { detail: String(detail).slice(0, 400) } : {}),
      options: [{ id: `q:${pending.requestId}:allow`, label: 'Yes' }, { id: `q:${pending.requestId}:deny`, label: 'No' }],
    }
  }
  log(`? ${state.question.question}${state.question.options.map((o) => `\n   - ${o.label}`).join('')}`)
  save()
}
function reply(response) {
  write({ type: 'control_response', response: { subtype: 'success', request_id: pending.requestId, response } })
  pending = null
  showQuestion()
}
/** An answer from the app (an option id) or, with text, words typed while a question is open. */
function answer(choice, text) {
  if (!pending) throw new Error('no question')
  if (pending.tool === 'AskUserQuestion') {
    const q = pending.input.questions[pending.index]
    let value = text
    if (choice !== undefined) {
      const [, rid, qi, oi] = String(choice).split(':')
      if (rid !== pending.requestId || Number(qi) !== pending.index || !q.options?.[Number(oi)]) throw new Error('question gone')
      value = q.options[Number(oi)].label
    }
    pending.answers[q.question] = value
    if (++pending.index < pending.input.questions.length) return showQuestion()
    log(`> ${Object.values(pending.answers).join(', ')}`)
    return reply({ behavior: 'allow', updatedInput: { ...pending.input, answers: pending.answers } })
  }
  const [, rid, verdict] = String(choice ?? '').split(':')
  if (text !== undefined) { log('> no (answered by a message)'); return reply({ behavior: 'deny', message: `The user declined and said: ${text}` }) }
  if (rid !== pending.requestId || !['allow', 'deny'].includes(verdict)) throw new Error('question gone')
  log(`> ${verdict}`)
  reply(verdict === 'allow' ? { behavior: 'allow', updatedInput: pending.input } : { behavior: 'deny', message: 'The user declined.' })
}

let buf = ''
let initId = null
child.stdout.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    let m
    try { m = JSON.parse(line) } catch { continue }
    if (m.type === 'control_response' && m.response?.request_id === initId) { state.ready = true; save(); log('· ready') }
    else if (m.type === 'system' && m.subtype === 'init') { if (!state.working) { state.working = true; save() } }
    else if (m.type === 'assistant') {
      for (const c of m.message?.content ?? []) {
        if (c.type === 'text' && c.text.trim()) log(c.text)
        else if (c.type === 'tool_use') log(`· ${c.name} ${JSON.stringify(c.input ?? {}).slice(0, 100)}`)
      }
    } else if (m.type === 'result') {
      state.working = false; state.queued = 0; save()
      log(`· done${m.is_error ? ' (error)' : ''}`)
    } else if (m.type === 'control_request' && m.request?.subtype === 'can_use_tool') ask(m)
    else if (m.type === 'control_cancel_request' && pending?.requestId === m.request_id) { pending = null; showQuestion() }
  }
})

function send(text) {
  if (pending) return answer(undefined, text) // a message while a question is open is its answer
  if (state.working) state.queued++
  state.working = true
  save()
  log(`> ${text.replace(/\s+/g, ' ').slice(0, 200)}`)
  userMessage(text)
}

const server = net.createServer((c) => {
  let input = ''
  c.on('data', (d) => {
    input += d
    const i = input.indexOf('\n')
    if (i < 0) return
    let req
    try { req = JSON.parse(input.slice(0, i)) } catch { return c.end(JSON.stringify({ ok: false, error: 'bad request' }) + '\n') }
    try {
      if (req.op === 'send' && typeof req.text === 'string' && req.text.trim()) send(req.text)
      else if (req.op === 'interrupt') { write({ type: 'control_request', request_id: crypto.randomUUID(), request: { subtype: 'interrupt' } }); log('· interrupted') }
      else if (req.op === 'answer') answer(req.choice)
      else if (req.op === 'model' && typeof req.model === 'string') write({ type: 'control_request', request_id: crypto.randomUUID(), request: { subtype: 'set_model', model: req.model } })
      else if (req.op !== 'state') throw new Error('unknown op')
      c.end(JSON.stringify({ ok: true, state }) + '\n')
    } catch (e) { c.end(JSON.stringify({ ok: false, error: e.message, state }) + '\n') }
  })
  c.on('error', () => undefined)
})
try { fs.unlinkSync(sockPath) } catch { /* first start */ }
server.listen(sockPath, () => fs.chmodSync(sockPath, 0o600))

function stop(code) {
  state.exited = { code, at: Date.now() }; state.working = false; state.ready = false; save()
  try { server.close(); fs.unlinkSync(sockPath) } catch { /* already gone */ }
  process.exit(code ?? 0)
}
child.on('exit', (code, signal) => { log(`· claude exited (${code ?? signal})`); stop(code ?? 1) })
child.on('error', (e) => { log(`· claude did not start: ${e.message}`); stop(127) })
for (const sig of ['SIGHUP', 'SIGTERM', 'SIGINT']) process.on(sig, () => { child.kill('SIGTERM'); setTimeout(() => stop(0), 3000).unref() })

initId = crypto.randomUUID()
write({ type: 'control_request', request_id: initId, request: { subtype: 'initialize', hooks: null } })
save()
if (firstFile && firstFile !== '-') {
  try { const text = fs.readFileSync(firstFile, 'utf8'); fs.unlinkSync(firstFile); if (text.trim()) send(text) } catch (e) { log(`· first message unreadable: ${e.message}`) }
}
