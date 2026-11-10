// Personalized tips: small cards built by rules from the real state (sessions, machines, conversations, config).
// The app asks GET /api/tips when the user sits idle on the feed, picks at most one card it has never shown,
// and POST /api/tips/act { id } runs a server-side action (e.g. close the idle sessions).
// Each weevilsd samples its own load every minute (24 h kept in DATA_DIR/tips-state.json, GET /api/tips/load);
// the main machine merges the samples of the remote machines that expose them.

import crypto from 'node:crypto'
import fs from 'node:fs'
import type http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { Session, Snapshot } from '../shared/api.ts'
import type { LoadSample, MachineLoad, TipCard } from '../shared/tips.ts'
import { DATA_DIR, KILL_AFTER_MS, MACHINE } from './config.ts'
import type { Weevils } from './core.ts'
import { tr, withLang } from './i18n.ts'
import M from './i18n/tips.ts'

/** One load sample per minute, 24 h kept. */
export const SAMPLE_MS = 60_000
export const KEEP_MS = 24 * 3600_000
/** Below twelve hours of samples, no verdict on a machine (one long build on a fresh install is not "often"). */
export const MIN_SAMPLES = 12 * 60
/** A sample is saturated above LOAD_FACTOR × cores, or under FREE_MIN of available memory. */
export const LOAD_FACTOR = 1.5
export const FREE_MIN = 0.1
/** Often saturated: more than this share of the samples. */
export const SATURATED_SHARE = 0.2
/** A live session idle for longer than this is worth closing. */
export const IDLE_SESSION_MS = 12 * 3600_000
/** A session waiting for the user longer than this deserves a nudge. */
export const WAITING_MS = 30 * 60_000
/** Remote load histories are refetched at most this often. */
const REMOTE_LOAD_TTL = 5 * 60_000

export interface TipInput {
  snap: Snapshot
  now: number
  loads: MachineLoad[]
  /** Dictation is configured (OPENAI_API_KEY). */
  dictation: boolean
  /** weevilsd already closes a weevils pane idle for this long (WEEVILS_KILL_AFTER_MIN, 2 h by default). */
  reapMs: number
}

/** A card plus what its action needs (never sent to the app). */
export interface Found extends TipCard {
  data?: string[]
}

export interface TipCtx {
  close: (id: string) => Promise<unknown>
}

interface Rule {
  rule: string
  check: (i: TipInput) => Found[]
  /** Server-side action; returns the confirmation shown on the card. */
  act?: (f: Found, ctx: TipCtx) => Promise<string>
}

const short = (s: string) => crypto.createHash('sha1').update(s).digest('base64url').slice(0, 10)
const clip = (s: string, n = 32) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)
const HOUR = 3600_000

/** Share of saturated samples over the last 24 h and the hours the samples cover, or null with too few samples. */
export function saturation(m: MachineLoad, now: number): { share: number; hours: number } | null {
  const recent = m.samples.filter(([at]) => now - at <= KEEP_MS)
  if (recent.length < MIN_SAMPLES) return null
  const hot = recent.filter(([, load, free]) => load > LOAD_FACTOR * Math.max(1, m.cores) || free < FREE_MIN).length
  const oldest = recent.reduce((a, [at]) => Math.min(a, at), now)
  return { share: hot / recent.length, hours: Math.max(1, Math.round((now - oldest) / HOUR)) }
}

const idleSessions = (snap: Snapshot, now: number): Session[] =>
  snap.sessions.filter((s) => s.live && s.hasScreen && s.controllable && (s.status === 'idle' || s.status === 'done') && now - s.lastActivityAt > IDLE_SESSION_MS)

/**
 * Live sessions weevils doesn't drive (opened in a terminal of their own) and quiet for over 12 h. The automatic
 * cleanup never touches them and weevils can't close them: their process is alive (its hook pid answers), that's all.
 */
const idleUnmanaged = (snap: Snapshot, now: number): Session[] =>
  snap.sessions.filter((s) => s.live && !s.controllable && s.status === 'idle' && now - s.lastActivityAt > IDLE_SESSION_MS)

const beforeToday = (list: Session[], now: number) => {
  const midnight = new Date(now).setHours(0, 0, 0, 0)
  return list.every((s) => s.lastActivityAt < midnight)
}

const since = (ms: number) => {
  const t = tr(M)
  const min = Math.round(ms / 60_000)
  return min < 60 ? t.minutes(min) : t.hours(Math.round(min / 60))
}

/** The rules, in order of importance. Each one only speaks when its situation is true. */
export const RULES: Rule[] = [
  {
    rule: 'waiting',
    check: ({ snap, now }) => {
      const s = snap.sessions.filter((x) => x.status === 'needs_user' && now - x.lastActivityAt > WAITING_MS).sort((a, b) => a.lastActivityAt - b.lastActivityAt)[0]
      if (!s) return []
      const t = tr(M)
      return [{ id: `waiting:${s.id}:${s.lastActivityAt}`, rule: 'waiting', personal: true, text: t.waiting(clip(s.title), since(now - s.lastActivityAt)), accept: t.openIt, action: { kind: 'open', page: 'session', id: s.id } }]
    },
  },
  {
    rule: 'idle-sessions',
    // weevils panes: weevilsd closes them itself after WEEVILS_KILL_AFTER_MIN (2 h by default), so this card only
    // speaks when that cleanup was set later than 12 h (otherwise those panes are already gone).
    check: ({ snap, now, reapMs }) => {
      if (reapMs <= IDLE_SESSION_MS) return []
      const list = idleSessions(snap, now)
      if (!list.length) return []
      const ids = list.map((s) => s.id).sort()
      const t = tr(M)
      return [{ id: `idle-sessions:${short(ids.join('|'))}`, rule: 'idle-sessions', personal: true, text: t.idleSessions(list.length, beforeToday(list, now)), accept: t.closeThem(list.length), action: { kind: 'server' }, data: ids }]
    },
    act: async (f, ctx) => {
      const t = tr(M) // before the first await: withLang only covers the synchronous part
      let n = 0
      for (const id of f.data ?? []) {
        try {
          await ctx.close(id)
          n++
        } catch (e) {
          console.error(`[tips] fermeture de ${id} : ${(e as Error).message}`)
        }
      }
      if (!n) throw new Error(t.gone)
      return t.closed(n)
    },
  },
  {
    rule: 'idle-unmanaged',
    // Sessions left open in a terminal weevils doesn't drive: the cleanup can't reach them and weevils can't close
    // them. The card says so and hands the list to weevboss, who has a shell, to find out and ask before closing.
    check: ({ snap, now }) => {
      const list = idleUnmanaged(snap, now).sort((a, b) => a.lastActivityAt - b.lastActivityAt)
      if (!list.length) return []
      const t = tr(M)
      const lines = list.slice(0, 8).map((s) => t.unmanagedLine(clip(s.title, 48), s.machineId, s.cwd, s.id, since(now - s.lastActivityAt)))
      const ids = list.map((s) => s.id).sort()
      return [{ id: `idle-unmanaged:${short(ids.join('|'))}`, rule: 'idle-unmanaged', personal: true, text: t.idleUnmanaged(list.length, beforeToday(list, now)), accept: t.askBoss, action: { kind: 'boss', text: t.idleUnmanagedAsk(list.length, lines.join('\n')) } }]
    },
  },
  {
    rule: 'saturated',
    check: ({ loads, now }) =>
      loads.flatMap((m) => {
        const sat = saturation(m, now)
        if (!sat || sat.share <= SATURATED_SHARE) return []
        const t = tr(M)
        // Once per machine: never the same card twice.
        return [{ id: `saturated:${m.machineId}`, rule: 'saturated', personal: true, text: t.saturated(m.name), accept: t.askBoss, action: { kind: 'boss', text: t.saturatedAsk(m.name, Math.round(sat.share * 100), sat.hours) } } satisfies Found]
      }),
  },
  {
    rule: 'unsorted',
    check: ({ snap }) => {
      const n = snap.conversationCounts.pending
      if (!n) return []
      const t = tr(M)
      // Same card while the pile stays in the same bucket of ten.
      return [{ id: `unsorted:${Math.ceil(n / 10)}`, rule: 'unsorted', personal: true, text: t.unsorted(n), accept: t.sortThem, action: { kind: 'open', page: 'conversations' } }]
    },
  },
  {
    rule: 'one-machine',
    // Only once the first machine is really used.
    check: ({ snap }) => {
      if (snap.machines.length !== 1 || snap.sessions.length === 0) return []
      const t = tr(M)
      return [{ id: 'one-machine', rule: 'one-machine', personal: true, text: t.oneMachine, accept: t.addMachine, action: { kind: 'intro' } }]
    },
  },
  {
    rule: 'no-dictation',
    check: ({ dictation }) => (dictation ? [] : [{ id: 'no-dictation', rule: 'no-dictation', personal: true, text: tr(M).noDictation }]),
  },
]

export function personalTips(i: TipInput): Found[] {
  return RULES.flatMap((r) => r.check(i))
}

/** Runs the server-side action of a card that still applies. */
export async function actOn(id: string, i: TipInput, ctx: TipCtx): Promise<string> {
  for (const r of RULES) {
    const f = r.check(i).find((x) => x.id === id)
    if (f && r.act) return r.act(f, ctx)
  }
  throw new Error(tr(M).gone)
}

/** Strips what the app doesn't need. */
export const toCard = ({ data: _data, ...card }: Found): TipCard => card

// ---------------------------------------------------------------- load sampling

const STATE_FILE = path.join(DATA_DIR, 'tips-state.json')

export class LoadSampler {
  samples: LoadSample[] = []
  private file: string

  constructor(file = STATE_FILE) {
    this.file = file
    try {
      const s = JSON.parse(fs.readFileSync(file, 'utf8')) as { samples?: LoadSample[] }
      if (Array.isArray(s.samples)) this.samples = s.samples.filter((x) => Array.isArray(x) && x.length === 3)
    } catch {
      /* first run */
    }
  }

  sample(now = Date.now()) {
    const total = os.totalmem()
    this.samples.push([now, Math.round(os.loadavg()[0] * 100) / 100, total ? Math.round((os.freemem() / total) * 1000) / 1000 : 1])
    this.samples = this.samples.filter(([at]) => now - at <= KEEP_MS)
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify({ samples: this.samples }))
    } catch {
      /* kept in memory */
    }
  }

  start() {
    setInterval(() => this.sample(), SAMPLE_MS).unref()
  }

  local(): MachineLoad {
    return { machineId: MACHINE.id, name: MACHINE.name, cores: os.availableParallelism?.() || os.cpus().length || 1, samples: this.samples }
  }
}

// ---------------------------------------------------------------- routes

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL, params: string[]) => Promise<void> | void
type Json = (res: http.ServerResponse, status: number, body: unknown) => void
type ReadBody = (req: http.IncomingMessage) => Promise<any>

/** GET /api/tips, POST /api/tips/act, GET /api/tips/load. */
export function tipRoutes(w: Weevils, json: Json, readBody: ReadBody, dictation: () => boolean): [string, RegExp, Handler][] {
  const sampler = new LoadSampler()
  sampler.start()
  const remoteLoads = new Map<string, { at: number; load: MachineLoad | null }>()

  const loads = async (): Promise<MachineLoad[]> => {
    const now = Date.now()
    const out = [sampler.local()]
    await Promise.all(
      w.remotes
        .filter((r) => r.online)
        .map(async (r) => {
          const c = remoteLoads.get(r.id)
          if (c && now - c.at < REMOTE_LOAD_TTL) return c.load && out.push(c.load)
          // An older weevilsd without sampling: local only for that machine.
          const load = await r.call<MachineLoad>('GET', '/api/tips/load').catch(() => null)
          remoteLoads.set(r.id, { at: now, load })
          if (load) out.push(load)
        }),
    )
    return out
  }
  const input = async (): Promise<TipInput> => ({ snap: w.snapshot(), now: Date.now(), loads: await loads(), dictation: dictation(), reapMs: KILL_AFTER_MS })

  return [
    // ?lang= : the app's language, so the cards match the screen even when the server writes in another one.
    ['GET', /^\/api\/tips$/, async (_req, res, url) => {
      const i = await input()
      json(res, 200, { tips: withLang(url.searchParams.get('lang'), () => personalTips(i).map(toCard)) })
    }],
    ['POST', /^\/api\/tips\/act$/, async (req, res, url) => {
      const body = await readBody(req)
      const i = await input()
      json(res, 200, { done: await withLang(url.searchParams.get('lang'), () => actOn(String(body.id ?? ''), i, { close: (id) => w.close(id) })) })
    }],
    ['GET', /^\/api\/tips\/load$/, (_req, res) => json(res, 200, sampler.local())],
  ]
}
