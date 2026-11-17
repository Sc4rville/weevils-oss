// @vitest-environment happy-dom
// The « auto » drawer: one band per automation (a tap opens its page), proposals as bands at the top (✓ takes the
// version on screen, × refuses), a one-line head, nothing of the old machine line.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { H24Activity, Optimizer, Snapshot } from '../../shared/api.ts'

const calls = vi.hoisted(() => [] as string[])
/** The pending answer of a talk turn: the test releases it. */
const talk = vi.hoisted(() => ({ release: null as null | ((r: unknown) => void) }))
const ApiError = vi.hoisted(
  () =>
    class ApiError extends Error {
      status: number
      constructor(status: number, message: string) {
        super(message)
        this.status = status
      }
    },
)
vi.mock('../api', () => ({
  ApiError,
  api: {
    deleteAutomation: async (id: string) => { calls.push(`delete ${id}`); return {ok:true,running:false} },
    createOptimizer: async () => {
      calls.push('create')
      return { item: { id: 'new-one', title: 'new automation', state: 'proposed', draft: true, talk: [] } }
    },
    acceptOptimizer: async (id: string, rev?: number) => {
      calls.push(rev === undefined ? `accept ${id}` : `accept ${id} rev ${rev}`)
      // Rewritten from another screen since this one drew it.
      if (id === 'old') throw new ApiError(409, 'conflict')
    },
    talkOptimizer: (id: string, text: string) => {
      calls.push(`talk ${id} ${text}`)
      return new Promise((r) => (talk.release = r))
    },
    refuseOptimizer: async (id: string) => void calls.push(`refuse ${id}`),
    toggleH24: async (id: string) => void calls.push(`toggle ${id}`),
  },
}))

const { MotionGlobalConfig } = await import('motion/react')
MotionGlobalConfig.skipAnimations = true
const { H24Rail, KIND_ICON } = await import('./h24')
const { Ctx } = await import('./app-context')

const NOW = Date.now()
/** A proposal (recurring by default: one-shot ones go to « for you », not the automated page). */
const opt = (o: Partial<Optimizer>): Optimizer => ({ id: 'o', title: 't', why: '', repo: null, kind: 'tests', heavy: false, state: 'proposed', createdAt: NOW, ...(o.state && o.state !== 'proposed' ? {} : { every: 86_400_000 }), ...o })
/** An accepted task. */
const task = (o: Partial<Optimizer>): Optimizer => opt({ state: 'queued', ...o })

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
  autoMachine: { load: 0.4, cpus: 4, freeGb: 6, wait: null },
  config: { userName: '', exposeDomain: '', publicHost: '' },
})

let root: Root
let host: HTMLElement
let pushed: unknown[]
let drawer: boolean[]

function render(s: Snapshot, open = true) {
  const ctx = {
    snap: s,
    now: NOW,
    offline: false,
    colors: { mygame: 'p3' },
    push: (p: unknown) => pushed.push(p),
    replace: () => {},
    back: () => {},
    home: () => {},
    expanded: null,
    setExpanded: () => {},
    h24Open: open,
    setH24Open: (v: boolean) => drawer.push(v),
    theme: 'light' as const,
    setTheme: () => {},
    refresh: () => {},
    logout: () => {},
  }
  act(() =>
    root.render(
      <Ctx.Provider value={ctx}>
        <H24Rail />
      </Ctx.Provider>,
    ),
  )
}

const flush = () => act(() => new Promise((r) => setTimeout(r, 30)))
const click = (el: Element | null) => act(async () => void (el as HTMLElement).click())
const label = (re: RegExp) => [...host.querySelectorAll('[aria-label]')].find((e) => re.test(e.getAttribute('aria-label')!))

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  localStorage.setItem('weevils-lang', 'en')
  calls.length = 0
  pushed = []
  drawer = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('auto drawer', () => {
  const running = (o: Partial<Optimizer> = {}) => opt({ id: 'r', state: 'running', title: 'Profile loader', repo: 'mygame', startedAt: NOW - 5 * 60_000, sessionId: 's1', ...o })
  const timer: H24Activity = { id: 'timer:wv-sync.timer', title: 'sync', kind: 'timer', projectId: null, schedule: '', enabled: true, runState: 'waiting', runStartedAt: null, lastEvent: '', canToggle: true, nextRunAt: NOW + 14 * 60_000, everyMs: 6 * 3600_000 }
  const head = () => host.querySelector('.h24-head')!
  const names = () => [...host.querySelectorAll('.auto-band .auto-name')].map((n) => n.textContent)

  it('no delete button on the drawer bands: one tap opens the page, where « delete » lives', async () => {
    const data = snap([task({ id: 'a', title: 'First' }), opt({ id: 'p', title: 'Proposed' })], [timer])
    render(data)
    expect(host.querySelector('.auto-delete')).toBeNull()
    expect(label(/Delete automation/)).toBeUndefined()
    await click(host.querySelector('[data-h24="a"] .auto-hit'))
    expect(pushed).toEqual([{ kind: 'auto', id: 'a' }])
  })

  it('a proposal of tests never wears the terminal glyph', () => {
    render(snap([opt({ id: 't', kind: 'tests', title: 'Run the tests' })]))
    expect(KIND_ICON.tests).not.toBe('terminal')
    expect(host.querySelector('[data-h24="t"] .st svg path')?.getAttribute('d')).not.toBe('M4 7l5 5-5 5M12 18h8')
  })

  it('collapsed automations keeps title/activity only, with language in settings and creation inside the hidden body', async () => {
    render(snap([opt({ id: 'draft', draft: true, title: 'new automation' })]), false)
    expect(head().querySelector('.h24-title')?.textContent).toBe('automations')
    expect(head().querySelector('.h24-activity, .auto-sum')).toBeNull() // no caption, no square marker
    expect(host.querySelector('.h24-top .h24-create')).toBeNull()
    expect(host.querySelector('.h24-top .h24-heading .h2')).toBeNull()
    expect(host.querySelector('#h24-body')?.hasAttribute('hidden')).toBe(true)
    expect(host.querySelector('#h24-body')?.hasAttribute('inert')).toBe(true)
    expect(host.querySelector('.h24-top .language-trigger')).toBeNull()
    expect(host.querySelector('#h24-body .h24-create')).not.toBeNull()
    await click(head())
    expect(drawer).toEqual([true])
    render(snap([]), true)
    expect(host.querySelector('#h24-body')?.hasAttribute('hidden')).toBe(false)
    expect(host.querySelector('#h24-body')?.hasAttribute('inert')).toBe(false)
  })

  it('the + opens a fresh creation conversation directly, without a form or a model round', async () => {
    render(snap([]))
    const plus = label(/^create an automation$/)!
    expect(plus.closest('[inert]')).toBeNull()
    expect(plus.querySelector('svg')).not.toBeNull()
    await click(plus)
    await flush()
    expect(calls).toEqual(['create'])
    expect(pushed).toEqual([{ kind: 'auto', id: 'new-one' }])
  })

  it('the real automations come first: an unfinished « new automation » sits under them, recurring proposals last', () => {
    render(snap([
      opt({ id: 'p', title: 'Weekly cleanup' }),
      opt({ id: 'draft', title: 'new automation', draft: true, userCreated: true, talk: [{ who: 'auto', text: 'What do you want to automate?', at: NOW }] }),
      task({ id: 'n', title: 'Night lens', every: 86_400_000 }),
      running(),
    ]))
    expect(names()).toEqual(['Profile loader', 'Night lens', 'new automation', 'Weekly cleanup'])
    expect(host.querySelector('[data-h24="p"]')!.classList.contains('auto-prop')).toBe(true)
    expect(host.querySelector('[data-h24="n"]')!.classList.contains('auto-prop')).toBe(false)
  })

  it('keeps personal proposals visible even when three automatic suggestions already wait', () => {
    render(snap([...['a', 'b', 'c'].map((id) => opt({ id, title: id })), opt({ id: 'personal', title: 'My own idea', userCreated: true })]))
    expect(names()).toEqual(['My own idea', 'a', 'b', 'c'])
  })

  it('an unfinished conversation stays available without a validation button', () => {
    render(snap([opt({ id: 'draft', title: 'new automation', draft: true, talk: [{ who: 'auto', text: 'What do you want to automate?', at: NOW }] })]))
    expect(host.querySelector('[data-h24="draft"]')!.textContent).not.toContain('draft — continue the conversation')
    expect(host.querySelector('[data-h24="draft"] .chars')).toBeNull()
    expect(head().getAttribute('aria-label')).not.toContain('to approve')
  })

  it('the head says what runs (AutoMark, its title, +N), else the next trigger, else what waits for a yes', () => {
    render(snap([running(), running({ id: 'r2', title: 'A second one' }), opt({ id: 'p' })]))
    expect(head().getAttribute('aria-label')).toContain(`${names()[0]} +1`)
    render(snap([opt({ id: 'p' }), opt({ id: 'p2' })]))
    expect(head().getAttribute('aria-label')).toContain('2 to approve')
    render(snap([], [timer]))
    expect(head().getAttribute('aria-label')).toMatch(/next \d\d:\d\d/)
    render(snap([]))
    expect(head().querySelector('.auto-sum')).toBeNull()
    expect(host.querySelector('.empty')!.textContent).toBe('nothing')
  })

  it('no machine line, no tag, no column', () => {
    render(snap([running(), task({ id: 'q', waiting: 'load' }), opt({ id: 'p' })], [timer]))
    for (const sel of ['.auto-machine', '.auto-tag', '.auto-props', '.auto-prop-strip', '.auto-gauge', '.auto-cat', '.auto-grp']) expect(host.querySelector(sel), sel).toBeNull()
    // Why it waits: a plain word in its meta line.
    expect(host.querySelector('[data-h24="q"] .auto-hit')!.getAttribute('aria-label')).toContain('machine busy')
  })

  it('one band per automation, running first, AutoMark on the running one; a tap opens its page, the drawer stays', async () => {
    render(snap([task({ id: 'q', waiting: 'time', startAt: NOW + 3600_000, every: 86_400_000, title: 'Nightly' }), running()], [timer]))
    expect(names()).toEqual(['Profile loader', 'sync', 'Nightly'])
    expect(host.querySelector('[data-h24="r"] .st .auto-mark')).not.toBeNull()
    expect(host.querySelector('[data-h24="q"] .st .auto-mark')).toBeNull()
    expect(host.querySelector('[data-h24="r"] .act')!.textContent).toBe('running 5m')
    // Its rail runs along the bottom edge, magenta; nothing crosses the name.
    expect(host.querySelector('[data-h24="r"] .auto-rail.run')).not.toBeNull()
    await click(host.querySelector('[data-h24="q"] .auto-hit'))
    expect(pushed).toEqual([{ kind: 'auto', id: 'q' }])
    expect(drawer).toEqual([])
    // Every band is one button.
    for (const b of host.querySelectorAll('.auto-band:not(.auto-round)')) expect(b.querySelector('.auto-hit')).not.toBeNull()
  })

  it('proposals are smaller bands under the automations: ✓ sends the version on screen (rev), × refuses, the band folds away; a tap elsewhere opens its page', async () => {
    let clock = 10_000
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock)
    render(snap([running(), opt({ id: 'a', title: 'Harden tests', why: 'ship it', rev: 3, window: { from: 60, to: 360 }, every: 7 * 86_400_000 }), opt({ id: 'b', title: 'Watch fairs', kind: 'watch' })]))
    expect(names()).toEqual(['Profile loader', 'Harden tests', 'Watch fairs'])
    expect(host.querySelector('[data-h24="a"] .why')!.textContent).toBe('ship it')
    expect(host.querySelector('[data-h24="a"] .meta.terms')!.textContent).toBe('every 7 days, at night')
    await click(host.querySelector('[data-h24="b"] .auto-hit'))
    expect(pushed).toEqual([{ kind: 'auto', id: 'b' }])
    await click(label(/^run "Harden tests"/)!)
    await click(label(/^refuse "Watch fairs"/)!)
    await flush()
    expect(calls).toEqual(['accept a rev 3', 'refuse b'])
    // Accepted: the same band, now among the automations; refused: gone.
    expect(names()).toEqual(['Profile loader', 'Harden tests'])
    expect(host.querySelector('[data-h24="a"] .chars')).toBeNull()
    now.mockRestore()
  })

  it('one-shot proposals are not in automated (they go to « for you »)', () => {
    render(snap([opt({ id: 'once', title: 'Draft a menu', every: undefined }), opt({ id: 'daily', title: 'Daily check' })]))
    expect(names()).toEqual(['Daily check'])
  })

  it('the kind glyph of a proposal is never ✓ nor ×', () => {
    render(snap([opt({ id: 'a', title: 'Harden tests' })]))
    const d = (sel: string) => host.querySelector(`${sel} path:last-child`)!.getAttribute('d')
    expect(d('[data-h24="a"] .st')).not.toBe(d('[data-h24="a"] .ch:first-child'))
    expect(d('[data-h24="a"] .st')).not.toBe(d('[data-h24="a"] .ch:last-child'))
  })

  it('while a round runs, a band with the cycle and the breathing squares sits after the automations and their proposals', () => {
    render({ ...snap([opt({ id: 'a' }), running()]), autoRound: { busy: true } })
    const bands = [...host.querySelectorAll('.h24-body > .band')]
    expect(bands.map((b) => b.getAttribute('data-h24') ?? (b.classList.contains('auto-round') ? 'round' : '?'))).toEqual(['r', 'a', 'round'])
    expect(bands[2].querySelector('.dots')).not.toBeNull()
    expect(bands[2].textContent).toBe('')
  })

  it('finished ones fold behind one line', async () => {
    render(snap([running(), opt({ id: 'd', state: 'done', endedAt: NOW - 3600_000, title: 'Old one' })]))
    expect(names()).toEqual(['Profile loader'])
    await click(label(/^1 finished$/)!)
    await flush()
    expect(names()).toEqual(['Profile loader', 'Old one'])
  })

  it('a paused one wears the pause glyph; a failed last run the ×, in the alert colour', () => {
    render(snap([task({ id: 'z', paused: true, waiting: 'paused', title: 'Z' }), task({ id: 'f', waiting: 'time', startAt: NOW + 3600_000, every: 86_400_000, runs: [{ at: NOW - 3600_000, startedAt: NOW - 3700_000, ok: false }], title: 'F' })]))
    expect(host.querySelector('[data-h24="z"]')!.classList.contains('paused')).toBe(true)
    expect(host.querySelector('[data-h24="f"] .st .alert')).not.toBeNull()
    expect(host.querySelector('[data-h24="f"] .auto-hit')!.getAttribute('aria-label')).toContain('failed 1h ago')
  })

  it('clears the old fold memory', () => {
    localStorage.setItem('weevils-auto-folds', '{}')
    render(snap([]))
    expect(localStorage.getItem('weevils-auto-folds')).toBeNull()
  })
})

it('labels quota retry eligibility instead of presenting it as a requested schedule',async()=>{
 const item=task({id:'retry',title:'Daily review',every:86_400_000,waiting:'later',retryAt:NOW+3600_000,startAt:NOW+3600_000})
 render(snap([item]))
 expect(host.querySelector('[data-h24="retry"] .act')?.textContent).toBe('waiting to retry')
 expect(host.querySelector('[data-h24="retry"] .act')?.textContent).not.toMatch(/\d\d:\d\d/)
 expect(host.querySelector('[data-h24="retry"] .auto-hit')?.getAttribute('aria-label')).toContain('every day')
 expect(item.window).toBeUndefined();expect(item.notBefore).toBeUndefined()
})

it('does not promote a legacy draft from an English ready claim in its discussion',()=>{
 const draft=opt({id:'original',draft:true,userCreated:true,title:'Improve interaction quality',talk:[{who:'user',text:'Améliore les interactions',at:NOW},{who:'auto',text:'Everything is ready for you to approve.',at:NOW+1}]})
 const original=JSON.stringify(draft)
 render(snap([draft]))
 const card=host.querySelector('[data-h24="original"]')!
 expect(card.textContent).not.toContain('Everything is ready')
 expect(card.querySelector('.chars')).toBeNull()
 expect(JSON.stringify(draft)).toBe(original)
 expect(calls).toEqual([])
})
