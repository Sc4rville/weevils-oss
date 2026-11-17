import { notificationEligible } from '../../shared/notification-policy'
import { streamOf } from './foryou-format'
import { closableFeedNotice } from '../../shared/notices.ts'
import { NoticeClose } from './notice'
// The top band's two words, « weevboss · pour toi », and the preview of the stream shown under them (docs/foryou.md §4.1).
// Both only exist when the server sends snap.foryou: on an older server or a secondary machine the band is unchanged.
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ForYouItem } from '../../shared/foryou.ts'
import { useT } from '../i18n'
import M from '../i18n/bands'
import { useApp } from './app-context'
import { useAuthors } from './bits'
import { itemSlot, itemWho, useForYou } from './foryou-store'
import { stopVoice, useVoiceId } from './foryou-voice'
import { Icon } from './icons'
import './foryou-top.css'

export type Top = 'boss' | 'foryou'

const KEY = 'weevils-top'
const CHANGE = 'weevils-top-change'
/** How many items the preview shows: a glance, the page has the rest. */
export const PEEK_ITEMS = 8

const read = (): Top => {
  try {
    return localStorage.getItem(KEY) === 'foryou' ? 'foryou' : 'boss'
  } catch {
    return 'boss'
  }
}

export function setTop(top: Top) {
  try {
    localStorage.setItem(KEY, top)
  } catch {
    /* storage unavailable: the choice lasts as long as nothing re-reads it */
  }
  window.dispatchEvent(new Event(CHANGE))
}

const subscribe = (f: () => void) => {
  window.addEventListener(CHANGE, f)
  window.addEventListener('storage', f)
  return () => {
    window.removeEventListener(CHANGE, f)
    window.removeEventListener('storage', f)
  }
}

/** Which of the two words is chosen on this device. Without a stream on this server it is always weevboss. */
export function useTop(): [Top, (top: Top) => void] {
  const { snap } = useApp()
  const stored = useSyncExternalStore<Top>(subscribe, read, () => 'boss')
  return [snap.foryou ? stored : 'boss', setTop]
}

/** The two small words. `active` is the one in full ink; a tap on either calls onPick (the band decides what it does). */
export function TopWords({ active, onPick }: { active: Top; onPick: (top: Top) => void }) {
  const t = useT(M)
  const { snap } = useApp()
  const { unseen } = useForYou()
  if (!snap.foryou) return null
  return (
    <div className="fyt-words">
      <button type="button" className={`fyt-word ${active === 'boss' ? 'on' : ''}`} aria-pressed={active === 'boss'} onClick={() => onPick('boss')}>
        weevboss
      </button>
      <button type="button" className={`fyt-word ${active === 'foryou' ? 'on' : ''}`} aria-pressed={active === 'foryou'} onClick={() => onPick('foryou')}>
        {t.forYou}
        {unseen > 0 && <span className="fyt-dot" role="img" aria-label={t.forYouUnseen(unseen)} />}
      </button>
    </div>
  )
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

/** What a strip says after the speaker: the item's words, else its title, else the name of what it shows.
 * Proposals: the first card's title (the strip already leads with « + n »; the item's own text would repeat the count). */
function lineOf(item: ForYouItem): string {
  if (item.cards?.length) return oneLine(item.cards[0].title)
  return oneLine(item.text) || oneLine(item.title ?? '') || oneLine(item.cards?.[0]?.title ?? '') || (item.media?.[0]?.name ?? '')
}

const soft = { type: 'spring', stiffness: 160, damping: 26, mass: 1 } as const

/**
 * The stream's first items as thin strips, in the box the thread preview uses. It scrolls in place; a tap anywhere
 * opens the stream full screen. The order comes from the store, which holds newcomers back while a finger is down.
 */
export function ForYouPeek() {
  const t = useT(M)
  const { snap, colors, push } = useApp()
  const { items, dismiss, feed } = useForYou()
  const authorOf = useAuthors()
  const shown = streamOf(items.filter(notificationEligible), PEEK_ITEMS, false)
  // Before the stream arrives, « nothing new » would be a false all-quiet: say what the snapshot already knows.
  const waiting = snap.foryou?.unseen ?? 0
  const emptyLine = feed ? t.forYouEmpty : waiting > 0 ? t.forYouUnseen(waiting) : t.forYouLoading
  const open = () => push({ kind: 'foryou' })
  // A voice message being read aloud: its strip shows it. It stops when its item leaves the stream.
  const speaking = useVoiceId()
  const stillThere = !speaking || items.some((i) => i.id === speaking)
  useEffect(() => {
    if (!stillThere) stopVoice()
  }, [stillThere])
  // At rest the box ends exactly under the last strip that fits whole: no strip is cut, and nothing fades. Scrolled
  // (there is more below than fits), the bottom fades as the thread preview does.
  const peek = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState<number | undefined>(undefined)
  const [scrolled, setScrolled] = useState(false)
  useLayoutEffect(() => {
    const box = peek.current?.parentElement
    const rows = list.current
    if (!box || !rows) return
    const measure = () => {
      const room = box.clientHeight
      if (!room) return // hidden (the other word is chosen): the last measure holds
      let h = 0
      for (const el of rows.children) {
        const next = h + (el as HTMLElement).offsetHeight
        if (next > room + 0.5) break
        h = next
      }
      // Not even one fits whole (a very small band): the box keeps its room and the first strip shows what it can.
      setFit(h > 0 && h < rows.scrollHeight ? h : undefined)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(box)
    ro.observe(rows)
    return () => ro.disconnect()
  }, [shown.map((i) => i.id).join()]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <motion.div
      ref={peek}
      layoutScroll
      className={scrolled ? 'fyt-peek fyt-scrolled' : 'fyt-peek'}
      style={fit ? { flex: 'none', height: fit } : undefined}
      onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 2 && e.currentTarget.scrollTop + e.currentTarget.clientHeight < e.currentTarget.scrollHeight - 2)}
      role="region" aria-label={t.forYouOpen} onClick={open}>
      <div ref={list} className="fyt-list">
        <AnimatePresence initial={false} mode="popLayout">
          {shown.map((item) => {
            const who = itemWho(item, authorOf, snap.projects.find((p) => p.id === item.projectId)?.name)
            const media = item.media?.[0]
            const cards = item.cards?.length ?? 0
            return (
              <motion.div
                key={item.id}
                layout="position"
                className={`fyt-item ${closableFeedNotice(item) ? 'notice-shell' : ''} ${item.kind === 'alert' ? 'fyt-alert' : ''} ${item.seen ? '' : 'fyt-new'}`}
                data-fy={item.id}
                style={itemSlot(item, colors, authorOf)}
                initial={{ opacity: 0, y: -14 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={soft}
              >
                {closableFeedNotice(item) && <NoticeClose about={item.title ?? item.text} onClose={() => void dismiss(item.id)} />}
                <div className="in">
                  <button type="button" className="fyt-open" onClick={(e) => { e.stopPropagation(); open() }} aria-label={t.forYouOpen}>
                  {media &&
                    (media.type === 'image' ? (
                      <img className="fyt-thumb" src={media.url} alt="" loading="lazy" draggable={false} />
                    ) : (
                      <span className="fyt-thumb fyt-play" aria-hidden>
                        <Icon name="play" />
                      </span>
                    ))}
                  {item.voice && !media && (
                    <span className={speaking === item.id ? 'fyt-wave on' : 'fyt-wave'} role={speaking === item.id ? 'img' : undefined} aria-label={speaking === item.id ? t.forYouSpeaking : undefined} aria-hidden={speaking === item.id ? undefined : true}>
                      <i />
                      <i />
                      <i />
                      <i />
                    </span>
                  )}
                  <span className="fyt-txt">
                    <span className="strong">{who}</span> {cards > 0 && <span className="fyt-n">+ {cards} </span>}
                    {lineOf(item)}
                  </span>
                  </button>
                </div>
              </motion.div>
            )
          })}
        </AnimatePresence>
        {shown.length === 0 && <button type="button" className="in fyt-empty" onClick={open}>{emptyLine}</button>}
      </div>
    </motion.div>
  )
}
