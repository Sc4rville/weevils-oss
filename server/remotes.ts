// Fédération : le weevilsd du VPS lit les weevilsd des autres machines (le PC) à travers un tunnel SSH inversé.
// Côté PC, la requête arrive de 127.0.0.1 sans en-tête de proxy ni Origin, Host 127.0.0.1:<port du tunnel> : elle est de confiance,
// comme un outil local (server/http.ts).

import type { Snapshot } from '../shared/api.ts'
import { tr } from './i18n.ts'
import M from './i18n/remotes.ts'

export class Remote {
  id: string
  url: string
  snap: Snapshot | null = null
  online = false
  private onChange: () => void

  constructor(id: string, url: string, onChange: () => void) {
    this.id = id
    this.url = url.replace(/\/$/, '')
    this.onChange = onChange
  }

  start() {
    const tick = async () => {
      try {
        const res = await fetch(`${this.url}/api/snapshot`, { signal: AbortSignal.timeout(2500) })
        if (!res.ok) throw new Error(String(res.status))
        const s = (await res.json()) as Snapshot
        const changed = !this.online || s.version !== this.snap?.version
        this.snap = s
        this.online = true
        if (changed) this.onChange()
      } catch {
        if (this.online) {
          this.online = false
          this.onChange()
        }
      }
    }
    void tick()
    setInterval(tick, 2000)
  }

  has(sessionId: string) {
    return !!this.online && !!this.snap?.sessions.some((s) => s.id === sessionId)
  }

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.online) throw new Error(tr(M).offline(this.id))
    const res = await fetch(`${this.url}${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    })
    const data = (await res.json().catch(() => ({}))) as T & { error?: string }
    if (!res.ok) throw new Error(data.error ?? tr(M).failed(this.id, res.status))
    return data
  }
}

/** WEEVILS_REMOTES="pc=http://127.0.0.1:4192,autre=http://…" */
export function parseRemotes(spec: string | undefined): [string, string][] {
  return (spec ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const i = x.indexOf('=')
      return [x.slice(0, i), x.slice(i + 1)] as [string, string]
    })
    .filter(([id, url]) => id && url)
}
