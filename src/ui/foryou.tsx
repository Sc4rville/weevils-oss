import { pageLinks } from '../../shared/pages'
import { LivingLink } from './living-link'
import { InlineMediaFormats } from './foryou-formats'
import { OutboxStatus } from './outbox-status'
import { SaveMediaButton, useLongPressSave } from './save-media'
import { useForYouOpen } from './foryou-open'
import { busyOf } from './foryou-busy'
import { rawEngineeringNotice } from '../../shared/feed-text.ts'
import { closableFeedNotice, feedNoticeKey, noticeKey } from '../../shared/notices.ts'
import { Notice, NoticeClose, useNotice } from './notice'
import { bigNumber, cardLine, detailLine, formatOf, looksOf, shortLine, streamOf, worthShowing, type ForYouFormat, type ForYouLook } from './foryou-format'
// « For you »: the stream next to weevboss, full screen. One single stream, no sections, no labels: every item is a
// full-width band in its own colour, drawn in one of five layouts (src/ui/foryou-format.ts).
import { AnimatePresence, motion, useIsPresent, useReducedMotion, type PanInfo, type Variants } from 'motion/react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import type { ForYouItem, ForYouMedia, ForYouPulse } from '../../shared/foryou.ts'
import { useApp } from './app-context'
import { spring, useAuthors } from './bits'
import { itemSlot, useForYou, type ForYouStore } from './foryou-store'
import { markSeen as gestureSeen } from './hints'
import { Icon } from './icons'
import { usePageChrome } from './shell'
import { intlLocale, useT } from '../i18n'
import M from '../i18n/foryou'
import './foryou.css'

const cssVar = (name: string) => `var(--${name})`
const slot = (name: string) => ({ '--c': cssVar(name) }) as CSSProperties
/** The left edge stays with the page's back gesture (same width as the code viewer's). */
const EDGE = 22
const SCROLL_KEY = 'stream'
const LOOK_KEY = 'weevils-foryou-look'
const SEEN_AFTER = 1200

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage unavailable */
  }
}

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** A light tap under the finger where the device allows it (accept, send). */
const buzz = () => {
  try {
    navigator.vibrate?.(8)
  } catch {
    /* not allowed here */
  }
}

/** A strip that scrolls sideways natively keeps its swipes: the page (swipe right = back) only gets the left edge.
 * Motion listens natively on the page, so only a native bubble-phase stop keeps it out (as askthread.tsx does). */
function useOwnSwipe(ref: RefObject<HTMLElement | null>, on = true) {
  useEffect(() => {
    const el = ref.current
    if (!el || !on) return
    const claim = (e: PointerEvent) => {
      if (e.clientX >= EDGE) e.stopPropagation()
    }
    el.addEventListener('pointerdown', claim)
    return () => el.removeEventListener('pointerdown', claim)
  }, [ref, on])
}

/** Under the eyes: `ratio` of it shows, or it fills that share of the screen when it is taller. Without an observer: yes. */
function useInView(ref: RefObject<Element | null>, ratio = 0.5, on = true): boolean {
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || !on) return
    if (typeof IntersectionObserver === 'undefined') return void setInView(true)
    const io = new IntersectionObserver(
      ([e]) => {
        const fills = !!e.rootBounds && e.intersectionRect.height >= e.rootBounds.height * ratio
        setInView(e.isIntersecting && (e.intersectionRatio >= ratio || fills))
      },
      { threshold: [0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.75, 1] },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [ref, ratio, on])
  return inView
}

// ---------------------------------------------------------------------------
// Pieces shared by the items.

interface CardProps {
  item: ForYouItem
  fy: ForYouStore
}

/** Where a tap on the item goes. */
function useOpen(item: ForYouItem): (() => void) | undefined {
  const open = useForYouOpen()
  const target = item.work?.open ?? item.open ?? (item.sessionId ? ({ page: 'session', id: item.sessionId } as const) : undefined)
  return target ? () => open(target, item.projectId) : undefined
}


const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)

/** The bars of a voice message: always the same for the same item (drawn from its id), between a quarter and full height. */
export function waveOf(id: string, n: number): number[] {
  let h = hash(id) || 1
  return Array.from({ length: n }, (_, i) => {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0
    // Fuller in the middle, like a sentence: a bell under the noise.
    const bell = 0.55 + 0.45 * Math.sin((Math.PI * (i + 0.5)) / n)
    return Math.round((0.25 + 0.75 * (h / 0xffffffff) * bell) * 100) / 100
  })
}

// ---------------------------------------------------------------------------
// Media: edge to edge, the video plays muted while it is under the eyes, a tap opens it alone, with sound.

/** How much of a media the stream may cut to fill its box: a little. Beyond, it is shown whole on the band's tone. */
const CROP_MAX = 0.12
/** The tallest a media gets in the stream, as a share of the screen (foryou.css: 62dvh). */
const MEDIA_CAP = 0.62

/** cover: it fills its box (at most CROP_MAX of it is cut) · contain: whole, on the tone, in a box of the capped height. */
export function mediaFit(w: number, h: number, boxW: number, boxH: number, fixed: boolean): 'cover' | 'contain' {
  if (!(w > 0 && h > 0 && boxW > 0 && boxH > 0)) return 'cover'
  const natural = (boxW * h) / w // its height at the box's width
  // A box that follows the media (one media alone): only what goes over the cap is cut.
  if (!fixed) return natural > boxH * (1 + CROP_MAX) ? 'contain' : 'cover'
  const kept = Math.min(natural / boxH, boxH / natural)
  return kept < 1 - CROP_MAX ? 'contain' : 'cover'
}

function MediaTile({ m, many }: { m: ForYouMedia; many: boolean }) {
  const t = useT(M)
  const { push } = useApp()
  const tile = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const inView = useInView(tile, 0.6)
  const target = { url: m.url, name: m.name, type: m.type }
  const notOpen = useLongPressSave(tile, target)
  const [fit, setFit] = useState<'cover' | 'contain' | 'crop'>('cover')
  const [focus, setFocus] = useState<{ flat: boolean; at: number } | null>(null)
  const sized = (w: number, h: number) => {
    const el = tile.current
    if (!el) return
    const cap = MEDIA_CAP * (window.innerHeight || 0)
    setFit(m.type === 'image' && h / w > 1.6 ? 'crop' : mediaFit(w, h, el.clientWidth, many ? Math.min(cap, 0.96 * (window.innerWidth || 0)) : cap, many))
  }
  // Muted, and only while it is under the eyes.
  useEffect(() => {
    const v = video.current
    if (!v) return
    try {
      if (inView) void v.play()?.catch(() => undefined)
      else v.pause()
    } catch {
      /* no player here */
    }
  }, [inView])
  return (
    <div ref={tile} className={`fy-media save-media-host ${fit}${inView ? ' fy-inview' : ''}${focus?.flat ? ' fy-flat' : ''}`}>
    <button type="button" className="fy-media-hit" onClickCapture={notOpen} onClick={() => push({ kind: 'media', url: m.url, type: m.type, name: m.name })} aria-label={t.openMedia(m.name)}>
      {m.type === 'video' ? (
        <video ref={video} src={m.url} playsInline muted loop preload="metadata" onLoadedMetadata={(e) => sized(e.currentTarget.videoWidth, e.currentTarget.videoHeight)} />
      ) : (
        <img src={m.url} alt="" loading="lazy" decoding="async" draggable={false} style={focus ? { objectPosition: `50% ${focus.at}%` } : undefined} onLoad={(e) => { const el = e.currentTarget; sized(el.naturalWidth, el.naturalHeight); setFocus(busyOf(el)) }} />
      )}
      {m.type === 'video' && (
        <span className="fy-media-mark" aria-hidden>
          <Icon name="play" />
        </span>
      )}
    </button>
    <SaveMediaButton target={target} />
    </div>
  )
}

function MediaStrip({ media }: { media: ForYouMedia[] }) {
  const t = useT(M)
  const strip = useRef<HTMLDivElement>(null)
  const many = media.length > 1
  useOwnSwipe(strip, many)
  return (
    <div ref={strip} className={many ? 'fy-media-strip many' : 'fy-media-strip'} role={many ? 'group' : undefined} aria-label={many ? t.mediaStrip(media.length) : undefined}>
      {media.map((m) => (
        <MediaTile key={m.id} m={m} many={many} />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The five layouts (src/ui/foryou-format.ts). No speaker, no kind, no frame: big words in the band's colour, a line
// or two at most, one big tap when something waits.

/** A big word to tap: no box, the word itself in the band's colour. quiet: the second choice, smaller and softer. */
function Tap({ label, onTap, quiet, busy }: { label: string; onTap?: () => void; quiet?: boolean; busy?: boolean }) {
  return (
    <button
      type="button"
      className={quiet ? 'fy-tap quiet' : 'fy-tap'}
      disabled={!onTap || busy}
      onClick={() => {
        if (!quiet) buzz()
        onTap?.()
      }}
    >
      {label}
      {!quiet && (
        <span className="fy-tap-go" aria-hidden>
          <Icon name="arrow" dir="right" />
        </span>
      )}
    </button>
  )
}

function ActionCard({ item, fy }: CardProps) {
  const t = useT(M)
  const open = useOpen(item)
  const busy = fy.acting(item.id)
  if (item.kind === 'proposals') {
    const c = item.cards?.[0]
    if (!c) return null
    const title = shortLine(c.title)
    return (
      <div className="in fy-c">
        <p className="fy-say">{c.own ? t.yourIdea(title) : title}</p>
        <div className="fy-taps">
          <Tap label={c.accept || t.tapYes} busy={busy} onTap={() => void fy.act(item.id, 'accept', c.id)} />
          <Tap quiet label={t.tapNotNow} busy={busy} onTap={() => void fy.act(item.id, 'refuse', c.id)} />
        </div>
      </div>
    )
  }
  const vp = item.visualProposal
  const actions = vp && !item.actions?.length ? vp.options.slice(0, 2).map((o) => ({ id: `choice:${o.id}`, label: o.label })) : (item.actions?.slice(0, 2) ?? [])
  const answer = item.kind === 'session' && item.tone === 'question'
  return (
    <div className="in fy-c">
      <p className="fy-say">{cardLine(item)}</p>
      <div className="fy-taps">
        {actions.length
          ? actions.map((a, i) => <Tap key={a.id} quiet={i > 0 && !vp} label={busy ? t.sending : shortLine(a.label, 40) || a.label} busy={busy} onTap={() => void fy.act(item.id, a.id)} />)
          : open && <Tap label={answer ? t.tapAnswer : t.tapLook} onTap={open} />}
      </div>
    </div>
  )
}

/** A text card: the first tap reveals one more line (its detail), the next one opens where it comes from. */
function useReveal(item: ForYouItem) {
  const open = useOpen(item)
  const detail = useMemo(() => detailLine(item), [item])
  const [shown, setShown] = useState(false)
  const tap = detail && !shown ? () => setShown(true) : open
  return { tap, more: shown ? detail : '', can: !!tap }
}

function ProgressCard({ item }: CardProps) {
  const t = useT(M)
  const { tap, more, can } = useReveal(item)
  const num = item.kind === 'milestone' || item.kind === 'stat' ? bigNumber(item) : null
  const line = num ? shortLine(num.rest || (item.recap ? t.doneOvernight : '')) : cardLine(item)
  return (
    <button type="button" className={`in fy-c fy-hit${num ? ' fy-numcard' : ''}`} onClick={tap} disabled={!can}>
      {num && <span className="fy-num tab">{num.n}</span>}
      {line && <span className={num ? 'fy-say' : 'fy-say fy-shipped'}>{line}</span>}
      {more && <span className="fy-more">{more}</span>}
    </button>
  )
}

function LearnCard({ item }: CardProps) {
  const { tap, more, can } = useReveal(item)
  return (
    <button type="button" className="in fy-c fy-hit" onClick={tap} disabled={!can}>
      <span className="fy-learn">{cardLine(item)}</span>
      {more && <span className="fy-more">{more}</span>}
    </button>
  )
}

function ThinkCard({ item }: CardProps) {
  const { tap, more, can } = useReveal(item)
  return (
    <button type="button" className="in fy-c fy-hit" onClick={tap} disabled={!can}>
      <span className="fy-think">{cardLine(item)}</span>
      {more && <span className="fy-more">{more}</span>}
    </button>
  )
}

function VisualCard({ item }: CardProps) {
  const media = item.resultGroup?.final ? [item.resultGroup.final] : (item.media ?? [])
  const caption = shortLine(item.title, 80) || shortLine(item.text, 80)
  return (
    <>
      {item.composition && !item.resultGroup ? <InlineMediaFormats item={item} /> : media.length === 2 ? (
        <div className="fy-two">{media.map((m) => <MediaTile key={m.id} m={m} many />)}</div>
      ) : !!media.length && <MediaStrip media={media} />}
      {caption && (
        <div className="in fy-caption">
          <p className="fy-say small">{caption}</p>
        </div>
      )}
    </>
  )
}

const CARDS: Record<ForYouFormat, (p: CardProps) => ReactNode> = {
  action: ActionCard,
  progress: ProgressCard,
  learn: LearnCard,
  think: ThinkCard,
  visual: VisualCard,
}

/** The band: its layout and tone only (an alert stays calm: never inverted, never red). */
const bandClass = (item: ForYouItem, format: ForYouFormat, look: ForYouLook = 'fill') => `band fy-f-${format} fy-l-${look} fy-t-${item.tone === 'alert' ? 'question' : item.tone}${item.seen ? '' : ' fy-unseen'}${item.workstream?.kind === 'self-improvement' ? ' recursive-identity' : ''}`

/** One item of the stream. compact: a thin strip (one line), nothing to tap inside. Hidden when it has no layout. */
export function ForYouItemView({ item, compact, look }: { item: ForYouItem; compact?: boolean; look?: ForYouLook }) {
  const fy = useForYou()
  const { hidden, dismiss } = useNotice(feedNoticeKey(item))
  const { colors, snap } = useApp()
  const t = useT(M)
  const authors = useAuthors()
  const style = itemSlot(item, colors, authors)
  const band = useRef<HTMLElement>(null)
  const inView = useInView(band, 0.5, !compact)
  const { markSeen } = fy
  // Seen once it stayed under the eyes a moment (any device then knows).
  useEffect(() => {
    if (compact || item.seen || !inView) return
    const timer = setTimeout(() => markSeen([item.id]), SEEN_AFTER)
    return () => clearTimeout(timer)
  }, [compact, item.id, item.seen, inView, markSeen])

  const format = formatOf(item)
  const closable = closableFeedNotice(item)
  if (!format || hidden || rawEngineeringNotice(item.id, item.text) || !worthShowing(item)) return null
  const links = pageLinks([item.text, item.body, item.moreText, item.title].filter(Boolean).join('\n'), [location.host, snap.config.publicHost])
  if (compact) {
    return (
      <div className={`${bandClass(item, format)} fy-strip${closable ? ' notice-shell' : ''}`} style={style} data-fy={item.id}>
        {closable && <NoticeClose about={item.title ?? item.text} onClose={() => { dismiss(); void fy.dismiss(item.id) }} />}
        <div className="in fy-strip-in">
          <span className="fy-strip-text ellipsis">{item.kind === 'proposals' && item.cards?.[0]?.own ? t.yourIdea(shortLine(item.cards[0].title)) : cardLine(item)}{links.map((link) => <span key={link.href}> · <LivingLink {...link} /></span>)}</span>
        </div>
      </div>
    )
  }
  const Card = CARDS[format]
  const err = fy.error(item.id)
  return (
    <article ref={band} className={`${bandClass(item, format, look)} fy-item${closable ? ' notice-shell' : ''}${inView ? ' fy-inview' : ''}`} style={style} data-fy={item.id} data-fy-format={format}>
      {closable && <NoticeClose about={item.title ?? item.text} onClose={() => { dismiss(); void fy.dismiss(item.id) }} />}
      <Card item={item} fy={fy} />
      {!!links.length && <div className="in fy-page-links">{links.map((link) => <p key={link.href}><LivingLink {...link} /></p>)}</div>}
      <OutboxStatus scope={`/api/foryou/${encodeURIComponent(item.id)}/`} eventId={feedNoticeKey(item)} />
      {err && (
        <Notice eventId={noticeKey('error:foryou', location.pathname, location.hash, err)} className="fy-err" role="alert">
          <div className="in meta">{err}</div>
        </Notice>
      )}
    </article>
  )
}

// ---------------------------------------------------------------------------
// The page.

const slide: Variants = { enter: { x: '100%' }, shown: { x: 0 }, leave: { x: '100%' } }

/** A full-screen page like Shell's: slides in from the right, swipe right = back. */
function usePageMotion() {
  const { back } = useApp()
  return {
    variants: slide,
    initial: 'enter',
    animate: 'shown',
    exit: 'leave',
    transition: spring,
    drag: 'x' as const,
    dragDirectionLock: true,
    dragConstraints: { left: 0, right: 0 },
    dragElastic: { left: 0, right: 0.9 },
    dragSnapToOrigin: true,
    onDragEnd: (_: unknown, info: PanInfo) => {
      if (info.offset.x > 110 || info.velocity.x > 600) {
        gestureSeen('g-back')
        back()
      }
    },
  }
}

/** A figure of the line: when it changes, the old number rolls out upwards and the new one rolls in from below. */
function Tick({ text }: { text: string }) {
  const m = /^(\d+)([\s\S]*)$/.exec(text)
  if (!m) return <span className="fy-tick">{text}</span>
  return (
    <span className="fy-tick">
      <span className="fy-tick-n tab">
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span key={m[1]} initial={{ y: '85%', opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: '-85%', opacity: 0 }} transition={spring}>
            {m[1]}
          </motion.span>
        </AnimatePresence>
      </span>
      {m[2]}
    </span>
  )
}

/** The line: what is turning right now. The only thing always alive: a star spins per working agent, figures roll when they change. */
export function ForYouPulse({ pulse }: { pulse: ForYouPulse }) {
  const t = useT(M)
  const stars = Math.min(pulse.working, 6)
  const parts: [string, string][] = []
  if (pulse.working > 0) parts.push(['working', t.pulseWorking(pulse.working)])
  if (pulse.delivered > 0) parts.push(['delivered', t.pulseDelivered(pulse.delivered)])
  if (pulse.waiting > 0) parts.push(['waiting', t.pulseWaiting(pulse.waiting)])
  if (pulse.auto > 0) parts.push(['auto', t.pulseAuto(pulse.auto)])
  return (
    <div className="band fy-pulse" role="group" aria-label={t.pulseLabel}>
      <div className="in fy-pulse-in">
        {stars > 0 && (
          <span className="fy-stars" aria-hidden>
            {Array.from({ length: stars }, (_, i) => (
              <span key={i} className="spin fluo" style={{ animationDelay: `${-i * 0.43}s` }}>
                <Icon name="star" />
              </span>
            ))}
          </span>
        )}
        <span className="fy-pulse-text">
          {parts.length
            ? parts.map(([key, text], i) => (
                <span key={key} className="fy-pulse-part">
                  <Tick text={text} />
                  {i < parts.length - 1 && ' · '}
                </span>
              ))
            : t.pulseQuiet}
        </span>
      </div>
    </div>
  )
}


/** How long the word flashed where an acted item was stays, before the next ones close the gap (seconds). */
const LEFT_HOLD = 0.62

/** An item's place in the stream. It comes in once with the house spring. Acted on, it leaves sideways (launched, sent:
 * to the right; refused, dismissed: to the left), a word flashes where it was, then the next ones close the gap. */
function Slot({ item, index, look, opening: atOpening }: { item: ForYouItem; index: number; look: ForYouLook; opening: boolean }) {
  const t = useT(M)
  // Decided once, when it comes in: a slot that came in with the page keeps that entrance for good (were its target to
  // change at the next render, Motion would send « y » back to where it started and every band would sit 22 px low).
  const [opening] = useState(atOpening)
  const { leaving, leftAs } = useForYou()
  const calm = useReducedMotion()
  const present = useIsPresent()
  const id = item.id
  const variants = useMemo<{ slot: Variants; body: Variants }>(
    () => ({
      slot: {
        gone: () =>
          leaving(id)
            ? { height: 0, transition: { height: calm ? { duration: 0, delay: LEFT_HOLD } : { ...spring, delay: LEFT_HOLD } } }
            : { opacity: 0, height: 0 },
      },
      body: {
        gone: () => {
          const d = leaving(id)
          if (!d) return {}
          // Reduced motion: it fades where it is. Otherwise a spring a little softer than the house one: the way out is seen.
          return calm ? { opacity: 0, transition: { duration: 0.18 } } : { x: d > 0 ? '100%' : '-100%', transition: { type: 'spring', stiffness: 240, damping: 30, mass: 0.9 } }
        },
      },
    }),
    [id, leaving, calm],
  )
  const left = present ? undefined : leftAs(id)
  // Opening the page: the first six come in one after the other, the next ones as they reach the screen (once).
  const later = opening && index >= 6
  return (
    <motion.div
      className="clip fy-slot"
      variants={variants.slot}
      initial={opening ? { opacity: 0, y: 22 } : { opacity: 0, height: 0 }}
      animate={later ? undefined : opening ? { opacity: 1, y: 0 } : { opacity: 1, height: 'auto' }}
      whileInView={later ? { opacity: 1, y: 0 } : undefined}
      viewport={later ? { once: true, amount: 0.05 } : undefined}
      exit="gone"
      transition={opening && !later ? { ...spring, delay: index * 0.04 } : spring}
    >
      {left && (
        <div className={`band invert fy-left fy-left-${leaving(id) < 0 ? 'l' : 'r'}`} role="status">
          <div className="in fy-left-in">
            <Icon name={left === 'dismissed' ? 'close' : 'check'} /> {left === 'launched' ? t.launched : left === 'sent' ? t.sent : t.dismissed}
          </div>
        </div>
      )}
      <motion.div className="fy-slot-body" variants={variants.body}>
        <ForYouItemView item={item} look={look} />
      </motion.div>
    </motion.div>
  )
}

function Stream({ items }: { items: ForYouItem[] }) {
  const opening = useRef(true)
  useEffect(() => {
    opening.current = false
  }, [])
  const looks = useMemo(() => looksOf(items), [items])
  return (
    <AnimatePresence>
      {items.map((it, i) => (
        <Slot key={it.id} item={it} index={i} look={looks[i]} opening={opening.current} />
      ))}
    </AnimatePresence>
  )
}

/** The time of the previous look, short: the hour today, the day before that. */
function lookTime(at: number): string {
  const d = new Date(at)
  const today = new Date().toDateString() === d.toDateString()
  return new Intl.DateTimeFormat(intlLocale(), today ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(d)
}

/** « Pour toi » in full screen. who: the participant isolated at opening (else the one chosen last time). */
const feedScroll = new Map<string, number>()
export function ForYouPage(_: { who?: string } = {}) {
  const t = useT(M)
  const { back } = useApp()
  const fy = useForYou()
  const page = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  usePageChrome('agent', page)
  const move = usePageMotion()
  const [lastLook] = useState(() => Number(read(LOOK_KEY)) || 0)
  const { showFresh, setReading } = fy
  useLayoutEffect(() => {
    // Opening the page is a fresh look: what waited comes in, in the server's order.
    showFresh()
    heading.current?.focus({ preventScroll: true })
    write(LOOK_KEY, String(Date.now()))
    const y = feedScroll.get(SCROLL_KEY) ?? 0
    if (body.current) body.current.scrollTop = y
    setReading(y > 48)
    return () => setReading(false)
  }, [showFresh, setReading])

  const toTop = (smooth: boolean) => body.current?.scrollTo?.({ top: 0, behavior: smooth && !reduced() ? 'smooth' : 'auto' })
  // One single stream: no filter, no section; only items that have a layout, at most STREAM_CAP of them.
  const shown = useMemo(() => streamOf(fy.items), [fy.items])

  return (
    <motion.div ref={page} className="page fy-page" style={slot('agent')} {...move} role="dialog" aria-modal="true" aria-label={t.title}>
      <div className="page-head band tone fy-top">
        <div className="in fy-top-in">
          <button className="back" onClick={back} aria-label={t.back}>
            <span aria-hidden>
              <Icon name="chevron" dir="left" />
            </span>
          </button>
          <div className="fy-words">
            <h1 ref={heading} tabIndex={-1} className="word on">
              {t.title}
            </h1>
          </div>
        </div>
      </div>
      <div ref={body} className="page-body fy-body" data-scroll onScroll={(e) => { feedScroll.set(SCROLL_KEY, e.currentTarget.scrollTop); setReading(e.currentTarget.scrollTop > 48) }}>
        <AnimatePresence initial={false}>
          {fy.fresh > 0 && (
            <Notice key="fresh-notice" eventId={noticeKey('fresh-items', fy.feed?.items.map(feedNoticeKey))}>
            <motion.button
              key="fresh"
              className="band invert fy-fresh"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={spring}
              onClick={() => {
                showFresh()
                toTop(true)
              }}
            >
              <span className="in fy-fresh-in">
                <Icon name="arrow" /> {t.fresh(fy.fresh)}
              </span>
            </motion.button>
            </Notice>
          )}
        </AnimatePresence>
        <Stream items={shown} />
        {fy.feed &&
          (shown.length ? (
            <div className="fy-end">
              <div className="in meta">
                {lastLook ? t.upToDateSince(lookTime(lastLook)) : t.upToDate}
              </div>
            </div>
          ) : (
            <div className="fy-end fy-quiet">
              <div className="in meta">{t.empty}</div>
            </div>
          ))}
        <div className="fill" />
      </div>
    </motion.div>
  )
}

/** One media of the stream, alone and whole, on the page's colour (never black). Back: the chevron or a swipe right. */
export function MediaPage({ url, type, name }: { url: string; type: 'image' | 'video'; name: string }) {
  const t = useT(M)
  const { back } = useApp()
  const page = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const picture = useRef<HTMLImageElement>(null)
  usePageChrome('agent', page)
  const move = usePageMotion()
  // A long press on the photo saves it, as the system's own callout would (the host turns that callout off). A video
  // keeps its long presses for the player's bar.
  useLongPressSave(picture, { url, name, type })
  // The player's own bar (scrubbing) keeps its drags.
  useOwnSwipe(video, type === 'video')
  return (
    <motion.div ref={page} className="page fy-viewer" style={slot('agent')} {...move} role="dialog" aria-modal="true" aria-label={name}>
      <div className="fy-viewer-top">
        <button className="ch" onClick={back} aria-label={t.back}>
          <Icon name="chevron" dir="left" />
        </button>
      </div>
      <div className="fy-stage save-media-host">{type === 'video' ? <video ref={video} src={url} controls autoPlay playsInline loop aria-label={name} /> : <img ref={picture} src={url} alt={name} draggable={false} />}<SaveMediaButton target={{ url, name, type }} /></div>
    </motion.div>
  )
}