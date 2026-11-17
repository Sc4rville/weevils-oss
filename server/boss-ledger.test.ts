import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Session } from '../shared/api.ts'
import { actionsOf, Ledger, readTurn, similar, verbatim, type LedgerHost, type Model } from './boss-ledger.ts'
import type { Entry } from './boss-view.ts'
import { BossTurns } from './boss-turns.ts'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'boss-ledger-'))
const T0 = Date.UTC(2026, 10, 14, 8, 0, 0)

const session = (id: string, o: Partial<Session> = {}): Session => ({
  id, projectId: 'weevils', repo: 'weevils', machineId: 'vps', tool: 'claude', title: 'Onboarding link', status: 'working', cwd: '/x', openedAt: T0, lastActivityAt: T0,
  workStartedAt: null, origin: 'weevils', controllable: true, live: true, hasScreen: true, subagents: [], background: 0, messageCount: 3, queued: 0, ...o,
}) as Session

function rig(o: { model?: Model; sessions?: Session[]; journal?: Entry[]; running?: Set<string>; messages?: Record<string, { role: string; text: string; at: number }[]> } = {}) {
  const dir = tmp()
  let now = T0
  const calls: { prompt: string; schema: object }[] = []
  const model: Model = o.model ?? (async () => '{"messages":[],"new_goals":[]}')
  const host: LedgerHost = {
    sessions: () => o.sessions ?? [],
    detail: async (id) => ({ session: (o.sessions ?? []).find((s) => s.id === id)!, messages: (o.messages?.[id] ?? []) as any }),
    turnRunning: (id) => !!o.running?.has(id),
    journal: () => o.journal ?? [],
    lang: () => 'en',
    user: () => 'Yann',
  }
  const ledger = new Ledger({ dir, host, model: async (p, s) => { calls.push({ prompt: p, schema: s }); return model(p, s) }, now: () => now })
  return { dir, ledger, calls, tick: (ms: number) => (now += ms), at: () => now }
}

const answer = (messages: object[], new_goals: object[] = []) => JSON.stringify({ messages, new_goals })

describe('verbatim', () => {
  it('keeps a quote that is really in the message, whatever the spacing and accents', () => {
    const msg = "met makzura collab de weevils aussi   et envoie   tout les content à instinct"
    expect(verbatim('envoie tout les content', msg)).toBe('envoie tout les content')
    expect(verbatim('« ENVOIE tout les content »', msg)).toBe('envoie tout les content')
  })
  it('falls back to the message itself when the model paraphrased', () => {
    expect(verbatim('send all the content', 'envoie tout les content')).toBe('envoie tout les content')
  })
})

describe('similar', () => {
  it('sees the same rule said twice, not two different ones', () => {
    expect(similar('Never present Yann’s own ideas as weevboss’s suggestions in For you', 'In For you, never present Yann’s own ideas as weevboss’s suggestions')).toBe(true)
    expect(similar('Default app language is English', 'Keep 20% of the Codex subscription')).toBe(false)
  })
})

describe('actionsOf', () => {
  it('reads sends, new sessions (with the id from the result) and chained commands', () => {
    const cmd = `weevils send 3f2a1b9c "Fix the link on phones" && weevils new content "Write the masterclass scripts" `
    const got = actionsOf(cmd, 'accepted for delivery\nnew session 9abc1234')
    expect(got.map((a) => [a.kind, a.session, a.project])).toEqual([['send', '3f2a1b9c', undefined], ['new', '9abc1234', 'content']])
    expect(got[0].brief).toBe('Fix the link on phones')
  })
  it('peels a heredoc brief', () => {
    const got = actionsOf(`weevils send abcdef12 "$(cat <<'EOF'\nLine one\nline two\nEOF\n)"`)
    expect(got[0].brief).toBe('Line one line two')
  })
  it('notes ledger commands without taking them for dispatches', () => {
    expect(actionsOf('weevils ask done r3').map((a) => a.kind)).toEqual(['ledger'])
  })
})

describe('readTurn', () => {
  it('finds the message id, the reply and the dispatches of a turn transcript', () => {
    const dir = tmp()
    const f = path.join(dir, 't.jsonl')
    fs.writeFileSync(f, [
      { type: 'user', uuid: 'msg-1', message: { role: 'user', content: 'fix the link and send the videos' } },
      { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'weevils new weevils "fix the link"' } }] } },
      { type: 'user', uuid: 'r1', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'new session 1234abcd' }] } },
      { type: 'assistant', uuid: 'a2', message: { content: [{ type: 'text', text: 'Sent to weevils.' }] } },
    ].map((o) => JSON.stringify(o)).join('\n'))
    const t = readTurn(f)
    expect(t.src).toBe('msg-1')
    expect(t.reply).toBe('Sent to weevils.')
    expect(t.actions).toMatchObject([{ kind: 'new', project: 'weevils', session: '1234abcd' }])
  })
})

describe('Ledger', () => {
  it('captures a message on disk at once, and a retry only once', () => {
    const { ledger, dir } = rig()
    const cid = ledger.capture('fix the link ⟦not here⟧')
    expect(cid).toMatch(/^c[0-9a-f]{8}$/)
    expect(ledger.capture('fix the link ⟦not here⟧')).toBe(cid)
    const disk = JSON.parse(fs.readFileSync(path.join(dir, 'ledger.json'), 'utf8'))
    expect(disk.inbox).toHaveLength(1)
    expect(new Ledger({ dir, host: {} as LedgerHost, model: async () => '' }).pending).toHaveLength(1)
  })

  it('splits a dictated message into atomic requests, links the dispatch, keeps exact words, writes the trace', async () => {
    const turns = tmp()
    const s = session('3f2a1b9c-0000-0000-0000-000000000000')
    const msg = 'le lien marche pas fais en sorte qu il marche et envoie tout les content à instinct et met le default en anglais'
    const model: Model = async (prompt) => {
      expect(prompt).toContain(msg)
      expect(prompt).toContain('sent to session 3f2a1b9c')
      return answer([{
        m: 'M1',
        requests: [
          { quote: 'fais en sorte qu il marche', text: 'Fix the onboarding link', kind: 'task', state: 'dispatched', sessions: ['3f2a1b9c'], goal: 'blow-up', expect: 'a working link tested on a phone' },
          { quote: 'envoie tout les content à instinct', text: 'Send all the content concepts to instinct', kind: 'task', state: 'open', sessions: [], goal: '' },
          { quote: 'default in English', text: 'Make English the default language', kind: 'task', state: 'open', sessions: [], goal: 'nope' },
        ],
        updates: [],
        memory: [{ kind: 'rule', text: 'The default app language is English: the community is English-speaking.' }],
        trace: [{ session: '3f2a1b9c', text: 'Asked the onboarding session to fix the link', why: 'Yann wants to post it on Twitter', expect: 'a working link' }],
      }], [{ id: 'blow-up', title: 'Make weevils blow up', why: 'launch on Twitter' }])
    }
    const { ledger, tick } = rig({ model, sessions: [s] })
    const cid = ledger.capture(msg)!
    ledger.attach(cid, 'turn-1')
    fs.writeFileSync(path.join(turns, 'turn-1.jsonl'), [
      { type: 'user', uuid: 'msg-uuid-1', message: { content: msg } },
      { type: 'assistant', uuid: 'a', message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'weevils send 3f2a1b9c "fix the link"' } }, { type: 'text', text: 'Sent.' }] } },
    ].map((o) => JSON.stringify(o)).join('\n'))
    tick(1000)
    expect(await ledger.reconcile(turns)).toBe(1)
    const asks = ledger.asks('open')
    expect(asks).toHaveLength(3)
    const link = asks.find((a) => a.text === 'Fix the onboarding link')!
    expect(link).toMatchObject({ status: 'dispatched', goal: 'blow-up', src: 'msg-uuid-1', quote: 'fais en sorte qu il marche' })
    expect(link.dispatches[0]).toMatchObject({ session: s.id, expect: 'a working link tested on a phone' })
    // A paraphrased quote never stands in for the user's words; an unknown goal is left out.
    const lang = asks.find((a) => a.text.startsWith('Make English'))!
    expect(lang.quote).toBe(msg)
    expect(lang.goal).toBeUndefined()
    expect(ledger.pending).toHaveLength(0)
    expect(ledger.knowledge()).toMatchObject([{ kind: 'rule', src: ['msg-uuid-1'] }])
    expect(ledger.traceList().map((e) => e.kind)).toEqual(['goal', 'request', 'request', 'request', 'dispatch'])
    expect(ledger.traceList({ goal: 'blow-up' }).find((e) => e.kind === 'dispatch')).toMatchObject({ asks: [link.id], why: 'Yann wants to post it on Twitter' })
  })

  it('waits for the turn to end, retries a failed read, and finally keeps the whole message as one request', async () => {
    const running = new Set(['turn-1'])
    const { ledger, tick } = rig({ model: async () => { throw new Error('quota') }, running })
    const cid = ledger.capture('do the thing and the other thing')!
    ledger.attach(cid, 'turn-1')
    expect(await ledger.reconcile(tmp())).toBe(0)
    running.clear()
    for (let i = 0; i < 5; i++) { await ledger.reconcile(tmp()); tick(3 * 3600_000) }
    const asks = ledger.asks('open')
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({ quote: 'do the thing and the other thing', note: expect.stringContaining('kept whole') })
    expect(ledger.pending).toHaveLength(0)
  })

  it('applies updates: done, dispatched, and dropped only on the user’s word', async () => {
    let reply = ''
    const { ledger, tick } = rig({ model: async () => reply })
    const a = ledger.add('Send the videos to instinct')
    const b = ledger.add('Make a stylish link')
    reply = answer([{ m: 'M1', requests: [], updates: [{ id: a.id, status: 'dropped', note: 'not needed' }], memory: [], trace: [] }])
    ledger.capture('[from:gepetto] forget the videos')
    tick(4 * 60_000)
    await ledger.reconcile(tmp())
    expect(ledger.ask(a.id)!.status).toBe('open')
    reply = answer([{ m: 'M1', requests: [], updates: [{ id: a.id, status: 'dropped' }, { id: b.id, status: 'done', note: 'link is live' }], memory: [], trace: [] }])
    ledger.capture('laisse tomber les vidéos, le lien c bon')
    tick(4 * 60_000)
    await ledger.reconcile(tmp())
    expect(ledger.ask(a.id)).toMatchObject({ status: 'dropped', closedBy: 'user' })
    expect(ledger.ask(b.id)).toMatchObject({ status: 'done', note: 'link is live' })
  })

  it('links an older open request named « (r12) » in a brief, whatever the model saw', async () => {
    const turns = tmp()
    const s = session('bbbb2222-0000-0000-0000-000000000000')
    const { ledger, tick } = rig({ sessions: [s] })
    const old = ledger.add('Ship the macOS version')
    const cid = ledger.capture('et la version mac alors ?')!
    ledger.attach(cid, 'turn-2')
    fs.writeFileSync(path.join(turns, 'turn-2.jsonl'), [
      { type: 'user', uuid: 'u2', message: { content: 'et la version mac alors ?' } },
      { type: 'assistant', uuid: 'a', message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: `weevils send bbbb2222 "Finish the macOS installer (${old.id}) and report the test result"` } }] } },
    ].map((o) => JSON.stringify(o)).join('\n'))
    tick(1000)
    await ledger.reconcile(turns)
    expect(ledger.ask(old.id)).toMatchObject({ status: 'dispatched', dispatches: [{ session: s.id }] })
  })

  it('lets a later turn of the same batch dispatch a request made by an earlier message (M1.1), notes without M labels', async () => {
    const e = (id: string, at: number, role: Entry['role'], text: string): Entry => ({ id, at, role, text })
    const s = session('cccc3333-0000-0000-0000-000000000000')
    const journal = [e('m1', T0 - 600_000, 'user', 'il faut virer les boutons terminal'), e('m2', T0 - 300_000, 'user', 'go'), e('ev', T0 - 299_000, 'event', 'Bash · weevils send cccc3333 "remove the terminal buttons"')]
    const { ledger } = rig({ journal, sessions: [s], model: async (p) => p.includes('durable goals') ? '{"goals":[]}' : answer([
      { m: 'M1', requests: [{ quote: 'virer les boutons terminal', text: 'Remove the terminal buttons', kind: 'task', state: 'open', sessions: [], goal: '' }], updates: [], memory: [], trace: [] },
      { m: 'M2', requests: [], updates: [{ id: 'M1.1', status: 'dispatched', sessions: ['cccc3333'], note: 'M2 sent it to the UX session' }], memory: [], trace: [] },
    ]) })
    await ledger.backfill(24)
    expect(ledger.asks('open')[0]).toMatchObject({ status: 'dispatched', note: 'sent it to the UX session', dispatches: [{ session: s.id }] })
  })

  it('closes the loop when a dispatched session stops, and only once per stop', async () => {
    const s = session('aaaa1111-0000-0000-0000-000000000000')
    let judged = 0
    const model: Model = async (prompt, schema) => {
      if (!('properties' in schema && (schema as any).properties.items)) return answer([])
      judged++
      expect(prompt).toContain('Request: Fix the link')
      expect(prompt).toContain('The link works, tested on iPhone')
      return JSON.stringify({ items: [{ n: 1, outcome: 'done', report: 'Link fixed and tested on an iPhone.' }] })
    }
    const sessions = [s]
    const r = rig({ model, sessions, messages: { [s.id]: [{ role: 'assistant', text: 'The link works, tested on iPhone', at: T0 + 120_000 }] } })
    const a = r.ledger.add('Fix the link')
    r.ledger.link(a.id, 'aaaa1111', 'a working link')
    expect(r.ledger.ask(a.id)!.dispatches[0].label).toBe('weevils · claude · Onboarding link')
    // Still working: nothing to judge.
    sessions[0] = { ...s, status: 'working', lastActivityAt: r.at() + 60_000 }
    r.tick(200_000)
    expect(await r.ledger.closeLoop()).toBe(0)
    sessions[0] = { ...s, status: 'idle', lastActivityAt: r.at() }
    r.tick(30_000)
    expect(await r.ledger.closeLoop()).toBe(0) // settles first
    r.tick(120_000)
    expect(await r.ledger.closeLoop()).toBe(1)
    expect(r.ledger.ask(a.id)).toMatchObject({ status: 'done', closedBy: 'auto', note: 'Link fixed and tested on an iPhone.' })
    expect(await r.ledger.closeLoop()).toBe(0)
    expect(judged).toBe(1)
    expect(r.ledger.traceList().map((e) => e.kind)).toContain('report')
  })

  it('surfaces stale requests first in a digest that never outgrows its budget', () => {
    const { ledger, tick } = rig()
    ledger.addGoal('open-source', 'Open-source weevils')
    const old = ledger.add('Old forgotten ask about the trailer', { goal: 'open-source' })
    tick(30 * 3600_000)
    for (let i = 0; i < 80; i++) ledger.add(`Request number ${i} with a fairly long description of what Yann wants done in the app`)
    ledger.remember('rule', 'Never put the Claude–Codex relay back on ask')
    const d = ledger.digest(600)
    expect(d.length).toBeLessThanOrEqual(600 * 3.2)
    const lines = d.split('\n')
    expect(lines[1]).toContain(old.id)
    expect(lines[1]).toContain('STALE')
    expect(d).toContain('more: weevils asks')
    expect(d).toContain('open-source: Open-source weevils · 0/1 done, 1 stale')
    expect(d).toContain('Never put the Claude–Codex relay back on ask')
    expect(ledger.asks('stale').map((a) => a.id)).toEqual([old.id])
  })

  it('remembers once, refuses secrets, and searches knowledge, requests and the log with ids that lead back', () => {
    const journal: Entry[] = [{ id: 'abcdef12-3456-0000-0000-000000000000', at: T0, role: 'user', text: 'mets le domaine tryweevils.scarville.tech partout' }]
    const { ledger } = rig({ journal })
    const k = ledger.remember('decision', 'The public link is tryweevils.scarville.tech', 'abcdef12-3456')
    expect(ledger.remember('fact', 'the public link is tryweevils.scarville.tech', 'other').id).toBe(k.id)
    expect(ledger.knowledge()).toHaveLength(1)
    expect(ledger.knowledge()[0].seen).toBe(2)
    expect(() => ledger.remember('fact', 'the api key is sk-abcdefghijklmnop1234')).toThrow()
    ledger.add('Update the public link domain')
    const r = ledger.search('domaine tryweevils')
    expect(r.knowledge[0].id).toBe(k.id)
    expect(r.log[0]).toMatchObject({ id: 'abcdef12', role: 'user' })
    expect(ledger.search('link').asks).toHaveLength(1)
    expect(ledger.forget(k.id)).toBe(true)
  })

  it('backfills the log once: messages with the actions that followed them', async () => {
    const e = (id: string, at: number, role: Entry['role'], text: string, author?: string): Entry => ({ id, at, role, text, ...(author ? { author } : {}) })
    const journal = [
      e('m1', T0 - 30 * 3600_000, 'user', 'too old'),
      e('m2', T0 - 3600_000, 'user', 'fais le trailer'),
      e('a2', T0 - 3599_000, 'assistant', 'Sent.'),
      e('a2.1', T0 - 3599_000, 'event', 'Bash · weevils send 3f2a1b9c "make the trailer"'),
      e('m3', T0 - 1800_000, 'agent', 'here are two ideas', 'gepetto'),
    ]
    let seen = ''
    const { ledger } = rig({ journal, model: async (p) => { seen = p; return answer([{ m: 'M1', requests: [{ quote: 'fais le trailer', text: 'Make the trailer', kind: 'task', state: 'dispatched', sessions: ['3f2a1b9c'], goal: '' }], updates: [], memory: [], trace: [] }, { m: 'M2', requests: [], updates: [], memory: [], trace: [] }]) } })
    const r = await ledger.backfill(24)
    expect(r).toEqual({ messages: 2, asks: 1 })
    expect(seen).not.toContain('too old')
    expect(seen).toContain('sent to session 3f2a1b9c')
    expect(seen).toContain('agent gepetto')
    expect(ledger.asks('open')[0]).toMatchObject({ src: 'm2', status: 'dispatched' })
    expect((await ledger.backfill(24)).messages).toBe(1) // m2 is already in; only the agent message without a request is read again
  })
})

describe('BossTurns + ledger', () => {
  it('joins the digest to the hidden block and keeps the capture id through the queue', async () => {
    const dir = tmp()
    const t = new BossTurns(async () => '{"lines":[]}', dir, path.join(dir, 'transcripts'), 8000)
    t.enqueue('hello', 'c12345678')
    const turn = await t.prepare({ id: 'turn-1', claude: ['claude'], memory: '', ledger: '## Open requests (1 open)\n- r1 [open · 2h] Fix the link', instructions: 'x', summaryMs: 0 })
    const prompt = fs.readFileSync(path.join(dir, 'turns', 'turn-1.txt'), 'utf8')
    expect(prompt).toContain('your request ledger right now')
    expect(prompt).toContain('r1 [open · 2h] Fix the link')
    expect(turn.ledgerTokens).toBeGreaterThan(10)
    expect(t.started(turn)?.cid).toBe('c12345678')
  })
})

describe('grouping a burst into one request', () => {
  const msg = (n: number, text: string, at = T0 + n * 40_000) => ({ key: `c${n}`, src: `m${n}`, at, from: 'user', text, reply: '', actions: [] })
  const req = (quote: string, text: string, merge_into = '') => ({ quote, text, kind: 'task', state: 'open', sessions: [], goal: '', merge_into })
  const one = (requests: object[]) => ({ m: '', requests, updates: [], memory: [], trace: [] })

  it('a burst of 4 messages on one topic makes 1 request, with every message id and exact words kept', async () => {
    const texts = ['refais l onboarding il est trop long', 'pc', 'et aussi enleve l etape langue', 'non garde la langue mais en dernier']
    const { ledger } = rig({ model: async () => answer([
      { ...one([req(texts[0], 'Shorten the onboarding')]), m: 'M1' },
      { ...one([req('pc', 'Shorten the onboarding on desktop', 'M1.1')]), m: 'M2' },
      { ...one([req('enleve l etape langue', 'Shorten the desktop onboarding, without the language step', 'M1.1')]), m: 'M3' },
      { ...one([req(texts[3], 'Shorten the desktop onboarding, language step moved last', 'M1.1')]), m: 'M4' },
    ]) })
    expect(await ledger.read(texts.map((t, i) => msg(i + 1, t)))).toBe(true)
    const asks = ledger.asks('all')
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({ src: 'm1', quote: texts[0], text: 'Shorten the desktop onboarding, language step moved last' })
    expect(asks[0].more?.map((x) => [x.src, x.quote])).toEqual([['m2', 'pc'], ['m3', 'enleve l etape langue'], ['m4', texts[3]]])
  })

  it('two different topics in a burst stay 2 requests, even when the model names a wrong merge', async () => {
    const { ledger } = rig({ model: async () => answer([
      { ...one([req('fix the login page', 'Fix the login page')]), m: 'M1' },
      { ...one([req('post the video on twitter', 'Post the video on Twitter')]), m: 'M2' },
    ]) })
    await ledger.read([msg(1, 'fix the login page'), msg(2, 'post the video on twitter')])
    expect(ledger.asks('all').map((a) => a.text).sort()).toEqual(['Fix the login page', 'Post the video on Twitter'])
  })

  it('a later message that refines an open request joins it; a closed one is never reopened by a merge', async () => {
    let reply = ''
    const { ledger } = rig({ model: async () => reply })
    const open = ledger.add('Fix the onboarding link', { quote: 'fix the onboarding link', src: 'm0' })
    const closed = ledger.add('Rename the app')
    ledger.setStatus(closed.id, 'done', 'user')
    reply = answer([
      { ...one([req('on iphone only', 'Fix the onboarding link on iPhone', open.id)]), m: 'M1' },
      { ...one([req('call it weevils', 'Call the app weevils', closed.id)]), m: 'M2' },
    ])
    await ledger.read([msg(1, 'on iphone only', T0 + 3600_000), msg(2, 'call it weevils', T0 + 3600_000)])
    expect(ledger.ask(open.id)).toMatchObject({ text: 'Fix the onboarding link on iPhone', more: [{ src: 'm1', quote: 'on iphone only' }] })
    expect(ledger.asks('all')).toHaveLength(3)
  })

  it('a twin the model forgot to merge, in the same burst, is merged anyway', async () => {
    const { ledger } = rig({ model: async () => answer([
      { ...one([req('fix the onboarding link', 'Fix the onboarding link')]), m: 'M1' },
      { ...one([req('the onboarding link fix', 'Fix the onboarding link')]), m: 'M2' },
    ]) })
    await ledger.read([msg(1, 'fix the onboarding link'), msg(2, 'the onboarding link fix')])
    expect(ledger.asks('all')).toHaveLength(1)
    expect(ledger.asks('all')[0].more).toHaveLength(1)
  })

  it('old ledger data without the new fields still loads and shows', () => {
    const { ledger, dir } = rig()
    fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify({ v: 1, next: { r: 5, k: 1 }, asks: [{ id: 'r4', text: 'Old one', quote: 'old', src: 'x', from: 'user', at: T0, kind: 'task', status: 'open', dispatches: [], progressAt: T0 }], goals: [], inbox: [], readTurns: [], recent: {} }))
    const again = new Ledger({ dir, host: (ledger as any).host, model: async () => '{}' })
    expect(again.view().asks[0]).toMatchObject({ id: 'r4', text: 'Old one' })
  })
})

describe('handling: answered, sent or queued', () => {
  it('records it on each new request from the user’s words', async () => {
    const r = (quote: string, text: string, state = 'open', kind = 'task') => ({ m: '', requests: [{ quote, text, kind, state, sessions: [], goal: '' }], updates: [], memory: [], trace: [] })
    const { ledger } = rig({ model: async () => answer([
      { ...r('fix the login, urgent', 'Fix the login'), m: 'M1' },
      { ...r('clean the repo this weekend', 'Clean the repo'), m: 'M2' },
      { ...r('what is the quota', 'What is the quota?', 'done', 'question'), m: 'M3' },
    ]) })
    const m = (n: number, text: string) => ({ key: `c${n}`, src: `m${n}`, at: T0, from: 'user', text, reply: '', actions: [] })
    await ledger.read([m(1, 'fix the login, urgent'), m(2, 'clean the repo this weekend'), m(3, 'what is the quota')])
    const by = (t: string) => ledger.asks('all').find((a) => a.text === t)!
    expect(by('Fix the login')).toMatchObject({ handling: 'send', why: 'you-said-now' })
    expect(by('Clean the repo')).toMatchObject({ handling: 'queued', why: 'you-said-later' })
    expect(by('What is the quota?')).toMatchObject({ handling: 'answered', why: 'answered' })
    expect(ledger.digest()).toContain('SEND NOW')
  })
})
