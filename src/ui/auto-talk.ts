// Talking a task over (the negotiation), shared by the drawer and the automation page: the question in flight, the
// reply, the task as rewritten before the snapshot follows, what changed (it flashes), and ✓ / × answered once for both.
import { createContext, createElement, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Optimizer, OptimizerField } from '../../shared/api.ts'
import { noticeKey } from '../../shared/notices.ts'
import { dismissNotice } from './notice-store'
import { api, ApiError } from '../api'
import { tr } from '../i18n'
import M from '../i18n/h24'
import { useApp } from './app-context'

/** What a reply can rewrite, and the exchange: the version received with the reply, before the snapshot follows. */
const TALKED = ['draft', 'title', 'why', 'kind', 'repo', 'est', 'priority', 'heavy', 'notBefore', 'window', 'every', 'next', 'talk', 'changed', 'rev'] as const
/** What a reader compares between two versions of a task (the fields that flash). */
const SHOWN = ['title', 'why', 'kind', 'repo', 'est', 'priority', 'heavy', 'notBefore', 'window', 'every'] as const
/** ✓ refused because the version on screen was old, and no newer one comes: ✓ works again after this. */
const STALE_MS = 30_000
const FLASH_MS = 1700
/** After a rewrite, ✓ and × wait this long: the finger that was reading never launches nor refuses a changed card. */
export const SETTLE_MS = 450

export interface Talks {
  create: () => Promise<Optimizer>
  find: (id: string) => Optimizer | undefined
  /** The task whose field is open (kept for callers that fold one open at a time). */
  open: string | null
  setOpen: (id: string | null) => void
  /** A question in flight (✓ waits), and its text, shown at once. */
  busy: ReadonlySet<string>
  asking: ReadonlyMap<string, string>
  /** No reply (model, network): the note to show, nothing changed. */
  notes: ReadonlyMap<string, string>
  flash: ReadonlyMap<string, OptimizerField[]>
  /** The last reply to a spoken question: the voice logo reads it. */
  reply: { key?: string; text?: string }
  item: (o: Optimizer) => Optimizer
  send: (id: string, text: string, voice?: boolean) => Promise<boolean>
  /** When the last reply on this task landed, when a field was opened (performance.now()). */
  landedAt: (id: string) => number
  openedAt: () => number
  /** ✓ refused (409): the version on screen was old; the note shows, ✓ waits for the new one. */
  stale: (o: Optimizer, note: string) => void
  isStale: (o: Optimizer) => boolean
  /** ✓ or × given here or on the page, before the snapshot follows: accepted ones slide among the automations, refused
   *  ones fold away. */
  decided: ReadonlyMap<string, 'yes' | 'no'>
  /** ✓ (the version on screen, its rev) or ×. False when the tap came too soon after a rewrite or during one. */
  answer: (o: Optimizer, yes: boolean, onSuccess?: () => void) => boolean
}

export const TalkCtx = createContext<Talks | null>(null)

function without<V>(m: ReadonlyMap<string, V>, k: string): Map<string, V> {
  const n = new Map(m)
  n.delete(k)
  return n
}

export function useTalks(optimizers: Optimizer[] | undefined): Talks {
  const { refresh } = useApp()
  const [open, setOpenState] = useState<string | null>(null)
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [asking, setAsking] = useState<ReadonlyMap<string, string>>(new Map())
  const [notes, setNotes] = useState<ReadonlyMap<string, string>>(new Map())
  const [flashes, setFlashes] = useState<ReadonlyMap<string, OptimizerField[]>>(new Map())
  const [local, setLocal] = useState<ReadonlyMap<string, Optimizer>>(new Map())
  const [reply, setReply] = useState<{ key?: string; text?: string }>({})
  const [stales, setStales] = useState<ReadonlyMap<string, { o: Optimizer; at: number }>>(new Map())
  const [decided, setDecided] = useState<ReadonlyMap<string, 'yes' | 'no'>>(new Map())
  const created = useRef(new Map<string, Optimizer>())
  useEffect(() => {
    for (const o of optimizers ?? []) created.current.delete(o.id)
  }, [optimizers])
  const seq = useRef(0)
  const inflight = useRef(new Set<string>())
  const landed = useRef(new Map<string, number>())
  const opened = useRef(-Infinity)
  const setOpen = useCallback((id: string | null) => {
    opened.current = performance.now()
    setOpenState(id)
    setReply({})
  }, [])
  const mark = useCallback((id: string, fields: OptimizerField[]) => {
    setFlashes((m) => new Map(m).set(id, fields))
    window.setTimeout(() => setFlashes((m) => (m.get(id) === fields ? without(m, id) : m)), FLASH_MS)
  }, [])
  // The newer version after a refused ✓ is here: what differs from the one that was on screen flashes, ✓ waits a beat.
  useEffect(() => {
    if (!stales.size) return
    for (const [id, { o: was }] of stales) {
      const now = optimizers?.find((x) => x.id === id)
      if (!now || (now.rev ?? 0) === (was.rev ?? 0)) continue
      const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
      const fields = SHOWN.filter((f) => !same(was[f], now[f]))
      if (fields.length) mark(id, [...fields])
      landed.current.set(id, performance.now())
      setStales((m) => without(m, id))
    }
  }, [optimizers, stales, mark])
  // A decision the snapshot now shows (no longer proposed) is forgotten.
  useEffect(() => {
    if (!decided.size) return
    const left = [...decided.keys()].filter((id) => optimizers?.find((o) => o.id === id)?.state === 'proposed')
    if (left.length !== decided.size) setDecided((m) => new Map([...m].filter(([id]) => left.includes(id))))
  }, [optimizers, decided])
  const item = (o: Optimizer): Optimizer => {
    const l = local.get(o.id)
    if (!l || ((l.rev ?? 0) <= (o.rev ?? 0) && (l.talk?.length ?? 0) <= (o.talk?.length ?? 0))) return o
    const out: Record<string, unknown> = { ...o }
    for (const key of TALKED) out[key] = l[key]
    return out as unknown as Optimizer
  }
  const create = async () => {
    const { item } = await api.createOptimizer()
    created.current.set(item.id, item)
    setLocal((m) => new Map(m).set(item.id, item))
    refresh()
    return item
  }
  const find = (id: string) => optimizers?.find((o) => o.id === id) ?? created.current.get(id)
  const send = async (id: string, text: string, voice = false) => {
    const said = text.trim()
    if (!said || inflight.current.has(id)) return false
    inflight.current.add(id)
    setBusy((b) => new Set(b).add(id))
    setAsking((a) => new Map(a).set(id, said))
    setNotes((n) => without(n, id))
    try {
      const r = await api.talkOptimizer(id, said)
      if (r.item && !r.failed) setLocal((m) => new Map(m).set(id, r.item!))
      if (r.failed) setNotes((n) => new Map(n).set(id, r.reply))
      if (r.changed.length) mark(id, r.changed)
      setReply(voice && r.reply ? { key: String(++seq.current), text: r.reply } : {})
      return !r.failed
    } catch (e) {
      setNotes((n) => new Map(n).set(id, (e as Error).message))
      return false
    } finally {
      landed.current.set(id, performance.now())
      inflight.current.delete(id)
      setBusy((b) => {
        const n = new Set(b)
        n.delete(id)
        return n
      })
      setAsking((a) => without(a, id))
      refresh()
    }
  }
  const stale = useCallback((o: Optimizer, note: string) => {
    setStales((m) => new Map(m).set(o.id, { o, at: Date.now() }))
    setNotes((n) => new Map(n).set(o.id, note))
  }, [])
  const isStale = (o: Optimizer) => {
    const s = stales.get(o.id)
    return !!s && (s.o.rev ?? 0) === (o.rev ?? 0) && Date.now() - s.at < STALE_MS
  }
  const answer = (o: Optimizer, yes: boolean, onSuccess?: () => void) => {
    // Just rewritten (the card changed under the finger), or being rewritten: the tap was not meant for ✓ or ×.
    if ((yes && o.draft) || performance.now() - (landed.current.get(o.id) ?? -Infinity) < SETTLE_MS || (yes && (inflight.current.has(o.id) || isStale(o)))) return false
    setDecided((m) => new Map(m).set(o.id, yes ? 'yes' : 'no'))
    void (yes ? api.acceptOptimizer(o.id, o.rev ?? 0) : api.refuseOptimizer(o.id))
      .then(() => {
        dismissNotice(noticeKey('proposal', o.id))
        dismissNotice(noticeKey('proposal-card', `o:${o.id}`))
        onSuccess?.()
      })
      .catch((e) => {
        setDecided((m) => without(m, o.id))
        // Rewritten elsewhere (another screen) or being rewritten: it comes back, what changed flashes once the new
        // version is here, and ✓ waits for it.
        if (yes && e instanceof ApiError && e.status === 409) stale(o, tr(M).stale)
        else setNotes((n) => new Map(n).set(o.id, (e as Error).message))
      })
      .finally(refresh)
    return true
  }
  return { create, find, open, setOpen, busy, asking, notes, flash: flashes, reply, item, send, landedAt: (id) => landed.current.get(id) ?? -Infinity, openedAt: () => opened.current, stale, isStale, decided, answer }
}

/** One negotiation state for the drawer and the pages (App wraps both). */
export function TalkProvider({ children }: { children: ReactNode }) {
  const { snap } = useApp()
  return createElement(TalkCtx.Provider, { value: useTalks(snap.optimizers) }, children)
}

/** The shared negotiation state; a standalone one when nothing provides it (a test rendering the drawer alone). */
export function useTalk(): Talks {
  const shared = useContext(TalkCtx)
  const { snap } = useApp()
  const own = useTalks(shared ? undefined : snap.optimizers)
  return shared ?? own
}
