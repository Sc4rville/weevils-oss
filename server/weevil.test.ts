import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Snapshot } from '../shared/api.ts'
import { smart } from './fast.ts'
import { claudeLogged } from './setup.ts'
import { Memory } from './memory.ts'
import { BACKOFF_MS, Flyers, MAX_AGE_MS, MAX_FOLLOWUPS, MAX_MISSES, angleFor, angleTurn, answers, followups, isRepeat, readHistory, tidyQuestion } from './weevil.ts'

// Hermetic: no claude CLI, no login check, the language switched in memory only.
vi.mock('./fast.ts', async (orig) => ({ ...(await orig<typeof import('./fast.ts')>()), smart: vi.fn() }))
vi.mock('./setup.ts', () => ({ claudeLogged: vi.fn(() => true) }))
let lang: 'en' | 'fr' = 'en'
vi.mock('./i18n.ts', async (orig) => {
  const real = await orig<typeof import('./i18n.ts')>()
  return {
    ...real,
    lang: () => lang,
    tr: (m: Record<string, unknown>) => m[lang],
    withLang: <T,>(l: 'en' | 'fr', fn: () => T) => {
      const saved = lang
      lang = l
      try {
        return fn()
      } finally {
        lang = saved
      }
    },
    user: () => 'Sam',
  }
})

const model = vi.mocked(smart)
const logged = vi.mocked(claudeLogged)

const snap = {
  projects: [{ id: 'mygame', name: 'mygame', kind: 'repo', repos: ['mygame', 'mygame-site'], where: {}, lastActivityAt: Date.now() }],
  sessions: [{ id: 's1', projectId: 'mygame', title: 'jump physics', now: 'tuning the double jump', lastActivityAt: Date.now() }],
} as unknown as Snapshot

let dir: string
let memory: Memory
let f: Flyers
const flyers = (main = true) => {
  const w = { memory: main ? memory : null, snapshot: () => snap } as never
  return new Flyers(w, memory, { auto: false })
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weevil-'))
  memory = new Memory(path.join(dir, 'memory.json'))
  f = flyers()
  lang = 'en'
  model.mockReset()
  logged.mockReturnValue(true)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.useRealTimers()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('weevil — writing questions', () => {
  it('the prompt carries the memory, every question asked and the real projects', () => {
    memory.add('wants to ship a mobile game this year')
    memory.ask('What would you like right now?')
    const p = f.questionPrompt()
    expect(p).toContain('wants to ship a mobile game this year')
    expect(p).toContain('What would you like right now?')
    expect(p).toContain('mygame [mygame-site] : jump physics (tuning the double jump)')
    expect(p).toContain('Sam')
  })

  it('follows the language of the server', () => {
    lang = 'fr'
    expect(f.questionPrompt()).toContain('au tutoiement')
  })

  it('keeps one question ready, written once', async () => {
    model.mockResolvedValue('```json\n{"question": "« And in ten years? »"}\n```')
    expect(await f.next()).toBeNull()
    await f.prepare()
    expect(model).toHaveBeenCalledTimes(1)
    const q = await f.next()
    expect(q?.text).toBe('And in ten years?')
    await f.prepare()
    expect(model).toHaveBeenCalledTimes(1)
  })

  it('a missed question comes back, then is retired and a new one is written', async () => {
    model.mockResolvedValueOnce('{"question": "What would make this week great?"}').mockResolvedValueOnce('{"question": "Which skill would you love to learn?"}')
    await f.prepare()
    const q = (await f.next())!
    for (let i = 1; i < MAX_MISSES; i++) {
      f.missed(q.id)
      expect((await f.next())?.id).toBe(q.id)
    }
    f.missed(q.id)
    await vi.waitFor(() => expect(model).toHaveBeenCalledTimes(2))
    await vi.waitFor(async () => expect((await f.next())?.text).toBe('Which skill would you love to learn?'))
  })

  it('never keeps a repeat, and waits before trying again', async () => {
    memory.ask('And in ten years, where do you see yourself?')
    memory.markAsked(memory.asked()[0].id, 'answered')
    model.mockResolvedValue('{"question": "And in ten years, where do you see yourself?"}')
    await f.prepare()
    expect(f.ready()).toBeNull()
    await f.prepare()
    expect(model).toHaveBeenCalledTimes(1)
  })

  it('backs off on model failure (no tight loop), then tries again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    model.mockRejectedValue(new Error('not logged in'))
    await f.prepare()
    await f.prepare()
    await f.next()
    expect(model).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() + BACKOFF_MS + 1000)
    await f.prepare()
    expect(model).toHaveBeenCalledTimes(2)
    // Second failure: twice as long.
    vi.setSystemTime(Date.now() + BACKOFF_MS + 1000)
    await f.prepare()
    expect(model).toHaveBeenCalledTimes(2)
  })

  it('nothing on another machine nor without Claude', async () => {
    const other = flyers(false)
    expect(await other.next()).toBeNull()
    await other.prepare()
    logged.mockReturnValue(false)
    await f.prepare()
    expect(await f.next()).toBeNull()
    expect(model).not.toHaveBeenCalled()
  })

  it('a question in another language or too old waits', () => {
    memory.ask('Et dans dix ans, tu te vois où ?')
    expect(f.ready()).toBeNull()
    lang = 'fr'
    expect(f.ready()?.text).toBe('Et dans dix ans, tu te vois où ?')
    expect(f.ready(Date.now() + MAX_AGE_MS + 1)).toBeNull()
  })
})

describe('weevil — answers', () => {
  it('applies the memory changes: add, update by id, no duplicate', async () => {
    const old = memory.add('likes board games')
    const q = memory.ask('What do you love doing on weekends?')
    model.mockResolvedValue(
      JSON.stringify({
        reply: 'Nice, sounds fun!',
        done: true,
        memory: [
          { op: 'update', id: old.id, text: 'likes board games, especially co-op ones' },
          { op: 'add', text: 'goes climbing on Sundays' },
          { op: 'add', text: 'Goes climbing on Sundays.' },
        ],
      }),
    )
    const r = await f.answer(q.id, 'Climbing on Sundays, and co-op board games', [{ role: 'weevil', text: q.text }])
    expect(r.reply).toBe('Nice, sounds fun!')
    expect(r.done).toBe(true)
    expect(r.learned.map((m) => m.text)).toEqual(['likes board games, especially co-op ones', 'goes climbing on Sundays'])
    expect(memory.count).toBe(2)
    const added = memory.list().find((m) => m.text === 'goes climbing on Sundays')!
    expect(added.source).toBe('answer')
    expect(added.q).toBe(q.text)
    expect(memory.question(q.id)?.state).toBe('answered')
    // The answer carries the memory and the exchange to the model.
    expect(model.mock.calls[0][0]).toContain('likes board games')
    expect(model.mock.calls[0][0]).toContain('Sam: Climbing on Sundays')
  })

  it('never remembers a secret, and masks it in the kept answer', async () => {
    const q = memory.ask('What are you building these days?')
    model.mockResolvedValue(
      JSON.stringify({
        reply: 'Got it.',
        done: true,
        memory: [
          { op: 'add', text: 'email is sam@example.com' },
          { op: 'add', text: 'password is hunter2' },
          { op: 'add', text: 'uses key sk-abcdefghijklmnop1234' },
          { op: 'add', text: 'phone 06 12 34 56 78' },
          { op: 'add', text: 'building a recipe app' },
        ],
      }),
    )
    const r = await f.answer(q.id, 'A recipe app, my key is sk-abcdefghijklmnop1234')
    expect(r.learned.map((m) => m.text)).toEqual(['building a recipe app'])
    expect(memory.list()[0].a).not.toContain('sk-abcdefghijklmnop1234')
  })

  it('at most one follow-up, then it closes', async () => {
    expect(MAX_FOLLOWUPS).toBe(1)
    const q = memory.ask('What would you like right now?')
    model.mockResolvedValue('{"reply": "And then?", "done": false, "memory": []}')
    expect((await f.answer(q.id, 'a nap', [{ role: 'weevil', text: q.text }])).done).toBe(false)
    expect(model.mock.calls[0][0]).toContain('ONE small follow-up')
    const after = [
      { role: 'weevil' as const, text: q.text },
      { role: 'user' as const, text: 'a nap' },
      { role: 'weevil' as const, text: 'Where?' },
    ]
    // The model asks again anyway: the exchange closes all the same.
    expect((await f.answer(q.id, 'in the sun', after)).done).toBe(true)
    expect(model.mock.calls[1][0]).toContain('no new question')
  })

  it('a memory from a follow-up keeps the opening question and every answer of the exchange', async () => {
    const old = memory.add('likes naps')
    const q = memory.ask('What would you like right now?')
    model.mockResolvedValue(JSON.stringify({ reply: 'Lovely.', done: true, memory: [{ op: 'update', id: old.id, text: 'likes naps in the sun' }, { op: 'add', text: 'loves sunny afternoons' }] }))
    const history = [
      { role: 'weevil' as const, text: q.text },
      { role: 'user' as const, text: 'a nap' },
      { role: 'weevil' as const, text: 'Where?' },
    ]
    const r = await f.answer(q.id, ' in the  sun ', history)
    expect(r.learned).toHaveLength(2)
    for (const m of r.learned) expect(m).toMatchObject({ q: 'What would you like right now?', a: 'a nap · in the sun' })
    expect(memory.get(old.id)).toMatchObject({ source: 'manual', q: 'What would you like right now?', a: 'a nap · in the sun' })
  })

  it('model down: a kind reply in the language of the answer, nothing stored', async () => {
    const q = memory.ask('Qu’est-ce qui te ferait plaisir, là ?')
    model.mockRejectedValue(new Error('down'))
    const r = await f.answer(q.id, "j'aimerais bien finir mon jeu")
    expect(r).toEqual({ reply: 'Merci ! Je file, on en reparle bientôt.', learned: [], done: true })
    expect(memory.count).toBe(0)
    model.mockResolvedValue('not json at all')
    expect((await f.answer(q.id, 'just a walk outside')).reply).toBe('Thanks! Off I fly, more another time.')
  })
})

describe('weevil — helpers', () => {
  it('spots repeats and near repeats', () => {
    const asked = [{ text: 'And in ten years, where do you see yourself?' }]
    expect(isRepeat('and in ten years — where do you see yourself', asked)).toBe(true)
    expect(isRepeat('What would make you smile this week?', asked)).toBe(false)
  })

  it('cleans the question', () => {
    expect(tidyQuestion('  "What  next?" 🚀 ')).toBe('What next?')
    expect(tidyQuestion('x'.repeat(200))).toBeNull()
    expect(tidyQuestion(3)).toBeNull()
  })

  it('angles: broad while little is known, every angle later', () => {
    const early = new Set(Array.from({ length: 8 }, (_, i) => angleFor(i, 0, true)))
    expect([...early].sort()).toEqual(['far', 'now', 'taste', 'week'])
    const later = new Set(Array.from({ length: 14 }, (_, i) => angleFor(i, 10, true)))
    expect(later.has('followup') && later.has('project') && later.has('suggest')).toBe(true)
    expect(Array.from({ length: 14 }, (_, i) => angleFor(i, 10, false))).not.toContain('project')
  })

  it('angles keep turning once the asked list is full (it is capped, its length stops moving)', () => {
    // A full list (400) that slides by one per new question: the angle still varies.
    const ids = Array.from({ length: 420 }, (_, i) => ({ id: (0x1a2b3c + i * 7919).toString(16).padStart(10, '0') }))
    const seen = new Set(Array.from({ length: 20 }, (_, i) => angleFor(angleTurn(ids.slice(i, i + 400), 0), 10, true)))
    expect(seen.size).toBeGreaterThan(3)
    // A failed try moves to another angle; an empty list starts at the first one.
    expect(angleFor(angleTurn([{ id: 'a0' }], 1), 10, true)).not.toBe(angleFor(angleTurn([{ id: 'a0' }], 0), 10, true))
    expect(angleTurn([], 0)).toBe(0)
  })

  it('joins the answers of an exchange, each with its share of the room', () => {
    expect(answers([], 'just this')).toBe('just this')
    expect(answers([{ role: 'weevil', text: 'q' }, { role: 'user', text: 'first\n answer' }, { role: 'weevil', text: 'f' }], 'second')).toBe('first answer · second')
    const long = answers([{ role: 'user', text: 'x'.repeat(1000) }], 'y'.repeat(1000))
    expect(long.length).toBeLessThanOrEqual(1200)
    expect(long).toMatch(/^x+… · y+…$/)
  })

  it('reads the exchange and counts follow-ups', () => {
    const h = readHistory([{ role: 'weevil', text: 'q' }, { role: 'user', text: 'a' }, { role: 'admin', text: 'x' }, { role: 'weevil', text: 'f' }, null])
    expect(h).toHaveLength(3)
    expect(followups(h)).toBe(1)
    expect(readHistory('nope')).toEqual([])
  })
})
