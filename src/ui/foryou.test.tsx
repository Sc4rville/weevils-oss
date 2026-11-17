// @vitest-environment happy-dom
// The « for you » page: each kind of item shows its essentials, what can be done from the stream calls the right route
// (accept a card, reply, more), a mail unfolds in place, a session's head opens the real conversation.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Snapshot } from '../../shared/api.ts'
import type { ForYouFeed, ForYouItem } from '../../shared/foryou.ts'

const receipts = vi.hoisted(() => ({ rows: [] as any[] }))
vi.mock('../outbox', async original => ({ ...await original<typeof import('../outbox')>(), useOutbox: () => receipts.rows }))

const srv = vi.hoisted(() => ({ feed: null as unknown, calls: [] as string[], result: {} as Record<string, unknown>, fail: '', gate: null as Promise<void> | null }))
vi.mock('../api', () => {
  const run = async (what: string) => {
    srv.calls.push(what)
    if (srv.gate && /^(act|reply) /.test(what)) await srv.gate
    if (srv.fail && what.startsWith(srv.fail)) throw new Error('refused by the server')
    return { ok: true as const, ...srv.result }
  }
  return {
    api: {
      foryou: async () => (srv.calls.push('feed'), srv.feed),
      foryouSeen: (ids: string[]) => run(`seen ${ids.join(',')}`),
      foryouDismiss: (id: string) => run(`dismiss ${id}`),
      foryouAct: (id: string, action: string, card?: string) => run(`act ${id} ${action}${card ? ` ${card}` : ''}`),
      foryouReply: (id: string, text: string) => run(`reply ${id} ${text}`),
      foryouMore: async (id: string) => (srv.calls.push(`more ${id}`), { text: 'Vite serves modules as they are asked for.' }),
    },
  }
})

const { MotionGlobalConfig } = await import('motion/react')
MotionGlobalConfig.skipAnimations = true
const { ForYouPage, ForYouItemView, MediaPage, mediaFit, waveOf } = await import('./foryou')
const { resetVoice } = await import('./foryou-voice')
const { resetForYou } = await import('./foryou-store')
const { Ctx, setSettledNow } = await import('./app-context')
const { tr, setLang } = await import('../i18n')
const { default: M } = await import('../i18n/foryou')

const NOW = Date.now()
const base = { tone: 'neutral' as const, at: NOW - 5 * 60_000 }
const ITEMS: ForYouItem[] = [
  { ...base, id: 'al', kind: 'alert', tone: 'alert', who: 'weevils', text: 'the usage window is at 92 %', open: { page: 'usage' }, live: true },
  {
    ...base,
    id: 'me',
    kind: 'media',
    tone: 'result',
    who: 'session',
    projectId: 'mygame',
    sessionId: 's9',
    title: 'the new title screen',
    text: 'the new title screen',
    reply: 'session',
    media: [
      { id: 'm1', type: 'image', url: '/api/foryou/media/m1', name: 'title.png', bytes: 1 },
      { id: 'm2', type: 'video', url: '/api/foryou/media/m2', name: 'run.mp4', bytes: 2 },
    ],
  },
  { ...base, id: 'bo', kind: 'boss', who: 'weevboss', text: 'Three sessions sent this morning, two are back.', reply: 'boss', actions: [{ id: 'go', label: 'review the two' }], open: { page: 'boss' } },
  { ...base, id: 'ma', kind: 'mail', who: 'juno', title: 'Re: invoices', text: 'sent the March invoices', body: 'Hello,\nall the March invoices went out this morning.', reply: 'mail', seen: true },
  {
    ...base,
    id: 'pr',
    kind: 'proposals',
    who: 'weevils',
    text: '',
    live: true,
    cards: [
      { id: 'c1', title: 'Harden the tests', why: 'three flaky runs this week', source: 'optimizer', kind: 'tests' },
      { id: 'c2', title: 'Watch the fairs', why: '', source: 'tip', kind: 'watch' },
      { id: 'c3', title: 'Draft the page', why: '', source: 'boss', kind: 'content' },
    ],
  },
  { ...base, id: 'se', kind: 'session', tone: 'question', who: 'session', projectId: 'mygame', sessionId: 's1', title: 'fix the login', text: 'Should I keep the old cookie?', reply: 'session', actions: [{ id: 'resume', label: 'resume' }] },
  { ...base, id: 'im', kind: 'improve', tone: 'magic', who: 'weevils', title: 'Your evenings', text: 'Most of your sessions start after 9 pm: queue them for the night.', actions: [{ id: 'do', label: 'do it' }], reply: 'boss' },
  { ...base, id: 'in', kind: 'insight', who: 'weevils', projectId: 'mygame', text: 'Vite only bundles for production.', more: true },
  { ...base, id: 'mi', kind: 'milestone', who: 'weevils', title: 'turns delivered today', text: '42 turns delivered today, up from 30 yesterday' },
  { ...base, id: 'st', kind: 'stat', who: 'weevils', title: 'this week', text: '', gauges: [{ label: 'usage', value: 71, max: 100, shown: '71 %', hot: true }, { label: 'mygame', value: 12, max: 18, shown: '12 of 18', projectId: 'mygame' }] },
]
const feed = (items: ForYouItem[], rev = 1): ForYouFeed => ({ rev, items, pulse: { working: 2, waiting: 1, delivered: 7, auto: 3 } })

/** rev null: a server without the stream (older, or a secondary machine). */
const snap = (rev: number | null = 1): Snapshot => ({
  version: rev ?? 1,
  now: NOW,
  machines: [{ id: 'm', name: 'm' }],
  projects: [{ id: 'mygame', name: 'mygame', kind: 'repo', repos: ['mygame'], where: {}, lastActivityAt: 0 }],
  sessions: [],
  h24: [],
  conversations: [],
  conversationCounts: { total: 0, pending: 0, byProject: {} },
  classifier: { running: false, queued: 0 },
  main: [],
  mainWorking: false,
  mainHasScreen: false,
  mainQueued: 0,
  devil: { enabled: false, working: false },
  pinnedRepos: [],
  config: { userName: '', exposeDomain: '', publicHost: 'app.example', authors: [{ id: 'juno', name: 'Juno', color: '#2ec4b6' }] },
  foryou: rev === null ? undefined : { rev, unseen: 3 },
})

let root: Root
let host: HTMLElement
let pushed: unknown[]

function render(node: React.ReactNode, s = snap()) {
  const ctx = {
    snap: s,
    now: NOW,
    offline: false,
    colors: { mygame: 'p4' },
    push: (p: unknown) => pushed.push(p),
    replace: () => {},
    back: () => pushed.push('back'),
    home: () => pushed.push('home'),
    expanded: null,
    setExpanded: () => {},
    h24Open: false,
    setH24Open: (_open: boolean, id?: string) => pushed.push({ kind: 'auto', id }),
    theme: 'light' as const,
    setTheme: () => {},
    refresh: () => {},
    logout: () => {},
  }
  act(() => root.render(<Ctx.Provider value={ctx}>{node}</Ctx.Provider>))
}

const flush = () => act(() => new Promise((r) => setTimeout(r, 30)))
const click = (el: Element | null | undefined) => act(async () => void (el as HTMLElement).click())
const band = (id: string) => host.querySelector<HTMLElement>(`[data-fy="${id}"]`)!
const labelled = (label: string, within: ParentNode = host) => [...within.querySelectorAll('[aria-label]')].find((e) => e.getAttribute('aria-label') === label)
const t = () => tr(M)

async function open(items = ITEMS, who?: string) {
  srv.feed = feed(items)
  render(<ForYouPage who={who} />)
  await flush()
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  sessionStorage.clear()
  receipts.rows = []
  srv.gate = null
  resetForYou()
  resetVoice()
  setSettledNow(true)
  srv.calls.length = 0
  srv.fail = ''
  srv.result = {}
  pushed = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

it.each(['', 'https://app.example'])('opens a result page directly from local or public links: %s', async (origin) => {
  const item: ForYouItem = { ...base, id: 'page-result', kind: 'boss', who: 'session', text: 'The report is ready to review.', body: `Read [Requests and goals](${origin}/p/report/requests).`, open: { page: 'boss' } }
  await open([item])
  const link = band(item.id).querySelector('a.living')!
  expect(link.textContent).toBe('Requests and goals')
  expect(link.closest('button')).toBeNull()
  await click(link)
  expect(pushed.at(-1)).toEqual({ kind: 'webpage', path: '/p/report/requests', title: 'Requests and goals', pageKind: 'report' })
  expect(srv.calls.some((c) => c.startsWith('act ') || c.startsWith('reply '))).toBe(false)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('for you page', () => {

  it('an empty stream is one quiet line', async () => {
    await open([])
    expect(host.querySelectorAll('[data-fy]')).toHaveLength(0)
    expect(host.querySelector('.fy-end')!.textContent).toBe(t().empty)
  })

  it('newcomers that arrived under the finger wait behind « n new »; a tap brings them in', async () => {
    await open(ITEMS.slice(2, 4))
    setSettledNow(false)
    srv.feed = feed([ITEMS[0], ...ITEMS.slice(2, 4)], 2)
    render(<ForYouPage />, snap(2))
    await flush()
    expect([...host.querySelectorAll('[data-fy]')].map((e) => e.getAttribute('data-fy'))).toEqual(['bo', 'ma'])
    const strip = host.querySelector<HTMLElement>('.fy-fresh')!
    expect(strip.textContent).toContain(t().fresh(1))
    await click(strip)
    await flush()
    expect([...host.querySelectorAll('[data-fy]')].map((e) => e.getAttribute('data-fy'))).toEqual(['al', 'bo', 'ma'])
    expect(host.querySelector('.fy-fresh')).toBeNull()
  })

  it('without a stream on the server: an empty page, and no call', async () => {
    render(<ForYouPage />, snap(null))
    await flush()
    expect(srv.calls).toEqual([])
    expect(host.querySelector('.page')).toBeTruthy()
    expect(host.querySelectorAll('[data-fy]')).toHaveLength(0)
  })
})

describe('for you: voice bars', () => {
  it('the bars of an item are always the same, between a quarter and full height', () => {
    expect(waveOf('b:1', 26)).toEqual(waveOf('b:1', 26))
    expect(waveOf('b:1', 26)).not.toEqual(waveOf('b:2', 26))
    for (const h of waveOf('b:1', 26)) expect(h >= 0.25 && h <= 1).toBe(true)
  })
})

describe('for you: figures, the line, media fit', () => {

  it('no status readout above the stream: it is content, not a control panel', async () => {
    await open()
    expect(host.querySelector('.fy-pulse')).toBeNull()
  })

  it('a media is never cut by more than a little: beyond, it is shown whole', () => {
    // One media alone on a phone (390 wide, cap 523): landscape and near-square fill, a portrait clip is shown whole.
    expect(mediaFit(1280, 720, 390, 523, false)).toBe('cover')
    expect(mediaFit(1170, 1560, 390, 523, false)).toBe('cover')
    expect(mediaFit(1000, 1480, 390, 523, false)).toBe('cover') // 577 high: 9 % over the cap
    expect(mediaFit(720, 1280, 390, 523, false)).toBe('contain')
    // Wide screen, in the 760 column (cap 496): the portrait clip would lose two thirds.
    expect(mediaFit(720, 1280, 760, 496, false)).toBe('contain')
    expect(mediaFit(1280, 720, 760, 496, false)).toBe('cover')
    // Several side by side: the box is fixed, so both ways count.
    expect(mediaFit(1280, 720, 335, 374, true)).toBe('contain')
    expect(mediaFit(1000, 1100, 335, 374, true)).toBe('cover')
    // Not known yet.
    expect(mediaFit(0, 0, 390, 523, false)).toBe('cover')
  })
})

describe('for you: strips and the media viewer', () => {

  it('the viewer shows the image whole, or the video with its controls, and goes back', async () => {
    render(<MediaPage url="/api/foryou/media/m1" type="image" name="title.png" />)
    expect(host.querySelector('.fy-stage img')!.getAttribute('src')).toBe('/api/foryou/media/m1')
    expect(host.querySelector('.fy-stage img')!.getAttribute('alt')).toBe('title.png')
    // The raw file name is not printed in the header (it stays the dialog's accessible name).
    expect(host.querySelector('.fy-viewer-top')!.textContent).not.toContain('title.png')
    await click(labelled(t().back))
    expect(pushed).toEqual(['back'])
    render(<MediaPage url="/api/foryou/media/m2" type="video" name="run.mp4" />)
    const video = host.querySelector<HTMLVideoElement>('.fy-stage video')!
    expect(video.controls).toBe(true)
    expect(video.getAttribute('src')).toBe('/api/foryou/media/m2')
  })

  it('in the viewer, a long press on the photo opens the share sheet with the original file', async () => {
    const nav = navigator as unknown as Record<string, unknown>
    const files: File[] = []
    nav.share = vi.fn(async (d: { files: File[] }) => void files.push(...d.files))
    nav.canShare = vi.fn(() => true)
    const realFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })) as typeof fetch
    vi.useFakeTimers()
    try {
      render(<MediaPage url="/api/foryou/media/m77" type="image" name="title.png" />)
      const img = host.querySelector<HTMLImageElement>('.fy-stage img')!
      await act(async () => { img.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: 5, clientY: 5 })) })
      await act(async () => { vi.advanceTimersByTime(600) })
      await act(async () => { img.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' })) })
      await act(async () => { await vi.runAllTimersAsync() })
      expect(files).toHaveLength(1)
      expect(files[0]).toMatchObject({ name: 'title.png', type: 'image/png', size: 3 })
    } finally {
      vi.useRealTimers()
      globalThis.fetch = realFetch
      delete nav.share
      delete nav.canShare
    }
  })
})

it('keeps authored panel text accessible when every source image is missing',async()=>{
 setLang('en')
 await open([{...ITEMS.find(i=>i.id==='me')!,media:[],composition:{layout:'split',panels:[{mediaId:'gone',title:'Earlier view',text:'The original context remains available.'}]}}])
 expect(band('me').textContent).toContain('The original context remains available.')
 expect(band('me').querySelector('[role="status"]')?.textContent).toContain('did not load')
 expect(band('me').querySelector('img')).toBeNull()
})

it('uses the static recursive signature only for structured identity, including compact history', () => {
 const item:ForYouItem={...ITEMS.find(i=>i.id==='bo')!,seen:true,workstream:{kind:'self-improvement',installationId:'here',target:{machineId:'vps',projectId:'weevils',repo:'weevils'},evidence:'repository-identity'}}
 for(const compact of [false,true]) {
  render(<ForYouItemView item={item} compact={compact}/> )
  expect(band(item.id).classList.contains('recursive-identity')).toBe(true)
  expect(band(item.id).className).not.toMatch(/recursive-working|is-working|fy-drift/)
  expect(band(item.id).getAttribute('data-fy')).toBe(item.id)
  render(<ForYouItemView item={{...item,workstream:undefined,text:'weevils improves itself',projectId:'weevils'}} compact={compact}/> )
  expect(band(item.id).classList.contains('recursive-identity')).toBe(false)
 }
 expect(srv.calls.some(c=>/^(act|reply|dismiss) /.test(c))).toBe(false)
})

describe('for you: one stream, five layouts, no labels', () => {
  it('one single stream titled only « For you »: no chips, no headers, no speaker or kind words', async () => {
    setLang('en')
    await open()
    expect(host.querySelector('.fy-people')).toBeNull()
    expect([...host.querySelectorAll('.fy-words .word')].map((w) => w.textContent)).toEqual(['For you'])
    const body = host.querySelector('[data-scroll]')!
    expect(body.querySelector('.fy-who, .fy-dot, .fy-plus, .fy-bang, .fy-btn, .fy-gauges, .fy-reply, details')).toBeNull()
    const text = body.textContent!
    for (const word of ['Action', 'Progress', 'Learn', 'Think', 'Visual', 'Built', 'From your agents', 'weevboss', 'Juno', 'mygame', 'proposals', 'insight']) expect(text).not.toContain(word)
  })

  it('every item takes one of the five layouts; stats without a moved number stay out', async () => {
    await open()
    const formats = Object.fromEntries([...host.querySelectorAll('[data-fy]')].map((e) => [e.getAttribute('data-fy'), e.getAttribute('data-fy-format')]))
    expect(formats).toEqual({ al: 'action', me: 'visual', bo: 'action', ma: 'action', pr: 'action', se: 'action', im: 'action', in: 'learn', mi: 'progress' })
    expect(band('mi').querySelector('.fy-num')!.textContent).toBe('42')
  })

  it('a proposal is one big tap: yes accepts the card, not now refuses it', async () => {
    setLang('en')
    await open([ITEMS.find((i) => i.id === 'pr')!])
    expect(band('pr').querySelector('.fy-say')!.textContent).toBe('Harden the tests')
    const [yes, no] = band('pr').querySelectorAll<HTMLButtonElement>('.fy-tap')
    expect(yes.textContent).toBe(t().tapYes)
    expect(no.textContent).toBe(t().tapNotNow)
    await click(yes)
    expect(srv.calls).toContain('act pr accept c1')
    resetForYou()
    await open([ITEMS.find((i) => i.id === 'pr')!])
    await click(band('pr').querySelectorAll('.fy-tap')[1])
    expect(srv.calls).toContain('act pr refuse c1')
  })

  it('the user’s own idea reads as theirs, never as weevils’', async () => {
    setLang('en')
    const pr = ITEMS.find((i) => i.id === 'pr')!
    await open([{ ...pr, cards: [{ ...pr.cards![0], own: true }] }])
    expect(band('pr').querySelector('.fy-say')!.textContent).toBe(t().yourIdea('Harden the tests'))
  })

  it('an alert is calm: a look, never the alert colour or an inverted band', async () => {
    setLang('en')
    await open([ITEMS[0]])
    expect(band('al').className).not.toMatch(/invert|fy-t-alert/)
    expect(band('al').getAttribute('style')).not.toContain('--alert')
    await click(band('al').querySelector('.fy-tap'))
    expect(pushed.length + srv.calls.length).toBeGreaterThan(0)
  })

  it('long words are cut to a line or two', async () => {
    const long = { ...ITEMS.find((i) => i.id === 'in')!, text: 'Vite only bundles for production and ' + 'serves each module on demand during development '.repeat(8) }
    await open([long])
    const line = band('in').querySelector('.fy-learn')!.textContent!
    expect(line.length).toBeLessThanOrEqual(120)
    expect(line.endsWith('…')).toBe(false)
  })

  it('the page renders at most 60 items', async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ ...base, id: `t${i}`, kind: 'boss' as const, who: 'weevboss', text: `Thought number ${i} worth a second look today.`, actions: [{ id: 'go', label: 'Go' }] }))
    await open(many)
    expect(host.querySelectorAll('[data-fy]').length).toBe(60)
  })
})
