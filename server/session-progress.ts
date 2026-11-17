import fs from 'node:fs'
import path from 'node:path'
import type { SessionProgress } from '../shared/api.ts'
import { tr } from './i18n.ts'
import M from './i18n/session-progress.ts'
const STALE = 60_000
interface Seen { file: string; count: number; verified: number; lastProgressAt?: number }
/** Reads existing atomic progress files only. Never starts a process or contacts a paid worker. */
export class SessionProgressReader {
 private seen = new Map<string, Seen>()
 private last = new Map<string, SessionProgress>()
 read(cwd: string, now = Date.now()): SessionProgress | undefined {
  try {
   const build = path.join(cwd, 'build')
   const files = fs.readdirSync(build).filter(n => /^production-[\w-]+$/.test(n)).sort().reverse()
   const file = files.map(n => path.join(build,n,'live.json')).find(f => fs.existsSync(f))
   if (!file || fs.statSync(file).size > 256_000) return this.last.get(cwd)
   const data = JSON.parse(fs.readFileSync(file,'utf8'))
   const updatedAt = Date.parse(data.observedUtc)
   const count = data.framesReportedByBlender, verified = data.framesVerifiedAndDownloaded
   if (!Number.isFinite(updatedAt) || updatedAt > now+30_000 || !Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(verified) || verified < 0) return
   const prev = this.seen.get(cwd)
   const increasing = prev?.file === file && (count > prev.count || verified > prev.verified)
   const lastProgressAt = increasing && now-updatedAt < STALE ? now : prev?.file === file && count >= prev.count && verified >= prev.verified ? prev.lastProgressAt : undefined
   this.seen.set(cwd,{file,count,verified,lastProgressAt})
   const stage = data.controller?.stage
   const done = stage === 'review-ready-needs-human-review'
   const error = ['failed-pod-removed','account-limit','other-pod-no-retry'].includes(stage)
   const fresh = now-updatedAt < STALE
   const moving = fresh && lastProgressAt !== undefined && now-lastProgressAt < 90_000
   const t = tr(M)
   const pauseReason = stage === 'failed-pod-removed' ? 'worker-stopped' : stage === 'account-limit' ? 'capacity' : stage === 'other-pod-no-retry' ? 'retry-stopped' : undefined
   const result: SessionProgress = {kind:'render', verified, ...(pauseReason ? {pauseReason} : {}), source:'remote',label:done?t.review:error?t.error:moving?t.render:t.waiting,state:done?'done':error?'error':moving?'working':'waiting',updatedAt,staleAfterMs:STALE,completed:count,detail:t.verified(verified),...(lastProgressAt ? {lastProgressAt} : {})}
   this.last.set(cwd, result)
   return result
  } catch { return this.last.get(cwd) }
 }
}
