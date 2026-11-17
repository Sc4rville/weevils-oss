import { ALCOVE_SOURCE, alcoveFinal, groupAlcove } from './foryou-results.ts'
import { isScratchDir } from './scratch.ts'
import { FeedLocalization } from './foryou-localization.ts'
import { OutboxError } from './outbox.ts'
import { internalFeedUpdate, editorialFeedText, acknowledgementOnly, humanFeedItem, humanFeedText, rawEngineeringNotice } from '../shared/feed-text.ts'
import { reviewedEditorial } from './foryou-editorial.ts'
import { softwareResult, type SoftwareCatalog } from './foryou-software.ts'
import { projectFeedWorkstream } from './foryou-workstream.ts'
import { WorkIntents, intentDispatch, substantive, briefKey, isWorkRequest, type IntentResult, type WorkIntent } from './foryou-intents.ts'
import reviewedIntents from './foryou-intents-reviewed.json' with { type: 'json' }
import { canonicalAlertId, feedNoticeKey, isRequestNotice, quotaReset, sessionNoticeKey } from '../shared/notices.ts'
// « For you »: the stream next to weevboss (docs/foryou.md, contract in shared/foryou.ts). Main machine only.
//
// Two sorts of items:
// - recorded (kept in DATA_DIR/foryou.json, mode 600, capped): what a session just did, asks or why it stopped (one
//   item per session, replaced by its next turn), the mails of outside authors, weevboss's posts (« weevils post »),
//   the files an agent shows (« weevils show »), and later what the curator generates (add());
// - live (computed at each read, never stored): alerts — a usage window nearly full, a saturated machine or a full
//   disk, a failed auto task, a machine offline — and the one « proposals » item (auto tasks waiting for a yes, tips
//   that carry an action). They leave with their cause; only their seen / dismissed state is kept, by id.
//
// The snapshot carries { rev, unseen } only (mark()); the app reads the stream with GET /api/foryou when rev changes.
// A tap on a button or a card removes the item (or the card): an action is done once.

import crypto from 'node:crypto'
import fs from 'node:fs'
import type http from 'node:http'
import path from 'node:path'
import type { InterruptReason, Message, Session, SessionDetail, Snapshot } from '../shared/api.ts'
import type { ForYouAction, ForYouCard, ForYouFeed, ForYouGauge, ForYouItem, ForYouKind, ForYouMark, ForYouMedia, ForYouOpen, ForYouPulse, ForYouTone } from '../shared/foryou.ts'
import { isLang } from '../shared/i18n.ts'
import { evidenceInput, evidenceLabel, mergeEvidence, type EvidenceInput } from '../shared/evidence.ts'
import { detectLang } from '../shared/detect-lang.ts'
import { withoutWeevilsBlock } from './transcripts.ts'
import type { Level, UsageInfo } from '../shared/infra.ts'
import { DATA_DIR, MACHINE } from './config.ts'
import type { MediaShelf } from './foryou-media.ts'
import { isLocal, trustedFrom } from './http.ts'
import { installationLang, lang, tr, withLang, type Lang } from './i18n.ts'
import CM from './i18n/core.ts'
import M from './i18n/foryou.ts'
import { ownIdea, ownTask } from './own-words.ts'
import { actOn, personalTips, type Found, type TipInput } from './tips.ts'
import { nightRecap, recapWorth, type RecapAuto } from './sleep.ts'
import SM from './i18n/sleep.ts'
import { ForYouNumbers } from './foryou-numbers.ts'

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL, params: string[]) => Promise<void> | void
type Json = (res: http.ServerResponse, status: number, body: unknown) => void
type ReadBody = (req: http.IncomingMessage) => Promise<any>

// ---------------------------------------------------------------- limits

// Raw engineering events belong to project history, never the user's feed or voice queue.
const technicalEvent = rawEngineeringNotice

export const MAX_ITEMS = 400
export const KEEP_MS = 14 * 24 * 3600_000
/** What GET /api/foryou returns at most. */
export const MAX_FEED = 60
/** How many of the newest stored items a view reads at most (hidden ones included), so a view never costs the whole store. */
export const VIEW_REACH = MAX_FEED * 3
export const TEXT_MAX = 600
export const POST_MAX = 1200
export const MAIL_LINE_MAX = 140
/** A session's line in the stream: what it did, said in passing. The whole closing words unfold under it. */
export const HEADLINE_MAX = 110
/** The curator's line for a result: a colleague's message in a chat, a little longer than the cut headline. */
export const LINE_MAX = 240
/** The closing words kept for the unfold. */
export const BODY_MAX = 4000
/** Attempts at a model title for a result card before its headline stays. */
const TITLE_TRIES = 3
/** What the user said (server/own-words.ts): read again at most this often, over this many days of the boss thread. */
const SAID_MS = 2 * 60_000
const SAID_DAYS = 14

/** What a model sometimes says before the title itself (« Here is the title for the card: », « Voici le titre : »,
 * « Sure! Title: »): left out, with the quotes the title came in. Also applied to titles stored before this rule. */
export function titleWithoutPreamble(raw: string): string {
  let s = collapse(raw)
  // Search patterns in both languages the titles are written in, never shown.
  const preamble = /^(?:(?:sure|ok(?:ay)?|of course|bien sûr|d['’]accord|voilà)\s*[,.!]\s*)?(?:(?:here(?:['’]s| is)|voici)\s+(?:(?:the|a|your|my|le|un|ton|votre|mon)\s+)?(?:(?:card|result)\s+)?(?:title|titre|sentence|phrase|line|ligne)(?:\s+(?:for|of|de|pour)\s+(?:the|this|that|your|la|cette|ta)\s+(?:card|result|carte|résultat))?|(?:(?:card|result)\s+)?title|titre(?:\s+de\s+la\s+carte)?)\s*[:：—–-]\s*/iu // i18n-ignore
  s = s.replace(preamble, '')
  // The whole answer wrapped in quotes.
  const wrapped = /^(["“«'])\s*([\s\S]*?)\s*(["”»'])$/u.exec(s)
  if (wrapped) s = wrapped[2]
  return s
}

/** A model's title for a result card, kept only if it is a whole sentence that stands on its own: '' otherwise (cut
 * fragment, a bare word, a sentence that starts in the middle, an ellipsis). `names`: where a lowercase product name
 * may legitimately open the sentence (« weevils now installs on a Mac »). */
export function resultTitleLine(raw: string, names: string[] = []): string {
  let s = titleWithoutPreamble(raw)
  s = s.replace(/`([^`]*)`/g, '$1')
  if (s.length < 15 || s.length > 260 || s.split(' ').length < 4) return ''
  if (/(?:\.\.\.|…)$/u.test(s) || /[,;:(–—-]$/u.test(s) || internalFeedUpdate(s)) return ''
  // Stops on a word that announces more (« …, and », « … avec »): cut short.
  if (/\s(?:and|or|but|with|to|of|the|a|an|for|et|ou|mais|avec|de|du|des|le|la|les|un|une|pour|à)$/iu.test(s)) return ''
  const first = s.split(/[\s,.:;!?]/u)[0] ?? ''
  if (/^\p{Ll}/u.test(first) && !names.some((n) => n.toLowerCase().split(/[\s/_-]+/).includes(first.toLowerCase()))) return ''
  return s
}
/** Turns that ended before the stream heard of them (first start, restart): picked up when this recent, this many at a time. */
export const BACKFILL_MS = 4 * 24 * 3600_000
export const BACKFILL_MAX = 40
export const MAIL_BODY_MAX = 12_000
export const MAX_ACTIONS = 2
/** Files shown by the same session within this delay join one item, up to MAX_MEDIA. */
export const MEDIA_JOIN_MS = 2 * 60_000
export const MAX_MEDIA = 6
/** Files cited in the message that ends a turn: at most this many. */
export const CITED_MAX = 4
export const MAX_CARDS = 4
/** A usage window at this percentage or more is an alert. */
export const USAGE_ALERT = 85
export const DISK_ALERT = 90
/** A machine is said saturated after this many measures in a row at the critical level (one peak is not an alert). */
export const HOT_SAMPLES = 2
/** A machine offline for less than this is a hiccup of the tunnel. */
export const OFFLINE_AFTER_MS = 2 * 60_000
export const FAILED_KEEP_MS = 24 * 3600_000
/** Usage and machine measures: refreshed in the background, this often while the app looks at the stream, else rarely. */
export const REFRESH_MS = 5 * 60_000
export const REFRESH_IDLE_MS = 30 * 60_000
/** The app « looks » for this long after its last GET /api/foryou (also read by the curator). */
export const WANTED_MS = 30 * 60_000
/** The state of a live item whose cause left is forgotten after this (a new episode is a new item). */
export const LIVE_FORGET_MS = 6 * 3600_000
/** The transcript may trail the end of the turn by a scan: the result is read again after this. */
export const REFINE_MS = 4000

// ---------------------------------------------------------------- order

/**
 * The order of the stream: newest first, so news always comes in at the top; the system alerts (a state that blocks,
 * not news) above.
 */
/** A session found waiting or cut without an item (first start, restart) only gets one when that is recent. */
export const CATCH_UP_MS = 12 * 3600_000

export function arrange(items: ForYouItem[], _now: number): ForYouItem[] {
  // One rule the eye can learn: what is new comes in at the top. Only what blocks right now (the system alerts, a
  // state, not news) sits above, and leaves once solved. Then the pace: never twice the same sort of item in a row
  // when a neighbour a few places down can step up (the order stays newest first to within those few places).
  const newest = (a: ForYouItem, b: ForYouItem) => b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const ranked = items.filter((i) => i.kind !== 'alert').sort(newest)
  // Keep genuinely new arrivals first. For two hours, one unread result or idea can
  // resurface just below them; the client holds this order while the user reads.
  const candidates = ranked.filter((i) => !i.seen && _now - i.at > 10 * 60_000 && _now - i.at < 2 * 3600_000 &&
    (i.kind === 'media' || i.kind === 'insight' || i.kind === 'improve' || i.kind === 'proposals'))
  const retained = candidates[Math.floor(_now / (10 * 60_000)) % Math.max(1, candidates.length)]
  if (retained) {
    const index = ranked.indexOf(retained)
    const slot = Math.max(2, ranked.filter((i) => _now - i.at <= 10 * 60_000).length)
    if (index > slot) ranked.splice(slot, 0, ...ranked.splice(index, 1))
  }
  return [...items.filter((i) => i.kind === 'alert').sort(newest), ...pace(ranked)]
}

/**
 * A band still waiting for a yes or a no (the live proposals: one-off tasks to do once) is an action, not news: it never
 * sinks out of reach. Taken from its arranged place, it goes back at most LIVE_REACH places down, and the MAX_FEED cut
 * never drops it, however many newer items came in since it was first seen.
 */
export const LIVE_REACH = 12
export function keepLive(list: ForYouItem[], max: number): ForYouItem[] {
  const waiting = (i: ForYouItem) => !!i.live && i.kind === 'proposals'
  const out = list.filter((i) => !waiting(i))
  list.forEach((i, at) => {
    if (waiting(i)) out.splice(Math.min(at, LIVE_REACH, out.length), 0, i)
  })
  return out.slice(0, max)
}

/** The sort of an item, for the pace: a session's result, question and cut read as three different things. */
const sortOf = (i: ForYouItem) => (i.kind === 'session' ? `session:${i.tone}` : i.kind)
/** How far down the pace may fetch an item to break a run. */
export const PACE_REACH = 4

export function pace(list: ForYouItem[]): ForYouItem[] {
  const out = [...list]
  for (let k = 1; k < out.length; k++) {
    if (sortOf(out[k]) !== sortOf(out[k - 1])) continue
    const j = out.findIndex((x, n) => n > k && n <= k + PACE_REACH && sortOf(x) !== sortOf(out[k - 1]))
    if (j > 0) out.splice(k, 0, ...out.splice(j, 1))
  }
  return out
}

// ---------------------------------------------------------------- texts

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim()
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)

/** What Claude Code writes at the top of a compacted conversation, and its note before replayed commands: not the agent's words. */
const PREAMBLE = /^\s*(?:This session is being continued from a previous conversation|Caveat: The messages below were generated by the user)/i

/** The last thing the agent said in a thread, whole (compaction preambles skipped), or undefined. */
export function lastWords(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'assistant') continue
    const text = m.text.trim()
    if (text && !PREAMBLE.test(text)) return text
  }
  return undefined
}

const GREETING = /^(?:hi|hello|hey|dear|bonjour|bonsoir|salut|coucou|hola)\b[^.!?]{0,40}[,!.]?$/i

/** A session title as shown: without the signature of who briefed it (« [from:weevboss] Fix the menu » → « Fix the menu »). */
export const cleanTitle = (title: string | undefined): string => (title ?? '').replace(/^\s*(?:\[from:[a-z0-9_-]{1,32}\]|\[weevils\])\s*/i, '')

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The closing words of a turn without the paths of the files shown next to them (`files`: the attached ones): the
 * path as it was written (relative or absolute, bare, quoted or in a markdown link) goes, a list of paths with it, and
 * the « : » that announced them when nothing follows. Text that cites no attached file comes back untouched.
 */
export function withoutPaths(text: string, files: string[]): string {
  const MARK = '\u0000'
  let out = text
  for (const base of new Set(files.map((f) => escapeRe(path.basename(f))).filter(Boolean))) {
    // i18n-ignore : motifs de recherche (guillemets français), jamais affichés
    const dir = '(?:[^\\s`"“”«»()<>]*/)?' // i18n-ignore
    out = out.replace(new RegExp(`!?\\[[^\\]\\n]*\\]\\(<?${dir}${base}>?(?:\\s+"[^"\\n]*")?\\)|[\`"“«]\\s?(?:[^\`"“”«»\\n]*/)?${base}\\s?[\`"”»]|(?<![^\\s\`"“”«»()<>])${dir}${base}(?![\\w-])`, 'g'), MARK) // i18n-ignore
  }
  if (out === text) return text
  return out
    .replace(/\([ \t]*\u0000[ \t]*\)/g, MARK)
    .replace(/\u0000(?:[ \t]*(?:,|;|\+|&|\bet\b|\band\b|\bpuis\b|\bthen\b)?[ \t]*\u0000)+/g, MARK)
    .replace(/^[ \t]*(?:[-*•]|\d+[.)])[ \t]*\u0000[ \t]*[.,;]?[ \t]*$\n?/gm, '\u0001')
    // « Here they are: » followed only by the list that left.
    .replace(/[ \t]*[:：][ \t]*\n\s*\u0001+/g, '.\n')
    .replace(/\u0001/g, '')
    .replace(/[ \t]*[:：][ \t]*\u0000[ \t]*([.!?]?)[ \t]*$/gm, (_m, end: string) => end || '.')
    .replace(/\u0000/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,.])/g, '$1')
    .replace(/[,;]([.!?])/g, '$1')
    .replace(/\s*[:：]\s*$/, '.')
    .trim()
}

/** Inline code that is code (a path, a call, a flag), not a word put in backticks. */
const CODEY = /[/\\_=<>{}()$#@|]|\.[a-z0-9]{1,5}\b|--|^[\w.-]+$/i

/** Where code left a sentence (a path, a call, a link, a hash): a line with such a hole is never shown. */
const GAP = '\u0002'
/** Inline code that reads as a plain word once out of its backticks (`main`, `weevils`): put back only when no line
 * without it is left. Never a hash, a file name, a camelCase or snake_case name. */
const WORDISH = /^[A-Za-z][a-z0-9-]*$/
const HASH = /^[0-9a-f]{7,40}$/
/** Words that turn a clause into a reservation (search pattern, both languages, never shown). */
const RESERVATION = /(?<!\p{L})(?:not|no|never|fail\p{L}*|still|but|yet|except|only|broken|pas|plus|jamais|aucun\p{L}*|échou\p{L}*|encore|mais|sauf|seulement|cass\p{L}*)(?!\p{L})|n['’]t(?!\p{L})/iu // i18n-ignore
const strictGaps = (l: string) => l.replace(/\u0003[^\u0004]*\u0004/g, GAP)
const softGaps = (l: string) => l.replace(/\u0003([^\u0004]*)\u0004/g, '$1')

/**
 * What a session did, in one short line said in passing (« La page des commandes passe à 240 ms »), from the closing
 * words of its turn: no markdown, no paths, no commands, no machine tag, the first sentence, and when it opens with a
 * heading before a colon (« Cause trouvée : … »), that heading. The whole words stay in the item's body.
 * A sentence that would read with a hole where its code was (« live on ; is pushed too ») gives way to the next
 * whole one; '' when none is left, never a fragment.
 */
export function headline(text: string, max = HEADLINE_MAX): string {
  const plain = text
    .replace(/[\u0002-\u0004]/g, '')
    .replace(/```[\s\S]*?```/g, '\n\n')
    .replace(/^\s*#{1,6}\s+(.*)$/gm, '$1\n\n')
    .replace(/\*\*|__/g, '')
    .replace(/^\s*(?:[-*•>]|\d+[.)])\s+/gm, '\n\n')
    .replace(/^\s*\[(?:VPS|PC|GPU|test)\]\s*/gim, '')
    .replace(/`([^`\n]*)`/g, (_m, c: string) => (!CODEY.test(c) ? c : WORDISH.test(c) && !HASH.test(c) ? `\u0003${c}\u0004` : GAP))
    .replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/https?:\/\/[^\s\u0002-\u0004]+/g, GAP)
    .replace(/(?<![\w/])(?:~|\.{1,2})?\/[\w.@~+-]+(?:\/[\w.@~+-]*)*/g, GAP)
    .replace(/(?<![\w/])[\w.-]+(?:\/[\w.@~+-]+)+\.[a-z0-9]{1,5}\b/gi, GAP)
    .replace(/\bPID\s*\d+\b/gi, '')
  const paragraphs = plain.split(/\n\s*\n/).map(collapse).filter((l) => {
    const words = strictGaps(l).replaceAll(GAP, '')
    return /\p{L}{2}/u.test(words) && !GREETING.test(words)
  })
  // In order: each paragraph's first sentence (the whole paragraph when that sentence is too short), then its others.
  const candidates: string[] = []
  for (const p of paragraphs) {
    const sentences = p.split(/(?<=[.!?…])\s+/u)
    if (sentences.length > 1 && softGaps(sentences[0]).length >= 12) candidates.push(...sentences)
    else candidates.push(p)
  }
  // A heading before a colon (« Cause trouvée : … ») only opens the words: further on, a colon or a dash is mid-sentence.
  const shape = (l: string, opening: boolean) => {
    const heading = opening ? /^(.{8,80}?)\s*[:：—–]\s/u.exec(l) : null
    if (heading) l = heading[1]
    return l
      // Code that was only an aside: « (`87aba80`) », « (branche `x`) », « … : `out/a.png` ».
      .replace(/\(\s*(?:\p{L}+\s+)?\u0002[\s,;/\u0002]*\)/gu, '')
      .replace(/\s*[:：]\s*\u0002[\s,;\u0002]*([.!?]?)\s*$/u, '$1')
      .replace(/\(\s*[,;]?\s*\)/g, '')
      .replace(/\s+([,.;:!?…])/g, '$1')
      .replace(/[\s,;:(–—-]+$/u, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
  }
  // A quote or a bracket left open is a cut sentence too.
  const balanced = (l: string) => (l.match(/"/g)?.length ?? 0) % 2 === 0 && (l.match(/«/g)?.length ?? 0) === (l.match(/»/g)?.length ?? 0) && (l.match(/\(/g)?.length ?? 0) === (l.match(/\)/g)?.length ?? 0)
  const whole = (l: string) => !!l && !l.includes(GAP) && /\p{L}{2}/u.test(l) && balanced(l)
  let line = ''
  pick: for (const [n, c] of candidates.entries()) {
    // « The new leads are: » only announces a list: never a line of its own.
    if (/[:：]$/u.test(c)) continue
    // The sentence as it is, then with its plain words put back; then its first clause (before « ; » or a dash), unless
    // what follows is a reservation (« the menu is live; the tests still fail »): a card never drops a « but ».
    const cut = /^(.{12,}?)\s*(?:;|\s[—–]\s)/u.exec(c)
    const clause = cut && !RESERVATION.test(c.slice(cut[0].length)) ? cut[1] : undefined
    for (const v of [c, ...(clause ? [`${clause.replace(/[\s,]+$/, '')}.`] : [])]) {
      for (const l of [shape(strictGaps(v), n === 0), shape(softGaps(v), n === 0)]) {
        if (whole(l)) {
          line = l
          break pick
        }
      }
    }
  }
  if (line.length <= max) return line
  const cut = line.slice(0, max - 1)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max * 0.6)).replace(/[\s,;:–—-]+$/u, '')}…`
}

/** Words that say something (more than a bare file name or a word or two), for a card whose headline is empty. */
const untitledProse = (s: string) => collapse(s).split(' ').length > 3

/** First line of a mail that says something: not a greeting, not a quote, not a separator. */
export function firstLine(text: string, max = MAIL_LINE_MAX): string {
  const lines = text.split(/\r?\n/).map(collapse).filter((l) => /\p{L}/u.test(l) && !l.startsWith('>'))
  return clip(lines.find((l) => !GREETING.test(l)) ?? lines[0] ?? '', max)
}

// ---------------------------------------------------------------- what the stream needs from the rest

/** The part of Weevils (server/core.ts) the stream uses; a plain object in the tests. */
export interface ForYouHost {
  snapshot(): Snapshot
  bump(): void
  detailAny(id: string): Promise<SessionDetail | undefined>
  send(id: string, text: string, from?: string): Promise<{ id: string }>
  sendMain(text: string, brief?: string): Promise<{ id: string }>
  resume(id: string): Promise<{ id: string }>
  close(id: string): Promise<unknown>
  orchestratorId: string | null
  /** One of weevboss's own conversations (current or older): never a session page of the app. */
  isBossThread?(id: string): boolean
  store?: { get(id: string): { firstPrompt?: string; headless?: boolean; originator?: string; messages?: { id: string; role: string; text: string; at: number }[] } | undefined }
}

/** One machine as the alerts need it. disk: used share in %, when known. */
export interface MachineState {
  id: string
  name: string
  level: Level
  disk?: number
}

/** The mail bridge's way out (MailBridge.write), absent when the bridge is not configured. false: nothing was sent. */
export interface MailOut {
  write(o: { to: string; subject: string; text: string; inReplyTo: string; author: string; target: string }): Promise<boolean>
}

/** What MailBridge.dispatch tells the stream (BridgeDeps.mailed). target: « weevboss » or a session id. */
export interface MailIn {
  author: string
  subject: string
  text: string
  target: string
  mid: string
  address: string
}

/** The curator (server/foryou-curator.ts, a later step) plugs in here: the longer answer behind « more ». */
export interface ForYouCurator {
  more(item: ForYouItem): Promise<string>
}

export interface ForYouDeps {
  /** Figures that moved (server/foryou-numbers.ts): goals' requests, commits per project, this week vs last. */
  numbers?: ForYouNumbers
  /** Read-only current deployment catalogue, never starts software or model work. */
  softwares?: () => Promise<SoftwareCatalog>
  /** Default DATA_DIR/foryou.json. */
  file?: string
  now?: () => number
  /** The registered media (server/foryou-media.ts); without it « weevils show » is refused. */
  shelf?: Pick<MediaShelf, 'add' | 'fromText' | 'get' | 'view' | 'serve'> | null
  /** Sessions under this folder are weevils' own (default DATA_DIR). */
  dataDir?: string
  /** Id of this machine (default MACHINE.id): only its sessions have their files here. */
  machineId?: string
  /** core.ts isTestBrief: a brief that starts with [test] never enters the stream. */
  isTestBrief?: (prompt?: string) => boolean
  /** The auto band (accept / refuse of a proposed task): the methods the /api/optimizers routes call. */
  optimizers?: () => { accept(id: string): boolean; refuse(id: string): boolean } | null
  /** What the personal tips are computed from (the same input as GET /api/tips), built without waiting. */
  tips?: (snap: Snapshot, now: number) => TipInput | null
  /** usage.ts quotas(): asked in the background, never on the way of a request. */
  quotas?: () => Promise<UsageInfo>
  /** Level and disk of each machine: asked in the background too. */
  machines?: () => Promise<MachineState[]>
  mail?: () => MailOut | null
  /** The voice a speaker's words are read in (ForYouItem.voice), undefined when this server cannot speak. */
  voiceOf?: (who: string) => string | undefined
  /** Runs fn after ms (default: an unref'd timer). */
  later?: (fn: () => void, ms: number) => void
  /** A button that acts here (server/cost.ts: switch a session's model, stop it), never through weevboss. */
  op?: (op: string) => Promise<void>
  /** A light model (haiku) answering a prompt: writes the title of each session result card from its whole closing message. */
  title?: (prompt: string) => Promise<string>
  /** What weevils remembers of the user (memory item texts): context only, never offered back as weevils' idea (server/own-words.ts). */
  said?: () => string[]
}

// ---------------------------------------------------------------- the store

/** A recorded item. Everything the app may read is copied field by field in view(): the rest never leaves. */
interface Stored {
  recap?: ForYouItem['recap']
  composition?: ForYouItem['composition']
  visualProposal?: ForYouItem['visualProposal']
  /** session question: what a model read in the session's last message (asked: false — not really a question). */
  q?: { ask?: boolean; title?: string; question?: string; options?: string[] }
  id: string
  kind: ForYouKind
  tone: ForYouTone
  at: number
  who: string
  projectId?: string
  sessionId?: string
  eventId?: string
  tool?: Session['tool']
  title?: string
  text: string
  body?: string
  reply?: ForYouItem['reply']
  open?: ForYouItem['open']
  more?: boolean
  moreText?: string
  gauges?: ForYouGauge[]
  seen?: boolean
  /** Dismissed or acted on: kept (a session's next turn revives its item), never shown. */
  gone?: boolean
  /** Generated items: original language, retained across all presentation locales. */
  lang?: Lang
  /** When it was written (a cut is the same episode while the session did nothing since). */
  rec?: number
  /** session, tone alert: why it was cut (put in words at read time, in the reader's language). */
  cut?: InterruptReason
  /** Ids on the media shelf. */
  mediaIds?: string[]
  /** media: where the caller stood (files of one place join one item). */
  cwd?: string
  /** Buttons: the brief goes to weevboss on a tap. */
  actions?: { id: string; label: string; brief: string; sourceIntentId?: string; /** done here on a tap (deps.op), never sent to weevboss */ op?: string; /** tapped on this card (its work is shown on it) */ tapped?: boolean }[]
  /** mail: what a reply needs. The address stays here. */
  mail?: { address: string; mid: string; subject: string; target: string }
  /** mail: the short « did this » line the curator wrote, shown instead of the first line (lang: the language it is
   *  in); without text: tried, nothing worth keeping. */
  /** The model's line (text); tries/at: attempts that gave nothing usable, retried a few times. */
  /** relang: asked again once because it was in another language than the installation's; prior: that title, shown
   * until the new one comes (and kept if it never does). */
  sum?: { text?: string; lang?: Lang; tries?: number; at?: number; relang?: boolean; prior?: string }
  /** weevils show / post: the evidence supplied with the publication, as given (the label is derived at read time). */
  evidence?: EvidenceInput
}

interface LiveState {
  /** First seen (the item's date when its cause has none). */
  at: number
  /** Last read where the cause was there. */
  last: number
  seen?: boolean
  gone?: boolean
  /** proposals: the cards it had, to notice a new one. */
  cards?: string[]
}

interface State {
  /** Bumped at every visible change. */
  rev: number
  items: Stored[]
  live: Record<string, LiveState>
  /** Cards already accepted or refused: id → when. They never come back. */
  cards: Record<string, number>
  /** What was visible at the last read (ids), to notice that a live item came or left. */
  sig: string
  /** Turns delivered today, and per project. */
  delivered: { day: string; n: number; by?: Record<string, number> }
}

/** What the curator may add: a generated item, in the language it was written in. */
export interface NewItem {
  /** Recorded event time; generated text defaults to now. */
  at?: number
  /** Stable id to replace an earlier item of the same subject (else a new one). */
  id?: string
  kind: 'boss' | 'improve' | 'insight' | 'milestone' | 'stat'
  tone?: ForYouTone
  who?: string
  projectId?: string
  title?: string
  text: string
  more?: boolean
  gauges?: ForYouGauge[]
  open?: ForYouItem['open']
  actions?: { label: string; brief: string; sourceIntentId?: string; op?: string }[]
  lang?: Lang
}

const questionKey = (i: Stored) => crypto.createHash('sha256').update(JSON.stringify([i.at, i.text, i.q])).digest('hex').slice(0, 12)

const day = (at: number) => {
  const d = new Date(at)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}
const newId = (prefix: string) => `${prefix}:${crypto.randomBytes(6).toString('hex')}`

export class ForYou {
  readonly w: ForYouHost
  readonly file: string
  /** Last time the app asked for the stream (0: never since the start). */
  lastWanted = 0
  /** Set by the curator when it exists. */
  curator: ForYouCurator | null = null
  readonly localization: FeedLocalization
  private deps: ForYouDeps
  private s: State
  private now: () => number
  private softwareCatalog: SoftwareCatalog = { at: 0, items: [] }
  readonly intents: WorkIntents
  private dataDir: string
  private machineId: string
  /** changed() already counted a revision: the next read does not count the same change again. */
  private dirty = false
  private usage: UsageInfo | null = null
  private machines: MachineState[] = []
  /** Measures in a row at the critical level, per machine. */
  private hot = new Map<string, number>()
  private offSince = new Map<string, number>()
  private refreshedAt = 0
  private refreshing = false

  constructor(w: ForYouHost, deps: ForYouDeps = {}) {
    this.w = w
    this.deps = deps
    this.file = deps.file ?? path.join(DATA_DIR, 'foryou.json')
    this.now = deps.now ?? Date.now
    this.intents = new WorkIntents(this.file + '.intents.json', this.now)
    this.localization = new FeedLocalization(this.file + '.translations.json', this.now)
    this.dataDir = deps.dataDir ?? DATA_DIR
    this.machineId = deps.machineId ?? MACHINE.id
    this.s = (() => {
      const empty: State = { rev: 0, items: [], live: {}, cards: {}, sig: '', delivered: { day: '', n: 0 } }
      try {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<State>
        const items = (Array.isArray(raw.items) ? raw.items : []).filter((i) => i && typeof i.id === 'string' && typeof i.kind === 'string' && typeof i.text === 'string' && typeof i.at === 'number')
        // Results written before they had a line said in passing: the whole words move to the body.
        for (const i of items) {
          if (i.kind !== 'session' || i.tone !== 'result' || i.body) continue
          const line = headline(i.text)
          if (line && line !== collapse(i.text)) Object.assign(i, { body: i.text, text: line })
        }
        const obj = <T>(v: unknown): Record<string, T> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, T>) : {})
        return {
          rev: Number(raw.rev) || 0,
          items,
          live: obj<LiveState>(raw.live),
          cards: obj<number>(raw.cards),
          sig: typeof raw.sig === 'string' ? raw.sig : '',
          delivered: raw.delivered && typeof raw.delivered.day === 'string' ? { day: raw.delivered.day, n: Number(raw.delivered.n) || 0, by: obj<number>(raw.delivered.by) } : empty.delivered,
        }
      } catch {
        return empty
      }
    })()
    if (this.localization.recovered) { this.s.rev++; this.save() }
    // Retire the old raw Git/build stream permanently, including already stored history.
    const kept = this.s.items.filter((i) => !technicalEvent(i.id, i.text) && !(i.kind === 'session' && i.tone === 'result' && !i.mediaIds?.length && acknowledgementOnly(i.body || i.text)))
    if (kept.length !== this.s.items.length) {
      this.s.items = kept
      this.s.rev++
      this.save()
    }
    if (this.s.delivered.day === day(this.now())) {
      const actual = this.deliveredToday()
      if (actual.n !== this.s.delivered.n) {
        this.s.delivered = { day: day(this.now()), ...actual }
        this.s.rev++
        this.save()
      }
    }
  }

  get shelf() {
    return this.deps.shelf ?? null
  }

  // ---------------------------------------------------------------- writing

  private save() {
    const now = this.now()
    this.s.items = this.s.items.filter((i) => now - i.at < KEEP_MS)
    if (this.s.items.length > MAX_ITEMS) this.s.items = [...this.s.items].sort((a, b) => b.at - a.at).slice(0, MAX_ITEMS)
    for (const [id, at] of Object.entries(this.s.cards)) if (now - at > 6 * KEEP_MS) delete this.s.cards[id]
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      // Mail bodies and results live here: readable by the user only.
      fs.writeFileSync(tmp, JSON.stringify(this.s), { mode: 0o600 })
      fs.renameSync(tmp, this.file)
    } catch (e) {
      console.error(`[foryou] écriture : ${(e as Error).message}`)
    }
  }

  /** Something visible changed: a new revision, saved, and the snapshot rebuilt (not from inside its own build). */
  private changed(bump = true) {
    this.s.rev++
    this.dirty = true
    this.save()
    if (bump) this.w.bump()
  }

  private put(item: Stored) {
    const i = this.s.items.findIndex((x) => x.id === item.id)
    if (i >= 0) this.s.items[i] = item
    else this.s.items.push(item)
  }

  private get(id: string) {
    return this.s.items.find((i) => i.id === id)
  }

  /** An item the user can still act on: recorded and not dismissed, or live. */
  has(id: string): boolean {
    const i = this.get(id)
    return i ? !i.gone : id in this.s.live
  }

  // ---------------------------------------------------------------- sessions

  /** A session of work the user follows: not a test (nor a probe in a temporary folder), not a one-shot call of a script, not weevils' own, not weevboss. */
  eligible(s: Session): boolean {
    if (s.archived) return false
    if (s.origin === 'headless' || s.id === this.w.orchestratorId) return false
    if (s.cwd && (s.cwd === this.dataDir || s.cwd.startsWith(this.dataDir + path.sep))) return false
    // A probe or a throwaway test in a temporary folder (server/scratch.ts) is never a card.
    if (isScratchDir(s.cwd)) return false
    // A repo-less automation's run (<projects>/.auto/.<id>: watches, hunters, reports) speaks in For you only through
    // what it posts (one line with its page link, docs/LINKS.md): its closing turn is not a card. A task working in a
    // repo (<projects>/.auto/<repo>/<id>) stays a session like another.
    if (s.cwd && /(?:^|\/)\.auto\/\.[^/]+(?:\/|$)/.test(s.cwd)) return false
    const t = this.w.store?.get(s.id)
    if (t?.headless || t?.originator === 'codex_exec') return false
    const test = this.deps.isTestBrief ?? ((p?: string) => !!p && /^\s*\[test\]/.test(p))
    // A session of another machine has no transcript here: its title still starts with the brief.
    return !test(t?.firstPrompt) && !test(s.title)
  }

  private sessionItem(s: Session, over: Pick<Stored, 'tone' | 'text' | 'at'> & Partial<Stored>): Stored {
    return { id: `s:${s.id}`, kind: 'session', who: 'session', projectId: s.projectId, sessionId: s.id, tool: s.tool, ...(s.noticeId ? { eventId: s.noticeId } : {}), title: cleanTitle(s.title), reply: 'session', open: { page: 'session', id: s.id }, rec: this.now(), ...over }
  }

  /**
   * Called by core.ts where it already sees a session change: a turn that ended (result), a session that starts
   * waiting (question), a cut (cut). One item per session: the newest replaces the previous one, unseen again.
   */
  sessionTurn(s: Session, what: 'result' | 'question' | 'cut') {
    if (!this.eligible(s)) return
    if (what === 'result') {
      void this.result(s, true).catch((e) => console.error(`[foryou] ${s.id.slice(0, 8)} : ${(e as Error).message}`))
      // The transcript is read every 1.5 s: the last words of the turn may not be there yet.
      const later = this.deps.later ?? ((fn, ms) => void setTimeout(fn, ms).unref?.())
      later(() => void this.result(s, false).catch(() => undefined), REFINE_MS)
    } else if (this.waiting(s, what, true)) this.changed()
  }

  /** Records a question or a cut unless the item already says it. true when written. */
  private waiting(s: Session, what: 'question' | 'cut', fromCore = false): boolean {
    const cur = this.get(`s:${s.id}`)
    const now = this.now()
    if (what === 'question') {
      const text = clip(collapse(s.attention ?? ''), TEXT_MAX)
      if (cur?.tone === 'question' && cur.text === text && cur.eventId === s.noticeId) return false
      this.put(this.sessionItem(s, { ...(cur?.eventId && cur.eventId === s.noticeId ? { gone: cur.gone, seen: cur.seen } : {}), tone: 'question', text, at: fromCore ? now : Math.min(now, s.lastActivityAt || now) }))
      return true
    }
    // The same episode while the session did nothing since it was written (its time may have been refined).
    if (cur?.tone === 'alert' && cur.eventId === s.noticeId && s.lastActivityAt <= (cur.rec ?? cur.at) + 30_000) return false
    this.put(this.sessionItem(s, { tone: 'alert', text: '', cut: s.interrupted?.reason ?? 'died', at: Math.min(now, s.interrupted?.at ?? now) }))
    return true
  }

  /** The words that end the turn (the transcript, here or on the session's machine), and the files they cite. */
  private async result(s: Session, first: boolean, back = false) {
    const cur0 = this.get(`s:${s.id}`)
    // Read again later: only to complete the result written a moment ago.
    if (!first && cur0?.tone !== 'result') return
    const detail = await this.w.detailAny(s.id).catch(() => undefined)
    const raw = (detail && lastWords(detail.messages)) ?? ''
    const local = s.machineId === this.machineId
    const cited = raw && local && this.shelf ? this.shelf.fromText(raw, s.cwd || undefined, CITED_MAX) : []
    const mediaIds = cited.map((e) => e.id)
    // The files are shown under the words: their raw paths leave the words (unless nothing else was said).
    const said = cited.length ? collapse(withoutPaths(raw, cited.map((e) => e.path))) : ''
    const whole = (said || raw || (first ? (s.lastMessage ?? '') : '')).trim()
    const line = headline(whole)
    const text = line || clip(collapse(whole), HEADLINE_MAX)
    if (!text || internalFeedUpdate(whole)) return
    // Words with no whole sentence to show keep their body too: the card says it finished, they unfold under it.
    const body = collapse(whole) === text && (line || !untitledProse(whole)) ? undefined : clip(whole.replace(/\n{3,}/g, '\n\n'), BODY_MAX)
    const cur = this.get(`s:${s.id}`)
    const same = cur?.tone === 'result' && cur.text === text && (cur.mediaIds ?? []).join() === mediaIds.join()
    if (same) return
    if (!first) {
      // Same turn, better words: the item keeps its place and its seen state.
      if (cur?.tone !== 'result') return
      cur.text = text
      if (body) cur.body = body
      else delete cur.body
      delete cur.sum
      if (mediaIds.length) cur.mediaIds = mediaIds
      else delete cur.mediaIds
      this.titleResult(cur.id)
      return this.changed()
    }
    const now = this.now()
    this.put(this.sessionItem(s, { tone: 'result', text, at: back ? Math.min(now, s.lastActivityAt || now) : now, ...(body ? { body } : {}), ...(mediaIds.length ? { mediaIds } : {}) }))
    this.titleResult(`s:${s.id}`)
    // Picked up late: already counted, or from another day.
    if (back) return this.changed()
    this.s.delivered = { day: day(now), ...this.deliveredToday(now) }
    this.changed()
  }

  // ---------------------------------------------------------------- mail, posts, media, generated

  /** A mail of an outside author, at dispatch (BridgeDeps.mailed). The user's own mails are not news to them. */
  mail(m: MailIn) {
    if (!m.author || !m.text.trim()) return
    const id = `m:${crypto.createHash('sha1').update(m.mid).digest('hex').slice(0, 12)}`
    const boss = m.target === 'weevboss' || !m.target
    const s = boss ? undefined : this.w.snapshot().sessions.find((x) => x.id === m.target)
    const mail = { address: m.address, mid: m.mid, subject: m.subject, target: m.target || 'weevboss' }
    const cur = this.get(id)
    if (cur) {
      // Dispatch tells again once the session exists: same mail, its target now known.
      cur.mail = mail
      cur.sessionId = s?.id
      cur.projectId = s?.projectId
      cur.open = boss ? { page: 'boss' } : { page: 'session', id: m.target }
      return this.changed()
    }
    this.put({
      id,
      kind: 'mail',
      tone: 'neutral',
      at: this.now(),
      who: m.author,
      title: clip(collapse(m.subject), 160) || undefined,
      text: firstLine(m.text),
      body: m.text.trim().slice(0, MAIL_BODY_MAX),
      sessionId: s?.id,
      projectId: s?.projectId,
      open: boss ? { page: 'boss' } : { page: 'session', id: m.target },
      mail,
    })
    this.changed()
  }

  /** Observe explicit request sources, not titles or a session's idle/done flag. */
  private syncIntents(snap = this.w.snapshot()) {
    for (const link of reviewedIntents) {
      const item = this.get(link.cardId)
      if (!item?.actions?.some(a => a.id === link.actionId && a.brief === link.brief)) continue
      if (!snap.sessions.some(s => s.id === link.sessionId)) continue
      this.intents.observe({ id: link.intentId, brief: link.brief, status: 'requested', scope: item.projectId,
        open: { page: 'session', id: link.sessionId }, source: { sessionId: link.sessionId, messageId: link.messageId } })
    }
    for (const session of snap.sessions.slice(0, 100)) {
      const source = this.w.store?.get(session.id)
      const incoming = source?.messages?.filter(m => m.role === 'user' || m.role === 'orchestrator') ?? []
      const requests = [...new Map([...incoming.slice(0, 1), ...incoming.slice(-8)].map(m => [m.id, m])).values()]
      if (!requests.length && source?.firstPrompt) requests.push({ id: 'initial', role: 'user', text: source.firstPrompt, at: session.openedAt ?? this.now() })
      for (const request of requests) {
        if (!substantive(request.text)) continue
        this.intents.observe({ id: `request:${session.id}:${request.id}`, brief: request.text, scope: session.projectId, status: 'requested', at: request.at,
          open: { page: 'session', id: session.id }, source: { sessionId: session.id, messageId: request.id } })
      }
    }
    for (const job of snap.optimizers ?? []) {
      if (job.state === 'refused' || (job.state === 'proposed' && !job.userCreated)) continue
      const request = job.talk?.find(m => m.who === 'user')?.text
      const brief = request || `${job.title}. ${job.why}`
      this.intents.observe({ id: `auto:${job.id}`, brief, exact: !!request, scope: job.repo ?? undefined, at: job.createdAt,
        status: job.state === 'done' ? 'completed' : job.state === 'running' ? 'running' : job.state === 'queued' ? 'queued' : 'requested',
        open: { page: 'auto', id: job.id } })
    }
  }

  intentContext(): string {
    this.syncIntents()
    return JSON.stringify(this.intents.list().slice(0, 30).map(i => ({ sourceIntentId: i.id, status: i.status, brief: i.brief.slice(0, 600) })))
  }

  async refreshSoftware(): Promise<void> {
    if (!this.deps.softwares) return
    try { this.softwareCatalog = await this.deps.softwares() } catch { this.softwareCatalog = { at: 0, items: [] } }
  }

  private actionIntent(item: Stored, action: NonNullable<Stored['actions']>[number]) {
    const reviewed = reviewedIntents.find(link => link.cardId === item.id && link.actionId === action.id && link.brief === action.brief)
    return this.intents.get(reviewed?.intentId) ?? this.intents.find(action.brief, item.projectId, action.sourceIntentId) ?? this.intents.get(`card:${item.id}:${action.id}`)
  }

  /** Core calls this before sending a direct request, sharing the same reservation
   * as a proposal click. No extra send occurs inside an accepted intent dispatch. */
  async directRequest(text: string, sessionId: string | undefined, run: () => Promise<{ id: string }>): Promise<{ id: string }> {
    if (intentDispatch.getStore() || !substantive(text)) return run()
    this.syncIntents()
    const scope = this.w.snapshot().sessions.find(s => s.id === sessionId)?.projectId
    const proposed = this.s.items.some(i => i.actions?.some(a => briefKey(a.brief) === briefKey(text)))
    if (!isWorkRequest(text) && !proposed) return run()
    const result = await this.intents.dispatch(text, scope, `direct:${briefKey(text)}`, run)
    if (!result.open && this.intents.get(result.intentId)?.status === 'uncertain') throw new OutboxError(503, tr(M).intentUncertain)
    return { id: result.open?.page === 'session' ? result.open.id : sessionId ?? this.w.orchestratorId ?? '__main' }
  }

  private buttons(actions: unknown): Stored['actions'] {
    const list = (Array.isArray(actions) ? actions : [])
      .map((a) => ({ label: clip(collapse(String((a as { label?: unknown })?.label ?? '')), 48), brief: String((a as { brief?: unknown })?.brief ?? '').trim().slice(0, 4000), ...(typeof a?.sourceIntentId === 'string' && this.intents.get(a.sourceIntentId) ? { sourceIntentId: a.sourceIntentId as string } : {}), ...(typeof a?.op === 'string' && a.op ? { op: a.op as string } : {}) }))
      .filter((a) => a.label && a.brief)
      .slice(0, MAX_ACTIONS)
      .map((a, i) => ({ id: `a${i + 1}`, ...a }))
    return list.length ? list : undefined
  }

  /** « weevils post »: a word in the stream, from weevboss unless another author signs it, with up to two buttons, and the
   *  evidence supplied with it when it reports a result (shared/evidence.ts). */
  post(text: unknown, actions?: unknown, from?: string, evidence?: unknown): ForYouItem {
    const body = typeof text === 'string' ? text.trim() : ''
    if (!body) throw new Error(tr(M).emptyText)
    if (technicalEvent('', body) || internalFeedUpdate(body)) throw new Error(tr(M).technicalPost)
    const proof = evidenceInput(evidence)
    const item: Stored = { id: newId('b'), kind: 'boss', tone: 'neutral', at: this.now(), who: from || 'weevboss', text: clip(body, POST_MAX), actions: this.buttons(actions), reply: 'boss', open: { page: 'boss' }, ...(proof ? { evidence: proof } : {}) }
    this.put(item)
    this.changed()
    return this.view(item, this.w.snapshot())!
  }

  /**
   * « weevils show »: a file an agent wants the user to see. Its session is the most recently active one working in
   * (or above) the caller's folder; files shown by the same session within two minutes join one item.
   */
  addMedia(o: { path: unknown; caption?: unknown; cwd?: unknown; from?: string; evidence?: unknown }): ForYouItem {
    if (!this.shelf) throw new Error(tr(M).noMedia)
    const cwd = typeof o.cwd === 'string' && o.cwd ? path.resolve(o.cwd) : undefined
    const entry = this.shelf.add(String(o.path ?? ''), cwd)
    const caption = clip(collapse(typeof o.caption === 'string' ? o.caption : ''), 200)
    const proof = evidenceInput(o.evidence)
    const snap = this.w.snapshot()
    const s = cwd
      ? snap.sessions
          .filter((x) => x.machineId === this.machineId && x.cwd && (cwd === x.cwd || cwd.startsWith(x.cwd + path.sep)) && this.eligible(x))
          .sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0]
      : undefined
    const now = this.now()
    const open = this.s.items.find((i) => i.kind === 'media' && !i.gone && now - i.at < MEDIA_JOIN_MS && (i.mediaIds?.length ?? 0) < MAX_MEDIA && (s ? i.sessionId === s.id : !i.sessionId && i.cwd === cwd))
    if (open) {
      if (!open.mediaIds!.includes(entry.id)) open.mediaIds!.push(entry.id)
      if (caption) open.title = caption
      const evidence = mergeEvidence(open.evidence, proof)
      if (evidence) open.evidence = evidence
      open.at = now
      delete open.seen
      this.changed()
      return this.view(open, snap)!
    }
    // No session: weevboss showing something from its own folder, else weevils itself.
    const own = !s && !!cwd && (cwd === this.dataDir || cwd.startsWith(this.dataDir + path.sep))
    const boss = !s && (own || o.from === 'weevboss')
    const item: Stored = {
      id: newId('v'),
      kind: 'media',
      tone: s ? 'result' : 'neutral',
      at: now,
      who: s ? 'session' : boss ? 'weevboss' : (o.from ?? 'weevils'),
      title: caption || undefined,
      text: '',
      mediaIds: [entry.id],
      cwd,
      ...(proof ? { evidence: proof } : {}),
      ...(s ? { projectId: s.projectId, sessionId: s.id, tool: s.tool, reply: 'session' as const, open: { page: 'session' as const, id: s.id } } : boss ? { reply: 'boss' as const, open: { page: 'boss' as const } } : {}),
    }
    this.put(item)
    this.changed()
    return this.view(item, snap)!
  }

  visualExample(l?: unknown): ForYouItem | null {
    const item = this.s.items.find(i => i.visualProposal)
    const view = item ? this.view({ ...item, gone: false }, this.w.snapshot()) : null
    return view ? withLang(l, () => this.localization.project(view, lang(), item?.lang, this.w.snapshot().projects.map(p=>p.name), true)) : null
  }

  /** Explicit local publication only; never called by the curator or historical ingestion. */
  publishVisualProposal(raw: unknown): ForYouItem | null {
    const b = raw as Record<string, any>
    const str = (v: unknown, max = 1600): v is string => typeof v === 'string' && !!v.trim() && v.length <= max
    if (!b || !str(b.key, 80) || !/^[a-z0-9-]+$/.test(b.key) || !str(b.title, 160) || !str(b.text) || !str(b.sessionId)) throw new Error(tr(M).invalidVisual)
    const session = this.w.snapshot().sessions.find(s => s.id === b.sessionId && s.controllable)
    if (!session || !this.shelf) throw new Error(tr(M).invalidVisual)
    const p = b.proposal
    if (!p || !str(p.question) || !str(p.recommendation) || !str(p.caveat) || !Array.isArray(p.frames) || p.frames.length !== 3 || !Array.isArray(p.options) || p.options.length !== 2) throw new Error(tr(M).invalidVisual)
    if (!p.frames.every((f: any) => f && str(f.path) && str(f.title, 160) && str(f.description))) throw new Error(tr(M).invalidVisual)
    if (!p.options.every((o: any) => o && str(o.id, 20) && str(o.label, 160) && str(o.description) && str(o.instruction, 4000)) || new Set(p.options.map((o: any) => o.id)).size !== 2) throw new Error(tr(M).invalidVisual)
    const id = `visual:${b.key}`
    const previous = this.get(id)
    if (previous) return this.view(previous, this.w.snapshot()) // repeat publication cannot revive a completed choice
    const media = p.frames.map((f: any) => this.shelf!.add(f.path))
    if (media.some((e: any) => e.type !== 'image')) throw new Error(tr(M).invalidVisual)
    const visualProposal: ForYouItem['visualProposal'] = {
      frames: p.frames.map((f: any) => ({ title: f.title, description: f.description })),
      question: p.question, recommendation: p.recommendation, caveat: p.caveat,
      options: p.options.map((o: any) => ({ id: o.id, label: o.label, description: o.description, instruction: o.instruction, recommended: o.recommended === true })),
    }
    const item: Stored = { id, kind: 'media', tone: 'neutral', at: this.now(), who: 'session', projectId: session.projectId, sessionId: session.id, title: b.title, text: b.text, mediaIds: media.map((e: any) => e.id), visualProposal }
    this.put(item)
    this.changed()
    return this.view(item, this.w.snapshot())
  }

  /** Explicit editorial publication only. Repeating a key never duplicates or revives a card. */
  publishComposition(raw: unknown): ForYouItem | null {
    const b = raw as Record<string, any>
    const str = (v: unknown, max = 600) => typeof v === 'string' && !!v.trim() && v.length <= max
    if (!b || !this.shelf || !str(b.key, 80) || !/^[a-z0-9-]+$/.test(b.key) || !str(b.title, 200) || !str(b.text, 1200)
      || !['split', 'rail'].includes(b.layout) || !Array.isArray(b.panels) || b.panels.length < 2 || b.panels.length > 6
      || !b.panels.every((p: any) => p && str(p.path, 4096) && str(p.title, 160) && str(p.text, 600))) throw new Error(tr(M).invalidVisual)
    const id = `composition:${b.key}`
    const previous = this.get(id)
    if (previous) return this.view(previous, this.w.snapshot())
    const snap = this.w.snapshot()
    if (b.projectId && !snap.projects.some(p => p.id === b.projectId)) throw new Error(tr(M).invalidVisual)
    const media = b.panels.map((p: any) => this.shelf!.add(p.path))
    if (media.some((m: any) => m.type !== 'image')) throw new Error(tr(M).invalidVisual)
    const item: Stored = { id, kind: 'media', tone: 'neutral', at: this.now(), who: 'weevboss', title: b.title, text: b.text,
      lang: lang(), ...(b.projectId ? { projectId: b.projectId } : {}), reply: 'boss', open: { page: 'boss' },
      mediaIds: [...new Set<string>(media.map((m: any) => m.id))],
      composition: { layout: b.layout, panels: b.panels.map((p: any, n: number) => ({ mediaId: media[n].id, title: p.title, text: p.text })) } }
    this.put(item)
    this.changed()
    return this.view(item, snap)
  }

  /**
   * Sleep mode's morning recap (server/sleep.ts): one card, each line read from a run or a session's state on wake,
   * never from a model. A short nap with nothing to tell leaves none.
   */
  addRecap(night: { from: number; to: number }, autos: RecapAuto[]): ForYouItem | null {
    const snap = this.w.snapshot()
    const sessions = snap.sessions.filter((s) => this.eligible(s)).map((s) => ({ ...s, title: cleanTitle(s.title) }))
    const { recap, counts } = nightRecap({ ...night, sessions, autos, headline: (t) => headline(editorialFeedText(t)) })
    if (!recapWorth(recap)) return null
    const t = tr(SM)
    const item: Stored = { id: `sleep:${night.from}`, kind: 'stat', tone: 'magic', at: night.to, who: 'weevils', title: t.recapTitle, text: t.recap(counts), lang: lang(), recap }
    this.put(item)
    this.changed()
    return this.view(item, snap)
  }

  /**
   * The seam for generated items (the curator): written as given, replacing an item of the same id (fresh and unseen
   * again; one the user dismissed stays dismissed).
   */
  add(n: NewItem): ForYouItem | null {
    this.syncIntents()
    // A curator proposal is new only when it does not point to authorized work.
    // Unknown source IDs are rejected, never silently treated as new permission.
    if (n.actions?.some(a => a.sourceIntentId && !this.intents.get(a.sourceIntentId))) return null
    if (n.kind === 'improve' && n.actions?.some(a => this.intents.find(a.brief, n.projectId, a.sourceIntentId) || this.intents.ambiguous(a.brief, n.projectId))) return null
    if (technicalEvent(n.id ?? '', n.text) || internalFeedUpdate(n.text)) return null
    if (this.proposal(n)) {
      const own = ownIdea({ title: n.title, text: n.text }, this.saidNow())
      if (own) return void console.log(`[foryou] not offered back as an idea, it is the user's own (${own.why}${own.source ? `: « ${clip(collapse(own.source), 80)} »` : ''}): ${clip(collapse(n.title || n.text), 80)}`), null
    }
    const text = clip(n.text.trim(), POST_MAX)
    if (!text) return null
    const boss = n.kind === 'boss'
    const gone = !!n.id && !!this.get(n.id)?.gone
    const item: Stored = {
      id: n.id ?? newId(n.kind[0]),
      kind: n.kind,
      tone: n.tone ?? (n.kind === 'improve' || n.kind === 'milestone' ? 'magic' : 'neutral'),
      at: n.at ?? this.now(),
      who: n.who ?? (boss ? 'weevboss' : 'weevils'),
      projectId: n.projectId,
      title: n.title ? clip(collapse(n.title), 160) : undefined,
      text,
      more: n.more || undefined,
      gauges: n.gauges?.length ? n.gauges : undefined,
      actions: this.buttons(n.actions),
      lang: n.lang,
      ...(boss || n.kind === 'improve' ? { reply: 'boss' as const, open: { page: 'boss' as const } } : {}),
      ...(n.open ? { open: n.open } : {}),
      ...(gone ? { gone } : {}),
    }
    this.put(item)
    this.changed()
    return this.view(item, this.w.snapshot())
  }

  /** Mails still raw (no « did this » line yet), never under the user's eyes, that say more than their first line: for the curator. */
  rawMails(max = 6): { id: string; who: string; subject: string; text: string }[] {
    return this.s.items
      .filter((i) => i.kind === 'mail' && !i.gone && !i.seen && !i.sum && !!i.body && collapse(i.body) !== i.text)
      .sort((a, b) => b.at - a.at)
      .slice(0, max)
      .map((i) => ({ id: i.id, who: i.who, subject: i.title ?? '', text: i.body! }))
  }

  /** Questions of sessions still waiting that no model has read yet: for the curator. */
  rawAsks(max = 4): { id: string; sessionId: string; project: string; title: string; attention: string }[] {
    const snap = this.w.snapshot()
    return this.s.items
      .filter((i) => i.kind === 'session' && i.tone === 'question' && !i.gone && !i.q && !!i.sessionId)
      .filter((i) => snap.sessions.find((s) => s.id === i.sessionId)?.status === 'needs_user')
      .sort((a, b) => b.at - a.at)
      .slice(0, max)
      .map((i) => ({ id: i.id, sessionId: i.sessionId!, project: snap.projects.find((p) => p.id === i.projectId)?.name ?? i.projectId ?? '', title: i.title ?? '', attention: i.text }))
  }

  /** What the curator read in a question (null: it could not; the raw line stays). */
  askRead(id: string, q: Stored['q'] | null, expected?: string) {
    const i = this.get(id)
    if (!i || i.kind !== 'session' || i.tone !== 'question' || (expected !== undefined && i.text !== expected)) return
    i.q = q ?? {}
    this.changed()
  }

  /** Session results still in their raw closing words (no line said in passing yet), never seen: for the curator. */
  rawResults(max = 6): { id: string; project: string; title: string; asked: string; askedAt: number; text: string }[] {
    // Each result is titled as it lands (titleResult): nothing left for the curator's batch.
    if (this.deps.title) return []
    const snap = this.w.snapshot()
    return this.s.items
      .filter((i) => i.kind === 'session' && i.tone === 'result' && !i.gone && !i.seen && !i.sum && !!i.body)
      .sort((a, b) => b.at - a.at)
      .slice(0, max)
      .map((i) => {
        const s = snap.sessions.find((x) => x.id === i.sessionId)
        // What the user asked, in their words (the brief, without the signature of who passed it on): the line recalls it.
        const asked = clip(collapse(cleanTitle(this.w.store?.get(i.sessionId ?? '')?.firstPrompt ?? '')), 400) || (i.title ?? '')
        return { id: i.id, project: snap.projects.find((p) => p.id === i.projectId)?.name ?? i.projectId ?? '', title: i.title ?? '', asked, askedAt: s?.openedAt ?? i.at, text: i.body! }
      })
  }

  private titling = new Set<string>()
  /** Cards rewritten while their title was being asked: asked again once that call ends. */
  private retitle = new Set<string>()
  private titles: Promise<void> = Promise.resolve()

  /** Every session result card is titled by a light model from its whole closing message: one complete sentence that
   * says what was done, never a fragment cut out of the last sentence. One call at a time; a useless answer is retried. */
  titleResult(id: string) {
    const ask = this.deps.title
    if (!ask) return
    // Already asked: a rewrite meanwhile asks again once that call ends, never dropped (it left the card a fragment).
    if (this.titling.has(id)) return void this.retitle.add(id)
    this.titling.add(id)
    const later = this.deps.later ?? ((fn, ms) => void setTimeout(fn, ms).unref?.())
    const job = async () => {
      const i = this.get(id)
      if (!i || i.kind !== 'session' || i.tone !== 'result' || i.gone || i.sum?.text || (i.sum?.tries ?? 0) >= TITLE_TRIES) return
      const source = i.body || i.text
      const snap = this.w.snapshot()
      const project = snap.projects.find((p) => p.id === i.projectId)?.name ?? i.projectId ?? ''
      // What was asked, without weevils' hidden context block (it would only blur the subject and the language).
      const asked = clip(collapse(cleanTitle(withoutWeevilsBlock(this.w.store?.get(i.sessionId ?? '')?.firstPrompt ?? ''))), 400)
      // The card is stored once, in the installation's language (other readers get it translated): never the language
      // of whichever request happened to start this turn's scan (a French call left English cards in French).
      const l = installationLang()
      let line = ''
      try {
        const raw = await ask(withLang(l, () => tr(M).resultTitle(project, withoutWeevilsBlock(asked), withoutWeevilsBlock(source))))
        line = resultTitleLine(raw, [project, i.title ?? ''])
        if (!line) console.log(`[foryou] result title not kept for ${id}: ${JSON.stringify(collapse(raw).slice(0, 200))}`)
      } catch (e) {
        console.error(`[foryou] result title: ${(e as Error).message}`)
      }
      const cur = this.get(id)
      if (!cur || cur.sum?.text) return
      // Rewritten meanwhile (same turn, better words): asked again with those words.
      if ((cur.body || cur.text) !== source) return void this.retitle.add(id)
      if (line) {
        cur.sum = { text: line, lang: detectLang(line) ?? l, ...(cur.sum?.relang ? { relang: true } : {}) }
        return this.changed()
      }
      const tries = (cur.sum?.tries ?? 0) + 1
      cur.sum = { tries, at: this.now(), ...(cur.sum?.relang ? { relang: true } : {}), ...(cur.sum?.prior ? { prior: cur.sum.prior } : {}) }
      this.save()
      if (tries < TITLE_TRIES) later(() => this.titleResult(id), tries * 2 * 60_000)
    }
    this.titles = this.titles.then(job).catch(() => undefined).finally(() => {
      this.titling.delete(id)
      // Only a rewritten card (its title state cleared): a failed try keeps its own delay.
      if (this.retitle.delete(id) && !this.get(id)?.sum) this.titleResult(id)
    })
  }

  /** Result cards of the last days still without a model's title (stored before titles, or after failed tries), and
   * titles written in another language than the installation's (once: the old one stays if the new try fails). */
  titleRecentResults(days = 7) {
    const since = this.now() - days * 86_400_000
    const l = installationLang()
    let moved = false
    for (const i of this.s.items) {
      if (i.kind === 'session' && i.tone === 'result' && !i.gone && i.at >= since && i.sum?.text && !i.sum.relang && (i.sum.lang ?? detectLang(i.sum.text) ?? l) !== l) {
        i.sum = { tries: TITLE_TRIES - 1, at: 0, relang: true, prior: i.sum.text }
        moved = true
      }
      const tries = i.sum?.tries ?? 0
      // A failed try keeps its delay (titleResult schedules the next one): the sweep never asks sooner.
      const waiting = !!tries && this.now() - (i.sum?.at ?? 0) < tries * 2 * 60_000
      if (i.kind === 'session' && i.tone === 'result' && !i.gone && !i.sum?.text && i.at >= since && tries < TITLE_TRIES && !waiting) this.titleResult(i.id)
    }
    if (moved) this.save()
  }

  /** The curator's line for a session result (null: it kept nothing, the headline stays). */
  resultLine(id: string, line: string | null, l?: Lang) {
    const i = this.get(id)
    if (!i || i.kind !== 'session') return
    const text = line && !internalFeedUpdate(line) ? clip(collapse(line), LINE_MAX) : ''
    i.sum = text ? { text, lang: l } : {}
    if (text) this.changed()
    else this.save()
  }

  /** The curator's line for a mail (null: it tried and kept nothing, the first line stays). The whole mail stays in body. */
  mailLine(id: string, line: string | null, l?: Lang) {
    const i = this.get(id)
    if (!i || i.kind !== 'mail') return
    const text = line ? clip(collapse(line), LINE_MAX) : ''
    i.sum = text ? { text, lang: l } : {}
    if (text) this.changed()
    else this.save()
  }

  /** The last usage figures the stream asked for in the background (null: none yet). Never asks. */
  usageKnown(): UsageInfo | null {
    return this.usage
  }

  /** Distinct sessions with a concrete result today, reconstructed from source records, not turn counts. */
  deliveredToday(now = this.now()): { n: number; by: Record<string, number> } {
    const by: Record<string, number> = {}
    const results = this.s.items.filter((i) => i.kind === 'session' && i.tone === 'result' && day(i.at) === day(now) && !technicalEvent(i.id, i.text) && !internalFeedUpdate(i.body || i.text))
    for (const i of results) if (i.projectId) by[i.projectId] = (by[i.projectId] ?? 0) + 1
    return { n: results.length, by }
  }

  /** Recorded items of these kinds, newest first, as the app would read them (for the curator: what was already said). */
  recent(kinds: ForYouKind[], max = 40): ForYouItem[] {
    const snap = this.w.snapshot()
    return [...this.s.items]
      .filter((i) => kinds.includes(i.kind))
      .sort((a, b) => b.at - a.at)
      .slice(0, max)
      .map((i) => this.view({ ...i, gone: false }, snap, true))
      .filter((i): i is ForYouItem => !!i)
  }

  /** Observed exposure and explicit removal only: neither is a satisfaction score. */
  editorialSignals() {
    return this.s.items.filter(i => i.id.startsWith('r:')).slice(-40).map(i => ({ title: i.title, text: i.text, seen: !!i.seen, dismissed: !!i.gone }))
  }

  /** The app looked at the stream in the last half hour. */
  wanted(now = this.now()): boolean {
    return this.lastWanted > 0 && now - this.lastWanted < WANTED_MS
  }

  // ---------------------------------------------------------------- reading: recorded items

  /** What the app may read of a recorded item, or null when it has nothing to show right now. */
  private view(i: Stored, snap: Snapshot, any = false): ForYouItem | null {
    if (i.gone || i.id.startsWith('r:') || technicalEvent(i.id, i.text)) return null
    if (((i.kind === 'session' && i.tone === 'result') || ['boss', 'improve', 'insight'].includes(i.kind)) && (internalFeedUpdate(i.body || i.text) || internalFeedUpdate([i.title, i.body || i.text].filter(Boolean).join('\n')))) return null
    let text = i.text
    if (i.id.startsWith('auto:proposed:')) {
      const idea = snap.optimizers?.find((o) => i.id === `auto:proposed:${o.id}`)
      if (!idea || idea.draft) return null
      if (this.ownTask(idea).own) text = tr(M).autoOwn(idea.title)
    }
    // Published before the rule, or the user said it since: their own idea is not shown back as weevils'. A card they
    // acted on stays when it only resembles what they said (the tap itself sends its brief to weevboss), never when it
    // tells them « You want… ».
    const own = this.proposal(i) ? this.ownStored(i) : null
    if (own && (own === 'echo' || !i.actions?.some(a => this.actionIntent(i, a)))) return null
    const out: ForYouItem = { id: i.id, kind: i.kind, tone: i.tone, at: i.at, who: i.who, text }
    if (i.visualProposal) out.visualProposal = i.visualProposal
    if (i.composition) out.composition = i.composition
    if (i.recap) out.recap = i.recap
    if (i.projectId) out.projectId = i.projectId
    if (i.sessionId) out.sessionId = i.sessionId
    if (i.eventId) out.eventId = i.eventId
    if (i.tool) out.tool = i.tool
    if (i.title) out.title = i.title
    if (i.body) out.body = i.body
    if (i.open) out.open = i.open
    if (i.reply && (i.reply !== 'session' || snap.sessions.some(s => s.id === i.sessionId && s.controllable))) out.reply = i.reply
    if (i.more) out.more = true
    if (i.moreText) out.moreText = i.moreText
    if (i.gauges?.length) out.gauges = i.gauges
    // A result says how far it was seen working, from what was supplied with it only: an agent's media result without
    // any is « implemented » at most, whatever its caption claims.
    if (i.evidence || (i.kind === 'media' && i.tone === 'result')) out.evidence = evidenceLabel(i.evidence)
    // Words of weevboss or of an outside author can be listened to, each in its own voice.
    const voice = i.kind === 'boss' && i.id.startsWith('b:') && i.text ? this.deps.voiceOf?.(i.who) : undefined
    if (voice) out.voice = voice
    if (i.seen) out.seen = true
    if (i.actions?.length) out.actions = i.actions.map(({ id, label }): ForYouAction => ({ id, label }))
    if (i.mediaIds?.length && this.shelf) {
      const media = i.mediaIds.map((id) => this.shelf!.get(id)).filter((e) => !!e).map((e): ForYouMedia => this.shelf!.view(e!))
      if (media.length) out.media = media
    }
    if (i.kind === 'media' && !out.media && i.id !== ALCOVE_SOURCE && !i.composition) return null
    if (i.kind === 'mail') {
      // Written in the mail's own language, like the first line it replaces: shown whatever the app's language.
      if (i.sum?.text) out.text = i.sum.text
      // Without a bridge to send through, nothing to reply with.
      if (i.mail?.address && this.deps.mail?.()) out.reply = 'mail'
      else delete out.reply
    }
    if (i.kind === 'session') {
      // The line follows the latest rules (an item stored earlier gets them too); the curator's line wins.
      if (i.tone === 'result') {
        // A stored title loses a model's preamble written before that rule; closing words with no whole sentence
        // left once their code is out say so plainly rather than show a fragment (a bare file name stays as it is).
        const kept = i.sum?.text || i.sum?.prior
        const titled = kept && !internalFeedUpdate(kept) ? titleWithoutPreamble(kept) : ''
        const source = i.body || i.text
        out.text = titled || headline(editorialFeedText(source)) || (untitledProse(source) ? tr(M).resultUntitled : i.text)
      }
      const cur = snap.sessions.find((s) => s.id === i.sessionId)
      if (cur?.archived) return null
      if (cur) out.title = cleanTitle(cur.title)
      const t = tr(M)
      if (i.tone === 'question') {
        // Answered since (or gone from the list): no longer a question.
        if (!any && cur?.status !== 'needs_user') return null
        out.text = i.text || t.waiting
        if (i.q?.ask === false && i.q.question) {
          // Not really a question: said as what the session did, no « asks you » card.
          out.tone = 'result'
          out.text = i.q.question
        } else if (i.q?.ask && i.q.question) {
          out.text = i.q.question
          if (i.q.title) out.lead = i.q.title
          if (i.q.options?.length) out.actions = i.q.options.map((label, n) => ({ id: `opt:${n}:${questionKey(i)}`, label }))
        }
      } else if (i.tone === 'alert') {
        if (!any && cur?.status !== 'interrupted') return null
        out.text = t.cut(tr(CM).cutWhy(i.cut ?? 'died'))
        out.actions = [{ id: 'resume', label: t.resume }]
      }
    }
    if (['boss', 'improve', 'insight'].includes(i.kind)) {
      const text = editorialFeedText(out.text)
      if (!text) return null
      out.text = text
      if (out.actions) out.actions = out.actions.filter(a => !internalFeedUpdate(a.label))
    }
    const result = humanFeedItem(reviewedEditorial(out, i.text))
    // A button already tapped: the card says what became of it (sent, then weevboss's answer) instead of offering it
    // again; the other buttons stay under it. Work that existed before the card (unrelated tasks it points to) and a
    // second work tapped on the same card stay one tap away, as « View existing work ».
    const intents = (i.actions ?? []).map(a => ({ a, work: this.actionIntent(i, a) }))
    const tracked = intents.filter((x) => !!x.work)
    const one = tracked.length === intents.length && new Set(tracked.map((x) => x.work!.id)).size === 1
    const tapped = one ? tracked : tracked.filter((x) => x.a.tapped)
    const shown = tapped.length ? tapped.reduce((x, y) => (y.work!.at > x.work!.at ? y : x)) : undefined
    if (shown) {
      const work = shown.work!
      const open = this.appOpen(work.open)
      const reply = open?.page === 'boss' ? this.bossReply(work, shown.a.label) : undefined
      result.work = { intentId: work.id, status: work.status, open, source: work.source, ...(reply ? { reply } : {}) }
      if (open) result.open = open
      result.editorial ??= { original: { ...(i.title ? { title: i.title } : {}), text: i.text } }
    }
    if (tracked.length && result.actions) {
      result.actions = result.actions.flatMap(a => {
        const work = intents.find(x => x.a.id === a.id)?.work
        if (!work) return [a]
        return work.id === shown?.work!.id ? [] : [{ ...a, label: tr(M).followWork }]
      })
    }
    const software = softwareResult(result, snap, this.softwareCatalog, this.now())
    if (software) result.software = software
    return projectFeedWorkstream(result, snap)
  }

  // ---------------------------------------------------------------- reading: live items

  /** Usage and machine measures, asked in the background: a read never waits for them. */
  private refresh(now: number, snap: Snapshot) {
    if (this.refreshing || !(this.deps.quotas || this.deps.machines)) return
    if (now - this.refreshedAt < (this.wanted(now) ? REFRESH_MS : REFRESH_IDLE_MS)) return
    this.refreshing = true
    this.refreshedAt = now
    const before = this.systemAlerts(snap, now).map((a) => a.id).join()
    void Promise.all([
      this.deps.quotas?.().then((u) => void (this.usage = u)).catch(() => undefined),
      this.deps.machines?.().then((list) => {
        this.machines = list
        const hot = new Map<string, number>()
        for (const m of list) if (m.level === 'crit') hot.set(m.id, (this.hot.get(m.id) ?? 0) + 1)
        this.hot = hot
      }).catch(() => undefined),
    ]).finally(() => {
      this.refreshing = false
      // The next snapshot's mark() counts the revision.
      if (this.systemAlerts(this.w.snapshot(), this.now()).map((a) => a.id).join() !== before) this.w.bump()
    })
  }

  /** Weekly quota pace, from the cached usage (no request of its own): said only when it changes a decision — it will
   * run dry before the reset, or a lot is left late in the week. */
  private paceInsights(now: number): ForYouItem[] {
    const t = tr(M)
    const out: ForYouItem[] = []
    const WEEK = 7 * 86_400_000
    for (const tool of ['claude', 'codex'] as const) {
      const q = this.usage?.[tool]
      const w = q?.ok ? q.windows.find((x) => x.kind === 'week') : undefined
      if (!w?.resetsAt || w.percent >= USAGE_ALERT) continue
      const left = w.resetsAt - now
      const gone = (WEEK - left) / WEEK
      if (left <= 0 || gone <= 0.15 || gone >= 1) continue
      const name = tool === 'claude' ? 'Claude' : 'Codex'
      const rate = w.percent / (WEEK - left) // % per ms
      const dryIn = rate > 0 ? (100 - w.percent) / rate : Infinity
      const id = `insight:pace:${tool}:${quotaReset(w.resetsAt)}`
      if (dryIn < left - 6 * 3_600_000) out.push({ id, kind: 'insight', tone: 'neutral', at: now, who: 'weevils', text: t.paceOut(name, Math.round(w.percent), Math.round(gone * 100), Math.round((left - dryIn) / 3_600_000)), open: { page: 'usage' }, live: true })
      else if (gone >= 0.6 && w.percent < 40) out.push({ id, kind: 'insight', tone: 'neutral', at: now, who: 'weevils', text: t.paceRoom(name, Math.round(w.percent), Math.max(1, Math.round(left / 86_400_000))), open: { page: 'usage' }, live: true })
    }
    return out
  }

  /** Alerts that come from the system (not from a session): each with the place where it is solved. */
  private systemAlerts(snap: Snapshot, now: number): ForYouItem[] {
    const t = tr(M)
    const out: ForYouItem[] = []
    const raise = (id: string, text: string, open: ForYouItem['open'], at?: number) => out.push({ id: `alert:${id}`, kind: 'alert', tone: 'alert', at: at ?? 0, who: 'weevils', text, open, live: true })
    for (const tool of ['claude', 'codex'] as const) {
      const q = this.usage?.[tool]
      const top = q?.ok ? [...q.windows].sort((a, b) => b.percent - a.percent)[0] : undefined
      if (!top || top.percent < USAGE_ALERT) continue
      // An authorized, available relay handles Claude's shared quota without a user decision.
      // Keep model-specific warnings and the other tool's own quota alerts actionable.
      if (tool === 'claude' && top.kind !== 'model' && snap.relay?.mode === 'auto' && snap.relay.codex) continue
      const name = top.kind === 'session' ? t.window_session : top.kind === 'week' ? t.window_week : t.window_model(top.label ?? '')
      // The window's reset is in the id: the next window is another alert.
      // The other tool, when it has room: said as the plan B it is (the relay hands work to it at the limit).
      const other = tool === 'claude' ? 'codex' : 'claude'
      const o = this.usage?.[other]
      const spare = o?.ok && o.windows.length && o.windows.every((w) => w.percent < USAGE_ALERT) ? (other === 'claude' ? 'Claude' : 'Codex') : ''
      raise(`usage:${tool}:${top.kind}:${top.label ?? ''}:${quotaReset(top.resetsAt ?? 0)}`, t.usage(top.kind === 'model' ? '' : tool === 'claude' ? 'Claude' : 'Codex', name.trim(), Math.round(top.percent), spare), { page: 'usage' })
    }
    for (const m of this.machines) {
      if ((this.hot.get(m.id) ?? 0) >= HOT_SAMPLES) raise(`machine:${m.id}`, t.saturated(m.name), { page: 'machine' })
      if (m.disk !== undefined && m.disk >= DISK_ALERT) raise(`disk:${m.id}`, t.diskFull(m.name, Math.round(m.disk)), { page: 'machine' })
    }
    for (const m of snap.machines) {
      const since = this.offSince.get(m.id)
      if (!m.online && since !== undefined && now - since >= OFFLINE_AFTER_MS) raise(`offline:${m.id}`, t.offline(m.name), { page: 'machine' }, since)
    }
    for (const o of snap.optimizers ?? []) {
      if (o.state === 'failed' && o.endedAt && now - o.endedAt < FAILED_KEEP_MS) raise(`auto:${o.id}`, t.autoFailed(o.title, o.lastEvent ?? ''), { page: 'auto', id: o.id }, o.endedAt)
    }
    return out
  }

  /** Tips whose accept runs on the server or goes to weevboss; the ones that open a page of the app stay in the app. */
  private tips(snap: Snapshot, now: number): Found[] {
    const input = this.deps.tips?.(snap, now)
    if (!input) return []
    try {
      return personalTips(input).filter((f) => f.action?.kind === 'server' || f.action?.kind === 'boss')
    } catch {
      return []
    }
  }

  /** The cards waiting for a yes or a no: proposed auto tasks first, then tips; never one already answered. */
  private cards(snap: Snapshot, now: number): ForYouCard[] {
    // One-shot proposals are actions to take: they live here. Recurring ones are automations: the automated page.
    const auto = (snap.optimizers ?? []).filter((o) => o.state === 'proposed' && !o.draft && !o.every && !o.userCreated).map((o): ForYouCard => {
      const own = this.ownTask(o)
      return { id: `o:${o.id}`, title: o.title, why: own.own && own.why !== null ? tr(M).ownWhy : (own.why ?? o.why), source: 'optimizer', kind: o.kind, repo: o.repo, ...(own.own ? { own: true } : {}) }
    })
    const tips = this.tips(snap, now).map((f): ForYouCard => ({ id: `t:${f.id}`, title: f.text, why: '', source: 'tip', kind: f.rule, ...(f.accept ? { accept: f.accept } : {}) }))
    return [...auto, ...tips].filter((c) => !(c.id in this.s.cards)).slice(0, MAX_CARDS)
  }

  /** Alerts and proposals of this instant, with their kept state (seen, dismissed, first seen). */
  private live(snap: Snapshot, now: number): ForYouItem[] {
    for (const m of snap.machines) {
      if (m.online) this.offSince.delete(m.id)
      else if (!this.offSince.has(m.id)) this.offSince.set(m.id, now)
    }
    const items = [...this.systemAlerts(snap, now), ...this.paceInsights(now), ...(this.deps.numbers?.items(now) ?? [])]
    const cards = this.cards(snap, now)
    if (cards.length) items.push({ id: 'proposals', kind: 'proposals', tone: 'neutral', at: 0, who: 'weevils', text: cards.every((c) => c.own) ? tr(M).ownProposals(cards.length) : tr(M).proposals(cards.length), cards, live: true })
    const out: ForYouItem[] = []
    for (const i of items) {
      // Migrate earlier raw API reset timestamps: a few milliseconds must never revive a closed quota event.
      if (!this.s.live[i.id] && i.id.startsWith('alert:usage:')) {
        const old = Object.keys(this.s.live).find((key) => key !== i.id && canonicalAlertId(key) === i.id)
        if (old) { this.s.live[i.id] = this.s.live[old]; delete this.s.live[old] }
      }
      const st = (this.s.live[i.id] ??= { at: now, last: now })
      st.last = now
      if (i.cards) {
        const ids = i.cards.map((c) => c.id)
        // A new card: the band is news again, even dismissed.
        if (st.cards && ids.some((id) => !st.cards!.includes(id))) {
          st.at = now
          delete st.seen
          delete st.gone
        }
        st.cards = ids
      }
      if (st.gone) continue
      out.push({ ...i, at: i.cards ? st.at : i.at || st.at, ...(st.seen ? { seen: true } : {}) })
    }
    for (const [id, st] of Object.entries(this.s.live)) if (now - st.last > LIVE_FORGET_MS) delete this.s.live[id]
    return out
  }

  // ---------------------------------------------------------------- reading: the whole

  /** Turns that ended while the stream did not listen (first start, restart): the recent ones get their item, once. */
  private backfill(snap: Snapshot, now: number) {
    const due = snap.sessions
      .filter((s) => (s.status === 'done' || s.status === 'idle') && s.messageCount > 2 && now - s.lastActivityAt < BACKFILL_MS)
      .filter((s) => !this.tried.has(s.id) && !this.has(`s:${s.id}`) && this.eligible(s))
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .slice(0, BACKFILL_MAX)
    for (const s of due) {
      this.tried.add(s.id)
      void this.result(s, true, true).catch(() => undefined)
    }
  }
  private tried = new Set<string>()

  /** An auto task that starts or ends is news, said once each (free: read from the snapshot). */
  private autoEvents(snap: Snapshot) {
    const t = tr(M)
    for (const o of snap.optimizers ?? []) {
      const proposed = { id: `auto:proposed:${o.id}`, at: o.createdAt, text: t.autoProposed(o.title), tone: 'neutral' as const }
      if (o.state === 'proposed' && !o.draft && !this.has(proposed.id) && this.now() - proposed.at <= BACKFILL_MS) {
        this.put({ ...proposed, kind: 'boss', who: 'weevils', open: { page: 'auto', id: o.id }, reply: 'boss', rec: this.now(), lang: lang() })
        this.changed(false)
      }
      const ev = o.state === 'running' && o.startedAt ? { id: `auto:go:${o.id}`, at: o.startedAt, text: t.autoGo(o.title), tone: 'neutral' as const }
        : o.state === 'done' && o.endedAt ? { id: `auto:done:${o.id}`, at: o.endedAt, text: t.autoDone(o.title, o.lastEvent ?? ''), tone: 'result' as const }
        : null
      if (!ev || this.has(ev.id) || this.now() - ev.at > BACKFILL_MS) continue
      this.put({ id: ev.id, kind: 'boss', tone: ev.tone, at: ev.at, who: 'weevils', text: ev.text, open: { page: 'auto', id: o.id }, reply: 'boss', rec: this.now(), lang: lang() })
      this.changed(false)
    }
  }

  /**
   * Everything visible now, independently of the presentation language. Also: a session that waits or was cut without an item saying
   * so gets one (after a restart, core's first pass is silent), and the revision moves when the visible set changed.
   */
  private all(snap: Snapshot, now: number, inBuild: boolean): { item: ForYouItem; lang?: Lang }[] {
    let wrote = false
    for (const s of snap.sessions) {
      if (s.status !== 'needs_user' && s.status !== 'interrupted') continue
      // An old cut or question nobody picked up is history, not news: a first start would otherwise open on a wall of them.
      if (now - Math.max(s.lastActivityAt, s.interrupted?.at ?? 0) > CATCH_UP_MS) continue
      if (this.eligible(s) && this.waiting(s, s.status === 'needs_user' ? 'question' : 'cut')) wrote = true
    }
    if (wrote) this.changed(false)
    this.backfill(snap, now)
    this.autoEvents(snap)
    const out: { item: ForYouItem; lang?: Lang }[] = []
    // Only the newest stored items are read for a view (view() is the costly part): the stream shows MAX_FEED at
    // most, the rest stays stored as history, untouched.
    const recent = this.s.items.length > VIEW_REACH ? [...this.s.items].sort((a, b) => b.at - a.at).slice(0, VIEW_REACH) : this.s.items
    for (const i of recent) {
      const item = this.view(i, snap)
      if (item) out.push({ item, lang: i.lang })
    }
    for (const item of this.live(snap, now)) out.push({ item })
    // weevboss's answer landing on a card that handed it work is a change of the stream too.
    const sig = out.map((x) => `${x.item.id}${x.item.cards ? `[${x.item.cards.map((c) => c.id).join()}]` : ''}${x.item.work?.reply ? '+reply' : ''}`).sort().join('|')
    let moved = wrote
    if (sig !== this.s.sig) {
      this.s.sig = sig
      // A change already counted by changed() is the same change.
      if (!this.dirty) this.s.rev++
      this.save()
      moved = true
    }
    // Found while answering the app, not while building the snapshot: the snapshot's mark has to follow.
    if (moved && !inBuild) this.w.bump()
    this.dirty = false
    return out
  }

  private pulse(snap: Snapshot, now: number): ForYouPulse {
    const mine = snap.sessions.filter((s) => this.eligible(s))
    return {
      working: mine.filter((s) => s.status === 'working').length,
      waiting: mine.filter((s) => s.status === 'needs_user' || s.status === 'interrupted').length,
      delivered: this.deliveredToday(now).n,
      auto: (snap.optimizers ?? []).filter((o) => o.state === 'running' || o.state === 'queued').length,
    }
  }

  /** GET /api/foryou: the stream in the app's language, ordered and paced, and the factory line. */
  feed(now = this.now(), l?: unknown): ForYouFeed {
    this.lastWanted = now
    const snap = this.w.snapshot()
    this.syncIntents(snap)
    this.refresh(now, snap)
    return withLang(l, () => {
      const cur = lang()
      const sources = this.all(snap, now, false).filter(x => !technicalEvent(x.item.id, x.item.text))
      const languages = new Map(sources.map(x => [x.item.id, x.lang]))
      const items = keepLive(arrange(sources.map(x => projectFeedWorkstream(humanFeedItem(x.item), snap)), now), MAX_FEED)
        .map(item => this.localization.project(item, cur, languages.get(item.id), snap.projects.map(p => p.name), true))
      const anchor = this.s.items.find(i => i.id === ALCOVE_SOURCE)
      return { rev: this.s.rev, items: groupAlcove(items, items.some(i => i.id === ALCOVE_SOURCE) ? alcoveFinal(this.shelf, anchor?.cwd) : undefined), pulse: this.pulse(snap, now) }
    })
  }

  /**
   * For the snapshot, called by Weevils.snapshot() with the snapshot it is building (never ask the host for it here):
   * the revision and how many items were never under the user's eyes.
   */
  mark(snap: Snapshot): ForYouMark {
    const now = this.now()
    this.refresh(now, snap)
    const unseen = this.all(snap, now, true).filter((x) => !x.item.seen).length
    return { rev: this.s.rev, unseen }
  }

  // ---------------------------------------------------------------- what the user does

  translationChanged(): void { this.s.rev++; this.save(); this.w.bump() }

  /** Seen on a device: seen everywhere. */
  seen(ids: unknown): void {
    let any = false
    for (const id of Array.isArray(ids) ? ids.map(String) : []) {
      const i = this.get(id)
      const st = this.s.live[id]
      if (i && !i.seen) any = i.seen = true
      else if (!i && st && !st.seen) any = st.seen = true
    }
    if (any) this.changed()
  }

  resolveSession(s: Session) {
    if (s.status === 'needs_user' || s.status === 'interrupted') this.dismiss(`s:${s.id}`, sessionNoticeKey(s))
  }

  dismiss(id: string, eventId?: string): boolean {
    const i = this.get(id)
    const st = this.s.live[id]
    if (eventId) {
      const current = i ? this.view({ ...i, gone: false }, this.w.snapshot(), true) : this.live(this.w.snapshot(), this.now()).find((item) => item.id === id)
      // A late click on yesterday's notification must not dismiss a newer turn of that session.
      if (current && feedNoticeKey(current) !== eventId) return true
    }
    if (i) i.gone = true
    else if (st) st.gone = true
    else return false
    this.changed()
    return true
  }

  /**
   * A button or a card. proposals: accept / refuse one card (the auto task through the auto band, a tip run here or
   * sent to weevboss), remembered so it never comes back. A button under a post: its brief goes to weevboss behind a
   * short visible message, and the item leaves. « resume » on a cut session: resumed, and the item leaves.
   */
  private actionFlights = new Map<string, Promise<void | IntentResult>>()
  /** weevboss's conversations are not session pages: a work handed to it opens its thread (or stays on the card). */
  private bossThread(id: string) {
    return id === '__main' || id === 'setup' || id === this.w.orchestratorId || !!this.w.isBossThread?.(id)
  }
  private appOpen(open?: ForYouOpen): ForYouOpen | undefined {
    return open?.page === 'session' && this.bossThread(open.id) ? { page: 'boss' } : open
  }
  /** weevboss's first answer after an action was handed to it, for the card that sent it. */
  /** A generated suggestion presented as weevils' idea: an « improve » card (not a cost button) or a story. */
  private proposal(i: { kind: string; id?: string; actions?: { op?: string }[] }): boolean {
    return (i.kind === 'improve' && !i.actions?.some(a => a.op)) || (i.kind === 'boss' && !!i.id?.startsWith('r:'))
  }

  /**
   * What the user said themselves: their memory, what they told weevboss and what they asked any session over the
   * last two weeks. Read again at most every two minutes (the boss thread can be long).
   */
  private saidNow(): string[] {
    const now = this.now()
    if (this.said && now - this.said.at < SAID_MS) return this.said.list
    const list = (this.deps.said?.() ?? []).filter(Boolean)
    const boss = this.w.orchestratorId ? this.w.store?.get(this.w.orchestratorId)?.messages ?? [] : []
    for (const m of boss) if (m.role === 'user' && now - m.at < SAID_DAYS * 86_400_000 && m.text.trim()) list.push(m.text.slice(0, 2000))
    // What they asked any session lately (each request is recorded as an intent before it is sent).
    this.syncIntents()
    for (const i of this.intents.list()) if (i.id.startsWith('request:') && now - i.at < SAID_DAYS * 86_400_000) list.push(i.brief.slice(0, 2000))
    this.said = { at: now, list }
    this.ownSeen.clear()
    this.ownTasks.clear()
    return list
  }
  private said: { at: number; list: string[] } | null = null
  private ownSeen = new Map<string, 'echo' | 'restates' | null>()

  private ownStored(i: Stored): 'echo' | 'restates' | null {
    const said = this.saidNow()
    const key = `${i.id}\n${i.title ?? ''}\n${i.text}`
    let own = this.ownSeen.get(key)
    if (own === undefined) this.ownSeen.set(key, (own = ownIdea({ title: i.title, text: i.text }, said)?.why ?? null))
    return own
  }

  private ownTask(o: { id: string; title: string; why: string }) {
    const said = this.saidNow()
    const key = `o:${o.id}\n${o.title}\n${o.why}`
    const hit = this.ownTasks.get(key)
    if (hit && hit.at === this.said?.at) return hit.v
    const v = ownTask(o, said)
    this.ownTasks.set(key, { at: this.said!.at, v })
    return v
  }
  private ownTasks = new Map<string, { at: number; v: ReturnType<typeof ownTask> }>()

  private bossReply(work: WorkIntent, label?: string): string | undefined {
    if (work.open?.page !== 'session') return
    const messages = this.w.store?.get(work.open.id)?.messages ?? []
    const asked = messages.findIndex(m => m.role === 'user' && m.at >= work.at - 60_000 && (!label || m.text.includes(label)))
    if (asked < 0) return
    const reply = messages.slice(asked + 1).find(m => m.role === 'assistant' && collapse(m.text))
    // Its paragraphs kept: the app shows its first plain sentence or two, the rest is in weevboss's thread.
    return reply ? clip(reply.text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), 1200) : undefined
  }

  async act(id: string, action: string, card?: string, l?: unknown): Promise<void | IntentResult> {
    const result = await this.actRaw(id, action, card, l)
    return result ? { ...result, open: this.appOpen(result.open) } : result
  }

  private async actRaw(id: string, action: string, card?: string, l?: unknown): Promise<void | IntentResult> {
    const key = card ?? id
    const previous = this.actionFlights.get(key)
    if (previous) return previous
    const next = this.actOnce(id, action, card, l)
    this.actionFlights.set(key, next)
    try { return await next } finally { this.actionFlights.delete(key) }
  }

  private async actOnce(id: string, action: string, card?: string, l?: unknown): Promise<void | IntentResult> {
    this.syncIntents()
    const t = withLang(l, () => tr(M))
    if (id === 'proposals') {
      const snap = this.w.snapshot()
      const now = this.now()
      const c = withLang(l, () => this.cards(snap, now)).find((x) => x.id === card)
      if (!c || (action !== 'accept' && action !== 'refuse')) throw new Error(c ? t.noAction : t.cardGone)
      const raw = c.id.slice(2)
      let followed: IntentResult | undefined
      if (c.source === 'optimizer') {
        const job = snap.optimizers?.find(o => o.id === raw)
        const request = job?.talk?.find(m => m.who === 'user')?.text
        const brief = job && (request || `${job.title}. ${job.why}`)
        const existing = request && this.intents.find(request, job?.repo ?? undefined)
        if (action === 'accept' && existing && existing.id !== `auto:${raw}`) {
          this.s.cards[c.id] = this.now()
          this.changed()
          return { intentId: existing.id, existing: true, open: existing.open }
        }
        const o = this.deps.optimizers?.()
        if ((action === 'accept' ? o?.accept(raw) : o?.refuse(raw)) !== true) throw new Error(t.cardGone)
        if (action === 'accept' && job && brief) {
          this.intents.observe({ id: `auto:${raw}`, brief, exact: !!request, scope: job.repo ?? undefined, status: 'requested', at: job.createdAt, open: { page: 'auto', id: raw } })
        }
      } else if (action === 'accept') {
        const input = this.deps.tips?.(snap, now)
        const f = input && withLang(l, () => personalTips(input)).find((x) => x.id === raw)
        if (!input || !f?.action) throw new Error(t.cardGone)
        if (f.action.kind === 'boss') {
          const text = f.action.text
          followed = await this.intents.dispatch(text, undefined, `tip:${raw}`, () => this.w.sendMain(text))
        }
        else await withLang(l, () => actOn(raw, input, { close: (sid) => this.w.close(sid) }))
      }
      this.s.cards[c.id] = this.now()
      this.changed()
      return followed
    }
    const i = this.get(id)
    if (!i) throw new Error(t.notFound)
    const direct = i.actions?.find(a => a.id === action && a.op)
    if (direct) {
      if (i.gone) throw new Error(t.notFound)
      if (!this.deps.op) throw new Error(t.noAction)
      await this.deps.op(direct.op!)
      i.gone = true
      this.changed()
      return
    }
    const rememberedAction = i.actions?.find(a => a.id === action)
    const existing = rememberedAction && this.actionIntent(i, rememberedAction)
    if (existing) return this.intents.dispatch(rememberedAction!.brief, i.projectId, existing.id,
      async () => { throw new Error(t.noAction) }, existing.id)
    if (i.gone) throw new Error(t.notFound)
    if (i.visualProposal && i.sessionId) {
      const choice = i.visualProposal.options.find(o => action === `choice:${o.id}`)
      if (!choice || !this.w.snapshot().sessions.some(s => s.id === i.sessionId && s.controllable)) throw new Error(t.noAction)
      await this.w.send(i.sessionId, `${i.title}\n${choice.label}\n\n${choice.instruction}`)
      i.visualProposal.selected = choice.id
    } else if (i.kind === 'session' && action === 'resume' && i.sessionId) await this.w.resume(i.sessionId)
    else if (i.kind === 'session' && action.startsWith('opt:') && i.sessionId) {
      // An option of a question card: said to the session as the user's answer.
      const session = this.w.snapshot().sessions.find((s) => s.id === i.sessionId)
      if (i.tone !== 'question' || session?.status !== 'needs_user' || clip(collapse(session.attention ?? ''), TEXT_MAX) !== i.text) throw new Error(t.cardGone)
      const [index, version] = action.slice(4).split(':')
      if (version !== questionKey(i)) throw new Error(t.cardGone)
      const label = /^(0|[1-9]\d*)$/.test(index) ? i.q?.options?.[Number(index)] : undefined
      if (!label) throw new Error(t.noAction)
      await this.w.send(i.sessionId, label)
    } else {
      const a = i.actions?.find((x) => x.id === action)
      if (!a) throw new Error(t.noAction)
      const result = await this.intents.dispatch(a.brief, i.projectId, `card:${i.id}:${a.id}`,
        () => this.w.sendMain(t.go(a.label), t.actBrief(clip(collapse(i.text), 300), a.brief)), a.sourceIntentId)
      a.sourceIntentId = result.intentId
      a.tapped = true
      // Keep the original record and expose the existing conversation on refresh.
      this.changed()
      return result
    }
    i.gone = true
    this.changed()
  }

  /** Words typed under an item: to its session, to weevboss (with the post as a hidden note), or by mail to its author. */
  async reply(id: string, text: unknown, l?: unknown): Promise<void> {
    const t = withLang(l, () => tr(M))
    const body = typeof text === 'string' ? text.trim() : ''
    if (!body) throw new Error(t.emptyText)
    const i = this.get(id)
    if (!i || i.gone) throw new Error(t.notFound)
    if (i.kind === 'mail') {
      const out = this.deps.mail?.()
      if (!out || !i.mail?.address) throw new Error(t.mailOff)
      const sent = await out.write({ to: i.mail.address, subject: i.mail.subject, text: body, inReplyTo: i.mail.mid, author: i.who, target: i.mail.target })
      if (!sent) throw new Error(t.noReply)
    } else if (i.reply === 'session' && i.sessionId) await this.w.send(i.sessionId, body)
    else if (i.reply === 'boss') await this.w.sendMain(body, t.replyBrief(clip(collapse(i.text || i.title || ''), 400)))
    else throw new Error(t.noReply)
    i.seen = true
    const rendered = this.view({ ...i, gone: false }, this.w.snapshot(), true)
    if (rendered && isRequestNotice(rendered)) this.dismiss(i.id, feedNoticeKey(rendered))
    else this.changed()
  }

  /** « Learn more »: the longer answer, kept in the item. Written by the curator; until it exists, only what is kept. */
  async more(id: string, l?: unknown): Promise<string> {
    const t = withLang(l, () => tr(M))
    const i = this.get(id)
    if (!i || i.gone) throw new Error(t.notFound)
    if (i.moreText) return humanFeedText(i.moreText)
    const item = i.more && this.curator ? this.view(i, this.w.snapshot(), true) : null
    if (!item) throw new Error(t.noMore)
    const text = humanFeedText(await this.curator!.more(item))
    if (!text) throw new Error(t.noMore)
    i.moreText = text.slice(0, MAIL_BODY_MAX)
    this.changed()
    return i.moreText
  }
}

// ---------------------------------------------------------------- routes

/**
 * GET /api/foryou[?lang=] → ForYouFeed · POST /api/foryou/seen { ids } · POST /api/foryou/:id/dismiss ·
 * POST /api/foryou/:id/act { action, card? } · POST /api/foryou/:id/reply { text } · POST /api/foryou/:id/more → { text } ·
 * POST /api/foryou/post { text, actions?, from?, evidence? } and POST /api/foryou/media { path, caption?, cwd?, from?,
 * evidence? } (evidence: { demonstrated?, verified?, limits? }, shared/evidence.ts): from this
 * machine only (weevils post / show) · GET /api/foryou/media/:id → the bytes (the router already checked the cookie).
 */
export function foryouRoutes(fy: ForYou, json: Json, readBody: ReadBody): [string, RegExp, Handler][] {
  const id = (raw: string) => {
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }
  const langOf = (url: URL) => (isLang(url.searchParams.get('lang')) ? url.searchParams.get('lang') : undefined)
  /** A refusal is a 400 with its short reason; an item that is not there, a 404. */
  const run = async (res: http.ServerResponse, known: boolean, fn: () => Promise<unknown> | unknown) => {
    if (!known) return json(res, 404, { error: tr(M).notFound })
    try {
      json(res, 200, (await fn()) ?? { ok: true })
    } catch (e) {
      if (e instanceof OutboxError) throw e
      json(res, 400, { error: (e as Error).message })
    }
  }
  const exists = (itemId: string) => fy.has(itemId)
  return [
    ['GET', /^\/api\/foryou$/, async (_req, res, url) => {
      await fy.refreshSoftware()
      json(res, 200, fy.feed(undefined, langOf(url)))
    }],
    ['POST', /^\/api\/foryou\/seen$/, async (req, res) => {
      fy.seen((await readBody(req))?.ids)
      json(res, 200, { ok: true })
    }],
    // weevboss and the sessions of this machine (weevils post / show): never the phone, whatever « from » it claims.
    ['POST', /^\/api\/foryou\/post$/, async (req, res) => {
      const b = await readBody(req)
      if (!isLocal(req)) return json(res, 403, { error: tr(M).localOnly })
      await run(res, true, () => ({ item: fy.post(b?.text, b?.actions, trustedFrom(req, b), b?.evidence) }))
    }],
    ['GET', /^\/api\/foryou\/formats$/, (_req, res, url) => json(res, 200, { proposal: fy.visualExample(langOf(url)) })],
    ['POST', /^\/api\/foryou\/composition$/, async (req, res) => {
      const b = await readBody(req)
      if (!isLocal(req)) return json(res, 403, { error: tr(M).localOnly })
      await run(res, true, () => ({ item: fy.publishComposition(b) }))
    }],
    ['POST', /^\/api\/foryou\/visual-proposal$/, async (req, res) => {
      const b = await readBody(req)
      if (!isLocal(req)) return json(res, 403, { error: tr(M).localOnly })
      await run(res, true, () => ({ item: fy.publishVisualProposal(b) }))
    }],
    ['POST', /^\/api\/foryou\/media$/, async (req, res) => {
      const b = await readBody(req)
      if (!isLocal(req)) return json(res, 403, { error: tr(M).localOnly })
      await run(res, true, () => ({ item: fy.addMedia({ path: b?.path, caption: b?.caption, cwd: b?.cwd, from: trustedFrom(req, b), evidence: b?.evidence }) }))
    }],
    // GET and HEAD (a player may ask for the size first): the router matches the method exactly.
    ...(['GET', 'HEAD'] as const).map((method): [string, RegExp, Handler] => [method, /^\/api\/foryou\/media\/([\w-]+)$/, (req, res, u, [mid]) => {
      if (!fy.shelf) return json(res, 404, { error: tr(M).noMedia })
      fy.shelf.serve(req, res, mid, u.searchParams.get('download') === '1')
    }]),
    ['POST', /^\/api\/foryou\/([^/]+)\/dismiss$/, async (req, res, _u, [raw]) => {
      const b = await readBody(req)
      const ok = fy.dismiss(id(raw), typeof b?.eventId === 'string' ? b.eventId : undefined)
      json(res, ok ? 200 : 404, ok ? { ok } : { error: tr(M).notFound })
    }],
    ['POST', /^\/api\/foryou\/([^/]+)\/act$/, async (req, res, url, [raw]) => {
      const b = await readBody(req)
      await run(res, exists(id(raw)), () => fy.act(id(raw), String(b?.action ?? ''), typeof b?.card === 'string' ? b.card : undefined, langOf(url)))
    }],
    ['POST', /^\/api\/foryou\/([^/]+)\/reply$/, async (req, res, url, [raw]) => {
      const b = await readBody(req)
      await run(res, exists(id(raw)), () => fy.reply(id(raw), b?.text, langOf(url)))
    }],
    ['POST', /^\/api\/foryou\/([^/]+)\/more$/, async (_req, res, url, [raw]) => {
      await run(res, exists(id(raw)), async () => ({ text: await fy.more(id(raw), langOf(url)) }))
    }],
  ]
}
