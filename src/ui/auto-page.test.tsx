// @vitest-environment happy-dom
// The page of an automation: the same five facts for a task, a timer and a job; the newest run unfolded (report,
// files, links, screenshots); the talk only for a task; a proposal's ✓ / × from the page, then back.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { vi } from 'vitest'
import { setLang } from '../i18n'
import type { Theme } from './app-context'
import type { AutoDetail, AutoRunDetail, H24Activity, Optimizer, OptimizerTalkReply, Snapshot } from '../../shared/api.ts'

const calls = vi.hoisted(() => [] as string[])
const fixtures = vi.hoisted(() => ({
  deleteFail: false, acceptFail: false, detail: new Map<string, AutoDetail>(), runs: new Map<string, AutoRunDetail>(), reads: 0, talk: undefined as OptimizerTalkReply | undefined }))
vi.mock('../api', () => ({
  ApiError: class extends Error {},
  api: {
    autoTrigger: async (id: string, t: unknown) => { calls.push(`trigger ${id} ${JSON.stringify(t)}`); return { item: {} } },
    deleteAutomation: async (id: string) => { calls.push(`delete ${id}`); if(fixtures.deleteFail) throw new Error('offline'); return {ok:true,running:false} },
    auto: async (id: string) => {
      fixtures.reads++
      const d = fixtures.detail.get(id)
      if (!d) throw new Error('404')
      return d
    },
    autoRun: async (id: string, at: number) => {
      const d = fixtures.runs.get(`${id}@${at}`)
      if (!d) throw new Error('404')
      return d
    },
    autoBlob: (id: string, path: string) => `/api/auto/${id}/blob?path=${path}`,
    acceptOptimizer: async (id: string, rev?: number) => { calls.push(`accept ${id} rev ${rev}`); if (fixtures.acceptFail) throw new Error('offline') },
    refuseOptimizer: async (id: string) => void calls.push(`refuse ${id}`),
    talkOptimizer: async (id: string, text: string) => {
      calls.push(`talk ${id} ${text}`)
      return fixtures.talk ?? { reply: 'ok', changed: [] }
    },
    pauseOptimizer: async (id: string, paused: boolean) => void calls.push(`pause ${id} ${paused}`),
    runOptimizer: async (id: string) => void calls.push(`run ${id}`),
    toggleH24: async (id: string) => void calls.push(`toggle ${id}`),
  },
}))

const { MotionGlobalConfig } = await import('motion/react')
MotionGlobalConfig.skipAnimations = true
const { AutoPage, AutoRunPage } = await import('./auto-page')
const { Ctx } = await import('./app-context')

const NOW = Date.now()
const MIN = 60_000
const DAY = 86_400_000
const opt = (o: Partial<Optimizer>): Optimizer => ({ id: 'o', title: 't', why: '', repo: null, kind: 'tests', heavy: false, state: 'queued', createdAt: NOW, ...o })
const runs = [3, 2, 1].map((i) => ({ at: NOW - i * DAY, startedAt: NOW - i * DAY - 9 * MIN, ok: i !== 2, note: `run ${i}`, tokens: 12_000, files: 3 }))
const daily = opt({ id: 'd', title: 'Daily digest', why: 'every morning, yesterday in one page', repo: 'mygame', every: DAY, window: { from: 420, to: 480 }, waiting: 'time', startAt: NOW + 6 * 3600_000, runs, runCount: 23, tokens: 412_000 })
const timer: H24Activity = { id: 'timer:wv-backup.timer', title: 'Backup', kind: 'timer', projectId: null, schedule: '', enabled: true, runState: 'waiting', runStartedAt: null, lastEvent: '', canToggle: true, nextRunAt: NOW + 3600_000, everyMs: DAY, lastRunAt: NOW - 3600_000, lastDurMs: 6 * MIN, lastOk: true, runCount: 60, description: 'copies the projects' }
const job: H24Activity = { id: 'job:render', title: 'render', kind: 'job', projectId: 'mygame', schedule: '', enabled: true, runState: 'running', runStartedAt: NOW - 3 * MIN, lastEvent: 'step 40/120', canToggle: false }

const snap = (optimizers: Optimizer[], h24: H24Activity[] = []): Snapshot => ({
  version: 1,
  now: NOW,
  machines: [{ id: 'm', name: 'm' }],
  projects: [{ id: 'mygame', name: 'mygame', kind: 'repo', repos: ['mygame'], where: {}, lastActivityAt: 0 }],
  sessions: [],
  h24,
  conversations: [],
  conversationCounts: { total: 0, pending: 0, byProject: {} },
  classifier: { running: false, queued: 0 },
  main: [],
  mainWorking: false,
  mainHasScreen: false,
  mainQueued: 0,
  devil: { enabled: false, working: false },
  pinnedRepos: [],
  optimizers,
  config: { userName: '', exposeDomain: '', publicHost: '' },
})

let root: Root
let host: HTMLElement
let pushed: unknown[]
let backs: number

function render(s: Snapshot, page: React.ReactNode, theme: Theme = 'light') {
  const ctx = {
    snap: s,
    now: NOW,
    offline: false,
    colors: { mygame: 'p3' },
    push: (p: unknown) => pushed.push(p),
    replace: () => {},
    back: () => void backs++,
    home: () => {},
    expanded: null,
    setExpanded: () => {},
    h24Open: false,
    setH24Open: () => {},
    theme,
    setTheme: () => {},
    refresh: () => {},
    logout: () => {},
  }
  act(() => root.render(<Ctx.Provider value={ctx}>{page}</Ctx.Provider>))
}

const flush = () => act(() => new Promise((r) => setTimeout(r, 30)))
const click = (el: Element | null | undefined) => act(async () => void (el as HTMLElement).click())
const label = (re: RegExp) => [...host.querySelectorAll('[aria-label]')].find((e) => re.test(e.getAttribute('aria-label')!))
const kpis = () => Object.fromEntries([...host.querySelectorAll('.auto-kpi')].map((c) => [c.querySelector('.k')!.textContent, c.querySelector('.v')!.textContent]))

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  localStorage.setItem('weevils-lang', 'en')
  window.confirm = vi.fn(() => false)
  calls.length = 0
  fixtures.detail.clear()
  fixtures.runs.clear()
  fixtures.talk = undefined
  pushed = []
  fixtures.deleteFail = false
  fixtures.acceptFail = false
  backs = 0
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  setLang(null)
})

describe('automation page', () => {
  it('confirms the exact automation and active-run effect, cancels without a request, then deletes once', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(snap([daily]), <AutoPage id="d" />)
    await click(host.querySelector('.auto-delete button'))
    expect(calls).not.toContain('delete d')
    expect(confirm.mock.calls[0][0]).toContain('Daily digest')
    expect(confirm.mock.calls[0][0]).toContain('already running will finish')
    confirm.mockReturnValue(true)
    await act(async () => {
      const button = host.querySelector<HTMLButtonElement>('.auto-delete button')!
      button.click(); button.click()
    })
    expect(calls.filter(x => x === 'delete d')).toHaveLength(1)
    expect(backs).toBe(1)
    render(snap([daily]), <AutoPage id="d" />)
    expect(host.querySelector('.auto-delete')).toBeNull()
  })
  it('keeps the automation after failure and retries only on explicit confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    fixtures.deleteFail = true
    render(snap([daily]), <AutoPage id="d" />)
    await click(host.querySelector('.auto-delete button'))
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not delete')
    expect(backs).toBe(0)
    fixtures.deleteFail = false
    await click(host.querySelector('.auto-delete button'))
    expect(backs).toBe(1)
  })

  it('a new conversation starts with one clear question and turns into the existing proposal after a natural-language reply', async () => {
    const draft = opt({ id: 'new', state: 'proposed', title: 'new automation', draft: true, talk: [{ who: 'auto', text: 'What do you want to automate?', at: NOW }] })
    render(snap([draft]), <AutoPage id="new" />)
    // One line, nothing else, before you've said anything.
    expect(host.querySelector('.auto-discuss')!.textContent).toBe('Let’s discuss your automation!')
    expect(host.textContent).not.toContain('What do you want to automate?')
    expect(host.querySelector('.auto-delete')).toBeNull()
    expect(host.querySelector('.auto-decide')).toBeNull()
    expect(host.querySelector('.auto-kpis')).toBeNull()
    expect(host.querySelectorAll('input')).toHaveLength(1)
    const ready = { ...draft, draft: undefined, title: 'Daily test report', rev: 1, every: DAY, talk: [...draft.talk!, { who: 'user' as const, text: 'Check mygame every day.', at: NOW }, { who: 'auto' as const, text: 'A daily report of mygame tests, ready to approve.', at: NOW }] }
    fixtures.talk = { reply: 'A daily report of mygame tests, ready to approve.', item: ready, changed: ['title', 'prompt', 'every'] }
    const field = host.querySelector<HTMLInputElement>('.composer input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'Check mygame every day.')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => void host.querySelector<HTMLFormElement>('.composer')!.requestSubmit())
    await flush()
    expect(calls).toContain('talk new Check mygame every day.')
    expect(host.querySelector('h1')!.textContent).toBe('Daily test report')
    expect(host.querySelector('.auto-decide')).not.toBeNull()
    expect(host.querySelector('.auto-talk')!.textContent).toContain('ready to approve')
    expect(calls.some((c) => c.startsWith('accept'))).toBe(false)
  })

  it('a new automation shows no suggestions and no settings: only « Let’s discuss your automation! » and the field', async () => {
    const first = { who: 'auto' as const, text: 'What do you want to automate?', at: NOW, suggestions: [{ label: 'Daily summary of mygame', text: 'I would like a daily summary of mygame.' }] }
    const draft = opt({ id: 'new', title: 'new automation', state: 'proposed', draft: true, talk: [first] })
    render(snap([draft]), <AutoPage id="new" />)
    expect(host.querySelectorAll('.auto-suggestions button')).toHaveLength(0)
    expect(host.textContent).not.toMatch(/Run when I sleep|Daily summary/)
    expect(host.querySelector('.composer input')).not.toBeNull()
  })

  it('the same five facts for a task (its state is the flow band, where it runs the head); tapping one prefills the talk', async () => {
    render(snap([daily]), <AutoPage id="d" />)
    await flush()
    const k = kpis()
    // No token count: a number of tokens means nothing to a person.
    expect(Object.keys(k)).toEqual(['when', 'next', 'last', 'length', 'runs'])
    expect(k).toMatchObject({ when: 'every day 07:00–08:00', last: '1d ago', length: '9 min', runs: '23' })
    expect(host.textContent).not.toMatch(/tokens|412K|12K/)
    expect(host.querySelector('.auto-flow .name')!.textContent).toBe('in 6h 00m')
    expect(host.querySelector('.page-head .strong')!.textContent).toBe('mygame')
    expect(host.querySelectorAll('button.auto-kpi')).toHaveLength(5)
    await click(host.querySelector('button.auto-kpi'))
    await act(() => new Promise((r) => requestAnimationFrame(() => r(null))))
    expect(host.querySelector<HTMLInputElement>('.composer input')!.value).toBe('when: ')
  })

  it('a timer and a job: the same five facts, not tappable, no talk', async () => {
    render(snap([], [timer]), <AutoPage id="timer:wv-backup.timer" />)
    await flush()
    expect(Object.keys(kpis())).toHaveLength(5)
    expect(kpis().when).toMatch(/^every day \d\d:\d\d$/)
    expect(kpis()).toMatchObject({ runs: '60', length: '6 min' })
    expect(host.querySelectorAll('button.auto-kpi')).toHaveLength(2) // last → its run, runs → the outputs
    expect(host.querySelector('.composer')).toBeNull()
    expect(host.querySelector('[aria-label="pause Backup"]')).not.toBeNull()
    render(snap([], [job]), <AutoPage id="job:render" />)
    await flush()
    // A job runs once: no next run, never « now ».
    expect(kpis()).toMatchObject({ when: 'started by hand', next: 'never' })
    expect(host.querySelector('.auto-flow .meta')!.textContent).toBe('running')
    expect(host.querySelector('.composer')).toBeNull()
    expect(host.querySelector('.auto-flow .auto-rail.run')).not.toBeNull()
  })

  it('the « when I sleep » trigger: one tap, no model; stop on wake once it is on; said in the « when » fact', async () => {
    render(snap([daily]), <AutoPage id="d" />)
    await flush()
    const row = () => [...host.querySelectorAll<HTMLButtonElement>('.auto-sleep .row')]
    expect(row().map((b) => b.querySelector('.ellipsis')!.textContent)).toEqual(['Run when I sleep · off'])
    await act(async () => row()[0].click())
    expect(calls).toContain('trigger d {"onSleep":true}')
    render(snap([{ ...daily, every: undefined, window: undefined, onSleep: true, stopOnWake: true, waiting: 'sleep' }]), <AutoPage id="d" />)
    await flush()
    expect(row().map((b) => b.querySelector('.ellipsis')!.textContent)).toEqual(['Run when I sleep · on', 'Stop when I wake up · on'])
    expect(kpis()).toMatchObject({ when: 'when I sleep, until I wake up', next: 'waits for your sleep' })
  })

  it('outputs, newest first, the newest unfolded: its report, files, links, screenshots', async () => {
    fixtures.detail.set('d', { id: 'd', runs: [...runs].reverse(), machine: 'srv' })
    fixtures.runs.set(`d@${runs[2].at}`, {
      run: runs[2],
      report: '# Fourteen sessions, two to read\n\nYesterday was calm.',
      files: [{ path: 'notes/a.md', abs: '/home/u/notes/a.md', status: 'A', add: 12, del: 3 }],
      links: ['https://example.com/pr/1'],
      images: ['shots/a.png', 'shots/b.png', 'shots/c.png', 'shots/d.png'],
    })
    render(snap([daily]), <AutoPage id="d" />)
    await flush()
    await flush()
    const lines = [...host.querySelectorAll('.page-body .row .stack-text > .ellipsis:first-child')].map((n) => n.textContent)
    // The changed files wait behind one line: a path is not the first thing to read.
    expect(lines).toEqual(['Run when I sleep · off', 'Fourteen sessions, two to read', 'everything it wrote', '1 file changed', 'example.com/pr/1', 'run 2', 'run 3'])
    expect(host.textContent).not.toContain('notes/a.md')
    await click([...host.querySelectorAll('.page-body .row')].find((r) => r.textContent?.includes('1 file changed')))
    expect(host.querySelector('.auto-report')!.textContent).toBe('Yesterday was calm.')
    expect(host.querySelectorAll('img.auto-shot')).toHaveLength(3)
    expect(host.querySelectorAll('.auto-ticks > span:not(.next)')).toHaveLength(3)
    expect(host.querySelectorAll('.auto-ticks > .bad')).toHaveLength(1)
    await click([...host.querySelectorAll('.page-body .row')].find((r) => r.textContent?.includes('notes/a.md')))
    expect(pushed).toEqual([{ kind: 'fsfile', machine: 'srv', path: '/home/u/notes/a.md' }])
  })

  it('a running task: AutoMark on the live line, one tap into its session; pause, no run-now', async () => {
    render(snap([opt({ id: 'r', title: 'Clean deps', state: 'running', startedAt: NOW - 12 * MIN, est: 45, sessionId: 's9', every: 6 * 3600_000 })]), <AutoPage id="r" />)
    await flush()
    expect(host.querySelector('.auto-flow .name')!.textContent).toBe('12 min/ 45 min')
    // A recurrence does not establish the next run's actual time.
    expect(kpis().next).toBe('not yet scheduled')
    const live = host.querySelector('.page-body .row .st .auto-mark')!.closest('button')!
    await click(live)
    expect(pushed).toEqual([{ kind: 'session', id: 's9' }])
    await click(host.querySelector('[aria-label="pause Clean deps"]'))
    expect(calls).toEqual(['pause r true'])
    expect(label(/^run "Clean deps" now/)).toBeUndefined()
  })

  it('while it runs, the page reads it again, and stops when it leaves', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      fixtures.detail.set('r', { id: 'r', runs: [], liveTokens: 1000, machine: 'srv' })
      render(snap([opt({ id: 'r', title: 'Clean deps', state: 'running', startedAt: NOW - 12 * MIN, sessionId: 's9' })]), <AutoPage id="r" />)
      await flush()
      const before = fixtures.reads
      fixtures.detail.set('r', { id: 'r', runs: [], liveTokens: 52_000, machine: 'srv' })
      await act(async () => void vi.advanceTimersByTime(20_000))
      await flush()
      expect(fixtures.reads).toBe(before + 1)
      expect(host.textContent).not.toMatch(/52K|tokens/)
      render(snap([]), <div />)
      const after = fixtures.reads
      await act(async () => void vi.advanceTimersByTime(60_000))
      expect(fixtures.reads).toBe(after)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads an async archive again when its file count arrives, even when the diff is empty', async () => {
    const run = { at: NOW, startedAt: NOW - 3 * MIN, ok: true }
    fixtures.detail.set('d', { id: 'd', runs: [run], machine: 'srv' })
    fixtures.runs.set(`d@${run.at}`, { run, files: [], links: [], images: [] })
    const done = { ...daily, state: 'done' as const, runs: [run], runCount: 1 }
    render(snap([done]), <AutoPage id="d" />)
    await flush()
    expect(host.querySelector('.auto-report')).toBeNull()
    const ready = { ...run, files: 0 }
    fixtures.detail.set('d', { id: 'd', runs: [ready], machine: 'srv' })
    fixtures.runs.set(`d@${run.at}`, { run: ready, report: 'The report is ready.', files: [], links: [], images: [] })
    render(snap([{ ...done, runs: [ready] }]), <AutoPage id="d" />)
    await flush()
    expect(host.querySelector('.auto-report')!.textContent).toContain('The report is ready.')
  })

  it('the first completed run lands in the runs strip, including when there was no history', () => {
    const frame = vi.spyOn(globalThis, 'requestAnimationFrame').mockReturnValue(1)
    try {
      render(snap([{ ...daily, state: 'running', startedAt: NOW - MIN, runs: [], runCount: 0 }]), <AutoPage id="d" />)
      expect(host.querySelector('.auto-land')).toBeNull()
      const first = { at: NOW, startedAt: NOW - MIN, ok: true }
      render(snap([{ ...daily, runs: [first], runCount: 1 }]), <AutoPage id="d" />)
      expect(host.querySelector('.auto-land')).not.toBeNull()
    } finally {
      frame.mockRestore()
    }
  })

  it('a scheduled task: pause and run now', async () => {
    render(snap([daily]), <AutoPage id="d" />)
    await click(label(/^run "Daily digest" now/))
    expect(label(/^run "Daily digest" now/)).toBeUndefined()
    await click(host.querySelector('[aria-label="pause Daily digest"]'))
    expect(calls).toEqual(['run d', 'pause d true'])
  })

  it('a run already requested stays hidden after reopening the page', () => {
    render(snap([{ ...daily, runRequested: true }]), <AutoPage id="d" />)
    expect(label(/^run "Daily digest" now/)).toBeUndefined()
    expect(label(/^pause Daily digest/)).toBeDefined()
  })

  it('a proposal: ✓ takes the version on screen then back; × refuses then back; the talk is there', async () => {
    const p = opt({ id: 'p', state: 'proposed', title: 'Harden tests', rev: 4, talk: [{ who: 'user', text: 'at night', at: NOW - MIN }, { who: 'auto', text: 'Nights it is.', at: NOW }] })
    render(snap([p]), <AutoPage id="p" />)
    expect(host.querySelector('.auto-decide')).not.toBeNull()
    // No past yet: no runs strip, no « last / runs / cost », its trigger only once (the flow band's big value).
    expect(host.querySelector('.auto-ticks')).toBeNull()
    expect(Object.keys(kpis())).toEqual(['next', 'length'])
    expect([...host.querySelectorAll('.auto-talk .msg .text')].map((n) => n.textContent)).toEqual(['at night', 'Nights it is.'])
    expect(host.querySelector('.composer')).not.toBeNull()
    await click(label(/^run "Harden tests"/))
    await flush()
    expect(calls).toEqual(['accept p rev 4'])
    expect(backs).toBe(1)
    render(snap([opt({ id: 'q', state: 'proposed', title: 'Watch' })]), <AutoPage id="q" />)
    await click(label(/^refuse "Watch"/))
    await flush()
    expect(calls).toEqual(['accept p rev 4', 'refuse q'])
    expect(backs).toBe(2)
  })

  it('a run: its report in full, its files, its session', async () => {
    fixtures.runs.set(`d@${runs[0].at}`, { run: { ...runs[0], sessionId: 's1' }, report: 'All of it.', files: [], links: [], images: [], log: undefined })
    render({ ...snap([daily]), sessions: [{ id: 's1' } as never] }, <AutoRunPage id="d" at={runs[0].at} />)
    await flush()
    expect(host.querySelector('.auto-report')!.textContent).toBe('All of it.')
    expect(host.querySelector('h1')!.textContent).toMatch(/\d\d:\d\d/)
    // Its session opens as a conversation: no terminal glyph, no token count.
    const open = [...host.querySelectorAll('.row')].at(-1)!
    expect(open.textContent).toContain('open the conversation')
    expect(host.textContent).not.toContain('>_')
    expect(host.textContent).not.toMatch(/tokens|12K/)
    await click(open)
    expect(pushed).toEqual([{ kind: 'session', id: 's1' }])
  })

  it('a run: its raw log waits behind « full log »', async () => {
    fixtures.runs.set(`d@${runs[0].at}`, { run: runs[0], report: 'Short.', files: [], links: [], images: [], log: 'npm ERR! raw line' })
    render(snap([daily]), <AutoRunPage id="d" at={runs[0].at} />)
    await flush()
    expect(host.textContent).not.toContain('npm ERR! raw line')
    await click([...host.querySelectorAll('.row')].find((r) => r.textContent?.includes('full log')))
    expect(host.querySelector('pre')!.textContent).toBe('npm ERR! raw line')
  })
})

it('a failed proposal validation stays on the page with its error until a successful retry', async () => {
  const p = opt({ id: 'retry', state: 'proposed', title: 'Retry tests', rev: 2 })
  render(snap([p]), <AutoPage id="retry" />)
  fixtures.acceptFail = true
  await click(label(/^run "Retry tests"/))
  await flush()
  expect(backs).toBe(0)
  expect(host.querySelector('.auto-decide')).not.toBeNull()
  expect(host.textContent).toContain('offline')
  fixtures.deleteFail = false
  fixtures.acceptFail = false
  await click(label(/^run "Retry tests"/))
  await flush()
  expect(backs).toBe(1)
  expect(host.querySelector('.auto-decide')).toBeNull()
})

describe('draft navigation preserves the original automation', () => {
  for (const lang of ['en', 'fr'] as const) for (const theme of ['light', 'dark', 'zen', 'graphite'] as const) {
    it(`keeps history across close/reopen and remount in ${lang}/${theme}`, async () => {
      setLang(lang)
      const draft = opt({ id: 'original-draft', state: 'proposed', draft: true, userCreated: true, title: 'Improve interaction quality', talk: [{ who: 'user', text: 'Keep this original request', at: NOW }, { who: 'auto', text: 'Which interaction?', at: NOW + 1 }] })
      const original = JSON.stringify(draft)
      render(snap([draft]), <AutoPage id={draft.id} />, theme)
      await flush()
      expect(host.querySelector('[aria-label="discard this draft"], [aria-label="abandonner ce brouillon"]')).toBeNull()
      await click(host.querySelector('button.back'))
      expect(backs).toBe(1)
      expect(calls).toEqual([])
      expect(window.confirm).not.toHaveBeenCalled()
      act(() => root.unmount())
      root = createRoot(host)
      render(snap([JSON.parse(original)]), <AutoPage id={draft.id} />, theme)
      await flush()
      expect(host.querySelector('.auto-talk')?.textContent).toContain('Keep this original request')
      expect(host.querySelector('.auto-talk')?.textContent).toContain('Which interaction?')
      expect(JSON.stringify(draft)).toBe(original)
      await click(host.querySelector('.auto-delete button'))
      expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining(draft.title))
      expect(calls).toEqual([])
      window.confirm = vi.fn(() => true)
      await click(host.querySelector('.auto-delete button'))
      expect(calls).toEqual(['delete original-draft'])
      expect(backs).toBe(2)
    })
  }
})

it('shows source restrictions without hiding the proposal or discussion, and enables ordinary approval when rights refresh', async () => {
 const p = opt({ id: 'access', state: 'proposed', title: 'Improve source', rev: 4, sourceAccess: { repo: 'source', machineId: 'm', canExecute: false, reason: 'not-writable' }, talk: [{ who: 'user', text: 'Keep this discussion', at: NOW }] })
 render(snap([p]), <AutoPage id="access" />)
 const approve = label(/^run "Improve source"/) as HTMLButtonElement
 expect(approve.disabled).toBe(true)
 await click(approve)
 expect(calls).toEqual([])
 expect(host.textContent).toContain('Read-only source')
 expect(host.textContent).toContain('Keep this discussion')
 expect(host.querySelector<HTMLInputElement>('.composer input')!.disabled).toBe(false)
 render(snap([{ ...p, sourceAccess: { ...p.sourceAccess!, canExecute: true, reason: 'owned-writable' } }]), <AutoPage id="access" />)
 expect((label(/^run "Improve source"/) as HTMLButtonElement).disabled).toBe(false)
 await click(label(/^run "Improve source"/)); await flush()
 expect(calls).toEqual(['accept access rev 4'])
})
