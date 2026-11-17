// Where each message the user sends to weevboss came from: 'device' (typed or dictated in the app, a signed-in browser),
// 'live' (live voice) or 'server' (weevilsd on his behalf: a For you tap, Siri, setup, a signed agent post). One line
// per message in boss/origins.jsonl, read back by the journal
// (server/boss-view.ts) so each user entry says who sent it. An audit trail only: never shown in the app.
// Why: on 2026-11-14 scripted questions reached weevboss as the user's, and nothing said where they came from.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export type BossOrigin = 'device' | 'live' | 'server'
export interface OriginRecord { at: number; origin: BossOrigin; key: string }

export const ORIGINS_FILE = 'origins.jsonl'
/** A message reaches the transcript after it was sent: a turn may wait for the one before it. */
const WINDOW_MS = 30 * 60_000
/** The transcript's timestamp can be a little earlier than ours (two clocks, two writers). */
const SKEW_MS = 60_000

/** The same message, as sent and as read back from the transcript: spaces collapsed, its start only. */
export const originKey = (text: string) => crypto.createHash('sha1').update(text.replace(/\s+/g, ' ').trim().slice(0, 400)).digest('hex').slice(0, 16)

export function recordOrigin(dir: string, text: string, origin: BossOrigin, at = Date.now()) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, ORIGINS_FILE), JSON.stringify({ at, origin, key: originKey(text) } satisfies OriginRecord) + '\n')
  } catch { /* an audit line never blocks a message */ }
}

export function readOrigins(dir: string): OriginRecord[] {
  let raw = ''
  try { raw = fs.readFileSync(path.join(dir, ORIGINS_FILE), 'utf8') } catch { return [] }
  const out: OriginRecord[] = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    try {
      const r = JSON.parse(line)
      if (typeof r?.at === 'number' && typeof r.origin === 'string' && typeof r.key === 'string') out.push(r)
    } catch { /* a torn last line */ }
  }
  return out
}

/** The origin of a user entry read from the transcript: the closest record of the same text sent shortly before. Each
 * record is used once (`used`), so the same words sent twice get their own origins. */
export function originOf(records: OriginRecord[], text: string, at: number, used: Set<string>): BossOrigin | undefined {
  const key = originKey(text)
  let best: OriginRecord | undefined
  for (const r of records) {
    if (r.key !== key || used.has(`${r.at}:${r.key}`) || r.at > at + SKEW_MS || r.at < at - WINDOW_MS) continue
    if (!best || Math.abs(at - r.at) < Math.abs(at - best.at)) best = r
  }
  if (best) used.add(`${best.at}:${best.key}`)
  return best?.origin
}
