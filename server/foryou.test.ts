import { feedNoticeKey } from '../shared/notices.ts'
// The « for you » stream: the store (cap, age, one item per session, what never enters), mail privacy, posts and their
// buttons, replies, media, live alerts and proposals, seen / dismissed across a restart, the order (arrange) and who
// may post. No server, no model: the host (Weevils) is a plain object.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message, Optimizer, Session, Snapshot } from '../shared/api.ts'
import type { ForYouItem, ForYouKind } from '../shared/foryou.ts'
import type { UsageInfo } from '../shared/infra.ts'
import {
  ForYou, KEEP_MS, MAX_CARDS, MAX_FEED, MAX_ITEMS, MAX_MEDIA, MEDIA_JOIN_MS, OFFLINE_AFTER_MS, REFRESH_MS,
  HEADLINE_MAX, arrange, cleanTitle, headline, firstLine, foryouRoutes, lastWords, withoutPaths, type ForYouDeps, type MachineState,
} from './foryou.ts'
import M from './i18n/foryou.ts'
import TM from './i18n/tips.ts'

// Only for the last block (the hooks in core.ts, with a real Weevils): tmux and the voice are simulated, as in
// lifecycle.test.ts. The stream itself imports none of them.
const mux = vi.hoisted(() => ({
  sendText: vi.fn(async (_name: string, _text: string) => {}),
  sendKey: vi.fn(async (_name: string, _key: string) => {}),
  capture: vi.fn(async (_name: string) => ''),
  spawnWv: vi.fn(async (..._args: unknown[]) => {}),
  killWv: vi.fn(async (_name: string) => {}),
  listWv: vi.fn(async () => [] as unknown[]),
  setOpt: vi.fn(async (..._args: unknown[]) => {}),
}))
vi.mock('./mux.ts', async (orig) => ({ ...(await orig<typeof import('./mux.ts')>()), ...mux }))
vi.mock('./voicepipe.ts', () => ({ keepWarm() {}, warmCues() {} }))
vi.mock('./fast.ts', () => ({ setCartesiaVoice() {} }))
vi.mock('./titles.ts', async (orig) => ({ ...(await orig<typeof import('./titles.ts')>()), llmTitles: async () => [] }))

const T0 = new Date('2026-11-10T09:00:00Z').getTime()
const MIN = 60_000
const HOUR = 3600_000

const session = (over: Partial<Session> = {}): Session =>
  ({ id: 's1', projectId: 'mygame', repo: 'mygame', machineId: 'test', tool: 'claude', title: 'Jump physics', status: 'idle', cwd: '/home/u/projects/mygame', lastActivityAt: T0, origin: 'weevils', controllable: true, live: true, hasScreen: true, messageCount: 4, lastMessage: 'short tail', ...over }) as Session
const optimizer = (over: Partial<Optimizer> = {}): Optimizer => ({ id: 'o1', title: 'Harden the tests', why: 'you want to ship mygame', repo: 'mygame', kind: 'tests', heavy: false, state: 'proposed', createdAt: T0, ...over })
const says = (text: string, role: Message['role'] = 'assistant'): Message => ({ id: `m${Math.random()}`, role, text, at: T0 })

let dir: string
let now: number
let snap: Snapshot
let threads: Record<string, Message[]>
let transcripts: Map<string, { firstPrompt?: string; headless?: boolean; originator?: string }>
/** Weevils, as the stream sees it. */
const newHost = () => ({
  snapshot: () => snap,
  bump: vi.fn(() => {}),
  detailAny: async (id: string) => (threads[id] ? { session: session({ id }), messages: threads[id] } : undefined),
  send: vi.fn(async (id: string, _text: string, _from?: string) => ({ id })),
  sendMain: vi.fn(async (_text: string, _brief?: string) => ({ id: 'boss' })),
  resume: vi.fn(async (id: string) => ({ id })),
  close: vi.fn(async (_id: string): Promise<unknown> => ({ ok: true })),
  orchestratorId: 'boss' as string | null,
  store: { get: (id: string) => transcripts.get(id) },
})
let host: ReturnType<typeof newHost>
let later: (() => void)[]
/** A shelf that knows the files it is told about (the real one is tested in foryou-media.test.ts). */
let shelf: NonNullable<ForYouDeps['shelf']> & { known: Set<string>; served: string[] }

const make = (deps: ForYouDeps = {}) =>
  new ForYou(host, { file: path.join(dir, 'foryou.json'), now: () => now, dataDir: '/home/u/.local/share/weevils', machineId: 'test', shelf, later: (fn) => void later.push(fn), ...deps })
const flush = () => new Promise((r) => setTimeout(r, 0))
const ids = (fy: ForYou) => fy.feed().items.map((i) => i.id)
const find = (fy: ForYou, id: string) => fy.feed().items.find((i) => i.id === id)

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foryou-'))
  now = T0
  later = []
  threads = {}
  transcripts = new Map()
  snap = { machines: [{ id: 'test', name: 'vps', online: true }], projects: [], sessions: [], optimizers: [], conversationCounts: { pending: 0 } } as unknown as Snapshot
  host = newHost()
  const entry = (p: string) => ({ id: `f${Buffer.from(p).toString('hex').slice(-12)}`, path: p, type: /\.mp4$/.test(p) ? ('video' as const) : ('image' as const), bytes: 10, mtime: T0, name: path.basename(p), at: T0 })
  const known = new Set<string>()
  const byId = new Map<string, ReturnType<typeof entry>>()
  shelf = {
    known,
    served: [],
    add(p, cwd) {
      const abs = path.resolve(cwd ?? '/', p)
      if (!known.has(abs)) throw new Error('not a file weevils can show')
      const e = entry(abs)
      byId.set(e.id, e)
      return e
    },
    fromText(text, cwd, max = 4) {
      return [...text.matchAll(/\S+\.(?:png|mp4)/g)].map((m) => path.resolve(cwd ?? '/', m[0])).filter((p) => known.has(p)).slice(0, max).map((p) => this.add(p))
    },
    get: (id) => byId.get(id) ?? null,
    view: (e) => ({ id: e.id, type: e.type, url: `/api/foryou/media/${e.id}`, name: e.name, bytes: e.bytes }),
    serve(_req, _res, id) {
      this.served.push(id)
    },
  }
})

// ---------------------------------------------------------------- the store

describe('the store', () => {
  it('writes foryou.json for the user only, through a temporary file', () => {
    const fy = make()
    fy.post('hello')
    expect(fs.statSync(fy.file).mode & 0o777).toBe(0o600)
    expect(fs.existsSync(`${fy.file}.tmp`)).toBe(false)
    expect(JSON.parse(fs.readFileSync(fy.file, 'utf8')).items).toHaveLength(1)
  })

  it('keeps at most 400 items, the newest, and nothing older than 14 days', () => {
    const fy = make()
    for (let i = 0; i < MAX_ITEMS + 5; i++) {
      now = T0 + i * 1000
      fy.post(`post ${i}`)
    }
    const kept = JSON.parse(fs.readFileSync(fy.file, 'utf8')).items as { text: string }[]
    expect(kept).toHaveLength(MAX_ITEMS)
    expect(kept.some((i) => i.text === 'post 0')).toBe(false)
    expect(kept.some((i) => i.text === `post ${MAX_ITEMS + 4}`)).toBe(true)
    // The app gets 60 of them at most.
    expect(fy.feed().items).toHaveLength(MAX_FEED)
    now = T0 + KEEP_MS + HOUR
    fy.post('the only fresh one')
    expect((JSON.parse(fs.readFileSync(fy.file, 'utf8')).items as { text: string }[]).map((i) => i.text)).toEqual(['the only fresh one'])
  })

  it('starts empty on a missing or broken file', () => {
    fs.writeFileSync(path.join(dir, 'foryou.json'), '{ not json')
    const fy = make()
    expect(fy.feed()).toMatchObject({ rev: 0, items: [], pulse: { working: 0, waiting: 0, delivered: 0, auto: 0 } })
  })
})

// ---------------------------------------------------------------- sessions

describe('session results', () => {
  it('one item per session: the last words of the turn, replaced by the next turn and unseen again', async () => {
    const fy = make()
    const s = session()
    snap.sessions = [s]
    threads.s1 = [says('do it', 'user'), says('The   jump\nnow feels right.')]
    fy.sessionTurn(s, 'result')
    await flush()
    expect(fy.feed().items).toEqual([
      { id: 's:s1', kind: 'session', tone: 'result', at: T0, who: 'session', projectId: 'mygame', sessionId: 's1', tool: 'claude', title: 'Jump physics', text: 'The jump now feels right.', reply: 'session', open: { page: 'session', id: 's1' } },
    ])
    fy.seen(['s:s1'])
    expect(find(fy, 's:s1')?.seen).toBe(true)
    // Same words again (a turn that said nothing new): nothing moves.
    fy.sessionTurn(s, 'result')
    await flush()
    expect(find(fy, 's:s1')?.seen).toBe(true)
    now = T0 + 10 * MIN
    threads.s1.push(says('more', 'user'), says('Double jump added.'))
    fy.sessionTurn(s, 'result')
    await flush()
    const items = fy.feed().items
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ id: 's:s1', text: 'Double jump added.', at: T0 + 10 * MIN })
    expect(items[0].seen).toBeUndefined()
    expect(fy.feed().pulse.delivered).toBe(2)
  })

  it('skips a compaction preamble, caps at 600 characters, falls back to the snapshot line', async () => {
    expect(lastWords([says('Real answer.'), says('This session is being continued from a previous conversation that ran out of context.')])).toBe('Real answer.')
    expect(lastWords([says('only me', 'user')])).toBeUndefined()
    const fy = make()
    threads.s1 = [says('x'.repeat(2000))]
    fy.sessionTurn(session(), 'result')
    await flush()
    // One line said in passing; the whole words unfold under it.
    const it1 = find(fy, 's:s1')!
    expect(it1.text.length).toBeLessThanOrEqual(HEADLINE_MAX)
    expect(it1.text.endsWith('…')).toBe(true)
    expect(it1.body).toHaveLength(2000)
    // A session of another machine whose thread cannot be read: what the snapshot says.
    fy.sessionTurn(session({ id: 'far', machineId: 'pc', lastMessage: 'done over there' }), 'result')
    await flush()
    expect(find(fy, 's:far')).toMatchObject({ text: 'done over there' })
  })

  it('reads the thread again a moment later: better words keep the item in place, seen or not', async () => {
    const fy = make()
    const s = session({ lastMessage: 'Running the last che' })
    threads.s1 = []
    fy.sessionTurn(s, 'result')
    await flush()
    expect(find(fy, 's:s1')?.text).toBe('Running the last che')
    fy.seen(['s:s1'])
    threads.s1 = [says('All checks pass.')]
    now = T0 + 4000
    later.forEach((fn) => fn())
    await flush()
    expect(find(fy, 's:s1')).toMatchObject({ text: 'All checks pass.', at: T0, seen: true })
  })

  it('attaches the files the last message cites (at most 4, this machine only)', async () => {
    const fy = make()
    for (const f of ['a.png', 'b.png', 'c.mp4', 'd.png', 'e.png']) shelf.known.add(`/home/u/projects/mygame/out/${f}`)
    threads.s1 = [says('Rendered out/a.png out/b.png out/c.mp4 out/d.png out/e.png and out/missing.png')]
    fy.sessionTurn(session(), 'result')
    await flush()
    expect(find(fy, 's:s1')?.media?.map((m) => m.name)).toEqual(['a.png', 'b.png', 'c.mp4', 'd.png'])
    expect(find(fy, 's:s1')?.media?.[2]).toMatchObject({ type: 'video', url: expect.stringMatching(/^\/api\/foryou\/media\//) })
    threads.far = threads.s1
    fy.sessionTurn(session({ id: 'far', machineId: 'pc' }), 'result')
    await flush()
    expect(find(fy, 's:far')?.media).toBeUndefined()
  })

  it('the paths of the files shown under the words leave the words, with the « : » that announced them', async () => {
    const fy = make()
    for (const f of ['menu.png', 'clip.mp4']) shelf.known.add(`/home/u/projects/mygame/out/${f}`)
    threads.s1 = [says('The menu is in, here are the renders:\n- out/menu.png\n- out/clip.mp4\n\nTests are green.')]
    fy.sessionTurn(session(), 'result')
    await flush()
    expect(find(fy, 's:s1')).toMatchObject({ text: 'The menu is in, here are the renders.', body: 'The menu is in, here are the renders. Tests are green.', media: [{ name: 'menu.png' }, { name: 'clip.mp4' }] })
    threads.s1 = [says('Rendu du menu : /home/u/projects/mygame/out/menu.png')]
    fy.sessionTurn(session(), 'result')
    await flush()
    expect(find(fy, 's:s1')?.text).toBe('Rendu du menu.')
    // A file that is not shown keeps its path; words that are only a path stay as they are.
    threads.s1 = [says('See out/menu.png and out/missing.png, then data-menu.png.')]
    fy.sessionTurn(session(), 'result')
    await flush()
    expect(find(fy, 's:s1')?.body).toBe('See and out/missing.png, then data-menu.png.')
    expect(find(fy, 's:s1')?.text).toBe('See and, then data-menu.png.')
    threads.s1 = [says('out/menu.png')]
    fy.sessionTurn(session(), 'result')
    await flush()
    expect(find(fy, 's:s1')).toMatchObject({ text: 'out/menu.png', media: [{ name: 'menu.png' }] })
    expect(withoutPaths('Done:\n- `out/menu.png`\n- ![menu](out/menu.png "the menu")\n', ['/x/out/menu.png'])).toBe('Done.')
    expect(withoutPaths('Done: ![menu](out/menu.png "the menu"), (out/clip.mp4) and « out/menu.png ».', ['/x/out/menu.png', '/x/out/clip.mp4'])).toBe('Done.')
    expect(withoutPaths('Nothing shown: out/other.png', ['/x/out/menu.png'])).toBe('Nothing shown: out/other.png')
  })

  it('a session title never shows the signature of who briefed it', async () => {
    const fy = make()
    const s = session({ title: '[from:weevboss] Fix the menu' })
    snap.sessions = [s]
    threads.s1 = [says('Menu fixed.')]
    fy.sessionTurn(s, 'result')
    await flush()
    expect(find(fy, 's:s1')?.title).toBe('Fix the menu')
    expect(JSON.parse(fs.readFileSync(fy.file, 'utf8')).items[0].title).toBe('Fix the menu')
    snap.sessions = [session({ title: '[from:gepetto]   Menu, second pass', status: 'needs_user', attention: 'Which font?' })]
    fy.sessionTurn(snap.sessions[0], 'question')
    expect(find(fy, 's:s1')).toMatchObject({ tone: 'question', title: 'Menu, second pass' })
    expect(cleanTitle('[weevils] Old prefix')).toBe('Old prefix')
    expect(cleanTitle('Plain [from:x] title')).toBe('Plain [from:x] title')
    expect(cleanTitle(undefined)).toBe('')
  })

  it('counts the turns delivered today, in all and per project, without counting as a look', async () => {
    const fy = make()
    for (const [id, projectId] of [['a', 'mygame'], ['b', 'mygame'], ['c', 'site']]) {
      threads[id] = [says(`done ${id}`)]
      fy.sessionTurn(session({ id, projectId }), 'result')
      await flush()
    }
    expect(fy.deliveredToday()).toEqual({ n: 3, by: { mygame: 2, site: 1 } })
    expect(make().deliveredToday()).toEqual({ n: 3, by: { mygame: 2, site: 1 } })
    expect(fy.wanted()).toBe(false)
    now += 24 * HOUR
    expect(fy.deliveredToday()).toEqual({ n: 0, by: {} })
    expect(fy.usageKnown()).toBeNull()
  })

  it('never takes a test brief, a one-shot call, weevils own folder or weevboss', async () => {
    const fy = make({ isTestBrief: (p) => !!p && p.startsWith('[test]') })
    transcripts.set('t1', { firstPrompt: '[test] probe' })
    transcripts.set('h1', { headless: true })
    transcripts.set('c1', { originator: 'codex_exec' })
    const out = [
      session({ id: 'archived-case', archived: true }),
      session({ id: 't1' }),
      session({ id: 't2', title: '[test] remote probe', machineId: 'pc' }),
      session({ id: 'h1' }),
      session({ id: 'c1' }),
      session({ id: 'h2', origin: 'headless' }),
      session({ id: 'd1', cwd: '/home/u/.local/share/weevils/titles' }),
      session({ id: 'boss' }),
    ]
    for (const s of out) {
      threads[s.id] = [says('I did things.')]
      expect(fy.eligible(s)).toBe(false)
      fy.sessionTurn(s, 'result')
      fy.sessionTurn({ ...s, status: 'needs_user', attention: 'ok?' }, 'question')
    }
    // Waiting or cut in the snapshot: still not in the stream, nor in the factory line.
    snap.sessions = out.map((s) => ({ ...s, status: 'needs_user' as const }))
    await flush()
    expect(fy.feed()).toMatchObject({ items: [], pulse: { waiting: 0 } })
    // A background task of the auto band is a session like another.
    const auto = session({ id: 'a1', cwd: '/home/u/projects/.auto/mygame/abc' })
    threads.a1 = [says('Tests hardened.')]
    fy.sessionTurn(auto, 'result')
    await flush()
    expect(ids(fy)).toEqual(['s:a1'])
  })
})

describe('headline', () => {
  it('a line said in passing: no markdown, no path, no command, no machine tag, the heading before a colon', () => {
    expect(headline('[VPS] Cause trouvée : l’instance de test PID 3999499 a exécuté `reapPanes()` et fermé les cinq sessions.')).toBe('Cause trouvée')
    expect(headline('« Pour toi » est en ligne : les deux mots en haut, l’aperçu dans la bande.')).toBe('« Pour toi » est en ligne')
    expect(headline('## Fait\n\nLa page passe de 1,8 s à 240 ms, mesuré sur `/api/orders`. Les tests passent.')).toBe('Fait')
    expect(headline('Index posé sur (boutique, jour) dans ~/projects/comptoir/db/schema.sql, et la page est rapide.')).toBe('Index posé sur (boutique, jour) dans, et la page est rapide.')
    expect(headline('- out/menu.png\n- ok')).toBe('ok')
    const long = headline('Le menu mobile glisse maintenant depuis la gauche avec un ressort plus doux et il se referme quand on touche ailleurs sur la page entière.')
    expect(long.length).toBeLessThanOrEqual(HEADLINE_MAX)
    expect(long).toMatch(/\S…$/)
  })
})

describe('sessions that wait or were cut', () => {
  it('a question shows once, as the session item, and leaves when the session moves on', async () => {
    const fy = make()
    const s = session({ status: 'needs_user', attention: 'Do you want to proceed?' })
    snap.sessions = [s]
    fy.sessionTurn(s, 'question')
    expect(fy.feed().items).toMatchObject([{ id: 's:s1', kind: 'session', tone: 'question', text: 'Do you want to proceed?', reply: 'session' }])
    expect(fy.feed().items.filter((i) => i.kind === 'alert')).toEqual([])
    snap.sessions = [session({ status: 'working' })]
    expect(fy.feed().items).toEqual([])
    threads.s1 = [says('Proceeded, all good.')]
    fy.sessionTurn(session(), 'result')
    await flush()
    expect(find(fy, 's:s1')).toMatchObject({ tone: 'result', text: 'Proceeded, all good.' })
  })

  it('after a restart, a session already waiting or cut gets its item at the first read', () => {
    snap.sessions = [session({ status: 'needs_user', attention: undefined, lastActivityAt: T0 - 5 * MIN }), session({ id: 's2', status: 'interrupted', interrupted: { at: T0 - HOUR, reason: 'quota' } })]
    const fy = make()
    const items = fy.feed().items
    expect(items.map((i) => [i.id, i.tone, i.text, i.at])).toEqual([
      ['s:s1', 'question', M.en.waiting, T0 - 5 * MIN],
      ['s:s2', 'alert', 'Ouch, I got cut off mid-work (usage limit reached). Want me to pick it back up?', T0 - HOUR],
    ])
    expect(items[1].actions).toEqual([{ id: 'resume', label: 'Resume' }])
    expect(fy.feed('fr' as never, 'fr').items[1]).toMatchObject({ text: 'Aïe, on m’a coupé en plein travail (limite d’usage atteinte). Tu me relances ?', actions: [{ id: 'resume', label: 'Reprendre' }] })
    // Dismissed: the same question does not come back at the next read.
    fy.dismiss('s:s1')
    expect(ids(fy)).toEqual(['s:s2'])
    expect(ids(make())).toEqual(['s:s2'])
  })

  it('« resume » resumes the session and the item leaves; the cut said by core is the same episode', async () => {
    const s = session({ status: 'interrupted', interrupted: { at: T0 - MIN, reason: 'died' }, lastActivityAt: T0 - MIN })
    snap.sessions = [s]
    const fy = make()
    fy.sessionTurn(s, 'cut')
    const rev = fy.feed().rev
    fy.sessionTurn(s, 'cut')
    expect(fy.feed().rev).toBe(rev)
    await fy.act('s:s1', 'resume')
    expect(host.resume).toHaveBeenCalledWith('s1')
    expect(fy.feed().items).toEqual([])
    await expect(fy.act('s:s1', 'resume')).rejects.toThrow(M.en.notFound)
  })
})

// ---------------------------------------------------------------- mail

describe('mail', () => {
  const mail = { author: 'gepetto', subject: 'menu  done', text: 'Hi,\n\n> you asked for the menu\nThe menu is in, with the three buttons.\nMore below.\n', target: 'weevboss', mid: '<m1@example.com>', address: 'gepetto@example.com' }

  it('records who, the subject, the first line that says something and the whole text', () => {
    const fy = make()
    fy.mail(mail)
    const [item] = fy.feed().items
    expect(item).toMatchObject({ kind: 'mail', tone: 'neutral', who: 'gepetto', title: 'menu done', text: 'The menu is in, with the three buttons.', body: mail.text.trim(), open: { page: 'boss' } })
    expect(firstLine('Bonjour Alex,\n\n' + 'a'.repeat(300))).toHaveLength(140)
    // The user's own mail (no author) is not news to them.
    fy.mail({ ...mail, author: '', mid: '<own@x>' })
    expect(fy.feed().items).toHaveLength(1)
    // Once the session exists, the same mail points at it.
    snap.sessions = [session()]
    fy.mail({ ...mail, target: 's1' })
    expect(fy.feed().items).toMatchObject([{ id: item.id, open: { page: 'session', id: 's1' }, sessionId: 's1', projectId: 'mygame' }])
  })

  it('the sender address stays on the server: in the file, never in what the app reads', () => {
    const write = vi.fn(async () => true)
    const fy = make({ mail: () => ({ write }) })
    fy.mail(mail)
    expect(fs.readFileSync(fy.file, 'utf8')).toContain('gepetto@example.com')
    const read = JSON.stringify([fy.feed(), fy.feed(now, 'fr'), fy.recent(['mail']), fy.mark(snap)])
    expect(read).not.toContain('gepetto@example.com')
    expect(read).not.toContain('<m1@example.com>')
    expect(read).not.toContain('"mail":{')
  })

  it('the curator may give a mail a short line: shown instead of the first line, the whole mail kept; only raw unseen mails are offered', () => {
    const fy = make()
    fy.mail(mail)
    fy.mail({ ...mail, mid: '<m2@example.com>', text: 'One line only.' })
    const [raw] = fy.rawMails()
    expect(fy.rawMails()).toHaveLength(1)
    expect(raw).toEqual({ id: raw.id, who: 'gepetto', subject: 'menu done', text: mail.text.trim() })
    expect(JSON.stringify(raw)).not.toContain('gepetto@example.com')
    fy.mailLine(raw.id, '  the menu is in,   three buttons ', 'en')
    expect(find(fy, raw.id)).toMatchObject({ text: 'the menu is in, three buttons', body: mail.text.trim() })
    expect(fy.feed(now, 'fr').items.find((i) => i.id === raw.id)?.text).toBe('the menu is in, three buttons')
    expect(fy.rawMails()).toEqual([])
    // Tried without a line worth keeping: the first line stays and the mail is not offered again; a seen mail never is.
    fy.mail({ ...mail, mid: '<m3@example.com>' })
    const [next] = fy.rawMails()
    fy.mailLine(next.id, null)
    expect(find(fy, next.id)?.text).toBe('The menu is in, with the three buttons.')
    expect(fy.rawMails()).toEqual([])
    fy.mail({ ...mail, mid: '<m4@example.com>' })
    fy.seen([fy.rawMails()[0].id])
    expect(fy.rawMails()).toEqual([])
  })

  it('a reply goes by mail to the author in the same thread; without a bridge the item has no reply', async () => {
    const write = vi.fn(async (_o: { to: string; subject: string; text: string; inReplyTo: string; author: string; target: string }) => true)
    let out: { write: typeof write } | null = null
    const fy = make({ mail: () => out })
    fy.mail(mail)
    const id = fy.feed().items[0].id
    expect(fy.feed().items[0].reply).toBeUndefined()
    await expect(fy.reply(id, 'thanks')).rejects.toThrow(M.en.mailOff)
    out = { write }
    expect(fy.feed().items[0].reply).toBe('mail')
    await fy.reply(id, ' thanks ')
    expect(write).toHaveBeenCalledWith({ to: 'gepetto@example.com', subject: 'menu  done', text: 'thanks', inReplyTo: '<m1@example.com>', author: 'gepetto', target: 'weevboss' })
    expect(host.sendMain).not.toHaveBeenCalled()
    write.mockResolvedValueOnce(false)
    await expect(fy.reply(id, 'again')).rejects.toThrow(M.en.noReply)
  })
})

// ---------------------------------------------------------------- weevboss's posts

describe('posts', () => {
  it('a post: weevboss by default, capped, two buttons at most, their briefs never sent to the app', () => {
    const fy = make()
    const item = fy.post(`  ${'w'.repeat(1500)}  `, [{ label: 'Ship it', brief: 'merge and deploy' }, { label: 'x', brief: '' }, { label: 'B', brief: 'b' }, { label: 'C', brief: 'c' }, { label: 'D', brief: 'd' }])
    expect(item).toMatchObject({ kind: 'boss', who: 'weevboss', reply: 'boss', open: { page: 'boss' }, actions: [{ id: 'a1', label: 'Ship it' }, { id: 'a2', label: 'B' }] })
    expect(item.actions).toHaveLength(2)
    expect(item.text).toHaveLength(1200)
    expect(JSON.stringify(fy.feed())).not.toContain('merge and deploy')
    expect(fy.post('from a friend', undefined, 'gepetto').who).toBe('gepetto')
    expect(() => fy.post('   ')).toThrow(M.en.emptyText)
  })

  it('a tapped button sends its brief to weevboss behind a short visible message, then the item leaves', async () => {
    const fy = make()
    const { id } = fy.post('Three things are ready.', [{ label: 'Ship it', brief: 'merge and deploy' }])
    await expect(fy.act(id, 'a9')).rejects.toThrow(M.en.noAction)
    await fy.act(id, 'a1', undefined, 'fr')
    expect(host.sendMain).toHaveBeenCalledWith('Vas-y : Ship it', M.fr.actBrief('Three things are ready.', 'merge and deploy'))
    expect(fy.feed().items).toEqual([])
    await expect(fy.act(id, 'a1')).rejects.toThrow(M.en.notFound)
  })

  it('a reply is a real message to weevboss, with the post as a hidden note', async () => {
    const fy = make()
    const { id } = fy.post('Three things are ready.')
    await fy.reply(id, 'which ones?')
    expect(host.sendMain).toHaveBeenCalledWith('which ones?', M.en.replyBrief('Three things are ready.'))
    expect(find(fy, id)?.seen).toBe(true)
    await expect(fy.reply(id, '  ')).rejects.toThrow(M.en.emptyText)
  })

  it('a reply under a session item goes to that session, as the user', async () => {
    const fy = make()
    threads.s1 = [says('Done.')]
    fy.sessionTurn(session(), 'result')
    await flush()
    await fy.reply('s:s1', 'and the tests?')
    expect(host.send).toHaveBeenCalledWith('s1', 'and the tests?')
  })

  it('the seam for generated items: language kept, hidden from another language, « more » waits for the curator', async () => {
    const fy = make()
    const item = fy.add({ kind: 'insight', projectId: 'mygame', text: 'Vite pré-bundle les dépendances.', more: true, lang: 'fr' })!
    expect(fy.feed().items).toEqual([])
    expect(fy.mark(snap).unseen).toBe(0)
    expect(fy.feed(now, 'fr').items).toMatchObject([{ id: item.id, kind: 'insight', more: true }])
    await expect(fy.more(item.id)).rejects.toThrow(M.en.noMore)
    fy.curator = { more: vi.fn(async () => ' Longer answer. ') }
    expect(await fy.more(item.id)).toBe('Longer answer.')
    expect(await fy.more(item.id)).toBe('Longer answer.')
    expect(fy.curator.more).toHaveBeenCalledTimes(1)
    expect(fy.feed(now, 'fr').items[0].moreText).toBe('Longer answer.')
    expect(fy.recent(['insight'])).toHaveLength(1)
    expect(fy.wanted()).toBe(true)
  })

  it('a generated item written again under the same id is fresh and unseen; dismissed, it stays dismissed', () => {
    const fy = make()
    const bars = (value: number) => fy.add({ id: 'stat:today', kind: 'stat', text: 'Where the day stands', gauges: [{ label: 'week', value, max: 100, shown: `${value}%` }] })
    bars(40)
    fy.seen(['stat:today'])
    now += HOUR
    bars(55)
    expect(fy.feed().items.filter((i) => i.kind === 'stat')).toMatchObject([{ id: 'stat:today', at: now, gauges: [{ value: 55 }] }])
    expect(find(fy, 'stat:today')?.seen).toBeUndefined()
    fy.dismiss('stat:today')
    expect(bars(70)).toBeNull()
    expect(find(fy, 'stat:today')).toBeUndefined()
  })
})

// ---------------------------------------------------------------- media

describe('media', () => {
  it('« weevils show »: the item finds its session by folder; files shown within two minutes join it', () => {
    const fy = make()
    snap.sessions = [session({ id: 'old', lastActivityAt: T0 - HOUR }), session({ lastActivityAt: T0 }), session({ id: 'other', cwd: '/home/u/projects/site' })]
    for (const f of ['a.png', 'b.mp4', 'c.png']) shelf.known.add(`/home/u/projects/mygame/out/${f}`)
    const a = fy.addMedia({ path: 'a.png', caption: 'The new menu', cwd: '/home/u/projects/mygame/out' })
    expect(a).toMatchObject({ kind: 'media', tone: 'result', who: 'session', sessionId: 's1', projectId: 'mygame', title: 'The new menu', reply: 'session', open: { page: 'session', id: 's1' } })
    expect(a.media).toHaveLength(1)
    fy.seen([a.id])
    now = T0 + MIN
    const b = fy.addMedia({ path: 'b.mp4', cwd: '/home/u/projects/mygame/out' })
    expect(b.id).toBe(a.id)
    expect(b.media?.map((m) => m.type)).toEqual(['image', 'video'])
    expect(b).toMatchObject({ title: 'The new menu', at: T0 + MIN })
    expect(b.seen).toBeUndefined()
    now = T0 + MIN + MEDIA_JOIN_MS + 1
    expect(fy.addMedia({ path: 'c.png', cwd: '/home/u/projects/mygame/out' }).id).not.toBe(a.id)
    expect(() => fy.addMedia({ path: 'nope.png', cwd: '/home/u/projects/mygame' })).toThrow('not a file weevils can show')
  })

  it('one item holds six files at most; no session: weevboss from its folder, else weevils', () => {
    const fy = make()
    for (let i = 0; i < 8; i++) shelf.known.add(`/home/u/.local/share/weevils/orchestrateur/${i}.png`)
    const got = Array.from({ length: 8 }, (_, i) => fy.addMedia({ path: `${i}.png`, cwd: '/home/u/.local/share/weevils/orchestrateur' }))
    expect(got[5].media).toHaveLength(MAX_MEDIA)
    expect(got[6].id).not.toBe(got[0].id)
    expect(got[0]).toMatchObject({ who: 'weevboss', tone: 'neutral', reply: 'boss', open: { page: 'boss' } })
    shelf.known.add('/tmp/x.png')
    expect(fy.addMedia({ path: '/tmp/x.png', cwd: '/tmp' })).toMatchObject({ who: 'weevils' })
    expect(() => make({ shelf: null }).addMedia({ path: '/tmp/x.png' })).toThrow(M.en.noMedia)
  })
})

// ---------------------------------------------------------------- live items

describe('alerts', () => {
  const usage = (percent: number, resetsAt = T0 + HOUR): UsageInfo => ({
    claude: { ok: true, windows: [{ kind: 'session', percent, resetsAt }, { kind: 'week', percent: 40, resetsAt: null }], source: 't', at: T0 },
    codex: { ok: false, windows: [], source: 't', at: T0 },
  })

  it('a usage window at 85 % or more: asked in the background, shown at the next read, gone with its cause', async () => {
    let u = usage(92)
    const fy = make({ quotas: async () => u })
    // The read that asks never waits for the answer.
    expect(fy.feed().items).toEqual([])
    await flush()
    expect(host.bump).toHaveBeenCalled()
    const [a] = fy.feed().items
    expect(a).toMatchObject({ id: `alert:usage:claude:session::${T0 + HOUR}`, kind: 'alert', tone: 'alert', who: 'weevils', text: "You're at 92% of your Claude 5 h window. I’m easing off what can wait.", open: { page: 'usage' }, live: true, at: T0 })
    expect(fy.feed(now, 'fr').items[0].text).toBe('T’es à 92 % de ta fenêtre de 5 h Claude. Je lève le pied sur ce qui peut attendre.')
    expect(JSON.parse(fs.readFileSync(fy.file, 'utf8')).items).toEqual([])
    u = usage(12)
    now = T0 + REFRESH_MS + 1
    fy.feed()
    await flush()
    expect(fy.feed().items).toEqual([])
  })

  it('automatic relay removes the current Claude quota warning and keeps it gone across reset jitter and restart', async () => {
    const u = usage(97)
    const fy = make({ quotas: async () => u })
    fy.feed()
    await flush()
    expect(fy.feed().items.some((i) => i.id.startsWith('alert:usage:claude:'))).toBe(true)
    snap.relay = { mode: 'auto', codex: true, switchAt: 97, plans: [] }
    expect(fy.feed().items.some((i) => i.id.startsWith('alert:usage:claude:'))).toBe(false)
    u.claude.windows[0].resetsAt! += 17
    now += REFRESH_MS + 1
    fy.feed()
    await flush()
    expect(fy.feed().items.some((i) => i.id.startsWith('alert:usage:claude:'))).toBe(false)
    const again = make({ quotas: async () => u })
    again.feed()
    await flush()
    expect(again.feed().items.some((i) => i.id.startsWith('alert:usage:claude:'))).toBe(false)
    snap.relay.codex = false
    expect(again.feed().items.some((i) => i.id.startsWith('alert:usage:claude:'))).toBe(true)
  })

  it('automatic relay preserves Codex quota warnings and model-specific Claude warnings', async () => {
    const u = usage(97)
    u.claude.windows = [{ kind: 'model', label: 'Fable', percent: 100, resetsAt: T0 + HOUR }]
    u.codex = { ok: true, source: 't', at: T0, windows: [{ kind: 'week', percent: 98, resetsAt: T0 + HOUR }] }
    snap.relay = { mode: 'auto', codex: true, switchAt: 97, plans: [] }
    const fy = make({ quotas: async () => u })
    fy.feed()
    await flush()
    expect(fy.feed().items.filter((i) => i.kind === 'alert')).toHaveLength(2)
  })

  it('a machine saturated twice in a row, a full disk, a machine offline for two minutes, a failed auto task', async () => {
    let states: MachineState[] = [{ id: 'test', name: 'vps', level: 'crit', disk: 93 }]
    const fy = make({ machines: async () => states })
    snap.machines.push({ id: 'pc', name: 'pc', online: false })
    snap.optimizers = [optimizer({ id: 'bad', state: 'failed', endedAt: T0 - HOUR, lastEvent: 'stopped after 2 h' }), optimizer({ id: 'old', state: 'failed', endedAt: T0 - 25 * HOUR })]
    fy.feed()
    await flush()
    // One peak is not an alert; the tunnel may hiccup.
    expect(ids(fy)).toEqual(['alert:disk:test', 'alert:auto:bad'])
    expect(find(fy, 'alert:auto:bad')).toMatchObject({ text: 'The auto task "Harden the tests" crashed (stopped after 2 h). Retry or drop it?', open: { page: 'auto', id: 'bad' }, at: T0 - HOUR })
    now = T0 + REFRESH_MS + 1
    fy.feed()
    await flush()
    expect(ids(fy).sort()).toEqual(['alert:auto:bad', 'alert:disk:test', 'alert:machine:test', 'alert:offline:pc'])
    expect(find(fy, 'alert:offline:pc')).toMatchObject({ text: "I can't reach pc anymore.", open: { page: 'machine' }, at: T0 })
    expect(now - T0).toBeGreaterThanOrEqual(OFFLINE_AFTER_MS)
    states = [{ id: 'test', name: 'vps', level: 'ok', disk: 40 }]
    snap.machines[1].online = true
    snap.optimizers = []
    now += REFRESH_MS + 1
    fy.feed()
    await flush()
    expect(fy.feed().items).toEqual([])
  })

  it('seen and dismissed are kept by id, across a restart, while the cause lasts', async () => {
    snap.optimizers = [optimizer({ id: 'bad', state: 'failed', endedAt: T0 - HOUR }), optimizer({ id: 'bad2', state: 'failed', endedAt: T0 - HOUR })]
    const fy = make()
    expect(fy.mark(snap).unseen).toBe(2)
    fy.seen(['alert:auto:bad'])
    expect(fy.dismiss('alert:auto:bad2')).toBe(true)
    expect(fy.dismiss('alert:auto:never')).toBe(false)
    const again = make()
    expect(again.feed().items).toMatchObject([{ id: 'alert:auto:bad', seen: true }])
    expect(again.mark(snap).unseen).toBe(0)
  })
})

describe('proposals', () => {
  it('never offers an incomplete creation conversation for approval', async () => {
    snap.optimizers = [optimizer({ draft: true })]
    const fy = make()
    expect(fy.feed().items.find((i) => i.id === 'proposals')).toBeUndefined()
    await expect(fy.act('proposals', 'accept', 'o:o1')).rejects.toThrow(M.en.cardGone)
  })

  const unmanaged = () => session({ id: 'u1', title: 'left open', controllable: false, status: 'idle', lastActivityAt: T0 - 13 * HOUR })
  const tips: ForYouDeps['tips'] = (s, at) => ({ snap: s, now: at, loads: [], dictation: false, reapMs: 24 * HOUR })

  it('one item: proposed auto tasks first, then the tips that act on the server or through weevboss; four cards at most', () => {
    const fy = make({ tips })
    expect(fy.feed().items.filter((i) => !i.id.startsWith('auto:proposed:'))).toEqual([])
    snap.optimizers = [optimizer(), optimizer({ id: 'o2', title: 'Watch fairs', kind: 'watch' }), optimizer({ id: 'run', state: 'running' }), optimizer({ id: 'q', state: 'queued' })]
    snap.sessions = [unmanaged(), session({ id: 'i1', status: 'done', lastActivityAt: T0 - 13 * HOUR })]
    const p = fy.feed().items.find((i) => i.id === 'proposals')!
    expect(p).toMatchObject({ id: 'proposals', kind: 'proposals', who: 'weevils', live: true, text: 'I have 4 ideas for you', at: T0 })
    // Tips that only open a page of the app (no dictation, one machine) stay in the app.
    expect(p.cards?.map((c) => [c.id.slice(0, 2), c.source, c.kind])).toEqual([['o:', 'optimizer', 'tests'], ['o:', 'optimizer', 'watch'], ['t:', 'tip', 'idle-sessions'], ['t:', 'tip', 'idle-unmanaged']])
    expect(p.cards?.[2]).toMatchObject({ title: TM.en.idleSessions(1, true), accept: TM.en.closeThem(1) })
    expect(fy.feed().pulse.auto).toBe(2)
    snap.optimizers.push(optimizer({ id: 'o3' }), optimizer({ id: 'o4' }), optimizer({ id: 'o5' }))
    expect(fy.feed().items.find((i) => i.id === 'proposals')!.cards).toHaveLength(MAX_CARDS)
    expect(fy.feed(now, 'fr').items.find((i) => i.id === 'proposals')!.text).toBe('J’ai 4 idées pour toi')
  })

  it('accept / refuse go through the auto band; an answered card never comes back, even after a restart', async () => {
    const auto = { accept: vi.fn(() => true), refuse: vi.fn(() => true) }
    const fy = make({ tips, optimizers: () => auto })
    snap.optimizers = [optimizer(), optimizer({ id: 'o2' })]
    await fy.act('proposals', 'accept', 'o:o1')
    expect(auto.accept).toHaveBeenCalledWith('o1')
    // The band still says « proposed » until its next tick: the card is already gone.
    expect(fy.feed().items.find((i) => i.id === 'proposals')!.cards?.map((c) => c.id)).toEqual(['o:o2'])
    await fy.act('proposals', 'refuse', 'o:o2')
    expect(auto.refuse).toHaveBeenCalledWith('o2')
    expect(fy.feed().items.filter((i) => !i.id.startsWith('auto:proposed:'))).toEqual([])
    expect(make({ tips }).feed().items.filter((i) => !i.id.startsWith('auto:proposed:'))).toEqual([])
    await expect(fy.act('proposals', 'accept', 'o:o1')).rejects.toThrow(M.en.cardGone)
    auto.accept.mockReturnValueOnce(false)
    snap.optimizers = [optimizer({ id: 'o9' })]
    await expect(fy.act('proposals', 'accept', 'o:o9')).rejects.toThrow(M.en.cardGone)
    await expect(fy.act('proposals', 'launch', 'o:o9')).rejects.toThrow(M.en.noAction)
  })

  it('a tip accepted runs on the server or goes to weevboss; refused, it is only remembered', async () => {
    const fy = make({ tips })
    snap.sessions = [unmanaged(), session({ id: 'i1', status: 'done', lastActivityAt: T0 - 13 * HOUR }), session({ id: 'i2', status: 'idle', lastActivityAt: T0 - 14 * HOUR })]
    const cards = fy.feed().items.find((i) => i.id === 'proposals')!.cards!
    const closing = cards.find((c) => c.kind === 'idle-sessions')!
    const asking = cards.find((c) => c.kind === 'idle-unmanaged')!
    await fy.act('proposals', 'accept', closing.id)
    expect(host.close.mock.calls.map((c) => c[0]).sort()).toEqual(['i1', 'i2'])
    await fy.act('proposals', 'refuse', asking.id)
    expect(host.sendMain).not.toHaveBeenCalled()
    expect(fy.feed().items.filter((x) => x.kind !== 'session' && !x.id.startsWith('auto:proposed:'))).toEqual([])
    // Another situation, another card: accepted, weevboss gets the prepared message.
    snap.sessions.push(session({ id: 'u2', controllable: false, status: 'idle', lastActivityAt: T0 - 20 * HOUR }))
    const next = fy.feed().items.find((i) => i.id === 'proposals')!.cards!.find((c) => c.kind === 'idle-unmanaged')!
    await fy.act('proposals', 'accept', next.id)
    expect(host.sendMain).toHaveBeenCalledTimes(1)
    expect(host.sendMain.mock.calls[0][0]).toContain('left open')
  })

  it('dismissed, the band comes back unseen when a new card arrives', () => {
    const fy = make()
    snap.optimizers = [optimizer()]
    fy.feed()
    fy.seen(['proposals'])
    fy.dismiss('proposals')
    expect(fy.feed().items.filter((x) => x.kind !== 'session' && !x.id.startsWith('auto:proposed:'))).toEqual([])
    now = T0 + HOUR
    snap.optimizers.push(optimizer({ id: 'o2' }))
    const p = fy.feed().items.find((i) => i.id === 'proposals')!
    expect(p).toMatchObject({ id: 'proposals', at: T0 + HOUR })
    expect(p.seen).toBeUndefined()
  })
})

// ---------------------------------------------------------------- revision, unseen, restart

describe('the mark in the snapshot', () => {
  it('rev moves at every visible change, live ones included, and only then', () => {
    const fy = make()
    const r0 = fy.mark(snap).rev
    expect(fy.mark(snap)).toEqual({ rev: r0, unseen: 0 })
    fy.post('one')
    const r1 = fy.mark(snap).rev
    expect(r1).toBe(r0 + 1)
    expect(fy.mark(snap)).toEqual({ rev: r1, unseen: 1 })
    // A live item comes, then leaves: each time one revision, counted while the snapshot is built (no bump from there).
    host.bump.mockClear()
    snap.optimizers = [optimizer()]
    expect(fy.mark(snap)).toEqual({ rev: r1 + 1, unseen: 3 })
    expect(fy.mark(snap).rev).toBe(r1 + 1)
    snap.optimizers = []
    expect(fy.mark(snap)).toEqual({ rev: r1 + 2, unseen: 1 })
    expect(host.bump).not.toHaveBeenCalled()
    // Found while answering the app instead: the snapshot is asked to follow.
    snap.optimizers = [optimizer()]
    expect(fy.feed().rev).toBe(r1 + 3)
    expect(host.bump).toHaveBeenCalledTimes(1)
    // The language of the reader does not move the revision.
    fy.add({ kind: 'insight', text: 'Une chose vraie.', lang: 'fr' })
    const r = fy.mark(snap).rev
    expect(fy.feed(now, 'fr').rev).toBe(r)
    expect(fy.feed(now, 'en').rev).toBe(r)
    expect(fy.mark(snap).rev).toBe(r)
  })

  it('seen on a device is seen everywhere, dismissed stays dismissed, the revision goes on after a restart', async () => {
    const fy = make()
    const a = fy.post('first')
    const b = fy.post('second')
    threads.s1 = [says('Done.')]
    fy.sessionTurn(session(), 'result')
    await flush()
    fy.seen([a.id, 'unknown'])
    fy.dismiss(b.id)
    const { rev } = fy.mark(snap)
    expect(fy.mark(snap).unseen).toBe(1)
    const again = make()
    expect(again.mark(snap)).toEqual({ rev, unseen: 1 })
    expect(again.feed().items.map((i) => [i.id, !!i.seen]).sort()).toEqual([[a.id, true], ['s:s1', false]].sort())
    expect(again.has(b.id)).toBe(false)
    expect(again.dismiss('nope')).toBe(false)
    // The dismissed item of a session is replaced by its next turn.
    again.dismiss('s:s1')
    threads.s1.push(says('Second pass done.'))
    again.sessionTurn(session(), 'result')
    await flush()
    expect(find(again, 's:s1')?.text).toBe('Second pass done.')
  })

  it('the factory line: working, waiting (asking or cut), delivered today, auto tasks', async () => {
    const fy = make()
    snap.sessions = [session({ id: 'w1', status: 'working' }), session({ id: 'w2', status: 'working' }), session({ id: 'n1', status: 'needs_user' }), session({ id: 'c1', status: 'interrupted', interrupted: { at: T0, reason: 'api' } }), session({ id: 'd1' })]
    snap.optimizers = [optimizer({ state: 'running' }), optimizer({ id: 'q', state: 'queued' }), optimizer({ id: 'p' })]
    threads.d1 = [says('Done.')]
    fy.sessionTurn(snap.sessions[4], 'result')
    await flush()
    expect(fy.feed().pulse).toEqual({ working: 2, waiting: 2, delivered: 1, auto: 2 })
    now = T0 + 24 * HOUR
    expect(fy.feed().pulse.delivered).toBe(0)
  })
})

// ---------------------------------------------------------------- order and pace

describe('arrange', () => {
  let n = 0
  const item = (kind: ForYouKind, over: Partial<ForYouItem> = {}): ForYouItem => ({ id: `${kind}-${n++}`, kind, tone: 'neutral', at: T0 - MIN, who: 'x', text: '', ...over })

  it('newest first, whatever the kind, seen or not: news always comes in at the top', () => {
    const list = [
      item('insight', { at: T0 - 5 * MIN }),
      item('session', { tone: 'result', at: T0 - MIN, seen: true }),
      item('mail', { at: T0 - 3 * MIN }),
      item('proposals', { at: T0 - 2 * MIN }),
      item('session', { tone: 'question', at: T0 - 9 * MIN }),
    ]
    expect(arrange(list, T0).map((i) => i.at)).toEqual([T0 - MIN, T0 - 2 * MIN, T0 - 3 * MIN, T0 - 5 * MIN, T0 - 9 * MIN])
  })

  it('temporarily resurfaces unread useful items below arrivals, then lets them expire', () => {
    const rows = Array.from({ length: 8 }, (_, n) => item(n % 2 ? 'mail' : 'boss', { at: T0 - (n + 1) * 12 * MIN }))
    const useful = item('media', { id: 'useful', at: T0 - 100 * MIN })
    const news = item('session', { id: 'new', at: T0 })
    const list = [useful, ...rows, news]
    expect(arrange(list, T0)[0].id).toBe('new')
    expect(arrange(list, T0).findIndex((i) => i.id === 'useful')).toBeLessThan(5)
    expect(arrange(list, T0 + 2 * HOUR).at(-1)?.id).toBe('useful')
    expect(arrange([{ ...useful, seen: true }, ...rows, news], T0).at(-1)?.id).toBe('useful')
  })

  it('the system alerts sit above, newest first among them', () => {
    const a1 = item('alert', { at: T0 - 60 * MIN })
    const a2 = item('alert', { at: T0 - 30 * MIN })
    const fresh = item('media', { at: T0 })
    expect(arrange([fresh, a1, a2], T0).map((i) => i.id)).toEqual([a2.id, a1.id, fresh.id])
  })

  it('stable for equal times, never twice the same sort in a row when a neighbour can step up, leaves its input alone', () => {
    const list = [item('boss', { id: 'b' }), item('boss', { id: 'a' }), item('mail', { id: 'c' })]
    const ids = list.map((i) => i.id)
    expect(arrange(list, T0).map((i) => i.id)).toEqual(['a', 'c', 'b'])
    expect(list.map((i) => i.id)).toEqual(ids)
  })
})

// ---------------------------------------------------------------- routes

describe('routes', () => {
  const local = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:4179' } }
  const phone = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'weevils.example.com', 'x-forwarded-for': '203.0.113.7', cookie: 'wv=valid' } }
  const call = async (fy: ForYou, method: string, url: string, body: unknown = {}, req: unknown = phone) => {
    const got = { status: 0, body: undefined as any }
    const routes = foryouRoutes(fy, (_res, status, b) => void ((got.status = status), (got.body = b)), async () => body)
    const u = new URL(url, 'http://x')
    for (const [m, re, handler] of routes) {
      const hit = m === method ? re.exec(u.pathname) : null
      if (!hit) continue
      await handler(req as never, {} as never, u, hit.slice(1))
      return got
    }
    return { status: 404, body: { error: 'no route' } }
  }

  it('post and media: from this machine only, whatever « from » the request claims', async () => {
    const fy = make()
    shelf.known.add('/home/u/projects/mygame/a.png')
    expect(await call(fy, 'POST', '/api/foryou/post', { text: 'hi', from: 'weevboss' })).toEqual({ status: 403, body: { error: M.en.localOnly } })
    expect(await call(fy, 'POST', '/api/foryou/media', { path: '/home/u/projects/mygame/a.png' })).toEqual({ status: 403, body: { error: M.en.localOnly } })
    // A page of another local server (another port) is not this machine's CLI either.
    const page = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:4179', origin: 'http://127.0.0.1:4173' } }
    expect((await call(fy, 'POST', '/api/foryou/post', { text: 'hi' }, page)).status).toBe(403)
    expect(fy.feed().items).toEqual([])
    const posted = await call(fy, 'POST', '/api/foryou/post', { text: 'hi', actions: [{ label: 'Go', brief: 'do it' }], from: 'weevils' }, local)
    expect(posted).toMatchObject({ status: 200, body: { item: { kind: 'boss', who: 'weevboss', text: 'hi', actions: [{ id: 'a1', label: 'Go' }] } } })
    expect(await call(fy, 'POST', '/api/foryou/post', { text: '' }, local)).toEqual({ status: 400, body: { error: M.en.emptyText } })
    expect(await call(fy, 'POST', '/api/foryou/media', { path: '/home/u/projects/mygame/a.png', caption: 'menu', cwd: '/home/u/projects/mygame' }, local)).toMatchObject({ status: 200, body: { item: { kind: 'media', title: 'menu' } } })
    expect(await call(fy, 'POST', '/api/foryou/media', { path: '/etc/passwd' }, local)).toMatchObject({ status: 400 })
  })

  it('the stream, seen, dismiss, act, reply, more and the bytes', async () => {
    const fy = make()
    const { id } = fy.post('Three things.', [{ label: 'Go', brief: 'do it' }])
    expect(fy.lastWanted).toBe(0)
    const feed = await call(fy, 'GET', '/api/foryou?lang=fr')
    expect(feed).toMatchObject({ status: 200, body: { items: [{ id }], pulse: { working: 0 } } })
    expect(fy.lastWanted).toBe(T0)
    expect(await call(fy, 'POST', '/api/foryou/seen', { ids: [id] })).toEqual({ status: 200, body: { ok: true } })
    expect(find(fy, id)?.seen).toBe(true)
    expect(await call(fy, 'POST', `/api/foryou/${encodeURIComponent(id)}/reply`, { text: '' })).toEqual({ status: 400, body: { error: M.en.emptyText } })
    expect(await call(fy, 'POST', `/api/foryou/${encodeURIComponent(id)}/more`)).toEqual({ status: 400, body: { error: M.en.noMore } })
    expect(await call(fy, 'POST', `/api/foryou/${encodeURIComponent(id)}/act?lang=fr`, { action: 'nope' })).toEqual({ status: 400, body: { error: M.fr.noAction } })
    expect(await call(fy, 'POST', `/api/foryou/${encodeURIComponent(id)}/reply`, { text: 'ok' })).toEqual({ status: 200, body: { ok: true } })
    expect(host.sendMain).toHaveBeenCalledWith('ok', expect.any(String))
    expect(find(fy, id)).toBeUndefined()
    const actionable = fy.post('Another request.', [{ label: 'Go', brief: 'do it' }]).id
    expect(await call(fy, 'POST', `/api/foryou/${encodeURIComponent(actionable)}/act`, { action: 'a1' })).toEqual({ status: 200, body: { ok: true } })
    expect(await call(fy, 'POST', `/api/foryou/${encodeURIComponent(actionable)}/act`, { action: 'a1' })).toEqual({ status: 404, body: { error: M.en.notFound } })
    expect(await call(fy, 'POST', '/api/foryou/b%3Anope/dismiss')).toEqual({ status: 404, body: { error: M.en.notFound } })
    // Ids with colons travel encoded.
    snap.optimizers = [optimizer({ id: 'bad', state: 'failed', endedAt: T0 })]
    fy.feed()
    expect(await call(fy, 'POST', '/api/foryou/alert%3Aauto%3Abad/dismiss')).toEqual({ status: 200, body: { ok: true } })
    expect(fy.feed().items).toEqual([])
    await call(fy, 'GET', '/api/foryou/media/abc123')
    expect(shelf.served).toEqual(['abc123'])
    expect(await call(make({ shelf: null }), 'GET', '/api/foryou/media/abc123')).toEqual({ status: 404, body: { error: M.en.noMedia } })
  })
})

// ---------------------------------------------------------------- the hooks in core.ts

describe('wired into core', async () => {
  const { Weevils, isTestBrief } = await import('./core.ts')
  const { DATA_DIR, HOME } = await import('./config.ts')
  type Transcript = import('./transcripts.ts').Transcript
  const cwd = path.join(HOME, 'projects', 'demo')
  const ALIVE = process.pid
  const DEAD = spawnSync('true').pid
  let w: InstanceType<typeof Weevils>
  let fy: ForYou
  const transcript = (over: Partial<Transcript> = {}): Transcript => {
    const id = over.id ?? 's1'
    return { id, tool: 'claude', file: `/nowhere/${id}.jsonl`, cwd, openedAt: T0 - 2 * MIN, lastActivityAt: T0 - MIN, workStartedAt: null, phase: 'idle', firstPrompt: 'earlier', messages: [{ id: `${id}-m0`, role: 'user', text: 'earlier', at: T0 - MIN }], subagents: [], offset: 0, partial: '', queued: [], ...over }
  }
  const put = (t: Transcript) => (w.store.byFile.set(t.file, t), t)
  const settle = () => vi.advanceTimersByTimeAsync(250)

  beforeEach(() => {
    vi.useFakeTimers({ now: T0 })
    for (const f of Object.values(mux)) f.mockReset()
    mux.capture.mockResolvedValue('')
    mux.listWv.mockResolvedValue([])
    fs.mkdirSync(cwd, { recursive: true })
    fs.rmSync(path.join(DATA_DIR, 'state.json'), { force: true })
    w = new Weevils()
    fy = new ForYou(w, { file: path.join(dir, 'foryou.json'), shelf: null, isTestBrief })
    w.foryou = fy
  })
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('a turn that ends and a question enter the stream without any push; the first pass after a start is silent', async () => {
    put(transcript())
    put(transcript({ id: 'probe', file: '/nowhere/probe.jsonl', firstPrompt: '[test] probe' }))
    w.panes = [{ name: 'wv-demo-abc123', tool: 'claude', sessionId: 's1', title: 't', cwd, createdAt: T0 - MIN }, { name: 'wv-demo-def456', tool: 'claude', sessionId: 'probe', title: 't', cwd, createdAt: T0 - MIN }]
    w.hooks.set('s1', { event: 'Stop', at: T0 - MIN, pid: ALIVE })
    w.hooks.set('probe', { event: 'Stop', at: T0 - MIN, pid: ALIVE })
    w.bump()
    await settle()
    expect(w.push.enabled).toBe(false)
    expect(fy.feed().items).toEqual([])
    expect(w.snapshot().foryou).toEqual({ rev: 0, unseen: 0 })
    // A short turn (under the 15 s of the push) is still a result.
    for (const id of ['s1', 'probe']) w.hook({ session_id: id, hook_event_name: 'UserPromptSubmit' })
    await settle()
    await vi.advanceTimersByTimeAsync(5000)
    for (const id of ['s1', 'probe']) {
      const t = w.store.get(id)!
      t.messages.push({ id: `${id}-a1`, role: 'assistant', text: 'All three buttons are in.', at: Date.now() })
      t.lastActivityAt = Date.now()
      w.hook({ session_id: id, hook_event_name: 'Stop' })
    }
    await settle()
    expect(fy.feed().items).toMatchObject([{ id: 's:s1', kind: 'session', tone: 'result', text: 'All three buttons are in.', projectId: 'demo' }])
    expect(w.snapshot().foryou).toMatchObject({ unseen: 1 })
    expect(w.snapshot().foryou!.rev).toBeGreaterThan(0)
    // Nothing of the stream but its mark rides in the snapshot.
    expect(JSON.stringify(w.snapshot())).not.toContain('"kind":"session"')
    w.hook({ session_id: 's1', hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' })
    await settle()
    expect(fy.feed().items).toMatchObject([{ id: 's:s1', tone: 'question', text: 'Claude needs your permission to use Bash' }])
    expect(fy.feed().pulse).toMatchObject({ waiting: 1 })
  })

  it('a cut enters the stream with its reason and « resume »; a mail told by the bridge is kept', async () => {
    put(transcript({ phase: 'working', lastActivityAt: T0 - MIN, messages: [{ id: 'm', role: 'user', text: 'build the page', at: T0 - MIN }] }))
    w.hooks.set('s1', { event: 'PostToolUse', at: T0 - MIN, pid: DEAD })
    w.bump()
    await settle()
    expect(fy.feed().items).toMatchObject([{ id: 's:s1', tone: 'alert', text: 'Ouch, I got cut off mid-work (process stopped). Want me to pick it back up?', actions: [{ id: 'resume', label: 'Resume' }] }])
    w.mailed({ author: 'gepetto', subject: 'done', text: 'The page is built.', target: 'weevboss', mid: '<m@x>', address: 'g@example.com' })
    expect(fy.feed().items.map((i) => i.kind).sort()).toEqual(['mail', 'session'])
    expect(JSON.stringify(fy.feed())).not.toContain('g@example.com')
  })
})


describe('question option routing', () => {
  it('sends to its session and refuses an outdated question', async () => {
    const fy = make()
    const q = session({ status: 'needs_user', attention: 'Which colour should I use?' })
    snap.sessions = [q]
    fy.sessionTurn(q, 'question')
    fy.askRead('s:s1', { ask: true, question: 'Which colour?', options: ['Blue', 'Green'] })
    const oldChoice = find(fy, 's:s1')!.actions![1].id
    await fy.act('s:s1', oldChoice)
    expect(host.send).toHaveBeenCalledWith('s1', 'Green')
    expect(host.sendMain).not.toHaveBeenCalled()
    q.attention = 'Which size should I use?'
    fy.sessionTurn(q, 'question')
    fy.askRead('s:s1', { ask: true, question: 'Which size?', options: ['Small', 'Large'] })
    await expect(fy.act('s:s1', oldChoice)).rejects.toThrow()
    const nextChoice = find(fy, 's:s1')!.actions![0].id
    q.status = 'working'
    await expect(fy.act('s:s1', nextChoice)).rejects.toThrow()
    expect(host.send).toHaveBeenCalledTimes(1)
  })
})


describe('retired technical events', () => {
  it('cleans persisted commit/build cards and rejects their recreation across restarts', () => {
    const file = path.join(dir, 'foryou.json')
    const old = ['commit:mygame:abc', 'deploy:abc'].map((id) => ({ id, kind: 'boss', who: 'weevils', text: 'raw engineering log', at: now }))
    fs.writeFileSync(file, JSON.stringify({ rev: 3, items: [...old, { id: 'd:useful', kind: 'boss', who: 'weevboss', text: 'Your application is ready to use.', at: now }] }))
    const fy = make({ voiceOf: () => 'default' })
    expect(ids(fy)).toContain('d:useful')
    for (const item of old) expect(fy.add({ ...item, kind: 'boss' })).toBeNull()
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).items.map((i: { id: string }) => i.id)).toEqual(['d:useful'])
    const restarted = make({ voiceOf: () => 'default' })
    expect(ids(restarted).some((id) => /^(commit|deploy):/.test(id))).toBe(false)
    expect(find(restarted, 'd:useful')?.voice).toBe('default')
  })
})


describe('useful spoken ideas', () => {
  it('keeps real proposals voiced and linked, but never announces a draft or a missing idea', () => {
    snap.optimizers = [optimizer(), optimizer({ id: 'draft', draft: true })]
    const fy = make({ voiceOf: () => 'default' })
    expect(find(fy, 'auto:proposed:o1')).toMatchObject({ voice: 'default', open: { page: 'auto', id: 'o1' } })
    expect(find(fy, 'auto:proposed:draft')).toBeUndefined()
    fy.add({ id: 'auto:proposed:missing', kind: 'boss', text: 'An idea that does not exist' })
    expect(find(fy, 'auto:proposed:missing')).toBeUndefined()
    snap.optimizers = []
    expect(find(fy, 'auto:proposed:o1')).toBeUndefined()
    expect(find(make(), 'auto:proposed:draft')).toBeUndefined()
  })
})

describe('dismissed notification events', () => {
  it('a late close of the previous question cannot hide a new question of the same session', () => {
    const fy = make()
    const first = session({ status: 'needs_user', noticeId: 'question-one', attention: 'First?' })
    snap.sessions = [first]
    fy.sessionTurn(first, 'question')
    const old = find(fy, 's:s1')!
    const second = { ...first, noticeId: 'question-two', attention: 'Second?' }
    snap.sessions = [second]
    fy.sessionTurn(second, 'question')
    expect(fy.dismiss('s:s1', feedNoticeKey(old))).toBe(true)
    expect(find(fy, 's:s1')).toMatchObject({ eventId: 'question-two', text: 'Second?' })
    fy.dismiss('s:s1', 'question-two')
    fy.sessionTurn({ ...second, lastActivityAt: now + 1000 }, 'question')
    expect(find(fy, 's:s1')).toBeUndefined()
    const again = make()
    expect(find(again, 's:s1')).toBeUndefined()
    const third = { ...second, noticeId: 'question-three', attention: 'Second?' }
    snap.sessions = [third]
    again.sessionTurn(third, 'question')
    expect(find(again, 's:s1')).toMatchObject({ eventId: 'question-three' })
    expect(host.send).not.toHaveBeenCalled()
    expect(host.close).not.toHaveBeenCalled()
    expect(host.resume).not.toHaveBeenCalled()
  })
  it('quota dismissal survives API timestamp jitter and restart; a genuinely new window can notify', async () => {
    const u: UsageInfo = { claude: { ok: true, source: 'test', at: now, windows: [{ kind: 'week', percent: 98, resetsAt: T0 + HOUR - 12 }] }, codex: { ok: false, source: 'test', at: now, windows: [] } }
    const fy = make({ quotas: async () => u })
    fy.feed(); await flush()
    const first = fy.feed().items.find((i) => i.kind === 'alert')!
    fy.dismiss(first.id, feedNoticeKey(first))
    u.claude.windows[0].resetsAt! += 31
    now += REFRESH_MS + 1
    fy.feed(); await flush()
    expect(fy.feed().items.filter((i) => i.kind === 'alert')).toEqual([])
    // A dismissal written by an older server used the raw (jittering) timestamp in its id.
    const saved = JSON.parse(fs.readFileSync(fy.file, 'utf8'))
    saved.live[first.id.replace(/:\d+$/, `:${T0 + HOUR + 19}`)] = saved.live[first.id]
    delete saved.live[first.id]
    fs.writeFileSync(fy.file, JSON.stringify(saved))
    const again = make({ quotas: async () => u })
    again.feed(); await flush()
    expect(again.feed().items.filter((i) => i.kind === 'alert')).toEqual([])
    u.claude.windows[0].resetsAt! += 7 * 24 * HOUR
    now += REFRESH_MS + 1
    again.feed(); await flush()
    expect(again.feed().items.filter((i) => i.kind === 'alert')).toHaveLength(1)
  })
})


describe('answered request persistence', () => {
  it('keeps failed questions, persists a successful reply over restart/refinement and accepts a new event', async () => {
    const fy = make()
    const q = session({ status: 'needs_user', noticeId: 'q-one', attention: 'Go?' })
    snap.sessions = [q]
    fy.sessionTurn(q, 'question')
    host.send.mockRejectedValueOnce(new Error('offline'))
    await expect(fy.reply('s:s1', 'yes')).rejects.toThrow('offline')
    expect(find(fy, 's:s1')).toBeDefined()
    await fy.reply('s:s1', 'yes')
    expect(find(fy, 's:s1')).toBeUndefined()
    const again = make()
    again.sessionTurn({ ...q, attention: 'Go, refined?' }, 'question')
    expect(find(again, 's:s1')).toBeUndefined()
    snap.sessions = [{ ...q, noticeId: 'q-two' }]
    again.sessionTurn(snap.sessions[0], 'question')
    expect(find(again, 's:s1')).toMatchObject({ eventId: 'q-two' })
  })
  it('a successful direct session response resolves only the request it answered', () => {
    const fy = make()
    const old = session({ status: 'needs_user', noticeId: 'old', attention: 'Old?' })
    const next = { ...old, noticeId: 'new', attention: 'New?' }
    snap.sessions = [next]
    fy.sessionTurn(next, 'question')
    fy.resolveSession(old)
    expect(find(fy, 's:s1')).toMatchObject({ eventId: 'new' })
    fy.resolveSession(next)
    expect(find(fy, 's:s1')).toBeUndefined()
    expect(find(make(), 's:s1')).toBeUndefined()
  })
})

it('retires raw announcements hidden behind post/digest ids and refuses their regeneration or voice', () => {
  const file = path.join(dir, 'foryou.json')
  const raw = 'weevils a un nouveau commit (435cf0d) : fix(auto): propColors kept (auto-model.ts)'
  fs.writeFileSync(file, JSON.stringify({ rev: 3, items: [
    { id: 'b:legacy', kind: 'boss', who: 'weevils', text: raw, at: now },
    { id: 'd:legacy', kind: 'boss', who: 'weevboss', text: raw, at: now },
    { id: 'd:human', kind: 'boss', who: 'weevboss', text: 'Le thème et les notifications sont prêts.', at: now },
  ] }))
  const fy = make({ voiceOf: () => 'default' })
  expect(ids(fy)).toEqual(['d:human'])
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).items).toHaveLength(1)
  expect(fy.add({ id: 'd:again', kind: 'boss', text: raw })).toBeNull()
  expect(() => fy.post(raw)).toThrow(M.en.technicalPost)
  expect(ids(make({ voiceOf: () => 'default' }))).toEqual(['d:human'])
  const useful = fy.add({ id: 'd:useful', kind: 'boss', text: 'Le thème est en ligne (commit 2d5496f, poussé sur main).' })!
  expect(useful.text).toBe('Le thème est en ligne.')
  expect(useful.voice).toBe('default')
})

it('coalesces concurrent actions on the same card before delivery is acknowledged', async () => {
  const fy = make()
  const { id } = fy.post('Prepare the sketches', [{ label: 'Prepare', brief: 'make three sketches' }])
  let resolve!: () => void
  host.sendMain.mockImplementationOnce(() => new Promise((done) => { resolve = () => done({ id: 'boss' }) }))
  const first = fy.act(id, 'a1')
  const second = fy.act(id, 'a1')
  expect(host.sendMain).toHaveBeenCalledTimes(1)
  resolve()
  await Promise.all([first, second])
  expect(fy.feed().items).toEqual([])
})
