// « For you » in five layouts. The names are internal and never shown: the stream is one single stream, no kind, no
// speaker, no section. Each stored item (whatever its legacy kind) maps to one of them, or is hidden (never deleted:
// the server keeps its history, only the stream leaves it out).
//   action:   something waiting for the user, one big tap (approve, look, answer)
//   progress: something shipped, a number that moved (big number type)
//   learn:    one concrete sentence worth knowing
//   think:    one short thought to chew on
//   visual:   full-bleed media (saveable to Photos)
import type { ForYouItem } from '../../shared/foryou.ts'

export type ForYouFormat = 'action' | 'progress' | 'learn' | 'think' | 'visual'

/** At most this many items in the stream at once: the page stays light. The server sends at most as many. */
export const STREAM_CAP = 60
/** The longest line a card shows (about two short lines on a phone); the rest stays in the place it opens. */
export const LINE_MAX = 120

const hasVisual = (i: ForYouItem) => !!i.media?.length || !!i.composition || !!i.resultGroup?.final

/** The layout an item takes in the stream, or null when it is hidden (legacy chatter, raw bookkeeping). */
export function formatOf(item: ForYouItem): ForYouFormat | null {
  if (item.work) {
    // Work the user already launched: only its outcome is news; the status chatter in between is not.
    if (item.work.status !== 'completed') return null
    return hasVisual(item) ? 'visual' : 'progress'
  }
  const id = item.id
  switch (item.kind) {
    case 'media':
      if (hasVisual(item)) return 'visual'
      return item.visualProposal ? 'action' : item.text || item.title ? 'progress' : null
    case 'alert':
      return 'action'
    case 'proposals':
      return item.cards?.length ? 'action' : null
    case 'mail':
      // weevboss's own relay mail (« [weevboss] ACTION — … ») is an internal handoff, not news for the user.
      return /^\s*\[weevboss\]/i.test(item.title ?? '') ? null : 'action'
    case 'session':
      if (item.tone === 'question' || item.tone === 'alert') return 'action'
      if (item.tone === 'result') return hasVisual(item) ? 'visual' : 'progress'
      return null
    case 'boss':
      // Automation lifecycle (started, running, wrapped up): bookkeeping, never a card. Only its media would say more.
      if (/^auto:(?:go|done|run|start|end|stop|fail)/.test(id) && !hasVisual(item)) return null
      if (id.startsWith('auto:proposed:') || item.actions?.length) return 'action'
      if (hasVisual(item)) return 'visual'
      return item.text ? 'think' : null
    case 'improve':
      if (item.actions?.length) return 'action'
      return item.text ? 'think' : null
    case 'insight':
      // The token audit is a page of bars, not a sentence to learn from.
      if (id.startsWith('cost:')) return null
      return item.text ? 'learn' : null
    case 'milestone':
      // A count alone (« 3 projects moved today ») is a readout; a figure earns a card when it compares.
      return compares(item) ? 'progress' : null
    case 'stat':
      // The overnight tally is a status readout, not content.
      if (item.recap) return null
      // Repeated « saved this week » lines and plain usage bars: not a number that moved.
      if (id.startsWith('cost:')) return null
      return bigNumber(item) && compares(item) ? 'progress' : null
    default:
      return null
  }
}

/** A figure that says something: a trend, a comparison, a record — not a bare count. */
export const compares = (item: ForYouItem) =>
  /\b(?:vs\.?|than|up|down|more|fewer|less|since|from|record|best|worst|first|doubled|halved|faster|slower|instead|before|after|compared|yesterday|last (?:week|month))\b|[×%]|\d\s?x\b/i.test(`${item.title ?? ''} ${item.text}`)

/** Plain words of a card: no markdown marks, no code spans, one line. */
export function plainLine(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|~~)/g, '')
    // File paths never reach a card: « ~/x/y.ts », « src/ui/a.tsx », « ./run.sh ».
    .replace(/(?<=^|\s)(?:(?:~|\.{1,2})?\/(?:[\w.-]+\/?)+|(?:[\w.-]+\/)+[\w-]+\.[a-z]{1,5})(?=[\s,;:)]|$)/g, ' ')
    .replace(/^\s*(?:#{1,6}|[-*•>]|\d+[.)])\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A mail subject or title as a person would say it: no « [tag] », no shouted « ACTION — » prefix, no trailing « … ». */
export function cleanSubject(text: string): string {
  let s = text.replace(/\[[^\]\n]{1,40}\]\s*/g, '').trim()
  // Shouted prefixes: « ACTION — », « FYI: », « URGENT - ».
  s = s.replace(/^(?:[A-Z][A-Z0-9]{1,15}\s*){1,3}[—–:-]\s+/, '')
  // A line still all in capitals reads as shouting: sentence case (keeps short acronyms intact in mixed lines).
  const letters = s.replace(/[^\p{L}]/gu, '')
  if (letters.length > 8 && letters.replace(/\p{Lu}/gu, "").length < letters.length * 0.3) s = s.charAt(0) + s.slice(1).toLowerCase()
  return s.replace(/\s*(?:…|\.{3})\s*$/, '').replace(/\s+[—–-]\s*$/, '').trim()
}

/** Automation bookkeeping worded as a sentence (« The automation "X" is wrapped up », « … is running »). */
export function lifecycleLine(text: string): boolean {
  return /^(?:the )?automation\s+["“«']?[^"”»']{0,80}["”»']?\s+(?:is|has|was|just)\s+(?:wrapped|running|started|starting|finished|done|over|complete|stopped|paused|scheduled|launched|back)/i.test(plainLine(text))
}

const TAIL_WORDS = /\s+(?:a|an|the|and|or|but|of|to|in|on|for|with|at|by|from|is|are|was|its|their|your|my|that|which|so|as|into|than)$/i

/** An outcome, not a diary: « I built the menu » → « Built the menu », « I couldn't run X » → « Couldn't run X ». */
export function outcomeWords(text: string): string {
  const s = text.replace(/^\s*(?:I|We)(?:'ve| have| just)?\s+(?=\S)/, '')
  return s === text ? text : s.charAt(0).toUpperCase() + s.slice(1)
}

/** One short line that never ends on « … »: the first sentence when it fits, else cut at a clause, else on a word
 * (never on a dangling « the »/« and »). Empty when nothing sensible fits. */
export function shortLine(text: string | undefined, max = LINE_MAX): string {
  const line = outcomeWords(cleanSubject(plainLine(text ?? '')))
  if (!line) return ''
  const first = /^[\s\S]*?[.!?](?=\s|$)/.exec(line)?.[0] ?? line
  const pick = first.length >= 12 && first.length <= max ? first : line
  if (pick.length <= max) return pick
  const cut = pick.slice(0, max)
  const clause = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '), cut.lastIndexOf(', '), cut.lastIndexOf(' — '), cut.lastIndexOf(': '))
  let out = clause > max * 0.45 ? cut.slice(0, clause) : cut.slice(0, Math.max(cut.lastIndexOf(' '), 0))
  for (let i = 0; i < 4 && TAIL_WORDS.test(out); i++) out = out.replace(TAIL_WORDS, '')
  out = out.replace(/[\s,;:–—-]+$/, '').replace(/\s*[(\["“«]$/, '')
  return out.length >= 12 ? out : ''
}

/** The figure a progress card shows big, and the words that go with it (« 100 » · « turns this week »). */
export function bigNumber(item: ForYouItem): { n: string; rest: string } | null {
  if (item.recap) {
    const done = item.recap.lines.filter((l) => l.state === 'done').length
    return done ? { n: String(done), rest: '' } : null
  }
  const text = plainLine(item.text)
  const m = /(?:^|\s)([+−-]?\d[\d\s.,]*(?:\s?(?:%|k|K|M|×|x))?)(?=\s|$|[.,!])/.exec(text)
  if (!m || !/\d/.test(m[1])) return null
  const n = m[1].trim().replace(/[.,]$/, '')
  const rest = (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length)).replace(/\s+/g, ' ').replace(/^[\s:·,-]+|[\s:·,]+$/g, '').trim()
  return { n, rest }
}

/** The one line a card says: its title when it has one that says it, else its words. */
export function cardLine(item: ForYouItem): string {
  if (item.kind === 'proposals') return shortLine(item.cards?.[0]?.title)
  if (item.kind === 'session' && item.tone === 'question') return shortLine(item.lead || item.text)
  // A session's outcome is in its words; its title alone (« content ideas index ») says nothing.
  if (item.kind === 'session') return shortLine(item.text) || shortLine(item.title)
  if (item.kind === 'mail' || item.kind === 'media') return shortLine(item.title) || shortLine(item.text)
  return shortLine(item.text) || shortLine(item.title)
}

const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/** How much an item brings: media, then something to do, then a figure, then words. Duplicates keep the richest. */
export function richness(item: ForYouItem): number {
  return (hasVisual(item) ? 1000 : 0) + (item.cards?.length || item.actions?.length ? 500 : 0) + (bigNumber(item) ? 200 : 0) + Math.min(plainLine(item.text).length + (item.body?.length ?? 0), 199)
}

/** Rich: an outcome to see (media, a figure, a decision). The rest is a short line. */
export const richItem = (item: ForYouItem) => {
  const f = formatOf(item)
  return f === 'visual' || f === 'action' || (f === 'progress' && !!bigNumber(item))
}

/** Shown at all: a layout, a line that says something (not a bare 3-word title, not bookkeeping). */
export function worthShowing(item: ForYouItem, strict = true): boolean {
  const f = formatOf(item)
  if (!f) return false
  if (lifecycleLine(item.text) || lifecycleLine(item.title ?? '')) return false
  if (f === 'visual' || !strict) return true
  if (f === 'action') return item.kind === 'proposals' ? !!shortLine(item.cards?.[0]?.title) : !!cardLine(item)
  if (f === 'progress' && bigNumber(item)) return true
  const line = cardLine(item)
  // A title alone (« content ideas index »): no outcome, no action, no insight.
  return line.split(/\s+/).length >= 5
}

/** Same thing said twice: one's words inside the other's, or the same subject. */
function sameThing(a: ForYouItem, b: ForYouItem): boolean {
  // A session's sentence and the media it posted are one result: the media wins (it is the thing itself).
  if (a.sessionId && a.sessionId === b.sessionId && (a.kind === 'session' || b.kind === 'session') && (a.kind === 'media' || b.kind === 'media')) return true
  const ta = a.title ? norm(cleanSubject(a.title)) : ''
  const tb = b.title ? norm(cleanSubject(b.title)) : ''
  if (ta && ta === tb) return true
  const la = norm(cardLine(a)), lb = norm(cardLine(b))
  if (la.length < 8 || lb.length < 8) return false
  const fa = norm(`${a.title ?? ''} ${plainLine(a.text)}`), fb = norm(`${b.title ?? ''} ${plainLine(b.text)}`)
  return fa.includes(lb) || fb.includes(la)
}

/** Interleave depths: within windows of WINDOW consecutive items (recency kept window by window), rich and short
 * items alternate, so a run of one-liners never hides the outcomes. */
const WINDOW = 6
export function mixDepths(items: ForYouItem[]): ForYouItem[] {
  const out: ForYouItem[] = []
  for (let w = 0; w < items.length; w += WINDOW) {
    const win = items.slice(w, w + WINDOW)
    const rich = win.filter(richItem), short = win.filter((i) => !richItem(i))
    let takeRich = richItem(win[0])
    while (rich.length || short.length) {
      const from = (takeRich && rich.length) || !short.length ? rich : short
      out.push(from.shift()!)
      takeRich = !takeRich
    }
  }
  return out
}

/** The stream as shown: only items worth a card, duplicates folded into the richest, depths mixed, at most STREAM_CAP. */
export function streamOf(items: ForYouItem[], cap = STREAM_CAP, strict = true): ForYouItem[] {
  const kept: ForYouItem[] = []
  const families = new Set<string>()
  for (const i of items) {
    if (kept.length >= cap * 2) break
    if (!worthShowing(i, strict)) continue
    // The same advice for one session after another (« X runs on Opus, Sonnet would do »): the latest once.
    const family = /^(cost:[a-z]+):/.exec(i.id)?.[1]
    if (family && families.has(family)) continue
    if (family) families.add(family)
    const twin = kept.findIndex((k) => sameThing(k, i))
    if (twin < 0) kept.push(i)
    else if (richness(i) > richness(kept[twin])) {
      // The media keeps its place in time and borrows the sentence's words when it has no caption.
      const words = kept[twin]
      kept[twin] = !i.title && !plainLine(i.text) && words.kind === 'session' ? { ...i, title: cardLine(words) } : i
    } else if (!kept[twin].title && !plainLine(kept[twin].text) && i.kind === 'session') kept[twin] = { ...kept[twin], title: cardLine(i) }
  }
  return strict ? fewSentences(mixDepths(kept.slice(0, cap))) : kept.slice(0, cap)
}

/** A sentence about a result, with no media, no figure, nothing to decide. */
export const sentenceOnly = (item: ForYouItem) => {
  const f = formatOf(item)
  return f === 'learn' || f === 'think' || (f === 'progress' && !bigNumber(item))
}

/** At most SENTENCES sentence-only cards per screen (a window of WINDOW cards): the rest is left out, the feed stays light. */
const SENTENCES = 3
export function fewSentences(items: ForYouItem[]): ForYouItem[] {
  // Figures are spread out (one per screen, the others wait further down): a feed, not a dashboard.
  const queue = [...items]
  const spread: ForYouItem[] = []
  const held: ForYouItem[] = []
  const isNum = (i: ForYouItem) => formatOf(i) === 'progress' && !!bigNumber(i)
  while (queue.length || held.length) {
    const recentNum = spread.slice(-(WINDOW - 1)).some(isNum)
    if (held.length && !recentNum) { spread.push(held.shift()!); continue }
    const next = queue.shift()
    if (!next) { spread.push(held.shift()!); continue }
    if (isNum(next) && recentNum) held.push(next)
    else spread.push(next)
  }
  const out: ForYouItem[] = []
  for (const i of spread) {
    const recent = out.slice(-(WINDOW - 1)).filter(sentenceOnly).length
    if (sentenceOnly(i) && recent >= SENTENCES) continue
    out.push(i)
  }
  return out
}

/** One more line, revealed on tap: what the card's line did not say (its body, its fetched « more », its text's rest). */
export function detailLine(item: ForYouItem): string {
  const line = norm(cardLine(item))
  for (const src of [item.moreText, item.body, item.text, item.title]) {
    if (!src) continue
    const plain = plainLine(src)
    const rest = norm(plain).startsWith(line) ? plain.slice(cardLine(item).length).trim() : plain
    const d = shortLine(rest, 160)
    if (d && !line.includes(norm(d)) && norm(d) !== line) return d
  }
  return ''
}

/** The look of each card in its place: rhythm so no two neighbours look alike. fill: the item's colour band ·
 * plain: on the page, words only · quote: a centred thought. */
export type ForYouLook = 'fill' | 'plain' | 'quote'
export function looksOf(items: ForYouItem[]): ForYouLook[] {
  const out: ForYouLook[] = []
  items.forEach((it, i) => {
    const f = formatOf(it)
    let look: ForYouLook = f === 'think' ? 'quote' : f === 'learn' || f === 'visual' ? 'plain' : 'fill'
    if (i > 0 && look === out[i - 1]) look = look === 'fill' ? 'plain' : f === 'think' ? 'fill' : look === 'plain' ? 'fill' : 'plain'
    out.push(look)
  })
  return out
}
