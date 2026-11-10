import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TOUR_IDS, groupOf, pending, type Tour } from '../shared/tour.ts'

// Premiers pas (server/tour.ts) : ce qui est déjà là est « déjà prêt » et jamais reproposé ; ce qui se fait ensuite est
// « fait » ; une base ne se passe pas ; l'installation laisse sa trace (install.json) ; l'historique compte.
const home = os.homedir()
const { buildSteps, handoff, history, satisfied, claudePlan } = await import('./tour.ts')
const { default: T } = await import('./i18n/tour.ts')

const none = { ready: [], done: [], skip: [], played: [] }

describe('buildSteps', () => {
  it('what was true at the very start is "ready"; what became true since is "done"; the rest is "todo"', () => {
    const steps = buildSteps({ machine: true, claude: true, github: true, voice: true }, { ...none, ready: ['machine', 'claude'] }, {})
    const st = Object.fromEntries(steps.map((s) => [s.id, s.state]))
    expect(st.machine).toBe('ready')
    expect(st.claude).toBe('ready')
    expect(st.github).toBe('done')
    expect(st.voice).toBe('done')
    expect(st.mail).toBe('todo')
    expect(st.first).toBe('todo')
  })
  it('no install.json, no history: those lines are not shown at all (nothing to tick)', () => {
    const ids = buildSteps({ machine: true }, none, {}).map((s) => s.id)
    expect(ids).not.toContain('install')
    expect(ids).not.toContain('history')
    expect(ids).toContain('machine')
  })
  it('a skipped use stays skipped, a base (claude) cannot be skipped, the phone can', () => {
    const steps = buildSteps({ machine: true }, { ...none, skip: ['mail', 'claude', 'phone'] }, {})
    const st = Object.fromEntries(steps.map((s) => [s.id, s.state]))
    expect(st.mail).toBe('skip')
    expect(st.claude).toBe('todo')
    expect(st.phone).toBe('skip')
  })
  it('a played demo is marked until the real thing is plugged in, then the mark goes', () => {
    const before = buildSteps({}, { ...none, played: ['voice'] }, {}).find((s) => s.id === 'voice')
    expect(before).toMatchObject({ state: 'todo', played: true })
    const after = buildSteps({ voice: true }, { ...none, played: ['voice'] }, {}).find((s) => s.id === 'voice')
    expect(after?.played).toBeUndefined()
    expect(after?.state).toBe('done')
  })
  it('the first request comes from the app (done) or from an existing install (ready)', () => {
    expect(buildSteps({}, { ...none, done: ['first'] }, {}).find((s) => s.id === 'first')?.state).toBe('done')
    expect(buildSteps({}, { ...none, ready: ['first'] }, {}).find((s) => s.id === 'first')?.state).toBe('ready')
  })
  it('the next step comes in order: bases, the first request, uses, gestures', () => {
    const tour: Tour = { steps: buildSteps({ machine: true, claude: true }, { ...none, ready: ['machine', 'claude'] }, {}), open: true, intro: true, finished: false }
    const order = pending(tour).map((s) => groupOf(s.id))
    const rank = { base: 0, first: 1, use: 2, gesture: 3 } as const
    expect([...order].sort((a, b) => rank[a] - rank[b])).toEqual(order)
    expect(pending(tour)[0].id).toBe('phone')
  })
})

describe('satisfied', () => {
  const state = {
    machine: { alwaysOn: false, othersAlwaysOn: false },
    claude: { installed: true, logged: true },
    codex: { installed: true, logged: false },
    github: { installed: true, logged: false },
    voice: { spoken: null },
    devil: { plugged: false },
    mail: { on: false },
    phone: { devices: 1, push: 0 },
  }
  const extra = { seen: new Set<string>(), h24: [], phone: false, history: { projects: 0, sessions: 0, repos: 0 } }
  it('reads the real state: a laptop alone is not set for the night, a demo job is not a real 24/7 job', () => {
    const s = satisfied(state as never, { ...extra, h24: [{ demo: true } as never] })
    expect(s.night).toBe(false)
    expect(s.h24).toBe(false)
    expect(s.claude).toBe(true)
    expect(s.codex).toBe(false)
    expect(satisfied(state as never, { ...extra, h24: [{} as never] }).h24).toBe(true)
  })
  it('a gesture is done once the app saw it done (hints.json)', () => {
    const s = satisfied(state as never, { ...extra, seen: new Set(['repos', 'g-back']) })
    expect(s['g-repos']).toBe(true)
    expect(s['g-back']).toBe(true)
    expect(s['g-calm']).toBe(false)
  })
  it('opened on a phone, or push turned on: the phone is there', () => {
    expect(satisfied(state as never, { ...extra, phone: true }).phone).toBe(true)
    expect(satisfied({ ...state, phone: { devices: 2, push: 1 } } as never, extra).phone).toBe(true)
    expect(satisfied(state as never, extra).phone).toBe(false)
  })
  it('every step id is covered (except the first request, told by the app)', () => {
    const s = satisfied(state as never, extra)
    for (const id of TOUR_IDS) if (id !== 'first') expect(s).toHaveProperty(id)
  })
})

describe('what was already on the machine', () => {
  it('install.json: who installed and how; a broken or missing file is nothing', () => {
    const f = path.join(home, '.local', 'share', 'weevils', 'install.json')
    fs.mkdirSync(path.dirname(f), { recursive: true })
    expect(handoff()).toBeUndefined()
    fs.writeFileSync(f, '{not json')
    expect(handoff()).toBeUndefined()
    fs.writeFileSync(f, JSON.stringify({ v: 1, at: 1000, by: 'agent', agent: 'claude', url: 'https://x', mode: 'public', phoneLink: true, lang: 'fr', ready: { claude: true }, projects: 3, repos: 2 }))
    expect(handoff()).toEqual({ by: 'agent', agent: 'claude', at: 1000, mode: 'public', phoneLink: true })
    fs.writeFileSync(f, JSON.stringify({ at: 5, by: 'robot', mode: 'weird' }))
    expect(handoff()).toMatchObject({ by: 'terminal', mode: 'local', phoneLink: false })
  })
  it('history: Claude Code projects with sessions, repos in the project roots; weevboss’s own folder does not count', () => {
    const cp = path.join(home, '.claude', 'projects')
    for (const [d, n] of [['-home-me-projects-a', 2], ['-home-me-projects-b', 1], ['-home-me-.local-share-weevils-orchestrateur', 5], ['-empty', 0]] as const) {
      fs.mkdirSync(path.join(cp, d), { recursive: true })
      for (let i = 0; i < n; i++) fs.writeFileSync(path.join(cp, d, `${i}.jsonl`), '{}')
    }
    fs.mkdirSync(path.join(home, 'projects', 'repo1', '.git'), { recursive: true })
    fs.mkdirSync(path.join(home, 'projects', 'not-a-repo'), { recursive: true })
    expect(history()).toEqual({ projects: 2, sessions: 3, repos: 1 })
  })
  it('the Claude plan is read from the login file, never anything odd', () => {
    const f = path.join(home, '.claude', '.credentials.json')
    fs.writeFileSync(f, JSON.stringify({ claudeAiOauth: { subscriptionType: 'Max' } }))
    expect(claudePlan()).toBe('max')
    fs.writeFileSync(f, JSON.stringify({ claudeAiOauth: { subscriptionType: '<script>' } }))
    expect(claudePlan()).toBe('')
  })
})

describe('demo texts', () => {
  it('the summary says what is true, in both languages', () => {
    expect(T.en.summary(2, 1, 3, ['a', 'b', 'c'], 0)).toBe('2 sessions are working, 1 waiting for you. Your projects: a, b and c.')
    expect(T.en.summary(0, 0, 0, [], 6)).toBe('Nothing is running right now. I found 6 Claude Code sessions on this machine.')
    expect(T.fr.summary(1, 0, 4, ['a', 'b', 'c'], 0)).toBe('1 session travaille. Tes projets : a, b, c et 1 autre.')
  })
})
