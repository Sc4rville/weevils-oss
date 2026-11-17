// Error margin of the spend estimator against the real weekly percent, from spend-calibration.jsonl
// (written by scripts/spend-log.ts or the server). Usage: node scripts/spend-report.ts [file]
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../server/config.ts'

const file = process.argv[2] ?? path.join(DATA_DIR, 'spend-calibration.jsonl')
type L = { quotaAt: number; weekPct: number | null; weekResets: number; weekCost: number }
const rows = fs
  .readFileSync(file, 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l) as L)
  .filter((r, i, all) => r.weekPct != null && r.weekPct >= 3 && all.findIndex((x) => x.quotaAt === r.quotaAt) === i)
// Group by week (reset times jitter by a few ms).
const weeks = new Map<number, L[]>()
for (const r of rows) {
  const k = Math.round(r.weekResets / 3600_000)
  weeks.set(k, [...(weeks.get(k) ?? []), r])
}
const h = (ms: number) => (ms / 3600_000).toFixed(1)
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
for (const [k, rs] of weeks) {
  const first = rs[0]
  const last = rs[rs.length - 1]
  console.log(`week ending ${new Date(k * 3600_000).toISOString()}: ${rs.length} readings over ${h(last.quotaAt - first.quotaAt)} h, ${first.weekPct}% -> ${last.weekPct}%, $${first.weekCost} -> $${last.weekCost}`)
  // Forward test: $ per point learned at reading i, predict reading j at least `horizon` hours later.
  for (const horizon of [1, 3, 6]) {
    const errs: number[] = []
    for (let i = 0; i < rs.length; i++) {
      const j = rs.findIndex((r) => r.quotaAt >= rs[i].quotaAt + horizon * 3600_000)
      if (j < 0) break
      const kI = rs[i].weekCost / rs[i].weekPct!
      errs.push(rs[i].weekPct! + (rs[j].weekCost - rs[i].weekCost) / kI - rs[j].weekPct!)
    }
    if (!errs.length) continue
    const abs = errs.map(Math.abs)
    console.log(`  ${horizon} h ahead: ${errs.length} predictions, mean |error| ${mean(abs).toFixed(2)} pt, max ${Math.max(...abs).toFixed(2)} pt, bias ${mean(errs).toFixed(2)} pt`)
  }
  const ks = rs.map((r) => r.weekCost / r.weekPct!)
  console.log(`  $ per 1 %: ${Math.min(...ks).toFixed(2)} to ${Math.max(...ks).toFixed(2)} (last ${ks[ks.length - 1].toFixed(2)})`)
  if (last.weekPct! > first.weekPct!) console.log(`  marginal $ per point over the log: ${((last.weekCost - first.weekCost) / (last.weekPct! - first.weekPct!)).toFixed(2)}`)
}
