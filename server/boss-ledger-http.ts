// The request ledger over HTTP (server/boss-ledger.ts): the `weevils asks|ask|goals|goal|trace|mem` commands and the
// app's « requests » page. A change from the machine is weevboss's; one from the phone is the user's own.
//
//   GET  /api/boss/ledger                 everything the page shows
//   GET  /api/boss/asks?filter=open|all|stale|done
//   POST /api/boss/asks                   { text, goal? }                       → { ask }
//   POST /api/boss/asks/:id               { action: done|drop|open|link|goal, note?, session?, expect?, goal? } → { ask }
//   GET  /api/boss/goals · POST /api/boss/goals { id, title, why? } · POST /api/boss/goals/:id { action: note|done|pause|open, text? }
//   GET  /api/boss/trace?goal=&n=  · POST /api/boss/trace { text, goal?, why? }
//   GET  /api/boss/mem?q=  · POST /api/boss/mem { kind, text } · DELETE /api/boss/mem/:id
//   POST /api/boss/ledger/backfill { hours }   (the machine only)

import type http from 'node:http'
import type { Ledger } from './boss-ledger.ts'
import { looksSecret } from './memory.ts'
import { tr } from './i18n.ts'
import M from './i18n/ledger.ts'

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL, params: string[]) => Promise<void> | void
type Json = (res: http.ServerResponse, status: number, body: unknown) => void
type ReadBody = (req: http.IncomingMessage) => Promise<any>

const text = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim()

export function ledgerRoutes(ledger: Ledger, json: Json, readBody: ReadBody, isLocal: (req: http.IncomingMessage) => boolean): [string, RegExp, Handler][] {
  const by = (req: http.IncomingMessage) => (isLocal(req) ? 'weevboss' : 'user') as 'weevboss' | 'user'
  return [
    ['GET', /^\/api\/boss\/ledger$/, (_req, res) => json(res, 200, ledger.view())],
    ['GET', /^\/api\/boss\/asks$/, (_req, res, url) => {
      const f = url.searchParams.get('filter')
      const filter = f === 'all' || f === 'stale' || f === 'done' ? f : 'open'
      json(res, 200, { asks: ledger.asks(filter).map((a) => ({ ...a, stale: ledger.stale(a) })), pending: ledger.pending.length, digestTokens: Math.ceil(ledger.digest().length / 3.2) })
    }],
    ['POST', /^\/api\/boss\/asks$/, async (req, res) => {
      const b = await readBody(req)
      if (!text(b.text)) return json(res, 400, { error: tr(M).empty })
      json(res, 200, { ask: ledger.add(text(b.text), { goal: b.goal ? text(b.goal) : undefined, from: by(req) === 'user' ? 'user' : 'weevboss' }) })
    }],
    ['POST', /^\/api\/boss\/asks\/([^/]+)$/, async (req, res, _u, [raw]) => {
      const id = decodeURIComponent(raw)
      if (!ledger.ask(id)) return json(res, 404, { error: tr(M).noRequest })
      const b = await readBody(req)
      const note = b.note ? text(b.note) : undefined
      switch (b.action) {
        case 'done': return json(res, 200, { ask: ledger.setStatus(id, 'done', by(req), note) }) // i18n-ignore : status ids
        case 'drop': return json(res, 200, { ask: ledger.setStatus(id, 'dropped', by(req), note) }) // i18n-ignore : status ids
        case 'open': return json(res, 200, { ask: ledger.setStatus(id, 'open', by(req), note) }) // i18n-ignore : status ids
        case 'link':
          if (!text(b.session)) return json(res, 400, { error: tr(M).empty })
          return json(res, 200, { ask: ledger.link(id, text(b.session), b.expect ? text(b.expect) : undefined) })
        case 'goal':
          if (!ledger.goal(text(b.goal))) return json(res, 404, { error: tr(M).noGoal })
          return json(res, 200, { ask: ledger.setGoalOf(id, text(b.goal)) })
        default: return json(res, 400, { error: tr(M).badAction })
      }
    }],
    ['GET', /^\/api\/boss\/goals$/, (_req, res, url) => {
      const all = url.searchParams.get('all') === '1'
      json(res, 200, { goals: ledger.goals(all).map((g) => ({ ...g, ...ledger.goalStats(g.id) })) })
    }],
    ['POST', /^\/api\/boss\/goals$/, async (req, res) => {
      const b = await readBody(req)
      if (!text(b.id) || !text(b.title)) return json(res, 400, { error: tr(M).empty })
      json(res, 200, { goal: ledger.addGoal(text(b.id), text(b.title), b.why ? text(b.why) : undefined) })
    }],
    ['POST', /^\/api\/boss\/goals\/([^/]+)$/, async (req, res, _u, [raw]) => {
      const id = decodeURIComponent(raw)
      if (!ledger.goal(id)) return json(res, 404, { error: tr(M).noGoal })
      const b = await readBody(req)
      switch (b.action) {
        case 'note':
          if (!text(b.text)) return json(res, 400, { error: tr(M).empty })
          return json(res, 200, { goal: ledger.goalNote(id, text(b.text)) })
        case 'done': return json(res, 200, { goal: ledger.setGoalStatus(id, 'done') })
        case 'pause': return json(res, 200, { goal: ledger.setGoalStatus(id, 'paused') })
        case 'open': return json(res, 200, { goal: ledger.setGoalStatus(id, 'active') })
        default: return json(res, 400, { error: tr(M).badAction })
      }
    }],
    ['GET', /^\/api\/boss\/trace$/, (_req, res, url) => {
      const goal = url.searchParams.get('goal') || undefined
      const n = Math.max(1, Math.min(500, Number(url.searchParams.get('n') ?? 30) || 30))
      json(res, 200, { trace: ledger.traceList({ goal, n }) })
    }],
    ['POST', /^\/api\/boss\/trace$/, async (req, res) => {
      const b = await readBody(req)
      if (!text(b.text)) return json(res, 400, { error: tr(M).empty })
      ledger.decide(text(b.text), b.goal ? text(b.goal) : undefined, b.why ? text(b.why) : undefined)
      json(res, 200, { ok: true })
    }],
    ['GET', /^\/api\/boss\/mem$/, (_req, res, url) => {
      const q = url.searchParams.get('q')
      json(res, 200, q ? ledger.search(q) : { knowledge: ledger.knowledge() })
    }],
    ['POST', /^\/api\/boss\/mem$/, async (req, res) => {
      const b = await readBody(req)
      const t = text(b.text)
      if (!t) return json(res, 400, { error: tr(M).empty })
      if (looksSecret(t)) return json(res, 400, { error: tr(M).secret })
      const kind = b.kind === 'rule' || b.kind === 'decision' ? b.kind : 'fact'
      json(res, 200, { item: ledger.remember(kind, t, b.src ? text(b.src) : undefined) })
    }],
    ['DELETE', /^\/api\/boss\/mem\/([^/]+)$/, (_req, res, _u, [raw]) => {
      if (!ledger.forget(decodeURIComponent(raw))) return json(res, 404, { error: tr(M).noMemory })
      json(res, 200, { ok: true })
    }],
    ['POST', /^\/api\/boss\/ledger\/backfill$/, async (req, res) => {
      if (!isLocal(req)) return json(res, 403, { error: tr(M).badAction })
      const b = await readBody(req)
      const hours = Math.max(1, Math.min(24 * 14, Number(b.hours ?? 24) || 24))
      json(res, 200, await ledger.backfill(hours))
    }],
  ]
}
