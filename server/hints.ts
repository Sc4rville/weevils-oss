// First-tap hints: the app shows a short bubble the first time someone taps an element (the voice logo, the star,
// a project's +…). Which ones were already seen lives here, on the main weevilsd, so every device of the
// user shares it and a phone change does not replay them. DATA_DIR/hints.json.
//
// Also the install id (DATA_DIR/install-id): a random id born with the data directory. The app keeps it on the
// device; when it changes (the server was reinstalled or reset from scratch), the device forgets what it kept about
// the old one (onboarding done, theme, devil mode…), so a blank server really looks blank.

import crypto from 'node:crypto'
import fs from 'node:fs'
import type http from 'node:http'
import path from 'node:path'

/** At most this many ids kept (the catalog is a few dozen; ids are short). */
const MAX = 200
const ID = /^[A-Za-z][A-Za-z0-9-]{0,39}$/

export interface HintsState {
  seen: string[]
  /** False until the app first wrote: an older device then knows the hints arrived after it was set up. */
  touched: boolean
}

export class Hints {
  private file: string
  private idFile: string
  private state: HintsState | null = null
  readonly install: string

  constructor(dir: string) {
    this.file = path.join(dir, 'hints.json')
    this.idFile = path.join(dir, 'install-id')
    this.install = this.readInstall(dir)
  }

  private readInstall(dir: string): string {
    try {
      const id = fs.readFileSync(this.idFile, 'utf8').trim()
      if (id) return id
    } catch {
      /* first launch */
    }
    const id = crypto.randomBytes(8).toString('base64url')
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(this.idFile, id + '\n')
    } catch {
      /* read-only: a new id each launch, the devices just keep their state */
    }
    return id
  }

  get(): HintsState {
    if (this.state) return this.state
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<HintsState>
      this.state = { seen: Array.isArray(raw.seen) ? raw.seen.filter((s) => typeof s === 'string' && ID.test(s)) : [], touched: raw.touched !== false }
    } catch {
      this.state = { seen: [], touched: false }
    }
    return this.state
  }

  /** Adds seen ids (unknown shapes ignored); `reset` forgets them all first. */
  mark(ids: unknown, reset = false): HintsState {
    const cur = this.get()
    const add = Array.isArray(ids) ? ids.filter((s): s is string => typeof s === 'string' && ID.test(s)) : []
    const seen = [...new Set([...(reset ? [] : cur.seen), ...add])].slice(-MAX)
    this.state = { seen, touched: true }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify(this.state))
    } catch {
      /* kept in memory */
    }
    return this.state
  }
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL, params: string[]) => Promise<void> | void
type Json = (res: http.ServerResponse, status: number, body: unknown) => void
type ReadBody = (req: http.IncomingMessage) => Promise<any>

/** GET /api/hints → { seen, touched, install } · POST /api/hints { seen: [...], reset? } */
export function hintRoutes(h: Hints, json: Json, readBody: ReadBody): [string, RegExp, Handler][] {
  return [
    ['GET', /^\/api\/hints$/, (_req, res) => json(res, 200, { ...h.get(), install: h.install })],
    ['POST', /^\/api\/hints$/, async (req, res) => {
      const body = await readBody(req)
      json(res, 200, { ...h.mark(body.seen, body.reset === true), install: h.install })
    }],
  ]
}
