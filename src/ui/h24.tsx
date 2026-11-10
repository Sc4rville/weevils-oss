import { AnimatePresence, animate, motion, useDragControls, useMotionValue, useTransform, type MotionValue } from 'motion/react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { Optimizer } from '../../shared/api.ts'
import { isSettled, stableOrder, useApp } from './app-context'
import { Collapse, Line, spring } from './bits'
import { AutoMark, Icon, type Dir, type IconName } from './icons'
import { useT } from '../i18n'
import M from '../i18n/h24'
import { at, autoList, autoRank, bandColors, fromOptimizer, isFinished, projectOfRepo, short, triggerText, type AutoItem } from './auto-model'
import { TalkCtx, useTalk } from './auto-talk'
import './h24.css'
import { flash, when } from './follow'

const color = (slot: string) => ({ '--c': `var(--${slot})` }) as CSSProperties

/** The kind of a proposal, drawn as its band's glyph (never ✓ nor ×: they would read as the buttons). */
export const KIND_ICON: Record<Optimizer['kind'], IconName> = { tests: 'terminal', watch: 'external', content: 'file', explore: 'slash', other: 'star' }

/** The fields that flash after a rewrite (auto-chg). */
export const chg = (on: boolean, base = '') => `${base}${on ? `${base ? ' ' : ''}auto-chg` : ''}`

/** The old fold memory of the drawer's categories: cleared once. */
const OLD_FOLDS = 'weevils-auto-folds'

/** Bande « auto » collée en bas : on la tire vers le haut (ou on la touche) pour voir ce qui tourne tout seul. */
export function H24Rail() {
  const { snap, now, push, h24Open: open, setH24Open: setOpen, h24Focus } = useApp()
  const t = useT(M)
  const k = useTalk()
  const y = useMotionValue(0)
  const drawer = useRef<HTMLDivElement>(null)
  const probe = useRef<HTMLDivElement>(null)
  const dragged = useRef(false)
  const controls = useDragControls()
  const creatingRef = useRef(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const create = async () => {
    if (creatingRef.current) return
    creatingRef.current = true
    setCreating(true)
    setCreateError(null)
    try {
      const item = await k.create()
      push({ kind: 'auto', id: item.id })
    } catch (e) {
      setCreateError((e as Error).message)
      setOpen(true)
    } finally {
      creatingRef.current = false
      setCreating(false)
    }
  }
  const [closedY, setClosedY] = useState(0)
  const [doneOpen, setDoneOpen] = useState(false)

  useEffect(() => {
    try {
      localStorage.removeItem(OLD_FOLDS)
    } catch {
      /* stockage indisponible */
    }
  }, [])

  const measure = useCallback(() => {
    const h = drawer.current?.offsetHeight ?? 0
    const visible = probe.current?.offsetHeight ?? 56
    setClosedY(Math.max(0, h - visible))
  }, [])

  useLayoutEffect(() => {
    measure()
    window.addEventListener('resize', measure)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    if (drawer.current) observer?.observe(drawer.current)
    if (probe.current) observer?.observe(probe.current)
    return () => { window.removeEventListener('resize', measure); observer?.disconnect() }
  }, [measure])

  // Position initiale sans animation, puis ressort à chaque ouverture/fermeture.
  const first = useRef(true)
  useEffect(() => {
    const target = open ? 0 : closedY
    if (first.current) {
      y.set(target)
      first.current = false
      return
    }
    const ctrl = animate(y, target, spring)
    return () => ctrl.stop()
  }, [open, closedY, y])

  // Ouvert sur une automatisation précise : le tiroir monté, elle est amenée sous les yeux dans la liste (seule la liste
  // défile : le tiroir est fixe) et s'éclaire un instant.
  useEffect(() => {
    if (!open || !h24Focus) return
    let off = false
    when(
      () => off || y.get() < 4,
      () => {
        const body = drawer.current?.querySelector<HTMLElement>('.h24-body')
        const row = body?.querySelector<HTMLElement>(`[data-h24="${CSS.escape(h24Focus)}"]`)
        if (off || !body || !row) return
        const r = row.getBoundingClientRect()
        const b = body.getBoundingClientRect()
        if (r.top < b.top || r.bottom > b.bottom) {
          const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches
          body.scrollTo({ top: body.scrollTop + r.top - b.top - 8, behavior: smooth ? 'smooth' : 'auto' })
        }
        flash(row)
      },
      900,
    )
    return () => {
      off = true
    }
  }, [open, h24Focus, y])

  // A task rewritten a moment ago: its new version, before the snapshot follows. One given ✓ here or on its page: an
  // automation already (it slides into its place), one given ×: gone (it folds away).
  const opts = (snap.optimizers ?? []).map(k.item)
  const drafts = opts.filter((o) => o.state === 'proposed' && o.draft && !k.decided.has(o.id))
  const ready = opts.filter((o) => o.state === 'proposed' && !o.draft && !k.decided.has(o.id))
  const proposals = [...ready.filter((o) => o.userCreated), ...ready.filter((o) => !o.userCreated).slice(0, 3)]
  const accepted = opts.map((o) => (o.state === 'proposed' && k.decided.get(o.id) === 'yes' ? ({ ...o, state: 'queued', acceptedAt: now } as Optimizer) : o))
  const all = autoList({ ...snap, optimizers: accepted })
  // Nothing moves under the finger: running first, then the soonest trigger, then the machine, then paused; a band
  // keeps its place within its rank.
  const shown = useRef<string[]>([])
  const live = stableOrder(
    all.filter((x) => !isFinished(x)),
    (x) => x.id,
    autoRank,
    (a, b) => (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity),
    shown.current,
    !isSettled(),
  )
  const order = live.map((x) => x.id).join('|')
  useLayoutEffect(() => {
    shown.current = order ? order.split('|') : []
  }, [order])
  const finished = all.filter(isFinished)
  const rounding = !!snap.autoRound?.busy
  // A colour per band, in display order: each one far from the one above it (the amber head for the first).
  const kept = useRef(new Map<string, string>())
  kept.current = bandColors([...drafts.map((o) => o.id), ...proposals.map((o) => o.id), ...(rounding ? ['__round'] : []), ...live.map((x) => x.id)], kept.current)
  const keptDone = useRef(new Map<string, string>())
  keptDone.current = bandColors(finished.map((x) => x.id), keptDone.current)

  // The head: what runs, else what waits for a yes, else the next trigger.
  const running = live.filter((x) => x.state === 'running')
  const next = live.filter((x) => x.nextAt && x.state !== 'running').sort((a, b) => a.nextAt! - b.nextAt!)[0]
  const summary: ReactNode = running.length ? (
    <>
      <AutoMark />
      <span className="txt">{running[0].title}</span>
      {running.length > 1 && <span className="more">+{running.length - 1}</span>}
    </>
  ) : proposals.length ? (
    <span className="txt">{t.toValidateN(proposals.length)}</span>
  ) : next ? (
    <span className="txt">{t.nextAt(at(next.nextAt!, now))}</span>
  ) : null
  const said = running.length ? `${running[0].title}${running.length > 1 ? ` +${running.length - 1}` : ''}` : proposals.length ? t.toValidateN(proposals.length) : next ? t.nextAt(at(next.nextAt!, now)) : t.nothing

  return (
    <>
      {open && <div className="catcher" onClick={() => setOpen(false)} aria-hidden />}
      <motion.div
        ref={drawer}
        className="h24 band"
        data-open={open}
        style={{ y }}
        drag="y"
        dragListener={false}
        dragControls={controls}
        dragConstraints={{ top: 0, bottom: closedY }}
        dragElastic={{ top: 0.05, bottom: 0.2 }}
        dragMomentum={false}
        onDragStart={() => (dragged.current = true)}
        onDragEnd={(_, info) => {
          const current = y.get()
          const next = info.velocity.y < -300 ? true : info.velocity.y > 300 ? false : current < closedY / 2
          if (next === open) animate(y, next ? 0 : closedY, spring)
          setOpen(next)
        }}
        role="region"
        aria-label={t.region}
      >
        <div ref={probe} className="h24-probe" />
        <div className="h24-top">
          <div className="in">
            <button
              className="h24-head"
              onPointerDown={(e) => {
                dragged.current = false
                controls.start(e)
              }}
              onClick={() => {
                if (dragged.current) {
                  dragged.current = false
                  return
                }
                setOpen(!open)
              }}
              aria-expanded={open}
              aria-controls="h24-body"
              aria-label={t.head(said, open)}
            >
              <span className="h24-grip" aria-hidden />
              <span className="h24-heading" aria-hidden>
                <span className="h24-title">{t.title}</span>
                <span className="h24-status"><span className="h24-activity" data-busy={running.length > 0 || rounding} aria-hidden><i /></span><span className="meta auto-sum">{summary}</span></span>
              </span>
            </button>
          </div>
        </div>

        <div id="h24-body" className="h24-body" inert={!open} hidden={!open}>
          <div className="in h24-tools"><button type="button" className="h24-create" aria-label={creating ? t.creating : t.create} disabled={creating} onClick={() => void create()}>
            {creating ? <AutoMark /> : <Icon name="plus" />}<span>{creating ? t.creating : t.create}</span>
          </button></div>
          {createError && (
            <div className="in meta" role="alert">{createError}</div>
          )}
          <TalkCtx.Provider value={k}>
            <AnimatePresence initial={false}>
              {drafts.map((o) => (
                <motion.section key={o.id} layout="position" className="band auto-band" style={color(kept.current.get(o.id) ?? 'p9')} data-h24={o.id} {...drop}>
                  <button className="auto-hit" onClick={() => push({ kind: 'auto', id: o.id })} aria-label={o.title} />
                  <div className="in" aria-hidden>
                    <span className="st">
                      <Icon name="bubble" />
                    </span>
                    <span className="auto-name">{o.title}</span>
                    <span className="meta sub ellipsis">{o.talk?.at(-1)?.text}</span>
                  </div>
                </motion.section>
              ))}
              {proposals.map((o) => (
                <AutoBand key={o.id} x={fromOptimizer(o, projectOfRepo(snap.projects, o.repo))!} proposal={o} slot={kept.current.get(o.id) ?? 'p9'} />
              ))}
              {rounding && (
                <motion.div key="__round" layout="position" className="band auto-band auto-round" style={color(kept.current.get('__round') ?? 'p9')} {...drop} role="status" aria-label={t.rounding}>
                  <div className="in">
                    <span className="st" aria-hidden>
                      <Icon name="cycle" />
                    </span>
                    <span className="dots" aria-hidden>
                      <i />
                      <i />
                      <i />
                    </span>
                  </div>
                </motion.div>
              )}
              {live.map((x) => (
                <AutoBand key={x.id} x={x} slot={kept.current.get(x.id) ?? 'p9'} />
              ))}
            </AnimatePresence>
            {finished.length > 0 && (
              <>
                <Line ch="✓" go={doneOpen ? '↑' : '↓'} onClick={() => setDoneOpen((v) => !v)} label={t.finishedN(finished.length)}>
                  <span className="meta">{t.finishedN(finished.length)}</span>
                </Line>
                <Collapse open={doneOpen || (!!h24Focus && finished.some((x) => x.id === h24Focus))}>
                  <AnimatePresence initial={false}>
                    {finished.map((x) => (
                      <AutoBand key={x.id} x={x} slot={keptDone.current.get(x.id) ?? 'p9'} />
                    ))}
                  </AnimatePresence>
                </Collapse>
              </>
            )}
          </TalkCtx.Provider>
          {all.length === 0 && proposals.length === 0 && drafts.length === 0 && !rounding && <div className="in meta empty">{t.empty}</div>}
          <div style={{ height: 14 }} />
        </div>
      </motion.div>
    </>
  )
}

/** A band that arrives drops in (height from 0), one that leaves folds away (RowSlot in bands.tsx). */
const drop = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1 },
  exit: { height: 0, opacity: 0 },
  transition: spring,
} as const

// ---------------------------------------------------------------------------
// One band per automation: one tap opens its page. The fill behind it is the page's flow, in miniature.

/** The glyph of an automation, by what it is doing; the name of the icon for the cross-fade. */
export function glyphOf(x: Pick<AutoItem, 'state' | 'trigger' | 'lastRun'>): { name: IconName | 'mark'; dir?: Dir; alert?: boolean } {
  if (x.state === 'running') return { name: 'mark' }
  if (x.state === 'paused') return { name: 'pause' }
  if (x.state === 'failed' || (x.lastRun && !x.lastRun.ok && x.state !== 'done')) return { name: 'close', alert: true }
  if (x.state === 'done') return { name: 'check' }
  if (x.state === 'waiting' || x.state === 'queued') return { name: 'idle' }
  if (x.trigger.kind === 'every') return { name: 'cycle' }
  return { name: 'arrow', dir: 'right' }
}

/** A glyph that cross-fades when it changes (a proposal turning into an automation, a run starting). */
export function Glyph({ name, dir, alert }: { name: IconName | 'mark'; dir?: Dir; alert?: boolean }) {
  return (
    <span className="auto-glyph">
      <AnimatePresence initial={false}>
        <motion.span key={`${name}${dir ?? ''}`} className={alert ? 'alert' : undefined} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }}>
          {name === 'mark' ? <AutoMark /> : <Icon name={name} dir={dir} />}
        </motion.span>
      </AnimatePresence>
    </span>
  )
}

/** How far the fill goes, as a scale from the left: set to where it is now, then running on its own to the trigger (or
 *  to the usual end of the run) as long as it is on screen. Paused: frozen. Starting a run: it snaps back to 0. */
export function useAutoFill(x: AutoItem | null): { scale: MotionValue<number>; dip: MotionValue<number>; over: boolean } {
  const scale = useMotionValue(0)
  const dip = useMotionValue(1)
  const { now } = useApp()
  const span = x?.progress(Date.now()) ?? null
  const state = x?.state
  const key = span ? `${span.from}:${span.to}:${state}` : `none:${state}`
  const was = useRef(state)
  useEffect(() => {
    const started = was.current !== undefined && was.current !== 'running' && state === 'running'
    was.current = state
    if (started) animate(dip, [0, 1], { duration: 0.1 })
    if (!span) {
      scale.set(0)
      return
    }
    const t = Date.now()
    const frac = Math.min(1, Math.max(0, (t - span.from) / Math.max(1, span.to - span.from)))
    scale.set(frac)
    if (state === 'paused' || frac >= 1) return
    const ctrl = animate(scale, 1, { duration: (span.to - t) / 1000, ease: 'linear' })
    return () => ctrl.stop()
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return { scale, dip, over: state === 'running' && !!span && now > span.to }
}

/** Under this much of the band, the fill does not show yet. */
const MIN_FILL = 0.04

/** The flat fill layer, and under the text, along the band's bottom edge, a rail as long as the fill: magenta while it
 *  runs, the fill's deeper tone while it waits for its time, a block travelling through it toward its edge (it is fed,
 *  even when its edge moves a pixel a minute). Nothing crosses the text: no line, no block behind the name. */
export function Fill({ x }: { x: AutoItem }) {
  const { scale, dip, over } = useAutoFill(x)
  const width = useTransform(scale, (v) => `${v * 100}%`)
  // A sliver at the left edge would read as a stripe: nothing shows before it has some width.
  const seen = useTransform([scale, dip], ([v, d]: number[]) => (v < MIN_FILL ? 0 : d))
  const running = x.state === 'running'
  const flowing = running || x.state === 'scheduled'
  return (
    <>
      <motion.span className={`auto-fill${x.state === 'paused' ? ' paused' : ''}`} style={{ scaleX: scale, opacity: x.state === 'paused' ? undefined : seen }} aria-hidden />
      {flowing && (
        <motion.span className={`auto-rail${running ? ' run' : ''}${over ? ' over' : ''}`} style={{ width, opacity: seen }} aria-hidden>
          <i />
        </motion.span>
      )}
    </>
  )
}

/** The trigger in words, then where it runs; then, when it matters, what holds it or that its last run failed. */
export function useMetaLine(x: AutoItem): string {
  const t = useT(M)
  const { snap, now } = useApp()
  const project = x.projectId ? (snap.projects.find((p) => p.id === x.projectId)?.name ?? x.projectId) : x.repo
  const parts = [triggerText(x.trigger, now), project]
  if ((x.state === 'waiting' || x.state === 'queued') && x.waiting && x.waiting !== 'time') parts.push(t[`wait_${x.waiting}`])
  else if (x.state === 'queued' && x.place) parts.push(`#${x.place}`)
  if (x.lastRun && !x.lastRun.ok && x.state !== 'running') parts.push(t.failedAgo(short(now - x.lastRun.at, true)))
  else if (x.state === 'done' && x.endedAt) parts.push(t.endedAgo(short(now - x.endedAt, true)))
  return parts.filter(Boolean).join(' · ')
}

/** One band, automation or proposal (the same component and key: a proposal given ✓ slides into its place among the
 *  automations, its glyph turning into theirs). */
function AutoBand({ x, slot, proposal: o }: { x: AutoItem; slot: string; proposal?: Optimizer }) {
  const t = useT(M)
  const { snap, now, push } = useApp()
  const k = useTalk()
  const meta = useMetaLine(x)
  const open = () => push({ kind: 'auto', id: x.id })
  if (o) {
    const f = k.flash.get(o.id) ?? []
    const busy = k.busy.has(o.id)
    const project = x.projectId ? (snap.projects.find((p) => p.id === x.projectId)?.name ?? x.projectId) : o.repo
    return (
      <motion.section layout="position" className="band auto-band auto-prop" style={color(slot)} data-h24={o.id} {...drop}>
        <button className="auto-hit" onClick={open} aria-label={t.taskLabel(o.title, t.state_proposed, [t[`kind_${o.kind}`], o.why].filter(Boolean).join(', '))} />
        <div className="in">
          <span className={chg(f.includes('kind'), 'st')} aria-hidden>
            <Glyph name={KIND_ICON[o.kind]} />
          </span>
          <span className={chg(f.includes('title'), 'auto-name')} aria-hidden>
            {o.title}
          </span>
          {o.why && (
            <span className={chg(f.includes('why'), 'meta sub why')} aria-hidden>
              {o.why}
            </span>
          )}
          <span className={chg(f.some((c) => c === 'every' || c === 'window' || c === 'notBefore' || c === 'repo'), 'meta sub terms')} aria-hidden>
            {[triggerText(x.trigger, now), project].filter(Boolean).join(' · ')}
          </span>
          <span className="chars">
            <button className="ch" onClick={() => k.answer(o, true)} disabled={busy || k.isStale(o)} aria-label={busy ? t.acceptBusy(o.title) : t.accept(o.title)}>
              <Icon name="check" />
            </button>
            <button className="ch" onClick={() => k.answer(o, false)} aria-label={t.refuse(o.title)}>
              <Icon name="close" />
            </button>
          </span>
          {k.notes.get(o.id) && (
            <span className="meta sub" role="status">
              ! {k.notes.get(o.id)}
            </span>
          )}
        </div>
      </motion.section>
    )
  }
  const right = x.state === 'running' && x.startedAt ? short(now - x.startedAt) : x.nextAt && x.state !== 'paused' ? at(x.nextAt, now) : ''
  return (
    <motion.section layout="position" className={`band auto-band${x.state === 'paused' ? ' paused' : ''}`} style={color(slot)} data-h24={x.id} {...drop}>
      <Fill x={x} />
      <button className="auto-hit" onClick={open} aria-label={t.taskLabel(x.title, t[`state_${x.state}`], [meta, right].filter(Boolean).join(', '))} />
      <div className="in" aria-hidden>
        <span className="st">
          <Glyph {...glyphOf(x)} />
        </span>
        <span className="auto-name">{x.title}</span>
        <span className="act">{right}</span>
        <span className="meta sub ellipsis">{meta}</span>
      </div>
    </motion.section>
  )
}
