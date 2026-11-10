// Lecture des transcripts Claude Code et Codex : découverte des sessions, lecture incrémentale, état (phase, file,
// sous-agents) qui pilote le statut et la confirmation de livraison. Vrais fichiers dans un dossier temporaire.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TranscriptStore, type Transcript } from './transcripts.ts'

const DAY = 86400_000
const UUID = '0b6c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d'
const CODEX_UUID = '11111111-2222-4333-8444-555555555555'
let root: string
let claudeDir: string
let codexDir: string
let store: TranscriptStore

const iso = (ms: number) => new Date(ms).toISOString()
const jsonl = (lines: unknown[]) => lines.map((l) => JSON.stringify(l) + '\n').join('')
const write = (file: string, lines: unknown[]) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, jsonl(lines))
}
const append = (file: string, lines: unknown[]) => fs.appendFileSync(file, jsonl(lines))
const claudeFile = (id = UUID) => path.join(claudeDir, '-home-u-projects-demo', `${id}.jsonl`)
/** Même arborescence que Codex : AAAA/MM/JJ, jour local. */
const codexFile = (at = Date.now(), id = CODEX_UUID) => {
  const d = new Date(at)
  const dir = path.join(codexDir, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))
  return path.join(dir, `rollout-2026-11-09T10-00-00-${id}.jsonl`)
}
const user = (text: unknown, at: number, extra: Record<string, unknown> = {}) => ({ type: 'user', uuid: `u-${at}`, timestamp: iso(at), cwd: '/home/u/projects/demo', message: { role: 'user', content: text }, ...extra })
const assistant = (content: unknown[], at: number, extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  uuid: `a-${at}`,
  timestamp: iso(at),
  message: { id: `msg-${at}`, role: 'assistant', model: 'claude-x', content, ...extra },
})
const one = (): Transcript => {
  const all = store.all()
  expect(all).toHaveLength(1)
  return all[0]
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-transcripts-'))
  claudeDir = path.join(root, 'claude')
  codexDir = path.join(root, 'codex')
  store = new TranscriptStore(claudeDir, codexDir, 3 * DAY)
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('scan : découverte', () => {
  it('trouve les sessions claude et codex ; id codex tiré du nom, puis de session_meta', () => {
    const now = Date.now()
    write(claudeFile(), [user('hello claude', now - 1000)])
    const cf = codexFile(now)
    write(cf, [{ type: 'response_item', timestamp: iso(now - 500), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello codex' }] } }])
    expect(store.scan(now)).toBe(true)
    const byTool = Object.fromEntries(store.all().map((t) => [t.tool, t]))
    expect(byTool.claude.id).toBe(UUID)
    expect(byTool.claude.cwd).toBe('/home/u/projects/demo')
    expect(byTool.codex.id).toBe(CODEX_UUID)
    append(cf, [{ type: 'session_meta', timestamp: iso(now - 400), payload: { id: 'real-codex-id', cwd: '/home/u/projects/demo', originator: 'codex_cli_rs' } }])
    store.scan(now)
    expect(store.get('real-codex-id')?.cwd).toBe('/home/u/projects/demo')
    expect(store.get('real-codex-id')?.originator).toBe('codex_cli_rs')
  })

  it('un fichier plus vieux que la fenêtre récente est ignoré', () => {
    const now = Date.now()
    const f = claudeFile()
    write(f, [user('old', now - 5 * DAY)])
    fs.utimesSync(f, (now - 5 * DAY) / 1000, (now - 5 * DAY) / 1000)
    expect(store.scan(now)).toBe(false)
    expect(store.byFile.size).toBe(0)
  })

  it('un jour codex hors fenêtre n’est pas parcouru', () => {
    const now = Date.now()
    write(codexFile(now - 10 * DAY), [{ type: 'event_msg', timestamp: iso(now), payload: { type: 'task_started' } }])
    store.scan(now)
    expect(store.byFile.size).toBe(0)
  })

  it('sans aucune ligne datée : lu mais absent de la liste', () => {
    write(claudeFile(), [{ type: 'summary', summary: 'x' }])
    store.scan(Date.now())
    expect(store.byFile.size).toBe(1)
    expect(store.all()).toEqual([])
  })
})

describe('scan : lecture incrémentale', () => {
  it('lit la suite seulement, attend la fin d’une ligne, repart de zéro si le fichier rétrécit', () => {
    const now = Date.now()
    const f = claudeFile()
    write(f, [user('first message', now - 3000)])
    expect(store.scan(now)).toBe(true)
    expect(store.scan(now)).toBe(false)
    expect(one().messages.map((m) => m.text)).toEqual(['first message'])

    append(f, [user('second message', now - 2000)])
    expect(store.scan(now)).toBe(true)
    expect(one().messages).toHaveLength(2)

    // Ligne en cours d'écriture : pas encore lue.
    const line = JSON.stringify(user('third message', now - 1000))
    fs.appendFileSync(f, line.slice(0, 20))
    store.scan(now)
    expect(one().messages).toHaveLength(2)
    fs.appendFileSync(f, line.slice(20) + '\n')
    store.scan(now)
    expect(one().messages.map((m) => m.text)).toEqual(['first message', 'second message', 'third message'])

    // Réécrit plus court : on repart de zéro.
    write(f, [user('rewritten', now - 500)])
    store.scan(now)
    expect(one().messages.map((m) => m.text)).toEqual(['rewritten'])
  })
})

describe('claude : phases et messages', () => {
  it('message → working ; réponse end_turn → idle', () => {
    const now = Date.now()
    const f = claudeFile()
    write(f, [user('build it', now - 3000)])
    store.scan(now)
    expect(one().phase).toBe('working')
    expect(one().workStartedAt).toBe(now - 3000)
    append(f, [assistant([{ type: 'text', text: 'done' }], now - 1000, { stop_reason: 'end_turn' })])
    store.scan(now)
    expect(one().phase).toBe('idle')
    expect(one().workStartedAt).toBeNull()
    expect(one().model).toBe('claude-x')
    expect(one().lastActivityAt).toBe(now - 1000)
  })

  it('modèle changé (/model) : celui de la dernière requête du fil principal, avant même sa première réponse', () => {
    const now = Date.now()
    const req = (model: string, at: number, querySource = 'repl_main_thread') => ({ type: 'api-request', timestamp: iso(at), querySource, params: { model } })
    const f = claudeFile()
    write(f, [user('go', now - 6000), assistant([{ type: 'text', text: 'ok' }], now - 5000, { model: 'claude-opus-5-5', stop_reason: 'end_turn' })])
    store.scan(now)
    expect(one().model).toBe('claude-opus-5-5')
    // Fable choisi : la requête part, la réponse n'est pas encore là.
    append(f, [user('next', now - 4000), req('claude-fable-5-1', now - 3900)])
    store.scan(now)
    expect(one().model).toBe('claude-fable-5-1')
    // Un sous-agent sur haiku, un message synthétique de Claude Code : le modèle de la session ne bouge pas.
    append(f, [req('claude-haiku-5-5', now - 3000, 'agent:custom'), assistant([{ type: 'text', text: 'x' }], now - 2500, { model: '<synthetic>' })])
    store.scan(now)
    expect(one().model).toBe('claude-fable-5-1')
  })

  it('appel d’outil : un événement « outil · détail »', () => {
    const now = Date.now()
    write(claudeFile(), [user('go', now - 3000), assistant([{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { description: 'Build', command: 'npm run build' } }], now - 2000, { stop_reason: 'tool_use' })])
    store.scan(now)
    expect(one().phase).toBe('working')
    expect(one().messages.at(-1)).toMatchObject({ role: 'event', text: 'Bash · Build' })
  })

  it('sidechain, méta et sorties de commandes ignorées', () => {
    const now = Date.now()
    write(claudeFile(), [
      user('real', now - 4000),
      user('from a subagent', now - 3500, { isSidechain: true }),
      user('meta', now - 3000, { isMeta: true }),
      user('<command-name>/model</command-name>', now - 2500),
      user('[Request interrupted by user]', now - 2000),
    ])
    store.scan(now)
    expect(one().messages.map((m) => m.text)).toEqual(['real'])
  })

  it('deux parties de texte du même message assistant : un seul message', () => {
    const now = Date.now()
    const a = assistant([{ type: 'text', text: 'part one' }], now - 2000)
    const b = { ...assistant([{ type: 'text', text: 'part two' }], now - 1000), message: { ...a.message, content: [{ type: 'text', text: 'part two' }] } }
    write(claudeFile(), [user('q', now - 3000), a, b])
    store.scan(now)
    expect(one().messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'q'],
      ['assistant', 'part one\n\npart two'],
    ])
  })

  it('message signé : rôle orchestrator, texte sans signature', () => {
    const now = Date.now()
    write(claudeFile(), [user('[from:weevboss] fais le menu', now - 1000)])
    store.scan(now)
    expect(one().messages[0]).toMatchObject({ role: 'orchestrator', author: 'weevboss', text: 'fais le menu' })
  })
})

describe('claude : file d’attente', () => {
  const queued = (prompt: string, at: number) => ({ type: 'attachment', uuid: `q-${at}`, timestamp: iso(at), attachment: { type: 'queued_command', prompt } })

  it('un message en file apparaît une fois, et sort de la file quand l’agent le reprend', () => {
    const now = Date.now()
    const f = claudeFile()
    write(f, [user('first', now - 5000), queued('next', now - 4000)])
    store.scan(now)
    expect(one().messages.map((m) => m.text)).toEqual(['first', 'next'])
    expect(one().queued.map((q) => q.key)).toEqual(['next'])
    append(f, [user('next', now - 4000)])
    store.scan(now)
    expect(one().messages.map((m) => m.text)).toEqual(['first', 'next'])
    expect(one().queued).toEqual([])
  })

  it('un pas plus récent vide la file de ce qui a été mis avant', () => {
    const now = Date.now()
    const f = claudeFile()
    write(f, [user('first', now - 5000), queued('a', now - 4000), queued('b', now - 3000)])
    store.scan(now)
    expect(one().queued).toHaveLength(2)
    append(f, [user([{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }], now - 3500)])
    store.scan(now)
    expect(one().queued.map((q) => q.key)).toEqual(['b'])
  })
})

describe('codex', () => {
  const ev = (type: string, payload: Record<string, unknown>, at: number) => ({ type, timestamp: iso(at), payload })

  it('début et fin de tâche, messages, appels d’outil, réglages', () => {
    const now = Date.now()
    const f = codexFile(now)
    write(f, [
      ev('session_meta', { id: CODEX_UUID, cwd: '/home/u/projects/demo', git: { branch: 'main' } }, now - 6000),
      ev('turn_context', { cwd: '/home/u/projects/demo', model: 'gpt-x', approval_policy: 'never' }, now - 5500),
      ev('event_msg', { type: 'task_started' }, now - 5000),
      ev('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list files' }] }, now - 5000),
      ev('response_item', { type: 'function_call', name: 'shell', arguments: '{"cmd":["ls","-la"]}', call_id: 'c1' }, now - 4000),
    ])
    store.scan(now)
    let t = one()
    expect(t).toMatchObject({ tool: 'codex', branch: 'main', model: 'gpt-x', approval: 'never', phase: 'working', workStartedAt: now - 5000 })
    expect(t.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'list files'],
      ['event', 'shell · ls -la'],
    ])
    append(f, [ev('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'two files' }] }, now - 3000), ev('event_msg', { type: 'task_complete' }, now - 2000)])
    store.scan(now)
    t = one()
    expect(t.phase).toBe('idle')
    expect(t.workStartedAt).toBeNull()
    expect(t.messages.at(-1)).toMatchObject({ role: 'assistant', text: 'two files' })
  })

  it('consignes AGENTS.md injectées : pas un message de l’utilisateur', () => {
    const now = Date.now()
    write(codexFile(now), [ev('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /x' }] }, now - 1000)])
    store.scan(now)
    expect(store.byFile.size).toBe(1)
    expect(store.all()).toEqual([])
  })
})

describe('claude : sous-agents', () => {
  it('lit <session>/subagents/agent-*.jsonl : sa description pour nom, son dernier pas pour activité (détail : background.test.ts)', () => {
    const now = Date.now()
    const f = claudeFile()
    write(f, [user('go', now - 2000)])
    const dir = path.join(f.slice(0, -'.jsonl'.length), 'subagents')
    write(path.join(dir, 'agent-x.jsonl'), [{ type: 'user', timestamp: iso(now - 1500) }, assistant([{ type: 'tool_use', name: 'Grep', input: { pattern: 'TODO' } }], now - 1000)])
    fs.writeFileSync(path.join(dir, 'agent-x.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'scan' }))
    store.scan(now)
    expect(one().subagents).toEqual([{ id: 'x', kind: 'agent', label: 'scan', activity: 'Grep · TODO', status: 'working', startedAt: now - 1500, endedAt: undefined }])
  })
})

describe('tour arrêté par une erreur (session coupée)', () => {
  const apiError = (text: string, error: string, at: number) => ({
    ...assistant([{ type: 'text', text }], at, { model: '<synthetic>', stop_reason: 'stop_sequence' }),
    isApiErrorMessage: true,
    error,
  })

  it('claude : réponse synthétique d’erreur → idle + stopError classée (quota, connexion, API) ; effacée par le message suivant', () => {
    const now = Date.now()
    const f = claudeFile()
    write(f, [user('build it', now - 5000), apiError('Claude AI usage limit reached|1794200000', 'rate_limit', now - 4000)])
    store.scan(now)
    expect(one()).toMatchObject({ phase: 'idle', workStartedAt: null, stopError: { at: now - 4000, reason: 'quota' } })
    append(f, [apiError('Failed to authenticate: OAuth session expired and could not be refreshed', 'authentication_failed', now - 3000)])
    store.scan(now)
    expect(one().stopError?.reason).toBe('auth')
    append(f, [apiError('API Error: 529 overloaded', 'unknown', now - 2500)])
    store.scan(now)
    expect(one().stopError).toMatchObject({ reason: 'api', text: 'API Error: 529 overloaded' })
    append(f, [user('try again', now - 2000)])
    store.scan(now)
    expect(one()).toMatchObject({ phase: 'working', stopError: undefined })
    expect(one().headless).toBeUndefined()
    append(f, [user('say ok', now - 1000, { entrypoint: 'sdk-cli' })])
    store.scan(now)
    expect(one().headless).toBe(true)
  })

  it('claude : une vraie réponse efface l’erreur ; compaction ratée → stopError', () => {
    const now = Date.now()
    const f = claudeFile()
    write(f, [user('go', now - 5000), apiError('API Error: 500', 'api_error', now - 4000), assistant([{ type: 'text', text: 'ok' }], now - 3000, { stop_reason: 'end_turn' })])
    store.scan(now)
    expect(one().stopError).toBeUndefined()
    append(f, [{ type: 'system', subtype: 'compact_error', level: 'error', content: 'Error during compaction: Conversation too long', timestamp: iso(now - 1000) }])
    store.scan(now)
    expect(one()).toMatchObject({ phase: 'idle', stopError: { reason: 'api' } })
  })

  it('codex : event_msg error → idle + stopError ; task_started l’efface', () => {
    const now = Date.now()
    const cf = codexFile(now)
    write(cf, [
      { type: 'event_msg', timestamp: iso(now - 3000), payload: { type: 'task_started' } },
      { type: 'event_msg', timestamp: iso(now - 2000), payload: { type: 'error', message: 'You have hit your usage limit.' } },
    ])
    store.scan(now)
    expect(one()).toMatchObject({ phase: 'idle', stopError: { reason: 'quota' } })
    append(cf, [{ type: 'event_msg', timestamp: iso(now - 1000), payload: { type: 'task_started' } }])
    store.scan(now)
    expect(one()).toMatchObject({ phase: 'working', stopError: undefined })
  })
})

describe('codex : messages entrants du relais', () => {
  const event = (type: string, payload: unknown, at: number) => ({ type, payload, timestamp: iso(at) })
  const incoming = (id: string, text: string, source = UUID) => ({ type: 'function_call_output', id, namespace: 'codex_tui', name: 'send_message_to_thread', output: `<codex_delegation>\n<source_thread_id>${source}</source_thread_id>\n<input>${text}</input>\n</codex_delegation>` })
  it('affiche les envois CLI et bridge une seule fois, dans leur ordre, avec leur auteur', () => {
    const now = Date.now(), file = codexFile(now)
    const first = incoming('fco-one', 'Vérifie le résultat &amp; reprends.')
    write(file, [
      event('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '[from:weevboss] Premier brief' }] }, now - 4000),
      event('response_item', first, now - 3000),
      event('event_msg', { type: 'item_completed', item: { ...first, type: 'FunctionCallOutput' } }, now - 2999),
      event('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Je vérifie.' }] }, now - 2000),
      event('event_msg', { type: 'item_completed', item: { ...incoming('fco-two', '[from:alice] Autre point'), type: 'FunctionCallOutput' } }, now - 1000),
    ])
    store.authorOfThread = (id) => id === UUID ? 'weevboss' : undefined
    store.scan(now)
    expect(one().messages.map(({ role, author, text }) => ({ role, author, text }))).toEqual([
      { role: 'orchestrator', author: 'weevboss', text: 'Premier brief' },
      { role: 'orchestrator', author: 'weevboss', text: 'Vérifie le résultat & reprends.' },
      { role: 'assistant', author: undefined, text: 'Je vérifie.' },
      { role: 'orchestrator', author: 'alice', text: 'Autre point' },
    ])
    expect(store.scan(now)).toBe(false)
    append(file, [event('response_item', incoming('fco-three', 'Vérifie le résultat &amp; reprends.'), now)])
    store.scan(now)
    expect(one().messages).toHaveLength(5) // A separate intentional message is kept.
    const reread = new TranscriptStore(claudeDir, codexDir, 3 * DAY)
    reread.authorOfThread = store.authorOfThread
    reread.scan(now)
    expect(reread.get(CODEX_UUID)?.messages).toEqual(one().messages)
  })
  it('ignore les sorties ordinaires, le contexte système et les enveloppes mal formées', () => {
    const now = Date.now()
    write(codexFile(now), [
      event('response_item', { ...incoming('wrong-tool', 'Secret'), namespace: 'exec' }, now - 4000),
      event('response_item', { ...incoming('malformed', 'Secret'), output: '<codex_delegation>system</codex_delegation>' }, now - 3000),
      event('response_item', { type: 'message', role: 'system', content: [{ text: 'Internal context' }] }, now - 2000),
      event('response_item', incoming('good', 'Message humain', CODEX_UUID), now - 1000),
    ])
    store.scan(now)
    expect(one().messages).toMatchObject([{ id: 'good', author: 'codex', text: 'Message humain' }])
    store.authorOfThread = () => 'weevboss'
    expect(store.scan(now)).toBe(true)
    expect(one().messages[0].author).toBe('weevboss')
  })
})
