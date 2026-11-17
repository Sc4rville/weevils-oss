import { notificationEligible } from '../../shared/notification-policy'
import { outboxSnapshot, subscribeOutbox } from '../outbox'
import { humanFeedItem, humanFeedText, rawEngineeringNotice } from '../../shared/feed-text.ts'
import { retainVoice } from './foryou-voice'
import { feedNoticeKey, isRequestNotice, noticeKey } from '../../shared/notices.ts'
import { dismissNotice, isNoticeDismissed, subscribeNotices, resetNotices } from './notice-store'
// « Pour toi » : one store for the whole app (the top band's preview and the full-screen page read the same stream,
// fetched once). It refetches GET /api/foryou when the snapshot's revision changes, and never calls the api when the
// snapshot has no « foryou » mark (older server, secondary machine, tests of other components).
import { useEffect, useMemo, useSyncExternalStore, type CSSProperties } from 'react'
import { api } from '../api'
import { useForYouOpen } from './foryou-open'
import type { Author } from '../../shared/api.ts'
import type { ForYouFeed, ForYouItem, ForYouMark } from '../../shared/foryou.ts'
import { isSettled, useApp } from './app-context'
import { propColors } from './h24-tree'
import { getLang, tr, useLang } from '../i18n'
import M from '../i18n/foryou'

export interface ForYouStore {
  feed: ForYouFeed | null
  /** What is shown, in an order that never changes under the finger. */
  items: ForYouItem[]
  unseen: number
  /** Newcomers held back while the user was touching or reading further down. */
  fresh: number
  /** Brings the newcomers in and takes the server's order again. */
  showFresh(): void
  /** The item leaves after acknowledgement; failures stay visible through error(id). Never rejects. */
  act(id: string, action: string, card?: string): Promise<void>
  acting(id: string, card?: string): boolean
  dismiss(id: string): Promise<void>
  /** Rejects on failure (the caller puts the text back). */
  reply(id: string, text: string): Promise<void>
  markSeen(ids: string[]): void
  more(id: string): Promise<string>
  refresh(): void
  /** The last failed action on this item, in the user's words. */
  error(id: string): string | undefined
  /** Which way an item or a card that just left should slide: 1 right (accepted, launched, sent), -1 left (refused, dismissed), 0 it left by itself. */
  leaving(id: string): 1 | -1 | 0
  /** What was done to the item that just left, for the word flashed where it was (undefined: it left by itself). */
  leftAs(id: string): Left | undefined
  /** The page tells it is scrolled away from the top: newcomers wait instead of pushing what is being read. */
  setReading(reading: boolean): void
}

/** What the user did to an item that leaves. */
export type Left = 'launched' | 'sent' | 'dismissed'

interface View {
  feed: ForYouFeed | null
  items: ForYouItem[]
  unseen: number
  fresh: number
}

const EMPTY: View = { feed: null, items: [], unseen: 0, fresh: 0 }
const SEEN_DELAY = 800

let feed: ForYouFeed | null = null
/** Ids shown, in the order shown. */
let order: string[] = []
let held = new Set<string>()
/** When each shown item was last news (its time when it took its place). */
const shownAt = new Map<string, number>()
const gone = new Set<string>()
const dismissedEvents = new Map<string, string>()
const goneCards = new Set<string>()
const seen = new Set<string>()
const seenQueue = new Set<string>()
const moreTexts = new Map<string, string>()
const moreFlights = new Map<string, Promise<string>>()
const errors = new Map<string, string>()
const dirs = new Map<string, 1 | -1>()
const lefts = new Map<string, Left>()
/** Buttons handed to weevboss here, until the server's item says so itself: the card shows « sent » at once. */
const handed = new Map<string, { action: string; intentId: string }>()
/** The language the stream was last asked in: the server's texts depend on it. */
let lang: string | undefined
let reading = false
let enabled = false
let markUnseen = 0
let wanted: number | undefined
let loading = false
let again = false
let seenTimer: ReturnType<typeof setTimeout> | undefined
let authorColors = new Map<string, string>()
let view: View = EMPTY
const listeners = new Set<() => void>()

/** The server's items minus what just left here, with what this device already knows (seen, « more » text). */
function current(): ForYouItem[] {
  return (feed?.items ?? []).flatMap((it) => {
    if (gone.has(it.id) || isNoticeDismissed(feedNoticeKey(it))) return []
    let x = it
    if (it.cards) {
      const cards = it.cards.filter((c) => !goneCards.has(c.id) && !isNoticeDismissed(noticeKey('proposal-card', c.id)))
      if (!cards.length) return []
      if (cards.length !== it.cards.length) x = { ...x, cards }
    }
    const sent = handed.get(it.id)
    if (sent && !it.work) x = { ...x, work: { intentId: sent.intentId, status: 'requested', open: { page: 'boss' } }, open: { page: 'boss' }, actions: it.actions?.filter((a) => a.id !== sent.action) }
    if (!it.seen && seen.has(it.id)) x = { ...x, seen: true }
    const more = moreTexts.get(`${getLang()}:${it.id}`)
    if (more && !it.moreText) x = { ...x, moreText: more }
    return [x]
  })
}

function rebuild() {
  const all = current()
  const by = new Map(all.map((i) => [i.id, i]))
  const items = order.flatMap((id) => by.get(id) ?? [])
  view = { feed, items, unseen: all.filter((i) => !i.seen && notificationEligible(i)).length, fresh: all.filter((i) => held.has(i.id)).length }
  for (const l of listeners) l()
}

function adopt(f: ForYouFeed) {
  f = { ...f, items: f.items.filter((i) => !rawEngineeringNotice(i.id, i.text)).map(humanFeedItem) }
  retainVoice(new Set(f.items.map((i) => i.id)))
  const first = !feed
  feed = f
  const ids = f.items.map((i) => i.id)
  const by = new Map(f.items.map((i) => [i.id, i]))
  for (const [id, event] of dismissedEvents) {
    const item = by.get(id)
    if (!item || feedNoticeKey(item) !== event) { gone.delete(id); dismissedEvents.delete(id) }
  }
  // What the server has caught up with is forgotten here.
  for (const id of gone) if (!by.has(id)) gone.delete(id)
  const cards = new Set(f.items.flatMap((i) => i.cards?.map((c) => c.id) ?? []))
  for (const id of goneCards) if (!cards.has(id)) goneCards.delete(id)
  for (const id of seen) if (!by.has(id) || by.get(id)!.seen) seen.delete(id)
  for (const id of dirs.keys()) if (!gone.has(id) && !goneCards.has(id)) dirs.delete(id)
  for (const id of lefts.keys()) if (!dirs.has(id)) lefts.delete(id)
  for (const [id, sent] of handed) if (!by.has(id) || by.get(id)!.work?.intentId === sent.intentId) handed.delete(id)
  for (const key of moreTexts.keys()) if (!by.has(key.slice(3))) moreTexts.delete(key)
  if (first || !order.length) {
    order = ids
    held = new Set()
  } else {
    const known = new Set(order)
    const next = order.filter((id) => by.has(id))
    // New, or an item that came back with news (a session's next turn): it belongs at the top.
    const news = ids.filter((id) => !known.has(id) || (by.get(id)!.at ?? 0) > (shownAt.get(id) ?? 0))
    // Finger down, stream moving, or reading further down: nothing moves, the newcomers wait behind « n new » at the top.
    if (reading || !isSettled()) held = new Set(news)
    else {
      // At the top and still: the server's order (newest first), so news always comes in from the top.
      held = new Set()
      next.splice(0, next.length, ...ids)
    }
    order = next
  }
  for (const id of order) if (!held.has(id)) shownAt.set(id, by.get(id)?.at ?? 0)
  rebuild()
}

async function load() {
  if (loading) return void (again = true)
  loading = true
  const requestedLang = getLang()
  try {
    const next = await api.foryou()
    if (requestedLang === getLang()) adopt(next)
    else again = true
  } catch {
    wanted = undefined // the next snapshot tries again
  } finally {
    loading = false
    if (again) {
      again = false
      void load()
    }
  }
}

function sync(mark: ForYouMark | undefined, authors: Author[] | undefined, appLang?: string) {
  authorColors = new Map((authors ?? []).map((a) => [a.id, a.color]))
  enabled = !!mark
  // The app changed language: the stream is asked again (titles, digests, alerts are written per language).
  const turned = lang !== undefined && appLang !== undefined && appLang !== lang
  if (appLang !== undefined) lang = appLang
  if (!mark) return
  if (turned) {
    wanted = mark.rev
    return void load()
  }
  if (markUnseen !== mark.unseen) {
    markUnseen = mark.unseen
    if (!feed) rebuild()
  }
  if (mark.rev === wanted || mark.rev === feed?.rev) return
  wanted = mark.rev
  void load()
}

subscribeNotices(() => rebuild())

const message = (e: unknown) => (e instanceof Error && e.message ? e.message : tr(M).failed)

const actionFlights = new Set<string>()
const acting = (id: string, card?: string) => actionFlights.has(card ?? id) || outboxSnapshot().some(r => r.url.split('?')[0] === `/api/foryou/${encodeURIComponent(id)}/act` && r.card === card && (!r.eventId || r.eventId === feedNoticeKey(feed?.items.find(i => i.id === id) ?? { id } as ForYouItem)) && !['failed', 'delivered'].includes(r.status))
subscribeOutbox(() => rebuild(), false)
async function act(id: string, action: string, card?: string) {
  const key = card ?? id
  if (acting(id, card) || (card ? goneCards.has(card) : gone.has(id))) return
  actionFlights.add(key)
  const event = feed?.items.find((i) => i.id === id)
  const eventId = event ? feedNoticeKey(event) : undefined
  const dir = action === 'refuse' ? -1 : 1
  const left: Left = action === 'refuse' ? 'dismissed' : action === 'accept' || action === 'resume' ? 'launched' : 'sent'
  errors.delete(id)
  rebuild()
  try {
    const result = await api.foryouAct(id, action, card, eventId)
    if (result?.open || result?.intentId || result?.existing) {
      if (!card && result.open?.page === 'boss' && result.intentId) handed.set(id, { action, intentId: result.intentId })
      refresh()
      return result
    }
    if (card) goneCards.add(card)
    else { gone.add(id); if (eventId) dismissedEvents.set(id, eventId) }
    dirs.set(id, dir)
    lefts.set(id, left)
    if (card) dirs.set(card, dir)
    if (card) dismissNotice(noticeKey('proposal-card', card))
    else if (eventId) { dismissedEvents.set(id, eventId); dismissNotice(eventId) }
  } catch (e) {
    if (card) goneCards.delete(card)
    else { gone.delete(id); dismissedEvents.delete(id) }
    errors.set(id, message(e))
  } finally {
    actionFlights.delete(key)
    rebuild()
  }
}

async function dismiss(id: string) {
  const item = feed?.items.find((i) => i.id === id)
  const eventId = item ? feedNoticeKey(item) : undefined
  if (eventId) { dismissedEvents.set(id, eventId); dismissNotice(eventId) }
  errors.delete(id)
  gone.add(id)
  dirs.set(id, -1)
  lefts.set(id, 'dismissed')
  rebuild()
  try {
    await api.foryouDismiss(id, eventId)
  } catch (e) {
    gone.delete(id)
    errors.set(id, message(e))
    rebuild()
  }
}

async function reply(id: string, text: string) {
  const event = feed?.items.find((i) => i.id === id)
  await api.foryouReply(id, text)
  if (event && isRequestNotice(event)) {
    dirs.set(id, 1)
    lefts.set(id, 'sent')
    const eventId = feedNoticeKey(event)
    dismissNotice(eventId)
  }
}

function flushSeen() {
  const ids = [...seenQueue]
  seenQueue.clear()
  if (!ids.length || !enabled) return
  api.foryouSeen(ids).catch(() => {
    // Not recorded: they count as unseen again, the next look marks them.
    for (const id of ids) seen.delete(id)
    rebuild()
  })
}

function markSeen(ids: string[]) {
  let changed = false
  for (const id of ids) {
    const it = feed?.items.find((i) => i.id === id)
    if (!it || it.seen || seen.has(id)) continue
    seen.add(id)
    seenQueue.add(id)
    changed = true
  }
  if (!changed) return
  rebuild()
  clearTimeout(seenTimer)
  seenTimer = setTimeout(flushSeen, SEEN_DELAY)
}

function more(id: string): Promise<string> {
  const key = `${getLang()}:${id}`
  const known = feed?.items.find((i) => i.id === id)?.moreText ?? moreTexts.get(key)
  if (known) return Promise.resolve(known)
  const flying = moreFlights.get(key)
  if (flying) return flying
  const p = api
    .foryouMore(id)
    .then((r) => {
      const text = humanFeedText(r.text)
      moreTexts.set(key, text)
      rebuild()
      return text
    })
    .finally(() => moreFlights.delete(key))
  moreFlights.set(key, p)
  return p
}

function refresh() {
  if (enabled) void load()
}

function showFresh() {
  if (!feed) return
  held = new Set()
  order = feed.items.map((i) => i.id)
  rebuild()
}

const error = (id: string) => errors.get(id)
const leaving = (id: string): 1 | -1 | 0 => dirs.get(id) ?? 0
const leftAs = (id: string): Left | undefined => lefts.get(id)
const setReading = (v: boolean) => void (reading = v)

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
const getView = () => view

export function useForYou(): ForYouStore {
  const open = useForYouOpen()
  const { snap } = useApp()
  const mark = snap.foryou
  const authors = snap.config.authors
  const appLang = useLang()
  useEffect(() => sync(mark, authors, appLang), [mark, mark?.rev, mark?.unseen, authors, snap.version, appLang])
  const v = useSyncExternalStore(subscribe, getView, getView)
  return useMemo(() => ({ ...v, showFresh, act: async (id: string, action: string, card?: string) => {
    const projectId = feed?.items.find(item => item.id === id)?.projectId
    const result = await act(id, action, card)
    // Handed to weevboss: the card stays under the eyes and says so (then shows its answer); only an existing session opens.
    if (result?.open && result.open.page !== 'boss') open(result.open, projectId)
  }, acting, dismiss, reply, markSeen, more, refresh, error, leaving, leftAs, setReading }), [v, open])
}

/** Tests only: a blank store. */
export function resetForYou() {
  actionFlights.clear()
  resetNotices()
  dismissedEvents.clear()
  feed = null
  order = []
  held = new Set()
  for (const s of [gone, goneCards, seen, seenQueue]) s.clear()
  for (const m of [moreTexts, moreFlights, errors, dirs, lefts, handed]) m.clear()
  lang = undefined
  reading = false
  enabled = false
  markUnseen = 0
  wanted = undefined
  loading = false
  again = false
  clearTimeout(seenTimer)
  authorColors = new Map()
  view = EMPTY
  for (const l of listeners) l()
}

// ---------------------------------------------------------------------------
// Who speaks, and in which colour.

const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)
const slot = (name: string): CSSProperties => ({ '--c': `var(--${name})` }) as CSSProperties
const NOT_AUTHORS = new Set(['weevboss', 'session', 'weevils'])
const IDEAS = new Set(['proposals', 'improve', 'insight', 'milestone'])

/** A finished result: a green drawn from --fluo per theme (foryou.css); without that sheet, the app's other readable green. */
const OK = 'var(--fy-ok, var(--devil-reply))'

/** An outside author's own colour, brought to the theme's band lightness (same idea as .msg.orch.ext in styles.css).
 * The --fy-who-* factors are set per theme in foryou.css; without them the colour is used as declared. */
const authorColor = (c: string) => `oklch(from ${c} calc(l * var(--fy-who-lm, 1) + var(--fy-who-la, 0)) calc(c * var(--fy-who-k, 1)) h)`

/** The colour of a proposal card: the auto band's palette, kept apart from the auto amber and from its neighbours. */
export function cardSlots(ids: string[], kept: ReadonlyMap<string, string> = new Map()): Map<string, string> {
  return propColors(ids, kept, null)
}

/** The band's --c for this item: project colour, author colour, weevboss, or the colour of its tone. */
export function itemSlot(item: ForYouItem, colors: Record<string, string>, authors?: (id?: string) => { color: string }): CSSProperties {
  const project = item.projectId ? colors[item.projectId] : undefined
  const own = slot(project ?? 'agent')
  // Never anxious: something that needs the user is drawn in the calm amber of a question, never the alert red.
  if (item.kind === 'alert' || item.tone === 'alert') return project ? own : slot('h24')
  if (item.tone === 'result') return project ? own : { '--c': OK } as CSSProperties
  if (item.tone === 'question') return project ? own : slot('h24')
  switch (item.kind) {
    case 'boss':
      return slot('agent')
    case 'mail': {
      if (NOT_AUTHORS.has(item.who)) return own
      const c = authors?.(item.who).color ?? authorColors.get(item.who) ?? `var(--p${hash(item.who) % 16})`
      return c ? ({ '--c': authorColor(c) } as CSSProperties) : slot('agent')
    }
    case 'proposals':
      return slot(cardSlots(item.cards?.length ? [item.cards[0].id] : [item.id]).values().next().value ?? 'p9')
    case 'improve':
      return slot('p13')
    case 'insight':
    case 'milestone':
      return project ? own : slot(`p${hash(item.id) % 16}`)
    case 'stat':
      return project ? own : slot('calm')
    default:
      return own
  }
}

/** The speaker shown on the item. */
export function itemWho(item: ForYouItem, authors: (id?: string) => { name: string }, projectName?: string): string {
  if (item.who === 'weevboss' || item.who === 'weevils') return item.who
  if (item.who === 'session') return projectName ?? item.title ?? tr(M).aSession
  return authors(item.who).name
}

/** The participants line: everything, weevboss, each outside author present, sessions, media, ideas. */
export const WHO_ALL = 'all'
export function participants(items: readonly ForYouItem[]): string[] {
  const authors = [...new Set(items.map((i) => i.who).filter((w) => !NOT_AUTHORS.has(w)))]
  return [
    WHO_ALL,
    'weevboss',
    ...authors,
    ...(items.some((i) => i.kind === 'session') ? ['session'] : []),
    ...(items.some((i) => i.kind === 'media') ? ['media'] : []),
    ...(items.some((i) => IDEAS.has(i.kind)) ? ['ideas'] : []),
  ]
}

export function matchesWho(item: ForYouItem, who: string): boolean {
  if (who === WHO_ALL) return true
  if (who === 'session') return item.kind === 'session'
  if (who === 'media') return item.kind === 'media'
  if (who === 'ideas') return IDEAS.has(item.kind)
  return item.who === who
}
