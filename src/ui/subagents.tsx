// Le travail d'arrière-plan d'une session, dans son fil : une ligne par sous-agent, étape de workflow ou commande
// lancée en arrière-plan (nom, ce qu'il fait, état, durée), dépliable pour voir ses derniers pas.

import { useIsPresent } from 'motion/react'
import { useEffect, useState } from 'react'
import type { Session, Subagent, SubagentDetail } from '../../shared/api.ts'
import { api } from '../api'
import { useT } from '../i18n'
import M from '../i18n/pages'
import { useApp } from './app-context'
import { Collapse, Line } from './bits'
import { activityText, dur, plain, step } from './format'
import { G, Icon } from './icons'

/** Un élément de la liste : une ligne seule, ou un workflow et ses étapes rangées par phase. */
export type SubItem =
  | { kind: 'one'; a: Subagent }
  | { kind: 'workflow'; name: string; phases: { phase?: string; items: Subagent[] }[]; live: boolean }

/** Le workflow lui-même, que le serveur envoie quand aucune étape ne tourne (tout début, entre deux phases) : pas une étape. */
const isFlowItself = (a: Subagent) => a.kind === 'step' && !!a.workflow && !a.phase && a.label === a.workflow

/** Range les étapes sous leur workflow (à la place de sa première étape), par phase dans l'ordre d'apparition ; le reste tel quel.
 *  Le workflow lui-même ne fait qu'animer son en-tête : ni ligne, ni compte. */
export function groupSubagents(subs: Subagent[]): SubItem[] {
  const out: SubItem[] = []
  const flows = new Map<string, Extract<SubItem, { kind: 'workflow' }>>()
  for (const a of subs) {
    if (a.kind !== 'step' || !a.workflow) {
      out.push({ kind: 'one', a })
      continue
    }
    let w = flows.get(a.workflow)
    if (!w) {
      w = { kind: 'workflow', name: a.workflow, phases: [], live: false }
      flows.set(a.workflow, w)
      out.push(w)
    }
    if (isFlowItself(a)) {
      w.live ||= a.status === 'working'
      continue
    }
    let p = w.phases.find((x) => x.phase === a.phase)
    if (!p) {
      p = { phase: a.phase, items: [] }
      w.phases.push(p)
    }
    p.items.push(a)
  }
  return out
}

/** Glyphe d'état, la même langue que les sessions : l'étoile tourne tant que ça travaille. */
function StateGlyph({ s }: { s: Subagent['status'] }) {
  if (s === 'working')
    return (
      <span className="spin fluo">
        <Icon name="star" />
      </span>
    )
  return <G c={s === 'done' ? '✓' : s === 'failed' ? '!' : '×'} />
}

/** Glyphe de la nature : & sous-agent, >_ commande ; une étape est déjà sous son workflow. */
const KIND_GLYPH: Record<Subagent['kind'], string | null> = { agent: '&', step: null, shell: '>_' }

const POLL_MS = 3000

/** Les derniers pas d'un sous-agent : lus à l'ouverture, relus toutes les 3 s tant qu'il travaille et que la ligne est dépliée.
 *  Au repli, le bloc garde ses anciennes props pendant l'animation de sortie : useIsPresent coupe la relecture dès le geste. */
function SubDetailView({ sessionId, a }: { sessionId: string; a: Subagent }) {
  const [detail, setDetail] = useState<SubagentDetail | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const working = a.status === 'working'
  const open = useIsPresent()
  useEffect(() => {
    if (!open) return
    let off = false
    const load = () =>
      api
        .subagent(sessionId, a.id)
        .then((d) => {
          if (off) return
          setDetail(d)
          setErr(null)
        })
        .catch((e) => !off && setErr((e as Error).message))
    void load()
    const t = working ? setInterval(load, POLL_MS) : undefined
    return () => {
      off = true
      if (t) clearInterval(t)
    }
  }, [sessionId, a.id, working, open])

  return (
    <div className="in sub-detail" data-testid="sub-detail">
      {err && !detail && <div className="meta">! {err}</div>}
      {!detail && !err && <div className="meta">…</div>}
      {detail?.steps.map((s, i) =>
        s.role === 'assistant' ? (
          <div key={`${s.at}-${i}`} className="text">
            {plain(s.text)}
          </div>
        ) : s.role === 'tool' ? (
          <div key={`${s.at}-${i}`} className="tool">
            <Icon name="arrow" dir="right" /> {step(s.text)}
          </div>
        ) : (
          <div key={`${s.at}-${i}`} className="result meta">
            {s.text}
          </div>
        ),
      )}
    </div>
  )
}

function SubRow({ sessionId, a, now }: { sessionId: string; a: Subagent; now: number }) {
  const t = useT(M)
  const [open, setOpen] = useState(false)
  const d = dur((a.endedAt ?? now) - a.startedAt)
  const state = t.subStatus(a.status)
  const kg = KIND_GLYPH[a.kind]
  return (
    <div className={`sub ${a.status}`} data-kind={a.kind} data-status={a.status}>
      <button className={`row sub-row ${a.status === 'working' ? 'live' : ''}`} onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={t.subAria(a.label, state, d, open)}>
        <span className="in" aria-hidden>
          <span className="st">
            <StateGlyph s={a.status} />
          </span>
          <span className="stack-text">
            <span className="ellipsis strong sub-label">
              {kg && (
                <span className="sub-kind">
                  <G c={kg} />
                </span>
              )}
              {a.label}
            </span>
            <span className="meta ellipsis">
              <span className="strong">{state}</span>
              {a.activity ? ` · ${activityText(a.activity)}` : ''}
            </span>
          </span>
          <span className="act">{d}</span>
          <span className="go">
            <G c={open ? '−' : '+'} />
          </span>
        </span>
      </button>
      <Collapse open={open}>
        <SubDetailView sessionId={sessionId} a={a} />
      </Collapse>
    </div>
  )
}

/** En-tête d'un workflow : son nom en gras, ce qui tourne sur le total ; chaque phase en sous-titre. */
function WorkflowGroup({ sessionId, w, now }: { sessionId: string; w: Extract<SubItem, { kind: 'workflow' }>; now: number }) {
  const all = w.phases.flatMap((p) => p.items)
  const working = all.filter((a) => a.status === 'working').length
  const live = working > 0 || w.live
  return (
    <div className="sub-flow" data-workflow={w.name}>
      <div className="in sub-flow-head">
        <span className="st" aria-hidden>
          {live ? (
            <span className="spin fluo">
              <Icon name="star" />
            </span>
          ) : (
            <G c="&" />
          )}
        </span>
        <span className="ellipsis">
          <span className="strong">{w.name}</span>
          {all.length > 0 && ` · ${working}/${all.length}`}
        </span>
      </div>
      {w.phases.map((p) => (
        <div key={p.phase ?? ''} className="sub-phase">
          {p.phase && <div className="in label sub-phase-head">{p.phase}</div>}
          {p.items.map((a) => (
            <SubRow key={a.id} sessionId={sessionId} a={a} now={now} />
          ))}
        </div>
      ))}
    </div>
  )
}

/** La bande du fil : ouverte d'office tant que quelque chose tourne, repliée sur une ligne quand tout est fini. */
export function Background({ session: s }: { session: Session }) {
  const { now } = useApp()
  const t = useT(M)
  const [choice, setChoice] = useState<boolean | null>(null)
  const active = s.subagents.filter((a) => a.status === 'working').length
  if (s.subagents.length === 0) return null
  const open = choice ?? (active > 0 || s.background > 0)
  const items = groupSubagents(s.subagents)
  return (
    <div className="band tone subs" data-testid="background">
      <Line ch={active > 0 ? <span className="spin fluo"><Icon name="star" /></span> : '&'} go={open ? '−' : '+'} onClick={() => setChoice(!open)} label={t.subagentsLabel(active)}>
        <span className="strong">{t.subagents}</span> · {t.active(active)} · {t.finished(s.subagents.length - active)}
      </Line>
      <Collapse open={open}>
        {items.map((it) =>
          it.kind === 'one' ? <SubRow key={it.a.id} sessionId={s.id} a={it.a} now={now} /> : <WorkflowGroup key={`wf:${it.name}`} sessionId={s.id} w={it} now={now} />,
        )}
        <div style={{ height: 8 }} />
      </Collapse>
    </div>
  )
}
