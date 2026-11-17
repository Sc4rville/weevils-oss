import { sourceAccessIssue } from './source-access'
import { noticeKey } from '../../shared/notices.ts'
import { Notice } from './notice'
// The page of one automation: a band that fills until it fires (and through its run), the same six facts for every
// automation, what it produced (newest first, the newest unfolded), and the talk that defines it. And the page of one
// run: everything that run wrote and left.
import { motion } from 'motion/react'
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { AutoDetail, AutoRun, AutoRunDetail, Message, Optimizer, OptimizerField } from '../../shared/api.ts'
import { api } from '../api'
import { useT } from '../i18n'
import M from '../i18n/h24'
import S from '../i18n/sleep'
import { useApp } from './app-context'
import { Collapse, Composer, Line, Messages, Prose, Working } from './bits'
import { at, nextTimeText, autoList, longAt, fromActivity, fromOptimizer, projectOfRepo, short, slotOf, triggerText, typicalMs, type AutoItem } from './auto-model'
import { TalkCtx, useTalk } from './auto-talk'
import { AutoDeleteAction } from './auto-delete'
import { autoCondition } from './auto-condition'
import { durLong, plain } from './format'
import { reveal, useFollow } from './follow'
import { Fill, chg } from './h24'
import { AutoMark, Icon } from './icons'
import { mergePending, type Pending } from './pending'
import { FootError, Shell } from './shell'
import { VoiceLogo } from './voice'
import './h24.css'

/** The newest run's report, unfolded on the page: this much of it. */
const REPORT_HEAD = 600
const MAX_TICKS = 30
const MAX_SHOTS = 3

/** The automation behind an id: a task (as rewritten by a talk, accepted a moment ago), a timer or a job. */
function useAutoItem(id: string): { item: AutoItem | null; opt: Optimizer | null } {
  const { snap, now } = useApp()
  const k = useTalk()
  if (k.deleted.has(id)) return { item: null, opt: null }
  const raw = snap.optimizers?.find((o) => o.id === id) ?? k.find(id)
  if (raw) {
    const o = k.item(raw)
    const opt = o.state === 'proposed' && k.decided.get(id) === 'yes' ? ({ ...o, state: 'queued', acceptedAt: o.acceptedAt ?? now } as Optimizer) : o
    return { item: fromOptimizer(opt, projectOfRepo(snap.projects, opt.repo)), opt }
  }
  const a = snap.h24.find((x) => x.id === id)
  if (!a) return { item: null, opt: null }
  return { item: autoList({ ...snap, optimizers: [] }).find((x) => x.id === id) ?? fromActivity(a), opt: null }
}

/** While it runs, the page reads it again this often. */
const LIVE_EVERY_MS = 20_000

/** GET /api/auto/:id, again when a run starts or ends, and every LIVE_EVERY_MS while one runs. Null until it answers
 *  (or when the server does not know it). */
function useDetail(id: string, item: AutoItem | null): AutoDetail | null {
  const [d, setD] = useState<AutoDetail | null>(null)
  const running = item?.state === 'running'
  const key = `${item?.state}:${item?.runCount}:${item?.lastRun?.at}:${item?.lastRun?.files}`
  useEffect(() => {
    let off = false
    const read = () =>
      api
        .auto(id)
        .then((r) => !off && setD(r))
        .catch(() => undefined)
    void read()
    const timer = running ? setInterval(read, LIVE_EVERY_MS) : undefined
    return () => {
      off = true
      clearInterval(timer)
    }
  }, [id, key, running])
  return d
}

function useRunDetail(id: string, at: number | undefined, files?: number): AutoRunDetail | null {
  const [d, setD] = useState<AutoRunDetail | null>(null)
  useEffect(() => {
    setD(null)
    if (!at) return
    let off = false
    api
      .autoRun(id, at)
      .then((r) => !off && setD(r))
      .catch(() => undefined)
    return () => {
      off = true
    }
  }, [id, at, files])
  return d
}

const projectName = (snap: { projects: { id: string; name: string }[] }, x: AutoItem) => (x.projectId ? (snap.projects.find((p) => p.id === x.projectId)?.name ?? null) : null)
const headline = (d: AutoRunDetail | null | undefined, r: AutoRun) => (d?.report ? plain(d.report).split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '').trim() : undefined) || r.note

export function AutoPage({ id }: { id: string }) {
  // One negotiation state for the whole page (App provides the one shared with the drawer).
  const k = useTalk()
  return (
    <TalkCtx.Provider value={k}>
      <AutoPageIn id={id} />
    </TalkCtx.Provider>
  )
}

function AutoPageIn({ id }: { id: string }) {
  const t = useT(M)
  const { item, opt } = useAutoItem(id)
  if (!item)
    return (
      <Shell slot={slotOf(id)} kicker={t.title} title="…">
        <div className="in meta empty">{t.empty}</div>
      </Shell>
    )
  return <AutoView item={item} opt={opt} />
}

function AutoView({ item: x, opt }: { item: AutoItem; opt: Optimizer | null }) {
  const t = useT(M)
  const { snap, push, back, refresh } = useApp()
  const k = useTalk()
  const detail = useDetail(x.id, x)
  const runs = detail?.runs?.length ? detail.runs : x.runs
  const newest = useRunDetail(x.id, runs[0]?.at, runs[0]?.files)
  const proposed = x.state === 'proposed'
  const [err, setErr] = useState<string | null>(null)
  const [runPending, setRunPending] = useState(false)
  const [draft, setDraft] = useState<{ text: string; n: number; reset?: boolean }>()
  const n = useRef(0)
  const form = useRef<HTMLFormElement>(null)
  const outputs = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const follow = useFollow(body, !!opt?.draft, 80, `${opt?.talk?.length}:${k.busy.has(x.id)}`)
  const wasDraft = useRef(!!opt?.draft)
  useLayoutEffect(() => {
    if (wasDraft.current && !opt?.draft) body.current?.scrollTo({ top: 0, behavior: 'smooth' })
    wasDraft.current = !!opt?.draft
  }, [opt?.draft])
  const heard = useRef('')
  const f = k.flash.get(x.id) ?? []
  // Where it runs: the project's name, else its folder (never both, never an internal id).
  const where = projectName(snap, x) ?? x.repo ?? ''

  const act = (p: Promise<unknown>) => void p.then(refresh).catch((e) => setErr((e as Error).message))
  useEffect(() => {
    if (x.state === 'running' || x.state === 'paused') setRunPending(false)
  }, [x.state])
  const sourceIssue = sourceAccessIssue(opt)
  const runNow = () => {
    if (sourceIssue) { setErr(sourceIssue); return }
    setRunPending(true)
    void api.runOptimizer(x.id).then(refresh).catch((e) => {
      setRunPending(false)
      setErr((e as Error).message)
    })
  }
  const actions: ReactNode[] = []
  // Closing a draft is navigation only. Destruction belongs to the confirmed delete action below.
  if (opt && !proposed && !x.state.match(/^(done|failed)$/)) {
    const paused = x.state === 'paused' || !!opt.paused
    actions.push(
      <button key="pause" className="ch" disabled={paused && !!sourceIssue} title={paused ? sourceIssue ?? undefined : undefined} onClick={() => act(api.pauseOptimizer(x.id, !paused))} aria-label={paused ? t.resume(x.title) : t.pause(x.title)}>
        <Icon name={paused ? 'play' : 'pause'} />
      </button>,
    )
    if (x.state !== 'running' && !runPending && !opt.runRequested)
      actions.push(
        <button key="run" className="ch" disabled={!!sourceIssue || runPending} title={sourceIssue ?? undefined} onClick={runNow} aria-label={t.runNow(x.title)}>
          <Icon name="arrow" dir="right" />
        </button>,
      )
  }
  if (x.src === 'timer' && x.toggle)
    actions.push(
      <button key="toggle" className="ch" onClick={() => act(api.toggleH24(x.id))} aria-label={x.state === 'paused' ? t.resume(x.title) : t.pause(x.title)}>
        <Icon name={x.state === 'paused' ? 'play' : 'pause'} />
      </button>,
    )

  // A fact tapped: the field opens with « quand : » typed in, you say what you want.
  const ask = (field: Asked) => {
    setDraft({ text: t[`askAbout_${field}`], n: ++n.current, reset: false })
    requestAnimationFrame(() => form.current?.querySelector('input')?.focus())
  }
  const toOutputs = () => reveal(outputs.current, { block: 'start', flash: false })

  const talkOn = !!opt
  const busy = k.busy.has(x.id)
  return (
    <Shell
      slot={slotOf(x.id)}
      bodyRef={body}
      kicker={t.title}
      title={<span className={chg(f.includes('title'))}>{x.title}</span>}
      meta={
        <>
          {x.why && (
            <>
              <span className={chg(f.includes('why'))}>{x.why}</span>
              <br />
            </>
          )}
          {where && <span className={chg(f.includes('repo'), 'strong')}>{where}</span>}
        </>
      }
      actions={actions.length ? actions : undefined}
      foot={
        talkOn ? (
          <>
            <div className="band tone auto-voice">
              <VoiceLogo
                recordingScope={`auto:${x.id}`}
                take={() => ''}
                onText={(said) => {
                  heard.current = heard.current ? `${heard.current} ${said}` : said
                  setDraft({ text: said, n: ++n.current })
                }}
                onSend={() => {
                  const q = heard.current.trim()
                  heard.current = ''
                  if (!q) return
                  setDraft({ text: '', n: ++n.current, reset: true })
                  void k.send(x.id, q, true)
                }}
                replyKey={k.reply.key}
                replyText={k.reply.text}
                working={busy}
              />
            </div>
            <FootError text={k.notes.get(x.id) ?? err} />
            <Composer
              draftKey={`auto:${x.id}`}
              placeholder={t.talkPlaceholder}
              label={t.talkLabel(x.title)}
              voice
              draft={draft}
              formRef={form}
              prompt={busy ? <AutoMark /> : undefined}
              onSend={async (said) => {
                if (opt?.draft) follow.toEnd()
                if (!(await k.send(x.id, said))) throw new Error(t.talkPlaceholder)
              }}
            />
          </>
        ) : err ? (
          <FootError text={err} />
        ) : undefined
      }
    >
      {sourceIssue && <div className="in meta" role="status">{sourceIssue}</div>}
      {opt && !(opt.draft && !opt.talk?.some((l) => l.who === 'user')) && <div className="in auto-delete-row"><AutoDeleteAction id={x.id} title={x.title} onDeleted={back} /></div>}
      {proposed && opt && !opt.draft && (
        <Notice closable={false} eventId={noticeKey("proposal", opt.id)} className="band invert auto-decide">
          <Line
            ch="✓"
            go={null}
            disabled={busy || k.isStale(opt) || !!sourceIssue}
            label={busy ? t.acceptBusy(x.title) : t.accept(x.title)}
            onClick={() => {
              k.answer(opt, true, back)
            }}
          >
            {t.acceptVersion}
          </Line>
          <Line ch="×" go={null} disabled={busy} label={t.refuse(x.title)} onClick={() => k.answer(opt, false, back)}>
            {t.refuseIt}
          </Line>
        </Notice>
      )}

      {!opt?.draft && (
        <>
          <Flow x={x} runs={runs} next={opt?.next?.title} onTicks={toOutputs} />

          <Kpis x={x} runs={runs} flash={f} ask={talkOn ? ask : undefined} onLast={() => runs[0] && push({ kind: 'autorun', id: x.id, at: runs[0].at })} onRuns={toOutputs} />
          {opt && <SleepTrigger o={opt} />}

          <div ref={outputs}>
            {(runs.length > 0 || x.state === 'running') && <div className="in label">{t.outputs}</div>}
            {x.state === 'running' && <LiveRun x={x} />}
            {runs.map((r, i) => (
              <Fragment key={r.at}>
                <RunLine id={x.id} r={r} head={i === 0 ? headline(newest, r) : r.note} />
                {i === 0 && newest && <Produced id={x.id} d={newest} machine={detail?.machine} short />}
              </Fragment>
            ))}
          </div>
        </>
      )}
      {opt && <Talk o={opt} />}
    </Shell>
  )
}

// ---------------------------------------------------------------------------
// The flow: one flat layer that fills until it fires, then through the run; the runs below it, one tick each.

/** next: the scope agreed for its next run, while this one runs. */
function Flow({ x, runs, next, onTicks }: { x: AutoItem; runs: AutoRun[]; next?: string; onTicks: () => void }) {
  const t = useT(M)
  const { now } = useApp()
  const typ = typicalMs(x)
  let big: ReactNode
  // Under the big value: the state in a word, unless the big value already is it; nothing a fact below repeats.
  let line: string = x.nextReason === 'retry' ? t.retryWaiting : t[`state_${x.state}`]
  if (x.state === 'proposed') {
    big = triggerText(x.trigger, now)
    line = ''
  } else if (x.state === 'running' && x.startedAt) {
    big = (
      <>
        {durLong(now - x.startedAt)}
        {typ && <span className="of">/ {durLong(typ)}</span>}
      </>
    )
    if (next) line = `${line} · ${t.nextScopeLabel(next)}`
  } else if (x.state === 'paused') {
    big = t.paused
    line = ''
  } else if (x.state === 'done' || x.state === 'failed') {
    big = t.endedAgo(short(now - (x.endedAt ?? runs[0]?.at ?? now), true))
  } else if (x.state === 'waiting' && x.waiting && x.waiting !== 'queue') {
    big = autoCondition(x)
    line = ''
  } else if (x.nextAt && x.nextAt > now) {
    big = x.nextReason === 'retry' ? autoCondition(x) : t.inTime(durLong(x.nextAt - now))
  } else {
    big = autoCondition(x)
    if (x.place) line = `${line} · ${t.placeN(x.place)}`
  }

  // A run that just ended: the full fill shrinks into its tick (shared layoutId), then fills again toward the next.
  const top = runs[0]?.at
  const ranAt = useRef(x.state === 'running' ? Date.now() : 0)
  if (x.state === 'running') ranAt.current = Date.now()
  const seenTop = useRef(top)
  const [landing, setLanding] = useState<number | null>(null)
  useLayoutEffect(() => {
    if (top && top !== seenTop.current && ranAt.current > 0 && Date.now() - ranAt.current < 60_000) setLanding(top)
    seenTop.current = top
  }, [top])
  useEffect(() => {
    if (landing === null) return
    const r = requestAnimationFrame(() => setLanding(null))
    return () => cancelAnimationFrame(r)
  }, [landing])

  const ticks = runs.slice(0, MAX_TICKS).reverse()
  const longest = Math.max(1, ...ticks.map((r) => r.at - r.startedAt))
  return (
    <div className={`band auto-flow st-${x.state}${ticks.length > 0 || x.state === 'running' ? '' : ' still'}`}>
      {x.state !== 'proposed' && <Fill x={x} />}
      {landing !== null && <motion.span layoutId={`run-${landing}`} className="auto-fill auto-land" aria-hidden />}
      <div className="in">
        <div className="name">{big}</div>
        {line && <div className="meta">{line}</div>}
      </div>
      {(ticks.length > 0 || x.state === 'running') && (
        <button className="auto-ticks" onClick={onTicks} aria-label={t.runsStrip(x.runCount || runs.length)}>
          {ticks.map((r) =>
            r.at === landing ? null : (
              <motion.span key={r.at} layoutId={`run-${r.at}`} className={r.ok ? undefined : 'bad'} style={{ height: Math.max(6, Math.min(40, ((r.at - r.startedAt) / longest) * 40)) }} transition={{ type: 'spring', stiffness: 260, damping: 30 }} />
            ),
          )}
          {x.state === 'running' && x.startedAt ? (
            <span className="live" style={{ height: Math.max(6, Math.min(40, ((now - x.startedAt) / Math.max(longest, typ ?? 0)) * 40)) }} />
          ) : (
            x.state !== 'done' && x.state !== 'failed' && <span className="next" />
          )}
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The same six facts for every automation.

type Field = 'when' | 'next' | 'last' | 'length' | 'runs'
/** The facts that open the talk when tapped (« quand : » typed in). */
type Asked = 'when' | 'next' | 'length'
const FLASHED: Partial<Record<Field, OptimizerField[]>> = { when: ['every', 'window', 'notBefore', 'onSleep', 'stopOnWake'], next: ['every', 'window', 'notBefore', 'onSleep'], length: ['est'] }

/**
 * The same facts for every automation, one quiet block: when it fires, the next time, the last run, how long it runs,
 * how many runs. What it is for is the head's line, where it runs the head's bold word, what it is doing
 * the flow band's: never said twice. A proposal has no past yet: its trigger is the flow band, here its next time and
 * its length.
 */
function Kpis({ x, runs, flash, ask, onLast, onRuns }: { x: AutoItem; runs: AutoRun[]; flash: OptimizerField[]; ask?: (f: Asked) => void; onLast: () => void; onRuns: () => void }) {
  const t = useT(M)
  const { now } = useApp()
  const last = runs[0] ?? x.lastRun
  const typ = typicalMs({ runs, est: x.est })
  const measured = runs.some((r) => r.at > r.startedAt)
  // Only a verified dated trigger; never infer the next run from duration or cadence.
  const following = x.nextAt && x.nextReason !== 'retry' && x.nextAt > now ? x.nextAt : null
  const next =
    x.state === 'proposed'
      ? x.trigger.at
        ? at(x.trigger.at, now)
        : autoCondition(x)
      : x.state === 'paused' || x.state === 'done' || x.state === 'failed'
        ? t.never
        : following
          ? nextTimeText({ ...x, nextAt: following }, now)
          : x.state === 'running'
            ? x.trigger.every ? t.nextNotScheduled : t.never
            : autoCondition(x)
  const all: { f: Field; icon: ReactNode; value: ReactNode; dim?: boolean }[] = [
    { f: 'when', icon: x.trigger.kind === 'every' ? <Icon name="cycle" /> : x.trigger.kind === 'sleep' ? <Icon name="sleep" /> : <Icon name="arrow" dir="right" />, value: triggerText(x.trigger, now) },
    { f: 'next', icon: <Icon name="arrow" dir="right" />, value: next },
    { f: 'last', icon: <Icon name={last && !last.ok ? 'close' : 'check'} />, value: last ? t.endedAgo(short(now - last.at, true)) : t.never },
    { f: 'length', icon: <Icon name="minus" />, value: typ ? durLong(typ) : t.unknown, dim: !measured },
    { f: 'runs', icon: <Icon name="hash" />, value: String(x.runCount || runs.length) },
  ]
  const cells = x.state === 'proposed' ? all.filter((c) => c.f === 'next' || c.f === 'length') : all
  const tap = (c: Field) => (c === 'last' ? onLast : c === 'runs' ? onRuns : ask ? () => ask(c) : undefined)
  return (
    <div className="in auto-kpis">
      {cells.map((c) => {
        const inner = (
          <>
            <span className="k small" aria-hidden>
              {c.icon}
              {t[`kpi_${c.f}`]}
            </span>
            <span className={`v${c.dim ? ' dim' : ''}${FLASHED[c.f]?.some((x) => flash.includes(x)) ? ' auto-chg' : ''}`}>{c.value}</span>
          </>
        )
        const onClick = ask || c.f === 'last' || c.f === 'runs' ? tap(c.f) : undefined
        return onClick ? (
          <button key={c.f} className="auto-kpi" onClick={onClick}>
            {inner}
          </button>
        ) : (
          <div key={c.f} className="auto-kpi">
            {inner}
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Outputs: the run in progress (one tap into its session), then each run, the newest unfolded.

function LiveRun({ x }: { x: AutoItem }) {
  const { snap, push } = useApp()
  const s = x.sessionId ? snap.sessions.find((y) => y.id === x.sessionId) : undefined
  // A timer's or a job's note is the raw last line of its log: never shown here.
  const note = x.src === 'optimizer' ? x.note : undefined
  return (
    <Line ch={<AutoMark />} onClick={x.sessionId ? () => push({ kind: 'session', id: x.sessionId! }) : undefined} go={x.sessionId ? '→' : null}>
      {s?.now || note || s?.title || x.title}
    </Line>
  )
}

/** A run: what it said (else when it ended), then when, how long, what it left. */
function RunLine({ id, r, head }: { id: string; r: AutoRun; head?: string }) {
  const t = useT(M)
  const { now, push } = useApp()
  const meta = [head ? t.endedAgo(short(now - r.at, true)) : '', r.at > r.startedAt ? durLong(r.at - r.startedAt) : '', r.files ? t.filesN(r.files) : ''].filter(Boolean).join(' · ')
  return (
    <Line ch={r.ok ? '✓' : <span className="alert"><Icon name="close" /></span>} meta={meta} onClick={() => push({ kind: 'autorun', id, at: r.at })} label={`${t.runLabel(t.endedAgo(short(now - r.at, true)), r.ok)}${head ? `, ${head}` : ''}`}>
      {head || longAt(r.at)}
    </Line>
  )
}

/** What a run wrote and left: its report (or last message), files, links, screenshots, its log. short: the newest run
 *  unfolded on the automation's page (the report's beginning, then a line to all of it). The changed files and the log
 *  wait behind a tap: paths and raw lines are not something to read first. */
function Produced({ id, d, machine, short: brief = false }: { id: string; d: AutoRunDetail; machine?: string; short?: boolean }) {
  const t = useT(M)
  const { push, snap } = useApp()
  // Unfolded under its line, the report does not repeat its first line (the line's headline).
  const full = d.report || d.message
  const text = brief && d.report ? d.report.replace(/^\s*#*[^\n]*\n+/, '') || d.report : full
  const cut = brief && text && text.length > REPORT_HEAD ? `${text.slice(0, REPORT_HEAD).replace(/\s+\S*$/, '')} …` : text
  const on = machine ?? snap.machines[0]?.id ?? ''
  return (
    <>
      {cut && (
        <div className="msg band auto-report">
          <div className="in">
            <Prose text={cut} />
          </div>
        </div>
      )}
      {brief && full && (
        <Line ch='"' onClick={() => push({ kind: 'autorun', id, at: d.run.at })}>
          {t.wholeReport}
        </Line>
      )}
      {d.files.length > 0 && (
        <Fold label={t.filesChanged(d.files.length)} ch={<Icon name="file" />}>
          {d.files.map((file) => (
            <Line key={file.path} ch="·" meta={file.status === 'D' ? '−' : [file.add ? `+${file.add}` : '', file.del ? `−${file.del}` : ''].filter(Boolean).join(' ') || undefined} onClick={file.status === 'D' ? undefined : () => push({ kind: 'fsfile', machine: on, path: file.abs })} go={file.status === 'D' ? null : '→'}>
              {file.path}
            </Line>
          ))}
        </Fold>
      )}
      {d.links.map((url) => (
        <Line key={url} ch={<Icon name="external" />} onClick={() => window.open(url, '_blank', 'noopener')}>
          {url.replace(/^https?:\/\//, '').replace(/\/$/, '')}
        </Line>
      ))}
      {(brief ? d.images.slice(0, MAX_SHOTS) : d.images).map((path) => (
        <img key={path} className="auto-shot" src={api.autoBlob(id, path)} alt={t.screenshot(path)} loading="lazy" />
      ))}
      {!brief && d.log && (
        <Fold label={t.fullLog} ch='"'>
          <pre className="screen tone">{d.log}</pre>
        </Fold>
      )}
    </>
  )
}

/** A line that unfolds what is under it (closed at first). */
function Fold({ label, ch, children }: { label: string; ch: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Line ch={ch} go={open ? '↑' : '↓'} onClick={() => setOpen((v) => !v)} label={label}>
        {label}
      </Line>
      <Collapse open={open}>{children}</Collapse>
    </>
  )
}

// ---------------------------------------------------------------------------
// The « when I sleep » trigger: one tap, no model (the talk can set it too: « run this when I sleep »).

function SleepTrigger({ o }: { o: Optimizer }) {
  const t = useT(S)
  const { refresh } = useApp()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  if (o.builtin || (o.state !== 'proposed' && o.state !== 'queued' && o.state !== 'running')) return null
  const set = (v: { onSleep?: boolean; stopOnWake?: boolean }) => {
    setBusy(true)
    setErr(null)
    api
      .autoTrigger(o.id, v)
      .then(() => refresh())
      .catch((e) => setErr((e as Error).message))
      .finally(() => setBusy(false))
  }
  return (
    <div className="auto-sleep" role="group" aria-label={t.triggerSleep}>
      <Line ch={<Icon name="sleep" />} go={null} disabled={busy} meta={t.runWhenSleepMeta} onClick={() => set({ onSleep: !o.onSleep })}>
        {t.runWhenSleep} · {o.onSleep ? t.on : t.off}
      </Line>
      {o.onSleep && (
        <Line ch={o.stopOnWake ? '✓' : ''} go={null} disabled={busy} onClick={() => set({ stopOnWake: !o.stopOnWake })}>
          {t.stopOnWake} · {o.stopOnWake ? t.on : t.off}
        </Line>
      )}
      <FootError text={err} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// The talk: the sessions' own thread look, the question in flight at once, AutoMark while it answers.

function Talk({ o }: { o: Optimizer }) {
  const t = useT(M)
  const k = useTalk()
  const real: Message[] = (o.talk ?? []).map((l, i) => ({ id: `talk-${l.at}-${i}`, role: l.who === 'user' ? 'user' : 'assistant', text: l.text, at: l.at }))
  const asking = k.asking.get(o.id)
  const sent = useRef(0)
  if (asking && !sent.current) sent.current = Date.now()
  if (!asking) sent.current = 0
  const pending: Pending[] = asking ? [{ id: `pending-${o.id}`, role: 'user', text: asking, at: sent.current, typed: asking, after: real.at(-1)?.id }] : []
  const messages = mergePending(real, pending)
  const last = o.talk?.at(-1)
  const suggestions = o.draft && last?.who === 'auto' ? last.suggestions ?? [] : []
  // A new automation before you've said anything: one line, nothing else (Yann, 2026-11-16).
  if (o.draft && !asking && !k.busy.has(o.id) && !real.some((m) => m.role === 'user')) return <div className="in auto-discuss">{t.letsDiscuss}</div>
  if (!messages.length && !k.busy.has(o.id)) return null
  return (
    <div className="auto-talk">
      <Messages messages={messages} author={t.title} />
      {!asking && !k.busy.has(o.id) && suggestions.length > 0 && (
        <div className="auto-suggestions" role="group" aria-label={t.replySuggestions}>
          {suggestions.map((s) => (
            <Line key={s.text} onClick={() => void k.send(o.id, s.text)}>
              {s.label}
            </Line>
          ))}
        </div>
      )}
      {k.busy.has(o.id) && <Working author={t.title} mark={<AutoMark />} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// One run.

export function AutoRunPage({ id, at: end }: { id: string; at: number }) {
  const t = useT(M)
  const { snap, push } = useApp()
  const { item } = useAutoItem(id)
  const d = useRunDetail(id, end)
  const [detail, setDetail] = useState<AutoDetail | null>(null)
  useEffect(() => {
    let off = false
    api
      .auto(id)
      .then((r) => !off && setDetail(r))
      .catch(() => undefined)
    return () => {
      off = true
    }
  }, [id])
  const r = d?.run ?? detail?.runs.find((x) => x.at === end) ?? item?.runs.find((x) => x.at === end)
  const when = longAt(end)
  const session = r?.sessionId && snap.sessions.some((s) => s.id === r.sessionId) ? r.sessionId : null
  return (
    <Shell
      slot={slotOf(id)}
      kicker={item?.title ?? t.title}
      title={when}
      meta={
        r ? (
          <>
            {r.at > r.startedAt ? durLong(r.at - r.startedAt) : ''}{' '}
            <span className={r.ok ? undefined : 'alert'}>
              <Icon name={r.ok ? 'check' : 'close'} />
            </span>{' '}
            {r.ok ? t.state_done : t.state_failed}
          </>
        ) : undefined
      }
    >
      {d && <Produced id={id} d={d} machine={detail?.machine} />}
      {session && (
        <Line ch={<Icon name="bubble" />} onClick={() => push({ kind: 'session', id: session })}>
          {t.openSession}
        </Line>
      )}
    </Shell>
  )
}
