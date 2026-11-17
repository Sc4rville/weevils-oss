// Who may speak as the user into weevboss's thread: his messages, his live voice, his taps that speak for him (a For
// you action, a reply, an explanation). Only a browser signed in with the access code (server/http.ts userVoice).
// Loopback stays trusted for everything else, but a script, curl or an automated browser on this machine never
// speaks as the user: on 2026-11-14 a live-voice test played recorded questions to weevboss through the live
// instance, and they reached it as if the user had asked them. An agent or the weevils command still writes there,
// signed with its name (trustedFrom). A test copy (scripts/test-copy.sh) sets WEEVILS_ALLOW_LOCAL_VOICE=1 so its own
// scripts can drive its own weevboss. No side effect: server/boss-door.test.ts.
import type http from 'node:http'
import { signAs } from './authors.ts'
import type { BossOrigin } from './boss-origins.ts'
import { automated, isLocal, trustedFrom, trustedSource, userVoice } from './http.ts'
import { isReplay } from './outbox-http.ts'
import { OutboxError } from './outbox.ts'

/** Doors into weevboss's thread; a session id counts when it is one of weevboss's conversations. */
const BOSS_DOOR = /^\/api\/(?:main(?:\/attach)?|sessions\/([^/]+)\/(?:send|attach))$/
/** Doors that sign the text with a trusted author (the others would deliver it unsigned, as the user's). */
const SIGNED_DOOR = /^\/api\/(?:main(?:\/attach)?|sessions\/[^/]+\/send)$/
/** Taps that speak for the user (a For you action, a reply, an explanation): the app only. */
const USER_TAP = /^\/api\/(?:foryou\/[^/]+\/(?:act|reply)|explain)$/
/** Siri's turn (spoken straight to weevboss) and the token that opens it: the shortcut's token or the app, any method. */
const VOICE_DOOR = /^\/api\/voice\/(?:turn|shortcut)$/

export interface BossDoorDeps {
  /** The request's cookie names a known device. */
  hasDevice(req: http.IncomingMessage): boolean
  /** A message to this session id lands in weevboss's thread. */
  isBossTarget(id: string): boolean
  sourceAuthor(id: string): string | undefined
  /** The refusal, in the reader's language. */
  refusal(): string
  /** WEEVILS_ALLOW_LOCAL_VOICE=1: a test copy. Read on each request. */
  allowLocal?(): boolean
}

export function bossDoor(d: BossDoorDeps) {
  const allowLocal = () => d.allowLocal?.() ?? process.env.WEEVILS_ALLOW_LOCAL_VOICE === '1'
  /** A replay of the outbox was checked when its intent was accepted, on the original request. */
  const speaksForUser = (req: http.IncomingMessage) => isReplay(req) || allowLocal() || userVoice(req, d.hasDevice(req))
  const signedBy = (req: http.IncomingMessage, body: any) => (String(body?.text ?? '').trim() ? trustedFrom(req, body, d.sourceAuthor) : undefined)
  return {
    speaksForUser,
    /** Throws a 403 when this POST would put words in the user's mouth in weevboss's thread. */
    guard(req: http.IncomingMessage, pathname: string, body: any) {
      const m = BOSS_DOOR.exec(pathname)
      if (!m || (m[1] !== undefined && !d.isBossTarget(decodeURIComponent(m[1])))) return
      if (SIGNED_DOOR.test(pathname) && signedBy(req, body)) return
      if (!speaksForUser(req)) throw new OutboxError(403, d.refusal())
    },
    /** A tap that speaks for the user (checked before the body is read, and before the outbox accepts it). */
    tapAllowed: (req: http.IncomingMessage, method: string | undefined, pathname: string) => method !== 'POST' || !USER_TAP.test(pathname) || speaksForUser(req),
    /** Siri's door: with the shortcut's own token (viaShortcut), or from the app. A script on this machine could
     * otherwise read the token, or post a turn with no token at all, and speak to weevboss as the user. */
    voiceAllowed: (req: http.IncomingMessage, pathname: string, viaShortcut: boolean) => !VOICE_DOOR.test(pathname) || viaShortcut || speaksForUser(req),
    /** The text as weevboss reads it: signed when a trusted author sent it, also when the outbox replays it. */
    text(req: http.IncomingMessage, body: any): { text: string; origin: BossOrigin } {
      const text = String(body?.text ?? '').trim()
      const from = signedBy(req, body)
      return from ? { text: signAs(from, text, trustedSource(req, body, d.sourceAuthor)), origin: 'server' } : { text, origin: 'device' }
    },
    /** The live voice websocket: a signed-in browser; in a test copy, anything this machine trusts. */
    liveAllowed: (req: http.IncomingMessage, authed: boolean) => (allowLocal() ? authed : userVoice(req, d.hasDevice(req))),
    /** A real browser on this machine, opened without the login link, may become a device: never a script (no browser
     * user agent) nor an automated or headless browser. */
    localClaimAllowed: (req: http.IncomingMessage) => isLocal(req) && !automated(req) && /^Mozilla\//.test(String(req.headers['user-agent'] ?? '')),
  }
}
