// The requests page (bottom of the machines band): weevboss's request ledger, read by the user in plain words.
//
// One page, no tabs, no counters: the goals (a short name and « 8/11 »), each with its open requests, then the requests
// with no goal, then the messages still being read, then what is closed, folded. A request is one line: a short title
// and one honest word read from its real session (in progress, waiting on you, stuck, to check, not started), with
// how long it has been quiet when it is not in progress. A tap opens it in place: the user's exact words, where it
// was sent (a tap opens that session), what came back; « done » and « drop » close it. The work journal (trace) stays
// in `weevils trace`: nobody read it here.

import { motion } from 'motion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionStatus } from '../../shared/api.ts'
import type { Ask, Dispatch } from '../../shared/ledger.ts'
import type { LedgerView } from '../../shared/ledger.ts'
import { noticeKey } from '../../shared/notices.ts'
import { api } from '../api'
import { getLang, useT } from '../i18n'
import M from '../i18n/requests'
import { useApp } from './app-context'
import { Collapse, spring } from './bits'
import { Notice } from './notice'
import { Shell } from './shell'
import './requests.css'

type Row = LedgerView['asks'][number]

const hhmm = (at: number) => new Date(at).toLocaleTimeString(getLang(), { hour: '2-digit', minute: '2-digit' })

/** « weevils · claude · Onboarding link » → « weevils · Onboarding link » ; no label: a plain word, never a session id. */
const who = (d: Dispatch, none: string) => {
  const p = (d.label ?? '').split(' · ')
  return p.length >= 3 ? `${p[0]} · ${p.slice(2).join(' · ')}` : d.label || none
}

type Chip = 'queued' | 'running' | 'blocked' | 'needs' | 'check' | 'paused' | 'done' | 'dropped'

/** A title that fits one line: its first clause (« Prepare the fix: show the… » → « Prepare the fix »). The whole
 *  sentence stays in the opened request. */
export const shortTitle = (text: string) => {
  const cut = text.split(/: | — | – |\. /)[0].trim()
  return cut.length >= 12 ? cut : text
}

/**
 * The one word that says where a request stands, read from the real session it was sent to (never from the ledger's
 * « dispatched » alone: a session gone for days is not running). `session`: its state, 'gone' when it no longer
 * exists, undefined when nothing was sent. Exported for tests.
 */
export function chipOf(a: Row, session?: SessionStatus | 'gone'): Chip {
  if (a.status === 'done') return 'done'
  if (a.status === 'dropped') return 'dropped'
  const d = a.dispatches.at(-1)
  if (!d) return 'queued'
  if (session === 'working') return 'running'
  if (session === 'needs_user') return 'needs'
  // Its session finished long ago, or no longer exists, and nobody closed it: nothing is happening, said plainly
  // (a failure or a question days old included: it opens with the report).
  if (a.stale || session === 'gone') return 'paused'
  if (session === 'interrupted' || d.outcome === 'failed') return 'blocked'
  if (d.outcome === 'question') return 'needs'
  return 'check'
}

/** « drop »: a first tap arms it, a second one (within 3 s) drops. */
function Drop({ onDrop }: { onDrop: () => void }) {
  const t = useT(M)
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const tm = setTimeout(() => setArmed(false), 3000)
    return () => clearTimeout(tm)
  }, [armed])
  return (
    <button className={armed ? 'req-btn on' : 'req-btn'} onClick={() => (armed ? onDrop() : setArmed(true))}>
      {armed ? t.sure : t.drop}
    </button>
  )
}

function AskRow({ a, open, state, onToggle, onAction }: { a: Row; open: boolean; state?: SessionStatus | 'gone'; onToggle: () => void; onAction: (action: 'done' | 'drop' | 'open') => void }) {
  const t = useT(M)
  const { push } = useApp()
  const live = a.status === 'open' || a.status === 'dispatched'
  const chip = chipOf(a, state)
  const words = [{ quote: a.quote, at: a.at, from: a.from }, ...(a.more ?? [])]
  return (
    <motion.div layout="position" transition={spring} className={`req-item c-${chip}${open ? ' band tone open' : ''}${a.stale ? ' stale' : ''}`}>
      <div className="in req-line">
        <button className="req-main" onClick={onToggle} aria-expanded={open}>
          <span className="req-text">{open ? a.text : shortTitle(a.text)}</span>
          <span className={`meta req-chip c-${chip}`}>{t.chip(chip)}</span>
        </button>
      </div>
      <Collapse open={open}>
        <div className="in req-detail">
          {words.map((w, i) => (
            <div key={i} className="req-said">
              <blockquote className="req-quote">“{w.quote}”</blockquote>
              <div className="meta">{i === 0 ? t.yourWords : ''}{w.from !== 'user' ? ` · ${t.from(w.from)}` : ''}{i === 0 ? ' · ' : ''}{hhmm(w.at)}</div>
            </div>
          ))}
          {a.dispatches.map((d) => (
            <div key={d.session + d.at} className="req-dispatch">
              <button type="button" className="link req-who" onClick={() => push({ kind: 'session', id: d.session })}>→ {who(d, t.aSession)}</button>
              {d.expect && <div className="meta"><span className="strong">{t.expects}</span> {d.expect}</div>}
              {d.report && <div className="meta"><span className="strong">{t.report}</span> {d.report}</div>}
            </div>
          ))}
          {!a.dispatches.length && a.note && <div className="meta">{a.note}</div>}
          <div className="req-actions">
            {live ? (
              <>
                <button className="req-btn" onClick={() => onAction('done')}>{t.markDone}</button>
                <Drop onDrop={() => onAction('drop')} />
              </>
            ) : (
              <button className="req-btn" onClick={() => onAction('open')}>{t.reopen}</button>
            )}
          </div>
        </div>
      </Collapse>
    </motion.div>
  )
}

function GoalHead({ g }: { g: LedgerView['goals'][number] }) {
  return (
    <div className="band tone req-goal">
      <div className="in req-goal-line">
        <span className="req-goal-title">{shortTitle(g.title)}</span>
        <span className="meta req-goal-n">{g.done}/{g.total}</span>
      </div>
    </div>
  )
}

export function RequestsPage() {
  const t = useT(M)
  const { snap, colors } = useApp()
  const [v, setV] = useState<LedgerView | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [showDone, setShowDone] = useState(false)
  const [showPaused, setShowPaused] = useState(false)
  const last = useRef(0)
  const load = useCallback(() => api.ledger().then((r) => { last.current = Date.now(); setV(r); setErr(null) }).catch((e) => setErr((e as Error).message)), [])
  useEffect(() => void load(), [snap.asksOpen, load])
  useEffect(() => {
    if (Date.now() - last.current > 8000) void load()
  }, [snap.version, load])

  const act = (a: Ask) => (action: 'done' | 'drop' | 'open') => void api.askAction(a.id, action).then(load).catch((e) => setErr((e as Error).message))

  const stateOf = (a: Row): SessionStatus | 'gone' | undefined => {
    const d = a.dispatches.at(-1)
    return d ? (sessionState.get(d.session) ?? 'gone') : undefined
  }
  const asks = v?.asks ?? []
  const sessionState = new Map<string, SessionStatus>(snap.sessions.map((x) => [x.id, x.status]))
  const open_ = asks.filter((a) => a.status === 'open' || a.status === 'dispatched')
  // Where nothing happens (paused) is folded under one line: the page shows what moves or waits on you.
  const live = open_.filter((a) => chipOf(a, stateOf(a)) !== 'paused')
  const paused = open_.filter((a) => chipOf(a, stateOf(a)) === 'paused').sort((x, y) => y.at - x.at)
  const closed = asks.filter((a) => a.status === 'done' || a.status === 'dropped').sort((x, y) => (y.closedAt ?? y.at) - (x.closedAt ?? x.at))
  // What waits on you first, then the newest.
  const order = (l: Row[]) => [...l].sort((x, y) => Number(chipOf(y, stateOf(y)) === 'needs') - Number(chipOf(x, stateOf(x)) === 'needs') || y.at - x.at)
  const goals = (v?.goals ?? []).filter((g) => g.status === 'active')
  const row = (a: Row) => <AskRow key={a.id} a={a} state={stateOf(a)} open={open === a.id} onToggle={() => setOpen(open === a.id ? null : a.id)} onAction={act(a)} />

  return (
    <Shell slot={colors.__foot ?? 'p3'} kicker="weevboss" title={t.title}>
      {err && (
        <Notice eventId={noticeKey('error:requests', location.pathname, location.hash, err)} className="band invert" role="alert">
          <div className="in meta" style={{ paddingBlock: 12 }}>! {err}</div>
        </Notice>
      )}
      {v && (
        <>
          {goals.map((g) => {
            const mine = order(live.filter((a) => a.goal === g.id))
            if (!mine.length) return null
            return (
              <section key={g.id} className="req-group">
                <GoalHead g={g} />
                {mine.map(row)}
              </section>
            )
          })}
          {live.some((a) => !a.goal || !goals.some((g) => g.id === a.goal)) && (
            <section className="req-group">
              <div className="in meta strong req-day">{t.noGoal}</div>
              {order(live.filter((a) => !a.goal || !goals.some((g) => g.id === a.goal))).map(row)}
            </section>
          )}
          {!!v.pending.length && (
            <section className="req-group">
              <div className="in meta strong req-day">{t.reading}</div>
              {v.pending.map((p) => (
                <div key={p.cid} className="in req-pending">
                  <span className="st" aria-hidden>…</span>
                  <span className="req-quote small">“{p.text}”</span>
                </div>
              ))}
            </section>
          )}
          {!live.length && !v.pending.length && <div className="in meta req-empty">{t.nothingOpen}</div>}
          {!!paused.length && (
            <section className="req-group">
              <button className="in meta strong req-day req-fold" aria-expanded={showPaused} onClick={() => setShowPaused(!showPaused)}>{t.pausedN(paused.length)}</button>
              <Collapse open={showPaused}>{paused.map(row)}</Collapse>
            </section>
          )}
          {!!closed.length && (
            <section className="req-group">
              <button className="in meta strong req-day req-fold" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>{t.closedN(closed.length)}</button>
              <Collapse open={showDone}>{closed.slice(0, 30).map(row)}</Collapse>
            </section>
          )}
        </>
      )}
      <div style={{ height: 96 }} />
    </Shell>
  )
}
