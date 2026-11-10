import { rawEngineeringNotice } from '../../shared/feed-text.ts'
import { closableFeedNotice, feedNoticeKey, noticeKey } from '../../shared/notices.ts'
import { Notice, NoticeClose, useNotice } from './notice'
// « Pour toi » : the stream next to weevboss, full screen. Every item is a full-width band in its own colour
// (project, author, weevboss, or the colour of what it says: done, asks, cut), one renderer per kind (docs/foryou.md §2.1).
import { AnimatePresence, motion, useIsPresent, useReducedMotion, type PanInfo, type Variants } from 'motion/react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode, type RefObject } from 'react'
import type { ForYouCard, ForYouGauge, ForYouItem, ForYouMedia, ForYouPulse } from '../../shared/foryou.ts'
import { useApp } from './app-context'
import { Collapse, spring, useAuthors } from './bits'
import { flash, focusBoss } from './follow'
import { ago } from './format'
import { cardSlots, itemSlot, itemWho, matchesWho, participants, useForYou, WHO_ALL, type ForYouStore } from './foryou-store'
import { toggleVoice, useVoice } from './foryou-voice'
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
const WHO_KEY = 'weevils-foryou-who'
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

interface KindProps {
  item: ForYouItem
  who: string
  project?: string
  inView: boolean
  fy: ForYouStore
}

/** Where a tap on the item goes. */
function useOpen(item: ForYouItem): (() => void) | undefined {
  const { push, home, setH24Open } = useApp()
  const o = item.open ?? (item.sessionId ? ({ page: 'session', id: item.sessionId } as const) : undefined)
  if (!o) return undefined
  switch (o.page) {
    case 'session':
      return () => push({ kind: 'session', id: o.id })
    case 'boss':
      return () => focusBoss({ mid: o.mid, flash: !!o.mid })
    case 'auto':
      return () => {
        home()
        setH24Open(true, o.id)
      }
    case 'usage':
      return () => push({ kind: 'usage' })
    case 'machine':
      return () => push({ kind: 'machine', projectId: item.projectId ?? '' })
  }
}

/** The speaker line: unseen dot, who, when; a tap opens the place it speaks of. */
function Who({ item, who, extra, children }: { item: ForYouItem; who: string; extra?: string; children?: ReactNode }) {
  const t = useT(M)
  const { now } = useApp()
  const open = useOpen(item)
  const line = (
    <>
      <span className="dot fy-dot" role={item.seen ? undefined : 'img'} aria-label={item.seen ? undefined : t.unseen} aria-hidden={item.seen ? true : undefined} />
      <span className="fy-who-name">{who}</span>
      {extra && <span className="fy-who-extra"> · {extra}</span>}
      <span className="fy-at"> · {ago(Math.max(0, now - item.at))}</span>
    </>
  )
  return (
    <div className="fy-who">
      {open ? (
        <button className="fy-who-line" onClick={open} aria-label={t.openIt(extra ? `${who} · ${extra}` : who)}>
          {line}
        </button>
      ) : (
        <span className="fy-who-line">{line}</span>
      )}
      {children}
    </div>
  )
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

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

/** A voice message: the play square and a wave of bars. A tap reads the item aloud in its speaker's voice (one at a
 * time for the whole stream, src/ui/foryou-voice.ts); the bars only move while it speaks. small: inside a thin line. */
function Listen({ item, who, small }: { item: ForYouItem; who: string; small?: boolean }) {
  const t = useT(M)
  const v = useVoice(item.id)
  const bars = useMemo(() => waveOf(item.id, small ? 7 : 26), [item.id, small])
  if (!item.voice || !item.text) return null
  const on = v.phase === 'playing' || v.phase === 'loading'
  return (
    <button
      type="button"
      className={`fy-listen fy-v-${v.phase}${small ? ' small' : ''}`}
      onClick={() => toggleVoice(item.id, item.text, item.voice ?? '')}
      aria-label={on ? t.stop : t.listen(who)}
      aria-pressed={on}
    >
      <span className="fy-listen-mark" aria-hidden>
        <Icon name={on ? 'pause' : 'play'} />
      </span>
      <span className="fy-wave" aria-hidden>
        {bars.map((h, i) => (
          <i key={i} style={{ '--h': h, '--d': `${-((i * 0.137) % 0.9).toFixed(3)}s` } as CSSProperties} />
        ))}
      </span>
      <span className="fy-listen-note tab" role="status">
        {v.phase === 'error' ? t.voiceFailed : v.phase === 'playing' ? clock(v.seconds) : ''}
      </span>
    </button>
  )
}

/** Where things stand, as flat bars: the label and the figure, the bar under them. They fill from nothing the first
 * time they come under the eyes (once; no animation when motion is reduced, foryou.css). A project's bar takes its
 * colour, a bar close to a limit the alert colour, the others the ink. */
function Gauges({ list }: { list: ForYouGauge[] }) {
  const { colors } = useApp()
  const box = useRef<HTMLDivElement>(null)
  const inView = useInView(box, 0.35)
  const [filled, setFilled] = useState(false)
  useEffect(() => {
    if (inView) setFilled(true)
  }, [inView])
  return (
    <div ref={box} className={filled ? 'fy-gauges fy-filled' : 'fy-gauges'}>
      {list.map((g, i) => {
        const pct = g.max > 0 ? Math.max(0, Math.min(100, (g.value / g.max) * 100)) : 0
        const own = !g.hot && g.projectId && colors[g.projectId] ? cssVar(colors[g.projectId]) : undefined
        return (
          <div
            key={i}
            className={`fy-gauge${g.hot ? ' hot' : ''}${own ? ' own' : ''}`}
            style={{ '--v': `${pct}%`, '--i': i, ...(own ? { '--g': own } : {}) } as CSSProperties}
            role="meter"
            aria-label={g.label}
            aria-valuemin={0}
            aria-valuemax={g.max}
            aria-valuenow={g.value}
            aria-valuetext={g.shown}
          >
            <span className="fy-gauge-label ellipsis">{g.label}</span>
            <span className="fy-gauge-shown tab">{g.shown}</span>
            <span className="fy-gauge-bar" aria-hidden>
              <i />
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** The item's buttons: the server knows what each one does. The item leaves once tapped. */
function Actions({ item, fy }: { item: ForYouItem; fy: ForYouStore }) {
  const t = useT(M)
  if (!item.actions?.length) return null
  return (
    <div className="in fy-acts" aria-busy={fy.acting(item.id)}>
      {item.actions.map((a) => (
        <button
          key={a.id}
          className="fy-btn"
          disabled={fy.acting(item.id)}
          onClick={() => {
            buzz()
            void fy.act(item.id, a.id)
          }}
        >
          {fy.acting(item.id) ? t.sending : a.label}
        </button>
      ))}
    </div>
  )
}

/** A reply typed right under the item: « > », the field, the arrow. Said « sent » at once; the text comes back if it failed. */
function ReplyLine({ item, who, fy }: { item: ForYouItem; who: string; fy: ForYouStore }) {
  const t = useT(M)
  const key = `weevils-feed-draft:${item.id}`
  const [text, setText] = useState(() => { try { return sessionStorage.getItem(key) ?? '' } catch { return '' } })
  useEffect(() => { try { if (text) sessionStorage.setItem(key, text); else sessionStorage.removeItem(key) } catch { /* private storage */ } }, [key, text])
  const submitting = useRef(false)
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const form = useRef<HTMLFormElement>(null)
  // Who receives it, not who spoke: under an idea of weevils, the words go to weevboss.
  const to = item.reply === 'boss' ? 'weevboss' : who
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const field = form.current?.querySelector('input')
    const original = field?.value ?? text
    const body = original.trim()
    if (!body || busy || submitting.current) return
    submitting.current = true
    setText(original)
    setErr(null)
    setSent(false)
    setBusy(true)
    buzz()
    flash(form.current)
    try {
      await fy.reply(item.id, body)
      setSent(true)
      if (field?.value === original) {
        field.value = ''
        try { sessionStorage.removeItem(key) } catch { /* private storage */ }
      }
      setText((current) => current === original ? '' : current)
    } catch (e) {
      setSent(false)
      setErr(e instanceof Error && e.message ? e.message : t.failed)
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }
  return (
    <form ref={form} className="tone fy-reply" aria-busy={busy} data-draft={!!text} onSubmit={submit}>
      <div className="in fy-reply-in">
        <span className="fy-reply-gt" aria-hidden>
          <Icon name="chevron" dir="right" />
        </span>
        <input
          type="text"
          name={`fy-reply-${item.id}`}
          value={text}
          onChange={(e) => { setText(e.target.value); setSent(false) }}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.nativeEvent.isComposing || e.keyCode === 229)) e.preventDefault() }}
          placeholder={t.replyTo(to)}
          aria-label={t.replyLabel(to, item.title ?? item.text.slice(0, 60))}
          enterKeyHint="send"
          autoComplete="off"
          autoCapitalize="sentences"
        />
        <span className="fy-sent" role="status">
          {busy && t.sending}
          {sent && (
            <>
              <Icon name="check" /> {t.sent}
            </>
          )}
        </span>
        <button type="submit" className="fy-send" aria-label={t.send} disabled={!text.trim() || busy}>
          <Icon name="arrow" />
        </button>
      </div>
      {err && (
        <Notice eventId={noticeKey('error:foryou', location.pathname, location.hash, err)} className="in meta fy-reply-err" role="alert">
          ! {err}
        </Notice>
      )}
    </form>
  )
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
  const tile = useRef<HTMLButtonElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const inView = useInView(tile, 0.6)
  const [fit, setFit] = useState<'cover' | 'contain' | 'crop'>('cover')
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
    <button ref={tile} className={`fy-media ${fit}${inView ? ' fy-inview' : ''}`} onClick={() => push({ kind: 'media', url: m.url, type: m.type, name: m.name })} aria-label={t.openMedia(m.name)}>
      {m.type === 'video' ? (
        <video ref={video} src={m.url} playsInline muted loop preload="metadata" onLoadedMetadata={(e) => sized(e.currentTarget.videoWidth, e.currentTarget.videoHeight)} />
      ) : (
        <img src={m.url} alt="" loading="lazy" decoding="async" draggable={false} onLoad={(e) => sized(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)} />
      )}
      <span className="fy-media-open">{m.type === 'image' ? t.fullImage : t.fullVideo}</span>
      {m.type === 'video' && (
        <span className="fy-media-mark" aria-hidden>
          <Icon name="play" />
        </span>
      )}
    </button>
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

function MediaItem({ item, who, fy }: KindProps) {
  return (
    <>
      <div className="tone fy-cap">
        <div className="in">
          <Who item={item} who={who}>
            <Listen item={item} who={who} small />
          </Who>
          {item.title && <div className="fy-title">{item.title}</div>}
          {item.text && item.text !== item.title && <div className="fy-text">{item.text}</div>}
          {!!item.gauges?.length && <Gauges list={item.gauges} />}
        </div>
      </div>
      {!!item.media?.length && <MediaStrip media={item.media} />}
      <Actions item={item} fy={fy} />
      {item.reply && <ReplyLine item={item} who={who} fy={fy} />}
    </>
  )
}

// ---------------------------------------------------------------------------
// weevboss, mail.

function BossItem({ item, who, fy }: KindProps) {
  const t = useT(M)
  const open = useOpen(item)
  return (
    <>
      <div className="in fy-pad">
        <Who item={item} who={who} />
        {/* Audio stays mounted and independent of the optional transcript. */}
        <Listen item={item} who={who} />
        {item.title && <div className="fy-title">{item.title}</div>}
        {item.voice && item.text ? (
          <details className="fy-transcript" key={item.id}>
            <summary>
              <span className="fy-transcript-read">{t.readTranscript}</span>
              <span className="fy-transcript-hide">{t.hideTranscript}</span>
              <Icon name="chevron" dir="down" />
            </summary>
            <div className="fy-text">{item.text}</div>
          </details>
        ) : <div className="fy-text">{item.text}</div>}
        {!!item.gauges?.length && <Gauges list={item.gauges} />}
      </div>
      {!!item.media?.length && <MediaStrip media={item.media} />}
      {item.id.startsWith('auto:proposed:') && open && <div className="in fy-pad-b"><button className="fy-btn" onClick={open}>{t.openIdea}</button></div>}
      <Actions item={item} fy={fy} />
      {item.reply && <ReplyLine item={item} who={who} fy={fy} />}
    </>
  )
}

/** A thin line (who · what was done); a tap unfolds the whole message, and the reply line with it. */
function MailItem({ item, who, fy }: KindProps) {
  const [open, setOpen] = useState(false)
  const more = !!item.body || !!item.reply
  return (
    <>
      <div className="in fy-mail-in">
        <Listen item={item} who={who} small />
        <button className="fy-mail" onClick={() => setOpen((v) => !v)} aria-expanded={open} disabled={!more}>
          <span className="dot fy-dot" aria-hidden />
          <span className="fy-who-name">{who}</span>
          <span className="fy-mail-sum ellipsis">{item.text}</span>
          {more && (
            <span className="fy-go" aria-hidden>
              <Icon name="chevron" dir={open ? 'up' : 'down'} />
            </span>
          )}
        </button>
      </div>
      <Collapse open={open}>
        <div className="tone">
          <div className="in fy-mail-body">
            {item.title && <div className="fy-title">{item.title}</div>}
            <div className="fy-text">{item.body ?? item.text}</div>
          </div>
        </div>
        {item.reply && <ReplyLine item={item} who={who} fy={fy} />}
      </Collapse>
    </>
  )
}

// ---------------------------------------------------------------------------
// Proposals: always the same trait, « + » before the title and the ✓ × pair. One: a wide band. Several: columns side by
// side that scroll natively, each in its own colour. ✓ leaves to the right, × to the left.

function Proposals({ item, who, fy }: KindProps) {
  const t = useT(M)
  const strip = useRef<HTMLDivElement>(null)
  const cards = item.cards ?? []
  const scrolls = cards.length > 2
  useOwnSwipe(strip, scrolls)
  // A colour per card, kept while it stays: one leaving does not repaint the others.
  const slots = useRef(new Map<string, string>())
  slots.current = cardSlots(
    cards.map((c) => c.id),
    slots.current,
  )
  // Two share the width; from three on, each takes most of it and the next one clearly shows its edge (it snaps).
  const basis = cards.length <= 1 ? '100%' : cards.length === 2 ? '50%' : '78%'
  const answer = (c: ForYouCard, yes: boolean) => {
    if (yes) buzz()
    void fy.act(item.id, yes ? 'accept' : 'refuse', c.id)
  }
  const gone = (id: string) => ({ x: fy.leaving(id) < 0 ? '-100%' : '100%', opacity: 0, flexBasis: '0%' })
  return (
    <>
      <div ref={strip} className={scrolls ? 'fy-props scroll' : 'fy-props'} role="list" aria-label={t.proposals}>
        <AnimatePresence initial={false}>
          {cards.map((c) => (
            <motion.div
              key={c.id}
              role="listitem"
              className={cards.length <= 1 ? 'fy-card wide' : 'fy-card'}
              style={slot(slots.current.get(c.id) ?? 'p9')}
              variants={{ gone: () => gone(c.id) }}
              initial={{ flexBasis: '0%', opacity: 0 }}
              animate={{ flexBasis: basis, opacity: 1, x: 0 }}
              exit="gone"
              transition={spring}
            >
              <div className="fy-card-in">
                <div className="fy-card-text">
                  <div className="fy-card-t">
                    <span className="fy-plus" aria-hidden>
                      <Icon name="plus" />
                    </span>
                    {c.title}
                  </div>
                  {c.why && <div className="fy-card-w">{c.why}</div>}
                </div>
                <div className="fy-card-acts">
                  <button className="fy-ok" onClick={() => answer(c, true)} aria-label={t.accept(c.title)}>
                    <Icon name="check" />
                    {c.accept && <span className="fy-ok-word">{c.accept}</span>}
                  </button>
                  <button className="fy-no" onClick={() => answer(c, false)} aria-label={t.refuse(c.title)}>
                    <Icon name="close" />
                  </button>
                </div>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
      {item.reply && <ReplyLine item={item} who={who} fy={fy} />}
    </>
  )
}

// ---------------------------------------------------------------------------
// A session: project · title (a tap opens the real conversation), what it did / asks / why it stopped.

function SessionItem({ item, who, project, fy }: KindProps) {
  const t = useT(M)
  const { now } = useApp()
  const open = useOpen(item)
  const [unfold, setUnfold] = useState(false)
  const said = item.tone === 'result' ? t.toneResult : item.tone === 'question' ? t.toneQuestion : item.tone === 'alert' ? t.toneAlert : null
  const name = project ?? who
  const label = item.title ? `${name} · ${item.title}` : name
  // A result says what was done in one line; the whole report and the reply wait behind a tap. A question or a cut
  // keeps its reply line in sight: answering is the point.
  const result = item.tone === 'result'
  const fold = !!item.body || (result && !!item.reply)
  return (
    <>
      <button className="fy-head" onClick={open} disabled={!open} aria-label={t.openSession(label)}>
        <span className="in fy-head-in">
          <span className="fy-head-text">
            <span className="dot fy-dot" aria-hidden />
            <span className="fy-who-name">{name}</span>
            {item.title && <span className="fy-head-title"> · {item.title}</span>}
          </span>
          {open && (
            <span className="fy-go" aria-hidden>
              <Icon name="arrow" dir="right" />
            </span>
          )}
        </span>
      </button>
      <div className="in fy-pad-b">
        <div className="fy-said">
          {said && <span className="fy-said-word">{said}</span>}
          <span className="fy-at">
            {said ? ' · ' : ''}
            {ago(Math.max(0, now - item.at))}
          </span>
          <Listen item={item} who={name} small />
        </div>
        {item.tone === 'question' ? (
          // A question card: only the short title in bold, the question itself at reading size.
          <>
            {item.lead && <div className="fy-q-lead">{item.lead}</div>}
            <div className="fy-q">{item.text}</div>
          </>
        ) : fold ? (
          <button className="fy-line fy-line-btn" onClick={() => setUnfold((v) => !v)} aria-expanded={unfold}>
            <span>{item.text}</span>
            <span className="fy-line-more" aria-hidden>
              {' '}
              <Icon name="chevron" dir={unfold ? 'up' : 'down'} />
            </span>
          </button>
        ) : (
          <div className="fy-line">{item.text}</div>
        )}
        {!!item.gauges?.length && <Gauges list={item.gauges} />}
      </div>
      {!!item.media?.length && <MediaStrip media={item.media} />}
      <Actions item={item} fy={fy} />
      {fold && (
        <Collapse open={unfold}>
          {item.body && (
            <div className="tone">
              <div className="in fy-mail-body">
                <div className="fy-text">{item.body}</div>
              </div>
            </div>
          )}
          {result && item.reply && <ReplyLine item={item} who={name} fy={fy} />}
        </Collapse>
      )}
      {/* The project is enough here: the title sits just above, and with it the placeholder was cut mid-word on a phone. */}
      {!result && item.reply && <ReplyLine item={item} who={name} fy={fy} />}
    </>
  )
}

// ---------------------------------------------------------------------------
// Improve (the one place colour goes wild), alert (sober), insight (a page you learn from), milestone, stat.

function ImproveItem({ item, who, fy }: KindProps) {
  return (
    <>
      <div className="in fy-pad">
        <Who item={item} who={who} />
        {item.title && <div className="fy-title">{item.title}</div>}
        <div className="fy-text fy-lead">{item.text}</div>
        {!!item.gauges?.length && <Gauges list={item.gauges} />}
      </div>
      <Actions item={item} fy={fy} />
      {item.reply && <ReplyLine item={item} who={who} fy={fy} />}
    </>
  )
}

function AlertItem({ item, fy }: KindProps) {
  const t = useT(M)
  const open = useOpen(item)
  const text = item.title && item.title !== item.text ? `${item.title} · ${item.text}` : item.text
  return (
    <>
      <button className="fy-alert" onClick={open} disabled={!open} aria-label={open ? t.openIt(text) : undefined}>
        <span className="in fy-alert-in">
          <span className="fy-bang" aria-hidden>
            <Icon name="bang" />
          </span>
          <span className="fy-alert-text">{text}</span>
          {open && (
            <span className="fy-go" aria-hidden>
              <Icon name="arrow" dir="right" />
            </span>
          )}
        </span>
      </button>
      <Actions item={item} fy={fy} />
    </>
  )
}

function InsightItem({ item, who, project, fy }: KindProps) {
  const t = useT(M)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const toggle = async () => {
    if (open) return setOpen(false)
    if (item.moreText) return setOpen(true)
    setBusy(true)
    setErr(null)
    try {
      await fy.more(item.id)
      setOpen(true)
    } catch (e) {
      setErr(e instanceof Error && e.message ? e.message : t.failed)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="in fy-pad">
      <Who item={item} who={project ?? who} />
      {item.title && <div className="fy-title">{item.title}</div>}
      <p className="fy-big">{item.text}</p>
      <Collapse open={open && !!item.moreText}>
        <div className="fy-text fy-more">{item.moreText}</div>
      </Collapse>
      {item.more && (
        <button className="link fy-more-btn" onClick={() => void toggle()} aria-expanded={open} disabled={busy}>
          {busy ? (
            <>
              {t.searching}
              <span className="dots" aria-hidden>
                <i />
                <i />
                <i />
              </span>
            </>
          ) : open ? (
            t.less
          ) : (
            t.more
          )}
        </button>
      )}
      {err && (
        <Notice eventId={noticeKey('error:foryou', location.pathname, location.hash, err)} className="meta" role="alert">
          ! {err}
        </Notice>
      )}
    </div>
  )
}

function MilestoneItem({ item, who, project }: KindProps) {
  return (
    <div className="in fy-pad">
      <Who item={item} who={project ?? who} />
      {item.title && <div className="fy-title">{item.title}</div>}
      <div className="fy-shift">{item.text}</div>
      {!!item.gauges?.length && <Gauges list={item.gauges} />}
    </div>
  )
}

function StatItem({ item, who, project, fy }: KindProps) {
  return (
    <>
      <div className="in fy-pad">
        <Who item={item} who={project ?? who} />
        {item.title && <div className="fy-title">{item.title}</div>}
        {item.text && <div className="fy-text">{item.text}</div>}
        {!!item.gauges?.length && <Gauges list={item.gauges} />}
      </div>
      <Actions item={item} fy={fy} />
    </>
  )
}

const KINDS: Record<ForYouItem['kind'], (p: KindProps) => ReactNode> = {
  media: MediaItem,
  boss: BossItem,
  mail: MailItem,
  proposals: Proposals,
  session: SessionItem,
  improve: ImproveItem,
  alert: AlertItem,
  insight: InsightItem,
  milestone: MilestoneItem,
  stat: StatItem,
}

/** The band's extra classes: an alert and a milestone are drawn inverted (ink band, coloured words). */
const bandClass = (item: ForYouItem) => `band fy-k-${item.kind} fy-t-${item.tone}${item.kind === 'alert' || item.kind === 'milestone' ? ' invert' : ''}${item.seen ? '' : ' fy-unseen'}`

/** One line of an item, for the thin strips of the top band's preview. */
const oneLine = (item: ForYouItem) => (item.kind === 'proposals' ? (item.cards?.[0]?.title ?? item.text) : item.kind === 'media' ? item.title || item.text : item.text || item.title || '')

/** One item of the stream. compact: a thin strip (speaker · one line), nothing to tap inside. */
export function ForYouItemView({ item, compact }: { item: ForYouItem; compact?: boolean }) {
  const fy = useForYou()
  const { hidden, dismiss } = useNotice(feedNoticeKey(item))
  const { colors, snap } = useApp()
  const authors = useAuthors()
  const project = item.projectId ? snap.projects.find((p) => p.id === item.projectId)?.name : undefined
  const who = itemWho(item, authors, project)
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

  const closable = closableFeedNotice(item)
  if (hidden || rawEngineeringNotice(item.id, item.text)) return null
  if (compact) {
    return (
      <div className={`${bandClass(item)} fy-strip${closable ? ' notice-shell' : ''}`} style={style} data-fy={item.id}>
        {closable && <NoticeClose about={item.title ?? item.text} onClose={() => { dismiss(); void fy.dismiss(item.id) }} />}
        <div className="in fy-strip-in">
          <span className="dot fy-dot" aria-hidden />
          {item.kind === 'proposals' && (
            <span className="fy-plus" aria-hidden>
              <Icon name="plus" />
            </span>
          )}
          <span className="fy-who-name">{who}</span>
          <span className="fy-strip-text ellipsis">{oneLine(item)}</span>
        </div>
      </div>
    )
  }
  const Kind = KINDS[item.kind]
  const err = fy.error(item.id)
  return (
    <article ref={band} className={`${bandClass(item)} fy-item${closable ? ' notice-shell' : ''}${inView ? ' fy-inview' : ''}`} style={style} data-fy={item.id} data-fy-kind={item.kind}>
      {closable && <NoticeClose about={item.title ?? item.text} onClose={() => { dismiss(); void fy.dismiss(item.id) }} />}
      {Kind && <Kind item={item} who={who} project={project} inView={inView} fy={fy} />}
      {err && (
        <Notice eventId={noticeKey('error:foryou', location.pathname, location.hash, err)} className="fy-err" role="alert">
          <div className="in meta">! {err}</div>
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
function ForYouPulse({ pulse }: { pulse: ForYouPulse }) {
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

function Participants({ list, sel, onPick }: { list: string[]; sel: string; onPick: (who: string) => void }) {
  const t = useT(M)
  const authors = useAuthors()
  const row = useRef<HTMLDivElement>(null)
  useOwnSwipe(row)
  const name = (w: string) => (w === WHO_ALL ? t.whoAll : w === 'weevboss' ? w : w === 'session' ? t.whoSessions : w === 'media' ? t.whoMedia : w === 'ideas' ? t.whoIdeas : authors(w).name)
  return (
    <div ref={row} className="fy-people" role="group" aria-label={t.participants}>
      {list.map((w) => (
        <button key={w} className={w === sel ? 'word on' : 'word'} aria-pressed={w === sel} onClick={() => onPick(w)}>
          {name(w)}
        </button>
      ))}
    </div>
  )
}

/** How long the word flashed where an acted item was stays, before the next ones close the gap (seconds). */
const LEFT_HOLD = 0.62

/** An item's place in the stream. It comes in once with the house spring. Acted on, it leaves sideways (launched, sent:
 * to the right; refused, dismissed: to the left), a word flashes where it was, then the next ones close the gap. */
function Slot({ item, index, opening: atOpening }: { item: ForYouItem; index: number; opening: boolean }) {
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
        <ForYouItemView item={item} />
      </motion.div>
    </motion.div>
  )
}

function Stream({ items }: { items: ForYouItem[] }) {
  const opening = useRef(true)
  useEffect(() => {
    opening.current = false
  }, [])
  return (
    <AnimatePresence>
      {items.map((it, i) => (
        <Slot key={it.id} item={it} index={i} opening={opening.current} />
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
export function ForYouPage({ who }: { who?: string }) {
  const t = useT(M)
  const { back, home } = useApp()
  const fy = useForYou()
  const page = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  usePageChrome('agent', page)
  const move = usePageMotion()
  const [sel, setSel] = useState(() => who ?? read(WHO_KEY) ?? WHO_ALL)
  const [lastLook] = useState(() => Number(read(LOOK_KEY)) || 0)
  const { showFresh, setReading } = fy
  useLayoutEffect(() => {
    // Opening the page is a fresh look: what waited comes in, in the server's order.
    showFresh()
    heading.current?.focus({ preventScroll: true })
    write(LOOK_KEY, String(Date.now()))
    const y = feedScroll.get(sel) ?? 0
    if (body.current) body.current.scrollTop = y
    setReading(y > 48)
    return () => setReading(false)
  }, [showFresh, setReading])

  const toTop = (smooth: boolean) => body.current?.scrollTo?.({ top: 0, behavior: smooth && !reduced() ? 'smooth' : 'auto' })
  const pick = (w: string) => {
    const next = w === sel ? WHO_ALL : w
    setSel(next)
    write(WHO_KEY, next)
    toTop(false)
  }
  const people = useMemo(() => {
    const list = participants(fy.items)
    return list.includes(sel) ? list : [...list, sel]
  }, [fy.items, sel])
  const shown = useMemo(() => fy.items.filter((i) => matchesWho(i, sel)), [fy.items, sel])

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
            <button className="word" onClick={() => focusBoss({ flash: false })} aria-label={t.openBoss}>
              weevboss
            </button>
            <span className="fyt-sep" aria-hidden>·</span>
            <h1 ref={heading} tabIndex={-1} className="word on">
              {t.title}
            </h1>
          </div>
          <button type="button" className="link fy-projects" onClick={home} aria-label={t.backToProjects}>{t.projects}</button>
        </div>
        <Participants list={people} sel={sel} onPick={pick} />
      </div>
      <div ref={body} className="page-body fy-body" data-scroll onScroll={(e) => { feedScroll.set(sel, e.currentTarget.scrollTop); setReading(e.currentTarget.scrollTop > 48) }}>
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
        {fy.feed && <ForYouPulse pulse={fy.feed.pulse} />}
        <Stream key={sel} items={shown} />
        {fy.feed &&
          (shown.length ? (
            <div className="fy-end">
              <div className="in meta">
                <Icon name="check" /> {lastLook ? t.upToDateSince(lookTime(lastLook)) : t.upToDate}
              </div>
            </div>
          ) : (
            <div className="fy-end fy-quiet">
              <div className="in meta">{sel === WHO_ALL ? t.empty : t.emptyWho}</div>
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
  usePageChrome('agent', page)
  const move = usePageMotion()
  // The player's own bar (scrubbing) keeps its drags.
  useOwnSwipe(video, type === 'video')
  return (
    <motion.div ref={page} className="page fy-viewer" style={slot('agent')} {...move} role="dialog" aria-modal="true" aria-label={name}>
      <div className="fy-viewer-top">
        <button className="ch" onClick={back} aria-label={t.back}>
          <Icon name="chevron" dir="left" />
        </button>
        <span className="meta ellipsis">{name}</span>
      </div>
      <div className="fy-stage">{type === 'video' ? <video ref={video} src={url} controls autoPlay playsInline loop aria-label={name} /> : <img src={url} alt={name} draggable={false} />}</div>
    </motion.div>
  )
}
