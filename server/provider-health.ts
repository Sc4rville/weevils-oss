import fs from 'node:fs'
import path from 'node:path'
import type { Tool } from '../shared/api.ts'
import type { QuotaInfo } from '../shared/infra.ts'

export interface ProviderBlock { since: number; resetAt: number | null; source: 'quota' | 'transcript' }
interface ProviderState { block?: ProviderBlock; observedAt?: number; stopAt?: number }
/** Quota evidence is distinct from credentials. Expiry only schedules a fresh check, never proves recovery. */
export class ProviderHealth {
  private file: string
  private read: () => Promise<Record<Tool, QuotaInfo>>
  private ready: (tool: Tool) => boolean
  private state: Record<Tool, ProviderState> = { claude: {}, codex: {} }
  private checkedAt = 0
  constructor(file: string, read: () => Promise<Record<Tool, QuotaInfo>>, ready: (tool: Tool) => boolean) {
    this.file = file; this.read = read; this.ready = ready
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
      for (const tool of ['claude', 'codex'] as const) {
        const s = saved[tool]
        if (!s || typeof s !== 'object' || Array.isArray(s) ||
          (s.block && (!Number.isFinite(s.block.since) || !['quota', 'transcript'].includes(s.block.source) || (s.block.resetAt !== null && !Number.isFinite(s.block.resetAt))))) {
          throw new Error('Invalid persisted provider health') // i18n-ignore: startup invariant, never presented as app copy
        }
      }
      this.state = saved
    } catch (e) { if (fs.existsSync(file)) throw e }
  }
  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 })
    const fd = fs.openSync(tmp, 'r'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    fs.renameSync(tmp, this.file)
    const dir = fs.openSync(path.dirname(this.file), 'r'); try { fs.fsyncSync(dir) } finally { fs.closeSync(dir) }
  }
  async refresh(now = Date.now()) {
    if (this.checkedAt && now - this.checkedAt < 60_000) return
    this.checkedAt = now
    const quotas = await this.read()
    for (const tool of ['claude', 'codex'] as const) {
      const q = quotas[tool], s = this.state[tool]
      if (!q.ok || q.error || !Number.isFinite(q.at) || q.at > now + 5000 || now - q.at > 5 * 60_000 || q.at < (s.observedAt ?? 0)) continue
      const windows = q.windows.filter(w => w.kind === 'session' || w.kind === 'week')
      if (!windows.length || windows.some(w => !Number.isFinite(w.percent))) continue
      s.observedAt = q.at
      const full = windows.filter(w => w.percent >= 100)
      if (full.length) {
        const known = full.every(w => w.resetsAt !== null && w.resetsAt > now)
        s.block = { since: s.block?.since ?? q.at, resetAt: known ? Math.max(...full.map(w => w.resetsAt!)) : null, source: 'quota' }
      } else if (q.at > (s.stopAt ?? 0)) delete s.block
    }
    this.save()
  }
  stop(tool: Tool, at: number, resetAt: number | null = null) {
    const s = this.state[tool]
    if (at <= (s.stopAt ?? 0)) return
    s.stopAt = at
    if (at >= (s.observedAt ?? 0)) s.block = { since: at, resetAt, source: 'transcript' }
    this.save()
  }
  canUse(tool: Tool) { return this.ready(tool) && !this.state[tool].block }
  block(tool: Tool) { return this.state[tool].block }
  view() { return { claude: { canAttempt: this.canUse('claude'), ...this.state.claude }, codex: { canAttempt: this.canUse('codex'), ...this.state.codex } } }
  /** A polling boundary, not a promised quota reset or a scheduled execution. */
  retryAt(now = Date.now()) { return now + 60_000 }
}
