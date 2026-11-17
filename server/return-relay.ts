import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Session } from '../shared/api.ts'
import type { Transcript } from './transcripts.ts'
import { signAs } from './authors.ts'
import { tr } from './i18n.ts'
import R from './i18n/relay.ts'

interface ReturnPlan {
  sourceId: string; targetId: string; at: number; sourceAt: number; cwd: string; title: string
  phase: 'waiting' | 'dispatching' | 'uncertain' | 'done' | 'cancelled'; context: string; auto: boolean; main?: boolean
}
export interface ReturnHost {
  sessions(): Session[]
  transcript(id: string): Transcript | undefined
  openClaude(cwd: string, title: string, text: string, id: string): Promise<string>
  autoOwns?(id: string): boolean
  autoReturn?(id: string, text: string, targetId: string, tool?: 'claude' | 'codex'): Promise<string>
  resumeCodex?(id: string, text: string, requestId: string): Promise<string>
  isMain?(id: string): boolean
  mainBusy?(): boolean
  returnMain?(text: string, requestId: string): Promise<string>
  bump(): void
}
/** No model is needed to preserve context. Persist intent before transport; ambiguous dispatch is never retried. */
export class ReturnRelay {
  private file: string
  private host: ReturnHost
  private plans: ReturnPlan[] = []
  private busy = false
  constructor(file: string, host: ReturnHost) {
    this.file = file; this.host = host
    try { this.plans = JSON.parse(fs.readFileSync(file, 'utf8')).map((p: ReturnPlan) => p.phase === 'dispatching' ? { ...p, phase: 'uncertain' } : p) } catch (e) { if (fs.existsSync(file)) throw e }
  }
  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(this.plans), { mode: 0o600 })
    const fd = fs.openSync(tmp, 'r'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    fs.renameSync(tmp, this.file)
    const dir = fs.openSync(path.dirname(this.file), 'r'); try { fs.fsyncSync(dir) } finally { fs.closeSync(dir) }
    try { this.host.bump() } catch { /* a UI refresh failure cannot undo the durable handoff */ }
  }
  target(id: string) {
    const p = this.plans.findLast(p => p.sourceId === id && p.phase === 'done')
    const s = this.host.sessions().find(s => s.id === id)
    return p && !(s && s.lastActivityAt > p.at) ? p.targetId : undefined
  }
  holds(id: string) { return this.plans.some(p => p.sourceId === id && p.phase !== 'done' && p.phase !== 'cancelled') }
  view() { return this.plans.map(({ context: _context, cwd: _cwd, ...p }) => p) }
  request(s: Session, now = Date.now()) {
    if (s.tool !== 'codex' || !s.controllable || s.status === 'working' || s.status === 'needs_user' || s.turnWorking || !s.cwd) return
    if (this.plans.some(p => p.sourceId === s.id && p.phase !== 'cancelled' && !(p.phase === 'done' && (s.interrupted?.at ?? 0) > p.at))) return
    const t = this.host.transcript(s.id)
    if (!t?.file) return
    const history = t.messages.filter(m => m.role !== 'event').slice(-24).map(m => `${m.role}${m.author ? ` (${m.author})` : ''}: ${m.text}`).join('\n').slice(-20000)
    const context = signAs('weevboss', tr(R).returnContext({ source: s.id, file: t.file, cwd: s.cwd, first: (t.firstPrompt ?? '').slice(0, 4000), history }))
    const p: ReturnPlan = { sourceId: s.id, targetId: crypto.randomUUID(), at: now, sourceAt: s.interrupted?.at ?? s.lastActivityAt, cwd: s.cwd, title: s.title, phase: 'waiting', context, auto: !!this.host.autoOwns?.(s.id), ...(this.host.isMain?.(s.id) ? { main: true } : {}) }
    this.plans.push(p)
    try { this.save() } catch (e) { this.plans.pop(); throw e }
  }
  async tick(canUseClaude: boolean, canUseCodex = false) {
    if (this.busy) return
    this.busy = true
    try {
      for (const p of this.plans) {
        // A persisted target ID lets a restart recognize a launch whose ACK was lost without creating a second job.
        if (!p.main && p.phase === 'uncertain' && p.targetId !== p.sourceId && (this.host.transcript(p.targetId) || this.host.sessions().some(s => s.id === p.targetId))) { p.phase = 'done'; this.save() }
        if ((!canUseClaude && !canUseCodex) || p.phase !== 'waiting') continue
        const s = this.host.sessions().find(s => s.id === p.sourceId)
        if (!s || s.status === 'working' || s.status === 'needs_user' || s.turnWorking) continue
        if (p.main && (!this.host.returnMain || this.host.mainBusy?.())) continue
        if (s.lastActivityAt > p.sourceAt && !s.interrupted) { p.phase = 'cancelled'; this.save(); continue }
        const tool = canUseClaude ? 'claude' : 'codex'
        if (tool === 'codex' && !p.auto && !this.host.resumeCodex) continue
        const requestId = p.targetId
        if (tool === 'codex' && !p.auto) p.targetId = p.sourceId
        p.phase = 'dispatching'
        try { this.save() } catch (e) { p.phase = 'waiting'; p.targetId = requestId; throw e }
        try {
          const target = p.main ? await this.host.returnMain!(p.context, requestId)
            : p.auto && this.host.autoReturn
            ? await this.host.autoReturn(p.sourceId, p.context, p.targetId, tool)
            : tool === 'codex' ? await this.host.resumeCodex!(p.sourceId, p.context, requestId)
            : await this.host.openClaude(p.cwd, p.title, p.context, p.targetId)
          if (!p.main && tool === 'claude' && target !== p.targetId) throw new Error('handoff target mismatch') // i18n-ignore: internal invariant, caught below; never rendered
          p.targetId = target
          p.phase = 'done'
        } catch { p.phase = 'uncertain' }
        this.save()
      }
    } finally { this.busy = false }
  }
}
