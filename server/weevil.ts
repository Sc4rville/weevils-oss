// The weevil's questions are gone: the panel that slid up from the bottom of the app with a question nobody asked for
// was removed (the user found it useless). The memory is fed by what the user tells weevboss and writes on the memory
// page. These routes stay only so an app still open from before (an old cached build) gets a calm « nothing » instead
// of an error: never a question, never a model call.

import type http from 'node:http'

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL, params: string[]) => Promise<void> | void
type Json = (res: http.ServerResponse, status: number, body: unknown) => void

/** GET /api/weevil → { question: null } · POST /api/weevil/:id/missed · POST /api/weevil/:id/answer → an empty, closed reply. */
export function weevilRoutes(json: Json): [string, RegExp, Handler][] {
  return [
    ['GET', /^\/api\/weevil$/, (_req, res) => json(res, 200, { question: null })],
    ['POST', /^\/api\/weevil\/([\w-]+)\/missed$/, (_req, res) => json(res, 200, { ok: true })],
    ['POST', /^\/api\/weevil\/([\w-]+)\/answer$/, (_req, res) => json(res, 200, { reply: '', learned: [], done: true })],
  ]
}
