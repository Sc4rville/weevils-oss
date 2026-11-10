import { describe, expect, it } from 'vitest'
import type { H24Activity, Optimizer, Project } from '../../shared/api.ts'
import { DRAWER_SLOT, PROP_PALETTE, at, autoList, autoOfSession, bandColors, propColors, failedLine, fromActivity, fromOptimizer, hueGap, progressOf, short, triggerText, windowStart, type Trigger } from './auto-model'

const NOW = 1_800_000_000_000
const MIN = 60_000
const H = 3600_000
const DAY = 86_400_000
const project = (id: string, repos: string[]): Project => ({ id, name: id, kind: 'repo', repos, where: {}, lastActivityAt: 0 })
const opt = (o: Partial<Optimizer>): Optimizer => ({ id: 'o', title: 't', why: '', repo: null, kind: 'tests', heavy: false, state: 'queued', createdAt: NOW, ...o })
const act = (a: Partial<H24Activity>): H24Activity => ({ id: 'job:x', title: 'x', kind: 'job', projectId: null, schedule: '', enabled: true, runState: 'waiting', runStartedAt: null, lastEvent: '', canToggle: false, ...a })
const list = (optimizers: Optimizer[], h24: H24Activity[] = [], projects: Project[] = []) => autoList({ projects, optimizers, h24, now: NOW })

describe('autoList: what runs without asking', () => {
  it('takes accepted tasks, timers, running jobs and the jobs ended under 3 h; never a proposal or a refused one', () => {
    const ids = list(
      [opt({ id: 'q' }), opt({ id: 'p', state: 'proposed' }), opt({ id: 'x', state: 'refused' }), opt({ id: 'd', state: 'done', endedAt: NOW - H })],
      [act({ id: 'timer:a', kind: 'timer', nextRunAt: NOW + H, everyMs: DAY }), act({ id: 'job:run', runState: 'running', runStartedAt: NOW - MIN }), act({ id: 'job:recent', lastRunAt: NOW - H }), act({ id: 'job:old', lastRunAt: NOW - 4 * H })],
    ).map((x) => x.id)
    expect(ids.sort()).toEqual(['d', 'job:recent', 'job:run', 'q', 'timer:a'])
  })

  it('orders: running, then the soonest trigger, then held by the machine, then paused; finished last', () => {
    const ids = list([
      opt({ id: 'paused', paused: true, waiting: 'paused' }),
      opt({ id: 'busy', waiting: 'busy' }),
      opt({ id: 'late', waiting: 'time', startAt: NOW + 9 * H, every: DAY }),
      opt({ id: 'soon', waiting: 'time', startAt: NOW + H, every: DAY }),
      opt({ id: 'done', state: 'done', endedAt: NOW - H }),
      opt({ id: 'run', state: 'running', startedAt: NOW - MIN }),
    ]).map((x) => x.id)
    expect(ids).toEqual(['run', 'soon', 'late', 'busy', 'paused', 'done'])
  })

  it('maps states and triggers', () => {
    expect(fromOptimizer(opt({ waiting: 'load' }))).toMatchObject({ state: 'waiting', trigger: { kind: 'idle' } })
    expect(fromOptimizer(opt({ waiting: 'queue' }))!.state).toBe('queued')
    expect(fromOptimizer(opt({ paused: true }))!.state).toBe('paused')
    expect(fromOptimizer(opt({ waiting: 'time', startAt: NOW + H, every: 7 * DAY, window: { from: 60, to: 360 } }))).toMatchObject({ state: 'scheduled', nextAt: NOW + H, trigger: { kind: 'every', every: 7 * DAY } })
    expect(fromOptimizer(opt({ window: { from: 60, to: 360 } }))!.trigger.kind).toBe('window')
    expect(fromOptimizer(opt({ notBefore: NOW + H }))!.trigger.kind).toBe('time')
    expect(fromActivity(act({ kind: 'timer', nextRunAt: NOW + MIN, everyMs: 6 * H }))).toMatchObject({ state: 'scheduled', trigger: { kind: 'every', every: 6 * H } })
    expect(fromActivity(act({ kind: 'timer', nextRunAt: NOW + MIN }))!.trigger.kind).toBe('time')
    // A job that runs: its run is the live one, there is no « last » yet.
    expect(fromActivity(act({ kind: 'job', runState: 'running', runStartedAt: NOW - MIN, lastRunAt: NOW }))).toMatchObject({ runCount: 0, runs: [], lastRun: undefined })
    expect(fromActivity(act({ kind: 'timer', runState: 'paused', nextRunAt: NOW }))).toMatchObject({ state: 'paused', nextAt: null })
    expect(fromActivity(act({ runState: 'running', runStartedAt: NOW }))).toMatchObject({ state: 'running', trigger: { kind: 'manual' } })
  })

  it('keeps the runs (newest first, old { at, ok, note } read as a run with no length), the count and the tokens', () => {
    const x = fromOptimizer(opt({ every: DAY, runs: [{ at: NOW - 2 * DAY, ok: true } as never, { at: NOW - DAY, startedAt: NOW - DAY - 9 * MIN, ok: false, tokens: 9000 }], runCount: 40, tokens: 1_200_000 }))!
    expect(x.runs.map((r) => r.at)).toEqual([NOW - DAY, NOW - 2 * DAY])
    expect(x.runs[1].startedAt).toBe(NOW - 2 * DAY)
    expect(x).toMatchObject({ runCount: 40, tokens: 1_200_000, lastRun: { ok: false } })
  })

  it('a queued task knows its place in line; one held by its time or a retry is not in it', () => {
    const xs = list([opt({ id: 'r', state: 'running' }), opt({ id: 'daily', waiting: 'time', every: DAY }), opt({ id: 'q1', waiting: 'queue' }), opt({ id: 'q2', waiting: 'queue' })])
    expect(xs.find((x) => x.id === 'q1')!.place).toBe(2)
    expect(xs.find((x) => x.id === 'q2')!.place).toBe(3)
    expect(xs.find((x) => x.id === 'daily')!.place).toBeUndefined()
  })

  it('places a task in the project of its repo, a job in its project or its family', () => {
    const xs = list([opt({ id: 'a', repo: 'mygame-site' })], [act({ id: 'job:b', group: 'notes', runState: 'running' })], [project('mygame', ['mygame', 'mygame-site']), project('notes', ['notes'])])
    expect(xs.find((x) => x.id === 'a')!.projectId).toBe('mygame')
    expect(xs.find((x) => x.id === 'job:b')!.projectId).toBe('notes')
  })

  it('finds the automation a session runs for', () => {
    expect(autoOfSession({ optimizers: [opt({ id: 'a', state: 'running', sessionId: 's1' })] }, 's1')).toBe('a')
    expect(autoOfSession({ optimizers: [opt({ id: 'a' })] }, 's1')).toBeNull()
    // Its run over (done, or queued for the next one), the session is yours again: the green star, not the loop.
    expect(autoOfSession({ optimizers: [opt({ id: 'a', state: 'done', sessionId: 's1' }), opt({ id: 'b', state: 'queued', sessionId: 's1' })] }, 's1')).toBeNull()
  })

  it('a finished job whose last line says it failed is failed; a running one, a clean end or a timer is not', () => {
    for (const line of ['✗ 3 failed — exit 1', 'npm ERR! code ELIFECYCLE', 'Command failed with exit code 2', 'exited with status 127', 'Error: ENOENT', 'FATAL: out of memory', 'Traceback (most recent call last):', 'build aborted'])
      expect(failedLine(line), line).toBe(true)
    for (const line of ['✓ 1203 files, 0 errors', 'no errors found', 'exit 0', 'errors: 0', 'Tests 12 passed, 0 failed', 'linking', '—', ''])
      expect(failedLine(line), line).toBe(false)
    expect(fromActivity(act({ lastEvent: 'npm ERR! code 1', lastRunAt: NOW })).state).toBe('failed')
    expect(fromActivity(act({ lastEvent: 'done, 0 errors' })).state).toBe('done')
    expect(fromActivity(act({ runState: 'running', lastEvent: 'error: retrying' })).state).toBe('running')
    expect(fromActivity(act({ kind: 'timer', lastEvent: 'failed' })).state).toBe('scheduled')
  })

  it('compact durations', () => {
    expect(short(14 * MIN)).toBe('14m')
    expect(short(90 * MIN)).toBe('1h30')
    expect(short(6 * H + MIN, true)).toBe('6h')
    expect(short(3 * DAY)).toBe('3d')
  })
})

describe('triggerText: when it fires, in one phrase', () => {
  const at7 = new Date(NOW).setHours(7, 0, 0, 0)
  const monday = (() => {
    const d = new Date(NOW)
    d.setHours(1, 0, 0, 0)
    while (d.getDay() !== 1) d.setDate(d.getDate() + 1)
    return d.getTime()
  })()
  const cases: [Trigger, string, string][] = [
    [{ kind: 'every', every: 6 * H }, 'toutes les 6 h', 'every 6h'],
    [{ kind: 'every', every: 90 * MIN }, 'toutes les 1 h 30', 'every 1h30'],
    [{ kind: 'every', every: DAY, window: { from: 420, to: 480 } }, 'chaque jour 07:00–08:00', 'every day 07:00–08:00'],
    [{ kind: 'every', every: DAY, at: at7 }, 'chaque jour 07:00', 'every day 07:00'],
    [{ kind: 'every', every: DAY, window: { from: 60, to: 360 } }, 'chaque nuit 01:00–06:00', 'every night 01:00–06:00'],
    [{ kind: 'every', every: 7 * DAY, window: { from: 60, to: 360 }, at: monday }, 'chaque lundi, la nuit', 'every Monday, at night'],
    [{ kind: 'every', every: 3 * DAY }, 'tous les 3 jours', 'every 3 days'],
    [{ kind: 'window', window: { from: 60, to: 360 } }, 'la nuit 01:00–06:00', 'at night 01:00–06:00'],
    [{ kind: 'window', window: { from: 600, to: 720 } }, 'entre 10:00 et 12:00', 'between 10:00 and 12:00'],
    [{ kind: 'idle' }, 'quand rien ne tourne', 'when nothing else runs'],
    [{ kind: 'manual' }, 'lancé à la main', 'started by hand'],
  ]
  it.each(cases)('%j', (tg, fr, en) => {
    expect(triggerText(tg, NOW, 'fr')).toBe(fr)
    expect(triggerText(tg, NOW, 'en')).toBe(en)
  })

  it('a proposal with a window says the weekday of its next window', () => {
    const x = fromOptimizer(opt({ state: 'proposed', every: 7 * DAY, window: { from: 60, to: 360 } }), null, NOW)!
    expect(x.trigger.at).toBe(windowStart({ from: 60 }, NOW))
    expect(x.trigger.at! > NOW && x.trigger.at! - NOW <= DAY).toBe(true)
  })
})

describe('bandColors', () => {
  const gaps = (ids: string[], m: Map<string, string>) => {
    let above = DRAWER_SLOT
    for (const id of ids) {
      expect(hueGap(m.get(id)!, above), `${id} under ${above}`).toBeGreaterThanOrEqual(3)
      expect(hueGap(m.get(id)!, DRAWER_SLOT), `${id} by the amber`).toBeGreaterThanOrEqual(2)
      above = m.get(id)!
    }
  }

  it('each band far from the one above (the amber head for the first), whatever the ids', () => {
    for (let n = 0; n < 40; n++) {
      const ids = Array.from({ length: 7 }, (_, i) => `t${n}-${i}`)
      gaps(ids, bandColors(ids, new Map()))
    }
    expect(hueGap('p2', 'p3')).toBe(1)
    expect(hueGap('p0', 'p15')).toBe(1)
  })

  it('stable: a band keeps its slot while it stays; one leaving repaints at most the band under it', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f']
    const first = bandColors(ids, new Map())
    expect(bandColors(ids, first)).toEqual(first)
    for (const gone of ids) {
      const left = ids.filter((x) => x !== gone)
      const next = bandColors(left, first)
      gaps(left, next)
      expect(left.filter((x) => next.get(x) !== first.get(x)).length, `without ${gone}`).toBeLessThanOrEqual(1)
    }
  })
})

describe('progress: the span the fill covers', () => {
  it('a wait from the last run (else the acceptance) to the next trigger, never longer than the period', () => {
    const x = fromOptimizer(opt({ waiting: 'time', startAt: NOW + 6 * H, every: DAY, acceptedAt: NOW - 30 * DAY, runs: [{ at: NOW - 18 * H, startedAt: NOW - 18 * H - 9 * MIN, ok: true }] }))!
    expect(x.progress(NOW)).toEqual({ from: NOW - 18 * H, to: NOW + 6 * H })
    const fresh = fromOptimizer(opt({ waiting: 'time', startAt: NOW + 6 * H, every: DAY, acceptedAt: NOW - 2 * H }))!
    expect(fresh.progress(NOW)).toEqual({ from: NOW - 2 * H, to: NOW + 6 * H })
    const old = fromOptimizer(opt({ waiting: 'time', startAt: NOW + 6 * H, every: DAY, acceptedAt: NOW - 30 * DAY }))!
    expect(old.progress(NOW)).toEqual({ from: NOW + 6 * H - DAY, to: NOW + 6 * H })
  })

  it('a run heads for its usual length (median of the past runs, else the estimate)', () => {
    const runs = [9, 12, 30].map((m, i) => ({ at: NOW - (i + 1) * DAY, startedAt: NOW - (i + 1) * DAY - m * MIN, ok: true }))
    expect(fromOptimizer(opt({ state: 'running', startedAt: NOW - MIN, runs }))!.progress(NOW)).toEqual({ from: NOW - MIN, to: NOW - MIN + 12 * MIN })
    expect(fromOptimizer(opt({ state: 'running', startedAt: NOW - MIN, est: 45 }))!.progress(NOW)).toEqual({ from: NOW - MIN, to: NOW + 44 * MIN })
  })

  it('nothing fills while it waits for the machine or for nothing else to run', () => {
    expect(fromOptimizer(opt({ waiting: 'busy' }))!.progress(NOW)).toBeNull()
    expect(fromOptimizer(opt({}))!.progress(NOW)).toBeNull()
  })

  it('paused: the span it had (its last run to one period later)', () => {
    const x = fromOptimizer(opt({ paused: true, every: 6 * H, runs: [{ at: NOW - 2 * H, startedAt: NOW - 2 * H - MIN, ok: true }] }))!
    expect(progressOf(x, NOW)).toEqual({ from: NOW - 2 * H, to: NOW + 4 * H })
  })
})

describe('side-by-side colours (« pour toi »)', () => {
  it('far from the head amber and the band below, apart from each other, kept while they stay', () => {
    const first = propColors(['a', 'b', 'c'], new Map(), null)
    expect([...first.values()]).toEqual(PROP_PALETTE.slice(0, 3))
    for (let i = 0; i < 16; i++) {
      const c = [...propColors(['a', 'b', 'c'], new Map(), `p${i}`).values()]
      for (const x of c) expect(Math.min(hueGap(x, `p${i}`), hueGap(x, DRAWER_SLOT)), `${x} on p${i}`).toBeGreaterThanOrEqual(3)
      for (const [j, x] of c.entries()) for (const y of c.slice(j + 1)) expect(hueGap(x, y), `${x} by ${y}`).toBeGreaterThanOrEqual(2)
    }
    const below = propColors(['a', 'b', 'c'], first, first.get('a')!)
    expect(below.get('a')).not.toBe(first.get('a'))
    expect(below.get('b')).toBe(first.get('b'))
    const next = propColors(['b', 'c', 'd'], below, null)
    expect(next.get('c')).toBe(first.get('c'))
    expect(new Set(next.values()).size).toBe(3)
  })
})


describe('automation time', () => {
  it('keeps the weekday across midnight even when the next run is only hours away', () => {
    const now = new Date(2026, 10, 10, 15).getTime()
    expect(at(new Date(2026, 10, 10, 19).getTime(), now, 'fr')).toBe('19:00')
    expect(at(new Date(2026, 10, 11, 0).getTime(), now, 'fr')).toBe('mer. 00:00')
    expect(at(new Date(2026, 10, 11, 0).getTime(), now, 'en')).toBe('Wed 00:00')
  })
})
