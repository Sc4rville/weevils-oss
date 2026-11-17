import { noticeKey, quotaReset, relayPlanNoticeKey } from '../../shared/notices.ts'
import { Notice, useNotices } from './notice'
import { dismissNotice, isNoticeDismissed } from './notice-store'
import { useEffect, useState } from 'react'
import type { ClaudeAccountLine, RelayMode, RelayPlan, Session } from '../../shared/api.ts'
import { startSetup } from './setup'
import { api } from '../api'
import { intlLocale, useT } from '../i18n'
import M from '../i18n/relay'
import { useApp } from './app-context'
import { Line, Prose } from './bits'
import { Shell } from './shell'

// Codex relay while Claude is at its usage limit (server/relay.ts): the alert band of the feed, the grouped view of the
// takeover plans (approve, adjust or wait for Claude, one by one or all at once), the plan inside a session's page and
// under weevboss' thread, the setting.

const MODES: RelayMode[] = ['ask', 'auto', 'never']
const SWITCHES = [90, 95, 97, 99]

/** « 18 h », with the day when it is not today. */
function useClock() {
  const t = useT(M)
  return (at: number, now: number) => {
    const d = new Date(at)
    const clock = t.clock(d.getHours(), d.getMinutes())
    return at - now < 20 * 3600_000 ? clock : `${d.toLocaleDateString(intlLocale(), { weekday: 'long' })} ${clock}`
  }
}

/** One line saying where Claude stands: « limite Claude atteinte · jusqu'à 18 h · weevboss répond par Codex ». */
function useStatus() {
  const { snap, now } = useApp()
  const t = useT(M)
  const clock = useClock()
  const r = snap.relay
  if (!r?.limit) return null
  return [t.limit(r.limit.kind, r.limit.percent), r.limit.until ? t.until(clock(r.limit.until, now)) : '', r.boss ? t.boss : ''].filter(Boolean).join(' · ')
}

const open = (plans: RelayPlan[]) => plans.filter((p) => !p.resolved && (p.state === 'ready' || p.state === 'failed' || p.state === 'preparing'))

/** In the feed, above the projects: shown only while Claude is unavailable or plans wait for a decision. */
export function RelayBand() {
  useNotices()
  const { snap, push } = useApp()
  const t = useT(M)
  const status = useStatus()
  const r = snap.relay
  if (!r || r.mode !== 'ask') return null
  const todo = r.plans.filter((p) => !p.resolved && !isNoticeDismissed(relayPlanNoticeKey(p)) && (p.state === 'ready' || p.state === 'failed')).length
  const coming = r.plans.filter((p) => !p.resolved && p.state === 'preparing').length
  if (!status && !todo && !coming) return null
  return (
    <Notice eventId={noticeKey("relay", r.limit?.since, r.limit?.window, quotaReset(r.limit?.until ?? 0), r.limit ? null : r.plans.map((p) => [p.sessionId, p.at]))} className="band relay-band" aria-label={t.title}>
      <button className="relay-band-row" onClick={() => push({ kind: 'relay' })}>
        <span className="in">
          <span aria-hidden>⇄</span>
          <span className="relay-band-text">{[status, todo ? t.toApprove(todo) : '', coming ? t.preparing(coming) : ''].filter(Boolean).join(' · ')}</span>
          <span aria-hidden>→</span>
        </span>
      </button>
    </Notice>
  )
}

/** A takeover plan: what Codex wrote, and the three answers. `bare`: without its title (inside the session's own page). */
export function PlanCard({ plan, bare, onError }: { plan: RelayPlan; bare?: boolean; onError?: (e: string) => void }) {
  const { snap, push } = useApp()
  const t = useT(M)
  const [busy, setBusy] = useState<string | null>(null)
  const [adjusting, setAdjusting] = useState(false)
  const [note, setNote] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const act = (action: 'go' | 'adjust' | 'wait', text?: string) => {
    setBusy(action)
    setErr(null)
    onError?.('')
    void api
      .relayDecide(plan.sessionId, action, text)
      .then(() => {
        dismissNotice(relayPlanNoticeKey(plan))
        setAdjusting(false)
        setNote('')
      })
      .catch((e) => {
        setErr((e as Error).message)
        onError?.((e as Error).message)
      })
      .finally(() => setBusy(null))
  }
  if (plan.resolved) return null
  const canDecide = snap.relay?.mode === 'ask'
  const decidable = canDecide && (plan.state === 'ready' || plan.state === 'failed' || plan.state === 'preparing')
  const project = snap.projects.find((p) => p.id === plan.projectId)?.name ?? plan.projectId
  return (
    <Notice closable={false} eventId={relayPlanNoticeKey(plan)} className="msg band relay-plan" role="group" aria-label={t.planAria(plan.title)}>
      <div className="in">
        {!bare && (
          <button className="link relay-plan-title" onClick={() => push({ kind: 'session', id: plan.sessionId })}>
            {plan.title}
          </button>
        )}
        <span className="who">
          ⇄ {t[`state_${plan.state}`]}
          {!bare && ` · ${project}`}
          {plan.auto ? ` · ${t.auto}` : ''}
          {plan.refreshing ? ` · ${t.refreshing}` : ''}
        </span>
        {/* Une fois le relais parti, le plan n'est plus à lire ici : il est dans la session Codex. */}
        {plan.text && plan.state !== 'running' && (
          <div className="relay-plan-text">
            <Prose text={plan.text} />
          </div>
        )}
        {(err ?? plan.error) && <Notice eventId={noticeKey("error:relay-plan", plan.sessionId, err ?? plan.error)} className="text meta" role="alert">{err ?? plan.error}</Notice>}
        {decidable && (
          <div className="cut-actions">
            <button className="resume" disabled={!!busy || plan.state === 'preparing'} onClick={() => act('go')}>
              {t.go}
            </button>
            <button className="link" disabled={!!busy} aria-expanded={adjusting} onClick={() => setAdjusting((v) => !v)}>
              {t.adjust}
            </button>
            <button className="link" disabled={!!busy} onClick={() => act('wait')}>
              {snap.relay?.limit ? t.wait : t.backToClaude}
            </button>
          </div>
        )}
        {decidable && adjusting && (
          <form
            className="relay-adjust"
            onSubmit={(e) => {
              e.preventDefault()
              if (note.trim()) act('adjust', note.trim())
            }}
          >
            <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder={t.adjustPlaceholder} aria-label={t.adjustPlaceholder} rows={2} />
            <button className="link" disabled={!note.trim() || !!busy}>
              {t.send}
            </button>
          </form>
        )}
        {canDecide && plan.state === 'waiting' && (
          <div className="cut-actions">
            <button className="link" disabled={!!busy} onClick={() => act('go')}>
              {t.go}
            </button>
          </div>
        )}
        {plan.state === 'running' && plan.relayTo && (
          <div className="cut-actions">
            <button className="link" onClick={() => push({ kind: 'session', id: plan.relayTo! })}>
              {t.openCodex} →
            </button>
          </div>
        )}
      </div>
    </Notice>
  )
}

/** The plans that wait for a decision, under weevboss' thread. */
export function ThreadPlans() {
  useNotices()
  const { snap } = useApp()
  const list = open(snap.relay?.plans ?? []).filter((p) => !isNoticeDismissed(relayPlanNoticeKey(p)))
  if (snap.relay?.mode !== 'ask' || !list.length) return null
  return (
    <div className="relay-thread">
      <AllActions plans={list} />
      {list.map((p) => (
        <PlanCard key={p.sessionId} plan={p} />
      ))}
    </div>
  )
}

function AllActions({ plans }: { plans: RelayPlan[] }) {
  useNotices()
  const { snap } = useApp()
  const t = useT(M)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const ready = plans.filter((p) => !p.resolved && !isNoticeDismissed(relayPlanNoticeKey(p)) && (p.state === 'ready' || p.state === 'failed'))
  if (snap.relay?.mode !== 'ask') return null
  if (ready.length < 2) return err ? <Notice eventId={noticeKey('error:relay-all', err)} role="alert" className="in">{err}</Notice> : null
  const all = (action: 'go' | 'wait') => {
    setBusy(true)
    setErr(null)
    void api
      .relayDecide('all', action)
      .then(() => { for (const p of ready) dismissNotice(relayPlanNoticeKey(p)) })
      .catch((e) => setErr((e as Error).message))
      .finally(() => setBusy(false))
  }
  return (
    <div className="in cut-actions relay-all">
      {err && <Notice eventId={noticeKey("error:relay-all", err)} role="alert">{err}</Notice>}
      <button className="resume" disabled={busy} onClick={() => all('go')}>
        {t.all}
      </button>
      <button className="link" disabled={busy} onClick={() => all('wait')}>
        {t.allWait}
      </button>
    </div>
  )
}

/** The grouped view: where Claude stands, every plan, the setting. */
export function RelayPage() {
  useNotices()
  const { snap } = useApp()
  const t = useT(M)
  const status = useStatus()
  const r = snap.relay
  const [err, setErr] = useState<string | null>(null)
  const set = (o: { mode?: RelayMode; switchAt?: number }) => void api.relaySet(o).catch((e) => setErr((e as Error).message))
  // Ce qui attend une décision d'abord, puis ce qui attend Claude, puis ce que Codex a déjà repris.
  const rank = { ready: 0, failed: 0, preparing: 0, waiting: 1, running: 2 } as const
  const plans = (r?.plans ?? []).filter((p) => !p.resolved && !isNoticeDismissed(relayPlanNoticeKey(p))).sort((a, b) => rank[a.state] - rank[b.state] || a.at - b.at)
  return (
    <Shell slot="agent" kicker="weevils" title={t.title}>
      <div className="ipage relay-page">
        <div className="in relay-status">{status ?? t.idle}</div>
        {r && !r.codex && <div className="in meta">{t.noCodex}</div>}
        {err && <Notice eventId={noticeKey("error:relay-setting", err)} className="in meta" role="alert">{err}</Notice>}
        {plans.length > 0 && <div className="in label">{t.plans}</div>}
        <AllActions plans={plans} />
        {plans.map((p) => (
          <PlanCard key={p.sessionId} plan={p} onError={setErr} />
        ))}
        {r?.accounts && <Accounts accounts={r.accounts} />}
        <div className="in label">{t.mode}</div>
        <div className="in words" role="group" aria-label={t.mode}>
          {MODES.map((m) => (
            <button key={m} className={`word ${r?.mode === m ? 'on' : ''}`} aria-pressed={r?.mode === m} onClick={() => set({ mode: m })}>
              {t[`mode_${m}`]}
            </button>
          ))}
        </div>
        <div className="in label">{t.switchAt}</div>
        <div className="in words" role="group" aria-label={t.switchAt}>
          {[...new Set([...SWITCHES, r?.switchAt ?? 97])]
            .sort((a, b) => a - b)
            .map((n) => (
              <button key={n} className={`word ${r?.switchAt === n ? 'on' : ''}`} aria-pressed={r?.switchAt === n} onClick={() => set({ switchAt: n })}>
                {t.percent(n)}
              </button>
            ))}
        </div>
      </div>
    </Shell>
  )
}

/** Several Claude accounts of the user's own: one line each (number, e-mail, the fullest window), a tap to add one. */
function Accounts({ accounts }: { accounts: ClaudeAccountLine[] }) {
  const t = useT(M)
  return (
    <>
      <div className="in label">{t.accounts}</div>
      {accounts.map((a) => (
        <Line key={a.id} go={null} className={a.active ? 'on' : ''} meta={!a.logged ? t.accountOut : a.percent === null ? '' : t.percent(a.percent)}>
          {[t.account(a.n), a.label, a.active ? t.accountInUse : ''].filter(Boolean).join(' · ')}
        </Line>
      ))}
      <Line onClick={() => void startSetup('account').catch(() => undefined)}>{t.addAccount}</Line>
    </>
  )
}

/** The bottom band: the setting, one line that opens the page. */
export function RelayPrefLine() {
  const { snap, push } = useApp()
  const t = useT(M)
  // The server writes « until 6 pm » in the time zone of the device.
  useEffect(() => {
    try {
      void api.relaySet({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone }).catch(() => undefined)
    } catch {
      /* no time zone: the server's */
    }
  }, [])
  if (!snap.relay) return null
  return (
    <Line ch="⇄" meta={t[`mode_${snap.relay.mode}`]} onClick={() => push({ kind: 'relay' })}>
      {t.pref}
    </Line>
  )
}

/** In a session's page: its plan, its link to the session on the other side of the relay, or the button that asks for a plan. */
export function SessionRelay({ session, onError }: { session: Session; onError: (e: string) => void }) {
  const { snap, push } = useApp()
  const t = useT(M)
  const [asked, setAsked] = useState(false)
  const plan = snap.relay?.plans.find((p) => p.sessionId === session.id)
  const from = session.relayOf ? snap.sessions.find((s) => s.id === session.relayOf) : undefined
  return (
    <>
      {session.relayOf && (
        <div className="in relay-link">
          <button className="link" onClick={() => push({ kind: 'session', id: session.relayOf! })}>
            ⇄ {from ? t.relayOf(from.title) : t.openClaude}
          </button>
        </div>
      )}
      {session.relayedBy && !plan && (
        <div className="in relay-link">
          <button className="link" onClick={() => push({ kind: 'session', id: session.relayedBy! })}>
            ⇄ {t.relayedBy} →
          </button>
        </div>
      )}
      {plan && <PlanCard plan={plan} bare onError={onError} />}
      {!plan && session.tool === 'claude' && session.status === 'interrupted' && snap.relay?.codex && (
        <div className="in relay-link">
          <button
            className="link"
            disabled={asked}
            onClick={() => {
              setAsked(true)
              void api.relayRequest(session.id).catch((e) => {
                setAsked(false)
                onError((e as Error).message)
              })
            }}
          >
            ⇄ {t.askPlan}
          </button>
        </div>
      )}
    </>
  )
}
