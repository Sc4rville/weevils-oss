// A project's page (the « > » beside its « / » on the home band): what is being done right now across all its sessions,
// then its to-do (the user's open requests sent to it), then its sessions. No headings, no counters, no boxes: weight says what is active.
//
// The to-do comes from weevboss's request ledger (GET /api/boss/ledger). A request belongs to a project through the
// session it was last sent to (that session's project; a session gone from the snapshot is matched by the project
// name its dispatch label starts with), or, never sent, when its words name the project.

import { useEffect, useRef, useState } from 'react'
import type { Session, SessionStatus } from '../../shared/api.ts'
import type { LedgerView } from '../../shared/ledger.ts'
import { api } from '../api'
import { useT } from '../i18n'
import M from '../i18n/project-screen'
import { useApp } from './app-context'
import { SessionRow } from './bits'
import { Shell } from './shell'
import { chipOf } from './requests'
import './project-screen.css'

type Row = LedgerView['asks'][number]
type Chip = ReturnType<typeof chipOf>

const FEED_MAX = 4
const TODO_MAX = 6
const OLDER_AFTER = 6

/** What runs now in a project, newest first: one short plain line per working session (its current activity). */
export function feedOf(sessions: Session[]): { id: string; text: string }[] {
  return sessions
    .filter((s) => !s.archived && s.status === 'working')
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .slice(0, FEED_MAX)
    .map((s) => ({ id: s.id, text: (s.now || s.title).trim() }))
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Does this request belong to this project? See the header. Exported for tests. */
export function inProject(a: Row, project: { id: string; name: string }, byId: Map<string, Session>): boolean {
  const d = a.dispatches.at(-1)
  if (d) {
    const s = byId.get(d.session)
    if (s) return s.projectId === project.id
    return (d.label ?? '').split(' · ')[0].trim().toLowerCase() === project.name.toLowerCase()
  }
  if (project.name.length < 3) return false
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escape(project.name)}($|[^\\p{L}\\p{N}])`, 'iu').test(`${a.text} ${a.quote}`)
}

/** Waiting on you first, then what moves, then what waits to be checked or started, then what sleeps. */
const RANK: Record<Chip, number> = { needs: 0, running: 1, check: 2, queued: 3, blocked: 4, paused: 5, done: 9, dropped: 9 }

/** The project's open requests, in reading order, each with its chip. Exported for tests. */
export function todoOf(asks: Row[], project: { id: string; name: string }, sessions: Session[]): { a: Row; chip: Chip }[] {
  const byId = new Map(sessions.map((s) => [s.id, s]))
  const stateOf = (a: Row): SessionStatus | 'gone' | undefined => {
    const d = a.dispatches.at(-1)
    return d ? (byId.get(d.session)?.status ?? 'gone') : undefined
  }
  return asks
    .filter((a) => (a.status === 'open' || a.status === 'dispatched') && inProject(a, project, byId))
    .map((a) => ({ a, chip: chipOf(a, stateOf(a)) }))
    .sort((x, y) => RANK[x.chip] - RANK[y.chip] || y.a.at - x.a.at)
}

/** The user's own words on one line; what doesn't fit fades at the edge. */
const oneLine = (q: string) => q.replace(/\s+/g, ' ').trim()

/** Bold is kept for what runs (the lines above) and what waits on you; sent and in progress stay regular; asleep dims. */
const weight = (c: Chip) => (c === 'needs' ? 'on' : c === 'paused' || c === 'blocked' ? 'rest' : '')

/** The ledger, read while the project is open: again when a request opens or closes, at most every 30 s otherwise. */
function useLedger(): LedgerView | null {
  const { snap } = useApp()
  const [v, setV] = useState<LedgerView | null>(null)
  const last = useRef(0)
  const load = () => {
    last.current = Date.now()
    api.ledger().then(setV).catch(() => undefined)
  }
  useEffect(load, [snap.asksOpen])
  useEffect(() => {
    if (Date.now() - last.current > 30_000) load()
  }, [snap.version])
  return v
}

/** What is being done now, then the to-do. Nothing running and nothing open: nothing at all. */
export function ProjectNow({ project, sessions }: { project: { id: string; name: string }; sessions: Session[] }) {
  const t = useT(M)
  const { push, snap } = useApp()
  const ledger = useLedger()
  const feed = feedOf(sessions)
  const todo = ledger ? todoOf(ledger.asks, project, snap.sessions) : []
  const shown = todo.slice(0, TODO_MAX)
  const open = (a: Row) => {
    const d = a.dispatches.at(-1)
    push(d && snap.sessions.some((s) => s.id === d.session) ? { kind: 'session', id: d.session } : { kind: 'requests' })
  }
  if (!feed.length && !todo.length) return null
  return (
    <div className="in pj">
      {!!feed.length && (
        <ul className="pj-feed" aria-label={t.now}>
          {feed.map((f) => (
            <li key={f.id}>
              <button type="button" className="pj-line on" onClick={() => push({ kind: 'session', id: f.id })}>{f.text}</button>
            </li>
          ))}
        </ul>
      )}
      {!!shown.length && (
        <ul className="pj-todo" aria-label={t.todo}>
          {shown.map(({ a, chip }) => (
            <li key={a.id}>
              <button type="button" className={`pj-line ${weight(chip)}`} onClick={() => open(a)} title={a.text}>“{oneLine(a.quote)}”</button>
            </li>
          ))}
          {todo.length > shown.length && (
            <li>
              <button type="button" className="pj-line rest" onClick={() => push({ kind: 'requests' })}>{t.more(todo.length - shown.length)}</button>
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

/** A project's own page (the « > » beside its « / »): what runs now, its to-do, then every session, the open ones first,
 *  then the finished ones newest first, a few, the rest one tap away. The home band keeps its own behaviour. */
export function ProjectPage({ projectId }: { projectId: string }) {
  const t = useT(M)
  const { snap, colors } = useApp()
  const [all, setAll] = useState(false)
  const project = snap.projects.find((p) => p.id === projectId)
  const sessions = snap.sessions.filter((s) => !s.archived && s.projectId === projectId)
  const rank = (s: Session) => (s.status === 'working' ? 0 : s.status === 'needs_user' || s.status === 'interrupted' ? 1 : 2)
  const open = sessions.filter((s) => s.status !== 'done').sort((a, b) => rank(a) - rank(b) || b.openedAt - a.openedAt)
  const done = sessions.filter((s) => s.status === 'done').sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  const shown = all ? done : done.slice(0, OLDER_AFTER)
  return (
    <Shell slot={colors[projectId] ?? 'agent'} kicker="weevils" title={project?.name ?? '…'}>
      <div className="pj-page">
        {project && <ProjectNow project={project} sessions={sessions} />}
        {[...open, ...shown].map((s) => <SessionRow key={s.id} session={s} />)}
        {done.length > shown.length && (
          <div className="in pj-older">
            <button type="button" className="pj-line rest" onClick={() => setAll(true)}>{t.older(done.length - shown.length)}</button>
          </div>
        )}
        <div style={{ height: 96 }} />
      </div>
    </Shell>
  )
}
