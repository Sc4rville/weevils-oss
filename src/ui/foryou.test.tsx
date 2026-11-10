// @vitest-environment happy-dom
// The « for you » page: each kind of item shows its essentials, what can be done from the stream calls the right route
// (accept a card, reply, more), a mail unfolds in place, a session's head opens the real conversation.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Snapshot } from '../../shared/api.ts'
import type { ForYouFeed, ForYouItem } from '../../shared/foryou.ts'

const srv = vi.hoisted(() => ({ feed: null as unknown, calls: [] as string[], fail: '', gate: null as Promise<void> | null }))
vi.mock('../api', () => {
  const run = async (what: string) => {
    srv.calls.push(what)
    if (srv.gate && /^(act|reply) /.test(what)) await srv.gate
    if (srv.fail && what.startsWith(srv.fail)) throw new Error('refused by the server')
    return { ok: true as const }
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
const { resetVoice, toggleVoice, LOGO_SAYS, ITEM_SAYS } = await import('./foryou-voice')
const { resetForYou } = await import('./foryou-store')
const { Ctx, setSettledNow } = await import('./app-context')
const { FOCUS_BOSS } = await import('./follow')
const { tr } = await import('../i18n')
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
  { ...base, id: 'mi', kind: 'milestone', who: 'weevils', title: 'turns delivered today', text: '42' },
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
  config: { userName: '', exposeDomain: '', publicHost: '', authors: [{ id: 'juno', name: 'Juno', color: '#2ec4b6' }] },
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

const type = async (form: HTMLFormElement, text: string) => {
  const field = form.querySelector<HTMLInputElement>('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!.call(field, text)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const submit = (form: HTMLFormElement) => act(async () => void form.requestSubmit())

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  sessionStorage.clear()
  srv.gate = null
  resetForYou()
  resetVoice()
  setSettledNow(true)
  srv.calls.length = 0
  srv.fail = ''
  pushed = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('for you page', () => {
  it('shows the two words, the line, every item in the server order, then « up to date »', async () => {
    await open()
    expect(host.querySelector('.page[role=dialog]')).toBeTruthy()
    expect(host.querySelector('[data-scroll]')).toBeTruthy()
    expect([...host.querySelectorAll('.fy-words .word')].map((w) => w.textContent)).toEqual(['weevboss', t().title])
    expect(host.querySelector('.fy-words .word.on')!.textContent).toBe(t().title)
    expect([...host.querySelectorAll('[data-fy]')].map((e) => e.getAttribute('data-fy'))).toEqual(ITEMS.map((i) => i.id))
    const pulse = host.querySelector('.fy-pulse')!
    expect(pulse.querySelectorAll('.spin.fluo')).toHaveLength(2)
    expect(pulse.textContent).toContain(t().pulseWorking(2))
    expect(pulse.textContent).toContain(t().pulseDelivered(7))
    expect(pulse.textContent).toContain(t().pulseWaiting(1))
    expect(pulse.textContent).toContain(t().pulseAuto(3))
    expect(host.querySelector('.fy-end')!.textContent).toContain(t().upToDate)
    // The plan's category names are internal: never on screen.
    for (const word of ['proposals', 'insight', 'milestone', 'improve']) expect(host.querySelector('[data-scroll]')!.textContent).not.toContain(word)
  })

  it('each kind shows its essentials', async () => {
    await open()
    // media: the image and the video edge to edge, the video muted, inline, waiting to be in view.
    const media = band('me')
    expect(media.querySelector('img')!.getAttribute('src')).toBe('/api/foryou/media/m1')
    const video = media.querySelector('video')!
    expect(video.getAttribute('src')).toBe('/api/foryou/media/m2')
    expect(video.hasAttribute('playsinline')).toBe(true)
    expect(video.loop).toBe(true)
    expect(video.getAttribute('preload')).toBe('metadata')
    expect(media.querySelector('.fy-media-strip.many')).toBeTruthy()
    expect(media.querySelector('.fy-cap.tone')!.textContent).toContain('the new title screen')
    expect(media.querySelector('.fy-cap')!.compareDocumentPosition(media.querySelector('.fy-media-strip')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(media.querySelector('.fy-media-open')!.textContent).toBe(t().fullImage)
    // weevboss: its words, its button, a reply line.
    expect(band('bo').textContent).toContain('Three sessions sent this morning')
    expect(band('bo').querySelector('.fy-btn')!.textContent).toBe('review the two')
    expect(band('bo').querySelector('form.fy-reply')).toBeTruthy()
    // mail: one thin line, author and summary; the body stays folded.
    expect(band('ma').querySelector('.fy-mail')!.textContent).toBe('Junosent the March invoices')
    expect(band('ma').textContent).not.toContain('all the March invoices went out')
    // proposals: « + » leads each title, each card has its ✓ × pair and its own colour.
    const cards = [...band('pr').querySelectorAll<HTMLElement>('.fy-card')]
    expect(cards.map((c) => c.querySelector('.fy-card-t')!.textContent)).toEqual(['Harden the tests', 'Watch the fairs', 'Draft the page'])
    for (const c of cards) {
      expect(c.querySelector('.fy-card-t .fy-plus svg')).toBeTruthy()
      expect(c.querySelector('.fy-ok')).toBeTruthy()
      expect(c.querySelector('.fy-no')).toBeTruthy()
    }
    expect(new Set(cards.map((c) => c.style.getPropertyValue('--c'))).size).toBe(3)
    // session: project · title, what it asks, in the waiting amber, its button and a reply line.
    expect(band('se').querySelector('.fy-head')!.textContent).toBe('mygame · fix the login')
    expect(band('se').textContent).toContain('Should I keep the old cookie?')
    expect(band('se').textContent).toContain(t().toneQuestion)
    expect(band('se').style.getPropertyValue('--c')).toBe('var(--h24)')
    expect(band('se').querySelector('.fy-btn')!.textContent).toBe('resume')
    // improve: the gradient band, « do it », reply, dismiss.
    expect(band('im').classList.contains('fy-k-improve')).toBe(true)
    expect(band('im').querySelector('.fy-btn')!.textContent).toBe('do it')
    expect(band('im').querySelector('form.fy-reply')).toBeTruthy()
    expect(band('im').querySelector('.notice-close')).toBeNull()
    for (const item of ITEMS) expect(!!band(item.id).querySelector('.notice-close')).toBe(item.kind === 'alert' && !!item.live)
    // alert: one sober inverted line that opens where it is solved.
    expect(band('al').classList.contains('invert')).toBe(true)
    expect(band('al').querySelector('.fy-alert')!.textContent).toBe('the usage window is at 92 %')
    // insight: big type in the project's colour, « more » still folded.
    expect(band('in').querySelector('.fy-big')!.textContent).toBe('Vite only bundles for production.')
    expect(band('in').style.getPropertyValue('--c')).toBe('var(--p4)')
    expect(band('in').querySelector('.fy-more-btn')!.textContent).toBe(t().more)
    // milestone: the number in shifting type.
    expect(band('mi').querySelector('.fy-shift')!.textContent).toBe('42')
    // figures as bars.
    const meters = [...band('st').querySelectorAll('[role=meter]')]
    expect(meters.map((m) => m.getAttribute('aria-valuetext'))).toEqual(['71 %', '12 of 18'])
    expect(meters[0].classList.contains('hot')).toBe(true)
  })

  it('unseen items carry the dot and the heavier type; seen ones do not', async () => {
    await open()
    expect(band('bo').classList.contains('fy-unseen')).toBe(true)
    expect(labelled(t().unseen, band('bo'))).toBeTruthy()
    expect(band('ma').classList.contains('fy-unseen')).toBe(false)
  })

  it('✓ on a card calls the act route with the card, and the card leaves; × refuses', async () => {
    await open()
    await click(labelled(t().accept('Harden the tests')))
    await flush()
    expect(srv.calls).toContain('act pr accept c1')
    expect([...band('pr').querySelectorAll('.fy-card-t')].map((c) => c.textContent)).toEqual(['Watch the fairs', 'Draft the page'])
    await click(labelled(t().refuse('Watch the fairs')))
    await flush()
    expect(srv.calls).toContain('act pr refuse c2')
    // One left: a wide band, still « + » and the pair.
    const last = band('pr').querySelectorAll('.fy-card')
    expect(last).toHaveLength(1)
    expect(last[0].classList.contains('wide')).toBe(true)
    await click(labelled(t().accept('Draft the page')))
    await flush()
    expect(host.querySelector('[data-fy="pr"]')).toBeNull()
  })

  it('a refused action brings the item back and says why', async () => {
    await open()
    srv.fail = 'act'
    await click(band('im').querySelector('.fy-btn'))
    await flush()
    expect(srv.calls).toContain('act im do')
    expect(band('im').querySelector('[role=alert]')!.textContent).toContain('refused by the server')
  })

  it('an action button makes its item leave; dismiss too', async () => {
    await open()
    await click(band('bo').querySelector('.fy-btn'))
    await flush()
    expect(srv.calls).toContain('act bo go')
    expect(host.querySelector('[data-fy="bo"]')).toBeNull()
    expect(band('im').querySelector('.notice-close')).toBeNull()
    await click(band('al').querySelector('.notice-close'))
    await flush()
    expect(srv.calls).toContain('dismiss al')
    expect(host.querySelector('[data-fy="al"]')).toBeNull()
  })

  it('a reply goes to the reply route and clears its draft after acknowledgement; each reply field has its own label', async () => {
    await open()
    const form = band('se').querySelector<HTMLFormElement>('form.fy-reply')!
    await type(form, 'keep it')
    await submit(form)
    await flush()
    expect(srv.calls).toContain('reply se keep it')
    expect(form.querySelector('input')!.value).toBe('')
    expect(sessionStorage.getItem('weevils-feed-draft:se')).toBeNull()
    const labels = [...host.querySelectorAll('form.fy-reply input')].map((i) => i.getAttribute('aria-label'))
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('a reply the server refuses puts the text back and says why, in place', async () => {
    await open()
    srv.fail = 'reply'
    const form = band('bo').querySelector<HTMLFormElement>('form.fy-reply')!
    await type(form, 'go on')
    await submit(form)
    await flush()
    expect(form.querySelector('input')!.value).toBe('go on')
    expect(form.querySelector('[role=alert]')!.textContent).toContain('refused by the server')
    expect(form.querySelector('[role=status]')!.textContent).toBe('')
  })

  it('a mail unfolds in place: the whole message, and its reply line', async () => {
    await open()
    const line = band('ma').querySelector<HTMLElement>('.fy-mail')!
    expect(line.getAttribute('aria-expanded')).toBe('false')
    expect(band('ma').querySelector('form.fy-reply')).toBeNull()
    await click(line)
    expect(line.getAttribute('aria-expanded')).toBe('true')
    expect(band('ma').textContent).toContain('all the March invoices went out this morning.')
    expect(band('ma').textContent).toContain('Re: invoices')
    expect(band('ma').querySelector('form.fy-reply')).toBeTruthy()
  })

  it('a session’s head opens the real conversation; a media opens alone; an alert opens where it is solved', async () => {
    await open()
    await click(band('se').querySelector('.fy-head'))
    expect(pushed).toEqual([{ kind: 'session', id: 's1' }])
    await click(labelled(t().openMedia('run.mp4')))
    expect(pushed[1]).toEqual({ kind: 'media', url: '/api/foryou/media/m2', type: 'video', name: 'run.mp4' })
    await click(band('al').querySelector('.fy-alert'))
    expect(pushed[2]).toEqual({ kind: 'usage' })
  })

  it('« more » asks once and unfolds the answer in place', async () => {
    await open()
    const more = band('in').querySelector<HTMLElement>('.fy-more-btn')!
    await click(more)
    await flush()
    expect(srv.calls.filter((c) => c.startsWith('more'))).toEqual(['more in'])
    expect(band('in').textContent).toContain('Vite serves modules as they are asked for.')
    expect(more.textContent).toBe(t().less)
    await click(more)
    await click(more)
    await flush()
    expect(srv.calls.filter((c) => c.startsWith('more'))).toHaveLength(1)
  })

  it('« weevboss » asks for the thread in full, without a flash', async () => {
    await open()
    const seen: unknown[] = []
    const on = (e: Event) => seen.push((e as CustomEvent).detail)
    window.addEventListener(FOCUS_BOSS, on)
    await click(host.querySelector('.fy-words button.word'))
    window.removeEventListener(FOCUS_BOSS, on)
    expect(seen).toEqual([{ flash: false }])
  })

  it('the participants line isolates one speaker and remembers it', async () => {
    await open()
    const words = () => [...host.querySelectorAll<HTMLElement>('.fy-people .word')]
    expect(words().map((w) => w.textContent)).toEqual([t().whoAll, 'weevboss', 'Juno', t().whoSessions, t().whoMedia, t().whoIdeas])
    await click(words()[3])
    expect([...host.querySelectorAll('[data-fy]')].map((e) => e.getAttribute('data-fy'))).toEqual(['se'])
    expect(words()[3].getAttribute('aria-pressed')).toBe('true')
    expect(localStorage.getItem('weevils-foryou-who')).toBe('session')
    await click(words()[5])
    expect([...host.querySelectorAll('[data-fy]')].map((e) => e.getAttribute('data-fy'))).toEqual(['pr', 'im', 'in', 'mi'])
    // The same word again: everything.
    await click(words()[5])
    expect(host.querySelectorAll('[data-fy]')).toHaveLength(ITEMS.length)
    expect(localStorage.getItem('weevils-foryou-who')).toBe('all')
  })

  it('opens on the participant asked for, else on the one chosen last time', async () => {
    localStorage.setItem('weevils-foryou-who', 'juno')
    await open()
    expect([...host.querySelectorAll('[data-fy]')].map((e) => e.getAttribute('data-fy'))).toEqual(['ma'])
    act(() => root.unmount())
    root = createRoot(host)
    await open(ITEMS, 'weevboss')
    expect([...host.querySelectorAll('[data-fy]')].map((e) => e.getAttribute('data-fy'))).toEqual(['bo'])
  })

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

/** The one audio element of the stream, as the browser would give it: what it was asked to play, and whether it plays. */
class FakeAudio {
  static made: FakeAudio[] = []
  static refuse = false
  src = ''
  preload = ''
  currentTime = 0
  paused = true
  onplaying: (() => void) | null = null
  ontimeupdate: (() => void) | null = null
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor() {
    FakeAudio.made.push(this)
  }
  play() {
    if (FakeAudio.refuse) return Promise.reject(new Error('no speech here'))
    this.paused = false
    return Promise.resolve()
  }
  pause() {
    this.paused = true
  }
}

describe('for you: voice messages', () => {
  const VOICED: ForYouItem[] = [
    { ...base, id: 'bo', kind: 'boss', who: 'weevboss', text: 'Three sessions sent this morning.', voice: 'nova' },
    { ...base, id: 'ma', kind: 'mail', who: 'juno', title: 'Re: invoices', text: 'sent the March invoices', body: 'Hello,\nall done.', reply: 'mail', voice: 'alloy' },
    { ...base, id: 'b2', kind: 'boss', who: 'weevboss', text: 'No voice on this one.' },
  ]
  const listen = (id: string) => band(id).querySelector<HTMLButtonElement>('.fy-listen')!
  const audio = () => FakeAudio.made[0]
  const fire = (what: 'onplaying' | 'ontimeupdate' | 'onended' | 'onerror') => act(async () => audio()[what]?.())

  beforeEach(() => {
    FakeAudio.made = []
    FakeAudio.refuse = false
    vi.stubGlobal('Audio', FakeAudio)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('projects is an explicit exit; leaving and reopening the feed keeps its scroll and active audio', async () => {
    await open(VOICED)
    await click(listen('bo'))
    await fire('onplaying')
    const body = host.querySelector<HTMLElement>('.fy-body')!
    body.scrollTop = 480
    act(() => body.dispatchEvent(new Event('scroll', { bubbles: true })))
    await click(labelled(t().backToProjects))
    expect(pushed.at(-1)).toBe('home')
    render(null)
    expect(audio().paused).toBe(false)
    render(<ForYouPage />)
    await flush()
    expect(host.querySelector('.fy-body')!.scrollTop).toBe(480)
    expect(audio().paused).toBe(false)
    expect(FakeAudio.made).toHaveLength(1)
  })

  it('only an item with a voice carries the play glyph and its bars, still until it is played', async () => {
    await open(VOICED)
    expect(listen('bo').getAttribute('aria-label')).toBe(t().listen('weevboss'))
    expect(listen('bo').querySelectorAll('.fy-wave i').length).toBeGreaterThan(12)
    expect(listen('bo').classList.contains('fy-v-idle')).toBe(true)
    expect(listen('ma').classList.contains('small')).toBe(true)
    expect(band('b2').querySelector('.fy-listen')).toBeNull()
    // Nothing is synthesised before a tap.
    expect(FakeAudio.made).toHaveLength(0)
    // The mail's play button is not inside the line that unfolds it.
    expect(band('ma').querySelector('.fy-mail .fy-listen')).toBeNull()
  })

  it('starts transcripts folded and keeps audio playing when the text opens or closes', async () => {
    await open(VOICED)
    const transcript = band('bo').querySelector<HTMLDetailsElement>('details.fy-transcript')!
    expect(transcript.open).toBe(false)
    expect(transcript.querySelector('summary')!.textContent).toContain(t().readTranscript)
    expect(transcript.querySelector('.fy-listen')).toBeNull()
    expect(band('b2').querySelector('.fy-transcript')).toBeNull()
    expect(band('b2').querySelector('.fy-text')!.textContent).toBeTruthy()
    await click(listen('bo'))
    await fire('onplaying')
    const playing = audio()
    transcript.open = true
    await flush()
    transcript.open = false
    await flush()
    expect(audio()).toBe(playing)
    expect(playing.paused).toBe(false)
    expect(listen('bo').classList.contains('fy-v-playing')).toBe(true)
  })

  it('a tap streams the item’s words in its speaker’s voice; a second tap stops', async () => {
    await open(VOICED)
    await click(listen('bo'))
    const q = new URL(audio().src, 'http://x')
    expect(q.pathname).toBe('/api/speak/stream')
    expect(q.searchParams.get('text')).toBe('Three sessions sent this morning.')
    expect(q.searchParams.get('voice')).toBe('nova')
    expect(listen('bo').classList.contains('fy-v-loading')).toBe(true)
    expect(listen('bo').getAttribute('aria-pressed')).toBe('true')
    await fire('onplaying')
    expect(listen('bo').classList.contains('fy-v-playing')).toBe(true)
    expect(listen('bo').getAttribute('aria-label')).toBe(t().stop)
    audio().currentTime = 7.4
    await fire('ontimeupdate')
    expect(listen('bo').querySelector('.fy-listen-note')!.textContent).toBe('0:07')
    await click(listen('bo'))
    expect(audio().paused).toBe(true)
    expect(listen('bo').classList.contains('fy-v-idle')).toBe(true)
  })

  it('one element for the whole stream: starting another item stops the first; the end brings the bars to rest', async () => {
    await open(VOICED)
    await click(listen('bo'))
    await fire('onplaying')
    await click(listen('ma'))
    expect(FakeAudio.made).toHaveLength(1)
    expect(new URL(audio().src, 'http://x').searchParams.get('voice')).toBe('alloy')
    expect(listen('bo').classList.contains('fy-v-idle')).toBe(true)
    await fire('onplaying')
    expect(host.querySelectorAll('.fy-v-playing')).toHaveLength(1)
    expect(listen('ma').classList.contains('fy-v-playing')).toBe(true)
    await fire('onended')
    expect(host.querySelectorAll('.fy-v-playing, .fy-v-loading')).toHaveLength(0)
  })

  it('no sound: said quietly in place, and a new tap tries again', async () => {
    await open(VOICED)
    FakeAudio.refuse = true
    await click(listen('bo'))
    await flush()
    expect(listen('bo').classList.contains('fy-v-error')).toBe(true)
    expect(listen('bo').querySelector('[role=status]')!.textContent).toBe(t().voiceFailed)
    FakeAudio.refuse = false
    await click(listen('bo'))
    await fire('onplaying')
    expect(listen('bo').classList.contains('fy-v-playing')).toBe(true)
    // The element itself fails later (the stream breaks): same quiet word.
    await fire('onerror')
    expect(listen('bo').classList.contains('fy-v-error')).toBe(true)
  })

  it('removing an old technical card stops its audio and raw commit text can never start another stream', async () => {
    await open(VOICED)
    await click(listen('bo'))
    expect(audio().paused).toBe(false)
    const raw = 'weevils a un nouveau commit (435cf0d) : fix(auto): propColors kept (auto-model.ts)'
    srv.feed = feed([{ ...base, id: 'b:old', kind: 'boss', who: 'weevils', text: raw, voice: 'nova' }], 2)
    render(<ForYouPage />, snap(2))
    await flush()
    expect(audio().paused).toBe(true)
    expect(host.querySelector('[data-fy="b:old"]')).toBeNull()
    const oldUrl = audio().src
    await act(async () => toggleVoice('b:old', raw, 'nova'))
    expect(audio().src).toBe(oldUrl)
    expect(audio().paused).toBe(true)
    expect(FakeAudio.made).toHaveLength(1)
    await act(async () => toggleVoice('human', 'Le thème est en ligne (commit 2d5496f, poussé sur main).', 'nova'))
    expect(new URL(audio().src, 'http://x').searchParams.get('text')).toBe('Le thème est en ligne.')
  })

  it('weevboss’s logo and a voice message never speak together', async () => {
    await open(VOICED)
    let asked = 0
    const onItem = () => void asked++
    window.addEventListener(ITEM_SAYS, onItem)
    await click(listen('bo'))
    await fire('onplaying')
    window.removeEventListener(ITEM_SAYS, onItem)
    // The message told the logo to be quiet when it started.
    expect(asked).toBe(1)
    // The logo speaks: the message stops.
    await act(async () => void window.dispatchEvent(new Event(LOGO_SAYS)))
    expect(audio().paused).toBe(true)
    expect(listen('bo').classList.contains('fy-v-idle')).toBe(true)
  })

  it('the bars of an item are always the same, between a quarter and full height', () => {
    expect(waveOf('b:1', 26)).toEqual(waveOf('b:1', 26))
    expect(waveOf('b:1', 26)).not.toEqual(waveOf('b:2', 26))
    for (const h of waveOf('b:1', 26)) expect(h >= 0.25 && h <= 1).toBe(true)
  })
})

describe('for you: figures, the line, media fit', () => {
  it('bars: label, figure, bar; a project’s colour, the alert colour when hot, the ink otherwise; also under a result', async () => {
    const result: ForYouItem = { ...base, id: 're', kind: 'session', tone: 'result', who: 'session', projectId: 'mygame', title: 'layout', text: 'twelve weeks laid out', gauges: [{ label: 'weeks', value: 12, max: 52, shown: '12 of 52', projectId: 'mygame' }, { label: 'tests', value: 48, max: 48, shown: '48 of 48' }, { label: 'hot project', value: 9, max: 10, shown: '9 of 10', projectId: 'mygame', hot: true }] }
    await open([result, ITEMS[9]])
    const bars = [...band('re').querySelectorAll<HTMLElement>('.fy-gauge')]
    expect(bars.map((b) => [b.querySelector('.fy-gauge-label')!.textContent, b.querySelector('.fy-gauge-shown')!.textContent])).toEqual([
      ['weeks', '12 of 52'],
      ['tests', '48 of 48'],
      ['hot project', '9 of 10'],
    ])
    expect(bars.map((b) => b.style.getPropertyValue('--v'))).toEqual([`${(12 / 52) * 100}%`, '100%', '90%'])
    expect(bars[0].classList.contains('own')).toBe(true)
    expect(bars[0].style.getPropertyValue('--g')).toBe('var(--p4)')
    expect(bars[1].className).toBe('fy-gauge')
    // Hot wins over the project's colour.
    expect(bars[2].className).toBe('fy-gauge hot')
    // A stat: a short title and its bars.
    expect(band('st').querySelector('.fy-title')!.textContent).toBe('this week')
    expect(band('st').querySelectorAll('.fy-gauge')).toHaveLength(2)
  })

  it('the line: a star per working agent, each count as its own figure', async () => {
    await open()
    const line = host.querySelector('.fy-pulse')!
    expect(line.querySelectorAll('.fy-stars .spin')).toHaveLength(2)
    expect([...line.querySelectorAll('.fy-tick-n')].map((n) => n.textContent)).toEqual(['2', '7', '1', '3'])
    expect(line.querySelector('.fy-pulse-text')!.textContent).toBe([t().pulseWorking(2), t().pulseDelivered(7), t().pulseWaiting(1), t().pulseAuto(3)].join(' · '))
  })

  it('three proposals or more: each takes most of the width so the next one shows its edge; two share it', async () => {
    await open()
    const strip = band('pr').querySelector('.fy-props')!
    expect(strip.classList.contains('scroll')).toBe(true)
    expect([...strip.querySelectorAll<HTMLElement>('.fy-card')].map((c) => c.style.flexBasis)).toEqual(['78%', '78%', '78%'])
    await click(labelled(t().refuse('Draft the page'), band('pr')))
    await flush()
    expect(strip.classList.contains('scroll')).toBe(false)
    expect([...strip.querySelectorAll<HTMLElement>('.fy-card')].map((c) => c.style.flexBasis)).toEqual(['50%', '50%'])
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
  it('compact: a thin strip with only its notification close control', async () => {
    srv.feed = feed(ITEMS)
    render(
      <>
        <ForYouItemView item={ITEMS[2]} compact />
        <ForYouItemView item={ITEMS[4]} compact />
      </>,
    )
    await flush()
    const strips = [...host.querySelectorAll('.fy-strip')]
    expect(strips.map((s) => s.textContent)).toEqual(['weevbossThree sessions sent this morning, two are back.', 'weevilsHarden the tests'])
    expect(strips[1].querySelector('.fy-plus svg')).toBeTruthy()
    expect(host.querySelectorAll('button.notice-close')).toHaveLength(0)
    expect(host.querySelectorAll('input, form, button:not(.notice-close)')).toHaveLength(0)
  })

  it('the viewer shows the image whole, or the video with its controls, and goes back', async () => {
    render(<MediaPage url="/api/foryou/media/m1" type="image" name="title.png" />)
    expect(host.querySelector('.fy-stage img')!.getAttribute('src')).toBe('/api/foryou/media/m1')
    expect(host.querySelector('.fy-stage img')!.getAttribute('alt')).toBe('title.png')
    await click(labelled(t().back))
    expect(pushed).toEqual(['back'])
    render(<MediaPage url="/api/foryou/media/m2" type="video" name="run.mp4" />)
    const video = host.querySelector<HTMLVideoElement>('.fy-stage video')!
    expect(video.controls).toBe(true)
    expect(video.getAttribute('src')).toBe('/api/foryou/media/m2')
  })
})


describe('spoken proposals', () => {
  it('offers a visible button that opens the announced idea itself', async () => {
    render(<ForYouItemView item={{ id: 'auto:proposed:real', kind: 'boss', tone: 'neutral', at: NOW, who: 'weevils', text: 'A useful idea', voice: 'default', open: { page: 'auto', id: 'real' } }} />)
    const button = [...host.querySelectorAll('button')].find((el) => el.textContent === t().openIdea)
    expect(button).toBeTruthy()
    await click(button)
    expect(pushed).toContainEqual({ kind: 'auto', id: 'real' })
  })
})

it('a pending feed reply keeps its draft, does not claim success, and ignores duplicate submits', async () => {
  await open(ITEMS.map((i) => i.id === 'bo' ? { ...i, actions: undefined } : i))
  let resolve!: () => void
  srv.gate = new Promise<void>((done) => { resolve = done })
  const form = band('bo').querySelector<HTMLFormElement>('form.fy-reply')!
  await type(form, 'oui')
  act(() => { form.requestSubmit(); form.requestSubmit() })
  expect(srv.calls.filter((s) => s === 'reply bo oui')).toHaveLength(1)
  expect(form.querySelector('input')!.value).toBe('oui')
  expect(form.querySelector('[role=status]')!.textContent).toContain(t().sending)
  expect(sessionStorage.getItem('weevils-feed-draft:bo')).toBe('oui')
  await act(async () => resolve())
  expect(form.querySelector('input')!.value).toBe('')
  expect(form.querySelector('[role=status]')!.textContent).toContain(t().sent)
})

it('an action stays visible and disabled until acknowledged, despite repeated taps', async () => {
  await open()
  let resolve!: () => void
  srv.gate = new Promise<void>((done) => { resolve = done })
  const button = band('bo').querySelector<HTMLButtonElement>('.fy-btn')!
  act(() => { button.click(); button.click(); button.click() })
  expect(srv.calls.filter((s) => s === 'act bo go')).toHaveLength(1)
  expect(button.disabled).toBe(true)
  expect(button.textContent).toContain(t().sending)
  await act(async () => resolve())
})
