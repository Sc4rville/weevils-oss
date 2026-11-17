import { sourceAccessIssue } from './source-access'
import type { AutoItem } from './auto-model'
import { tr } from '../i18n'
import M from '../i18n/h24'

/** Conditions describe eligibility, not a promised execution time. */
export function autoCondition(x: AutoItem): string {
  const accessIssue = sourceAccessIssue(x)
  if (accessIssue) return accessIssue
  const t = tr(M)
  if (x.waiting === 'later' || x.nextReason === 'retry') return t.retryWaiting
  if (x.waiting && !['time', 'queue'].includes(x.waiting)) return t[`wait_${x.waiting}`]
  if (x.trigger.window) return t.withinWindow
  if (x.waiting === 'time') return t.whenEligible
  if (x.waiting === 'queue') return t.wait_queue
  return t.whenIdle
}
