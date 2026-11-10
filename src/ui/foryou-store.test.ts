// @vitest-environment happy-dom
// The « for you » store: one fetch for every component, only when the server has a stream (snap.foryou), again when its
// revision changes; act and dismiss are optimistic and roll back; nothing moves under the finger (newcomers wait).
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Snapshot } from '../../shared/api.ts'
import type { ForYouFeed, ForYouItem, ForYouMark } from '../../shared/foryou.ts'

const srv = vi.hoisted(() => ({
  feed: null as unknown,
  calls: [] as string[],
  fail: '' as string,
}))
vi.mock('../api', () => {
  const run = async (what: string) => {
    srv.calls.push(what)
    if (srv.fail && what.startsWith(srv.fail)) throw new Error('nope')
    return { ok: true as const }
  }
  return {
    api: {
      foryou: async () => {
        srv.calls.push('feed')
        if (srv.fail === 'feed') throw new Error('nope')
        return srv.feed
      },
      foryouSeen: (ids: string[]) => run(`seen ${ids.join(',')}`),
      foryouDismiss: (id: string) => run(`dismiss ${id}`),
      foryouAct: (id: string, action: string, card?: string) => run(`act ${id} ${action}${card ? ` ${card}` : ''}`),
      foryouReply: (id: string, text: string) => run(`reply ${id} ${text}`),
      foryouMore: async (id: string) => {
        srv.calls.push(`more ${id}`)
        return { text: `more about ${id}` }
      },
    },
  }
})

const { Ctx, setSettledNow } = await import('./app-context')
const { useForYou, resetForYou, itemSlot, itemWho, participants, matchesWho, WHO_ALL } = await import('./foryou-store')
const { setLang } = await import('../i18n')
type Store = ReturnType<typeof useForYou>

const NOW = Date.now()
const item = (o: Partial<ForYouItem> & { id: string }): ForYouItem => ({ kind: 'boss', tone: 'neutral', at: NOW, who: 'weevboss', text: o.id, ...o })
const feed = (rev: number, items: ForYouItem[]): ForYouFeed => ({ rev, items, pulse: { working: 0, waiting: 0, delivered: 0, auto: 0 } })

const snap = (foryou?: ForYouMark, version = 1): Snapshot => ({
  version,
  now: NOW,
  machines: [{ id: 'm', name: 'm' }],
  projects: [],
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
  foryou,
})

let root: Root
let host: HTMLElement
let fy: Store
let renders = 0

function Probe() {
  fy = useForYou()
  renders++
  return null
}

function render(s: Snapshot, probes = 1) {
  const ctx = {
    snap: s,
    now: NOW,
    offline: false,
    colors: { game: 'p4' },
    push: () => {},
    replace: () => {},
    back: () => {},
    home: () => {},
    expanded: null,
    setExpanded: () => {},
    h24Open: false,
    setH24Open: () => {},
    theme: 'light' as const,
    setTheme: () => {},
    refresh: () => {},
    logout: () => {},
  }
  act(() => root.render(createElement(Ctx.Provider, { value: ctx }, ...Array.from({ length: probes }, (_, i) => createElement(Probe, { key: i })))))
}

const flush = () => act(() => new Promise((r) => setTimeout(r, 10)))
const ids = () => fy.items.map((i) => i.id)
const fetches = () => srv.calls.filter((c) => c === 'feed').length

/** A server at revision `rev` with these items, seen by the app. */
async function serve(rev: number, items: ForYouItem[], unseen = items.filter((i) => !i.seen).length) {
  srv.feed = feed(rev, items)
  render(snap({ rev, unseen }, rev))
  await flush()
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  resetForYou()
  setSettledNow(true)
  srv.feed = feed(1, [])
  srv.calls.length = 0
  srv.fail = ''
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

describe('for you store', () => {
  it('never calls the api when the server has no stream', async () => {
    render(snap(undefined))
    await flush()
    act(() => fy.refresh())
    act(() => fy.markSeen(['a']))
    await flush()
    expect(srv.calls).toEqual([])
    expect(fy.feed).toBeNull()
    expect(fy.items).toEqual([])
    expect(fy.unseen).toBe(0)
  })

  it('fetches once for every component, and again only when the revision changes', async () => {
    srv.feed = feed(1, [item({ id: 'a' }), item({ id: 'b', seen: true })])
    render(snap({ rev: 1, unseen: 1 }), 3)
    await flush()
    expect(fetches()).toBe(1)
    expect(ids()).toEqual(['a', 'b'])
    expect(fy.unseen).toBe(1)
    // A new snapshot, same revision: nothing to fetch.
    render(snap({ rev: 1, unseen: 1 }, 2), 3)
    await flush()
    expect(fetches()).toBe(1)
    srv.feed = feed(2, [item({ id: 'a' }), item({ id: 'b', seen: true }), item({ id: 'c' })])
    render(snap({ rev: 2, unseen: 2 }, 3), 3)
    await flush()
    expect(fetches()).toBe(2)
    expect(ids()).toEqual(['a', 'b', 'c'])
  })

  it('shows the snapshot count before the stream is there, and tries again after a failed fetch', async () => {
    srv.fail = 'feed'
    render(snap({ rev: 1, unseen: 4 }))
    await flush()
    expect(fy.feed).toBeNull()
    expect(fy.unseen).toBe(4)
    srv.fail = ''
    srv.feed = feed(1, [item({ id: 'a' })])
    render(snap({ rev: 1, unseen: 4 }, 2))
    await flush()
    expect(ids()).toEqual(['a'])
    expect(fy.unseen).toBe(1)
  })

  it('act: the item leaves at once; it comes back with the error when the server refuses', async () => {
    await serve(1, [item({ id: 'a', actions: [{ id: 'go', label: 'go' }] }), item({ id: 'b' })])
    srv.fail = 'act'
    let done!: Promise<void>
    act(() => void (done = fy.act('a', 'go')))
    expect(ids()).toEqual(['b'])
    expect(fy.leaving('a')).toBe(1)
    await act(() => done)
    expect(srv.calls).toContain('act a go')
    expect(ids()).toEqual(['a', 'b'])
    expect(fy.error('a')).toBe('nope')
  })

  it('act on a card: only the card leaves (refused: to the left); the item leaves with its last card', async () => {
    const cards = [
      { id: 'c1', title: 'one', why: '', source: 'optimizer' as const, kind: 'tests' },
      { id: 'c2', title: 'two', why: '', source: 'tip' as const, kind: 'x' },
    ]
    await serve(1, [item({ id: 'p', kind: 'proposals', who: 'weevils', cards }), item({ id: 'b' })])
    await act(() => fy.act('p', 'refuse', 'c1'))
    expect(srv.calls).toContain('act p refuse c1')
    expect(fy.items[0].cards!.map((c) => c.id)).toEqual(['c2'])
    expect(fy.leaving('c1')).toBe(-1)
    await act(() => fy.act('p', 'accept', 'c2'))
    expect(ids()).toEqual(['b'])
    expect(fy.leaving('p')).toBe(1)
  })

  it('dismiss: stays hidden locally even if the server is temporarily unreachable', async () => {
    await serve(1, [item({ id: 'a' }), item({ id: 'b' })])
    await act(() => fy.dismiss('a'))
    expect(srv.calls).toContain('dismiss a')
    expect(ids()).toEqual(['b'])
    // The server caught up: the stream no longer lists it.
    await serve(2, [item({ id: 'b' })])
    expect(ids()).toEqual(['b'])
    srv.fail = 'dismiss'
    await act(() => fy.dismiss('b'))
    expect(ids()).toEqual([])
    expect(fy.error('b')).toBe('nope')
  })

  it('a closed event stays closed on reconnect; a new event of the same session is visible', async () => {
    await serve(1, [item({ id: 's:one', eventId: 'question-one' })])
    await act(() => fy.dismiss('s:one'))
    expect(ids()).toEqual([])
    await serve(2, [item({ id: 's:one', eventId: 'question-one', text: 'refined wording' })])
    expect(ids()).toEqual([])
    await serve(3, [item({ id: 's:one', eventId: 'question-two' })])
    expect(ids()).toEqual(['s:one'])
  })

  it('says which way a leaving item goes and what was done: launched or sent to the right, refused or dismissed to the left', async () => {
    await serve(1, [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' }), item({ id: 'd' }), item({ id: 'e' })])
    expect(fy.leftAs('a')).toBeUndefined()
    await act(() => fy.act('a', 'accept'))
    await act(() => fy.act('b', 'resume'))
    await act(() => fy.act('c', 'a1'))
    await act(() => fy.act('d', 'refuse'))
    await act(() => fy.dismiss('e'))
    expect(['a', 'b', 'c', 'd', 'e'].map((id) => [fy.leaving(id), fy.leftAs(id)])).toEqual([
      [1, 'launched'],
      [1, 'launched'],
      [1, 'sent'],
      [-1, 'dismissed'],
      [-1, 'dismissed'],
    ])
    // The server caught up: nothing is remembered of them.
    await serve(2, [])
    expect([fy.leaving('a'), fy.leftAs('a'), fy.leaving('e'), fy.leftAs('e')]).toEqual([0, undefined, 0, undefined])
  })

  it('asks for the stream again when the app changes language (the server writes it per language), not otherwise', async () => {
    // The choice stays local; the stream is requested in that language.
    vi.stubGlobal('fetch', async () => new Response('{}'))
    setLang('fr')
    await serve(1, [item({ id: 'a', text: 'bonjour' })])
    expect(fetches()).toBe(1)
    srv.feed = feed(1, [item({ id: 'a', text: 'hello' })])
    await act(async () => setLang('en'))
    await flush()
    expect(fetches()).toBe(2)
    expect(fy.items[0].text).toBe('hello')
    // Same language, same revision: nothing more.
    render(snap({ rev: 1, unseen: 1 }, 2))
    await flush()
    expect(fetches()).toBe(2)
    await act(async () => setLang('fr'))
    await flush()
    expect(fetches()).toBe(3)
    vi.unstubAllGlobals()
  })

  it('reply rejects when the server refuses (the caller puts the text back)', async () => {
    await serve(1, [item({ id: 'a', reply: 'boss' })])
    await fy.reply('a', 'hello')
    expect(srv.calls).toContain('reply a hello')
    srv.fail = 'reply'
    await expect(fy.reply('a', 'again')).rejects.toThrow('nope')
  })

  it('at the top and still, takes the server order (newest first): news comes in at the top', async () => {
    await serve(1, [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })])
    await serve(2, [item({ id: 'n' }), item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })])
    expect(ids()).toEqual(['n', 'a', 'b', 'c'])
    expect(fy.fresh).toBe(0)
  })

  it('finger down or reading further down: newcomers wait behind a count, showFresh brings them in', async () => {
    await serve(1, [item({ id: 'a' }), item({ id: 'b' })])
    setSettledNow(false)
    await serve(2, [item({ id: 'n' }), item({ id: 'a' }), item({ id: 'b' })])
    expect(ids()).toEqual(['a', 'b'])
    expect(fy.fresh).toBe(1)
    expect(fy.unseen).toBe(3)
    act(() => fy.showFresh())
    expect(ids()).toEqual(['n', 'a', 'b'])
    expect(fy.fresh).toBe(0)

    setSettledNow(true)
    act(() => fy.setReading(true))
    await serve(3, [item({ id: 'm' }), item({ id: 'n' }), item({ id: 'a' }), item({ id: 'b' })])
    expect(ids()).toEqual(['n', 'a', 'b'])
    expect(fy.fresh).toBe(1)
    // Back at the top and still: the next stream lets them in.
    act(() => fy.setReading(false))
    await serve(4, [item({ id: 'm' }), item({ id: 'n' }), item({ id: 'a' }), item({ id: 'b' })])
    expect(ids()).toEqual(['m', 'n', 'a', 'b'])
    expect(fy.fresh).toBe(0)
  })

  it('markSeen: seen here at once, sent to the server in one batch a moment later', async () => {
    await serve(1, [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c', seen: true })])
    vi.useFakeTimers()
    act(() => fy.markSeen(['a']))
    act(() => fy.markSeen(['b', 'c', 'zz']))
    expect(fy.items.map((i) => !!i.seen)).toEqual([true, true, true])
    expect(fy.unseen).toBe(0)
    expect(srv.calls.filter((c) => c.startsWith('seen'))).toEqual([])
    await act(async () => void vi.advanceTimersByTime(900))
    expect(srv.calls.filter((c) => c.startsWith('seen'))).toEqual(['seen a,b'])
    // Already seen: nothing more to send.
    act(() => fy.markSeen(['a']))
    await act(async () => void vi.advanceTimersByTime(900))
    expect(srv.calls.filter((c) => c.startsWith('seen'))).toHaveLength(1)
  })

  it('more: asked once, then kept in the item', async () => {
    await serve(1, [item({ id: 'i', kind: 'insight', more: true })])
    let a = ''
    let b = ''
    await act(async () => {
      ;[a, b] = await Promise.all([fy.more('i'), fy.more('i')])
    })
    expect(a).toBe('more about i')
    expect(b).toBe(a)
    expect(await fy.more('i')).toBe(a)
    expect(srv.calls.filter((c) => c.startsWith('more'))).toEqual(['more i'])
    expect(fy.items[0].moreText).toBe(a)
  })

  it('does not re-render its readers when nothing changed', async () => {
    await serve(1, [item({ id: 'a' })])
    const before = renders
    act(() => fy.markSeen(['unknown']))
    expect(renders).toBe(before)
  })
})

describe('for you: colours and speakers', () => {
  const c = (i: ForYouItem) => (itemSlot(i, { game: 'p4' }) as Record<string, string>)['--c']
  const authors = (id?: string) => ({ name: id === 'juno' ? 'Juno' : (id ?? 'weevboss'), color: id === 'juno' ? '#2ec4b6' : '' })

  it('the band takes the colour of what it says, else of who says it', () => {
    expect(c(item({ id: '1', kind: 'boss' }))).toBe('var(--agent)')
    expect(c(item({ id: '2', kind: 'session', who: 'session', tone: 'neutral', projectId: 'game' }))).toBe('var(--p4)')
    expect(c(item({ id: '3', kind: 'session', who: 'session', tone: 'result', projectId: 'game' }))).toContain('--fy-ok')
    expect(c(item({ id: '4', kind: 'session', who: 'session', tone: 'question', projectId: 'game' }))).toBe('var(--h24)')
    expect(c(item({ id: '5', kind: 'session', who: 'session', tone: 'alert', projectId: 'game' }))).toBe('var(--alert)')
    // An alert is drawn inverted on its project's colour, never on the red itself.
    expect(c(item({ id: '6', kind: 'alert', who: 'weevils', tone: 'alert', projectId: 'game' }))).toBe('var(--p4)')
    expect(c(item({ id: '7', kind: 'insight', who: 'weevils', projectId: 'game' }))).toBe('var(--p4)')
    expect(c(item({ id: '8', kind: 'proposals', who: 'weevils', cards: [{ id: 'c', title: '', why: '', source: 'tip', kind: '' }] }))).toMatch(/^var\(--p\d+\)$/)
  })

  it('an outside author keeps its own colour, brought to the theme', () => {
    const mail = item({ id: 'm', kind: 'mail', who: 'juno' })
    expect((itemSlot(mail, {}, authors) as Record<string, string>)['--c']).toContain('#2ec4b6')
    // Unknown to the config: a stable tint of the palette.
    const other = (itemSlot(item({ id: 'm', kind: 'mail', who: 'ghost' }), {}) as Record<string, string>)['--c']
    expect(other).toMatch(/var\(--p\d+\)/)
    expect((itemSlot(item({ id: 'n', kind: 'mail', who: 'ghost' }), {}) as Record<string, string>)['--c']).toBe(other)
  })

  it('names the speaker', () => {
    expect(itemWho(item({ id: '1' }), authors)).toBe('weevboss')
    expect(itemWho(item({ id: '2', who: 'juno' }), authors)).toBe('Juno')
    expect(itemWho(item({ id: '3', who: 'session', title: 'fix login' }), authors, 'mygame')).toBe('mygame')
    expect(itemWho(item({ id: '4', who: 'session', title: 'fix login' }), authors)).toBe('fix login')
  })

  it('lists who is present and filters on one', () => {
    const items = [
      item({ id: '1' }),
      item({ id: '2', kind: 'mail', who: 'juno' }),
      item({ id: '3', kind: 'session', who: 'session' }),
      item({ id: '4', kind: 'media', who: 'session' }),
      item({ id: '5', kind: 'insight', who: 'weevils' }),
    ]
    expect(participants(items)).toEqual([WHO_ALL, 'weevboss', 'juno', 'session', 'media', 'ideas'])
    expect(participants([item({ id: '1' })])).toEqual([WHO_ALL, 'weevboss'])
    const only = (w: string) => items.filter((i) => matchesWho(i, w)).map((i) => i.id)
    expect(only(WHO_ALL)).toHaveLength(5)
    expect(only('weevboss')).toEqual(['1'])
    expect(only('juno')).toEqual(['2'])
    expect(only('session')).toEqual(['3'])
    expect(only('media')).toEqual(['4'])
    expect(only('ideas')).toEqual(['5'])
  })
})


describe('resolved requests', () => {
  it('successful actions and question replies persist by event; failed replies stay visible', async () => {
    const q = item({ id: 'q', eventId: 'q-one', kind: 'session', tone: 'question', reply: 'session' })
    const a = item({ id: 'a', eventId: 'a-one', actions: [{ id: 'go', label: 'go' }] })
    await serve(1, [q, a])
    srv.fail = 'reply'
    await act(async () => { await expect(fy.reply('q', 'yes')).rejects.toThrow('nope') })
    expect(ids()).toEqual(['q', 'a'])
    srv.fail = ''
    await act(() => fy.reply('q', 'yes'))
    await act(() => fy.act('a', 'go'))
    expect(ids()).toEqual([])
    await serve(2, [{ ...q, text: 'same refined' }, a])
    expect(ids()).toEqual([])
    await serve(3, [{ ...q, eventId: 'q-two', at: NOW + 1 }, a])
    expect(ids()).toEqual(['q'])
  })
})

it('filters old-server commit cards and sanitizes text before a cached item can be shown or read', async () => {
  await serve(1, [
    item({ id: 'commit:repo:435cf0d', voice: 'default' }),
    item({ id: 'b:legacy', voice: 'default', text: 'weevils a un nouveau commit (435cf0d) : fix(auto): old subject' }),
    item({ id: 'human', voice: 'default', text: 'Le thème est en ligne (commit 2d5496f, poussé sur main).' }),
  ])
  expect(ids()).toEqual(['human'])
  expect(fy.items[0].text).toBe('Le thème est en ligne.')
  await serve(2, srv.feed ? (srv.feed as ForYouFeed).items : [])
  expect(ids()).toEqual(['human'])
})
