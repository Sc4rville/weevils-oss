// Logs the spend estimate next to the real Claude quota, without asking Anthropic anything: it reads the quota answer
// the running weevils already saved (quota-cache.json, refreshed every 5 min). `--once` prints a summary and exits.
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../server/config.ts'
import { anchorFor, entries, logCalibration, summarize } from '../server/spend.ts'

const quota = () => {
  try {
    return JSON.parse(fs.readFileSync(process.env.WEEVILS_QUOTA_CACHE ?? path.join(DATA_DIR, 'quota-cache.json'), 'utf8')).claude
  } catch {
    return undefined
  }
}
const tick = () => {
  const q = quota()
  const es = entries()
  const s = summarize(es, q, Date.now(), anchorFor(summarize(es, q).week.end) ?? undefined)
  logCalibration(s, es, q)
  return s
}
if (process.argv.includes('--once')) {
  const s = tick()
  console.log(JSON.stringify({ ...s, week: { ...s.week, bySession: s.week.bySession.slice(0, 3) } }, null, 1))
} else {
  // Nudge the running weevils to keep its quota fresh while nobody has the app open: its own 5 min throttle and
  // back-off still decide whether Anthropic is asked; this only reads its loopback API.
  const port = process.env.WEEVILS_PORT ?? '4179'
  // With weevils' local token (server/http.ts isLocal), read from its data folder.
  const token = (() => {
    try {
      return /^x-weevils-local:\s*([0-9a-f]{32,128})/im.exec(fs.readFileSync(path.join(DATA_DIR, 'local-token'), 'utf8'))?.[1]
    } catch {
      return undefined
    }
  })()
  const nudge = () => void fetch(`http://127.0.0.1:${port}/api/usage`, { headers: token ? { 'x-weevils-local': token } : {} }).catch(() => {})
  nudge()
  setInterval(nudge, 5 * 60_000 + 5000)
  tick()
  setInterval(tick, 60_000)
}
