// get's anonymous stats, for weevboss or a terminal:
//   node get/stats.mjs [days]     the last days in a few sentences (default 7), with the records
//   node get/stats.mjs --csv      the install register (CSV)
//   node get/stats.mjs --json [days]
// The live counters are written every minute; the page with everything: https://get.scarville.tech/stats/<GET_STATS_KEY>.
import fs from 'node:fs'
import path from 'node:path'
import { REGISTER_HEAD, config, describeStats, readJson, readStats } from './server.mjs'

const cfg = config()
const days = Number(process.argv.find((a) => /^\d+$/.test(a))) || 7
if (process.argv.includes('--csv')) {
  let csv = REGISTER_HEAD + '\n'
  try {
    csv = fs.readFileSync(path.join(cfg.data, 'installs.csv'), 'utf8')
  } catch {
    /* no install yet */
  }
  process.stdout.write(csv)
} else if (process.argv.includes('--json')) console.log(JSON.stringify({ days: readStats(cfg, days), records: readJson(path.join(cfg.data, 'records.json')) || {} }, null, 2))
else {
  const list = readStats(cfg, days)
  const r = readJson(path.join(cfg.data, 'records.json')) || {}
  console.log(list.length ? describeStats(list) : 'No stats yet.')
  console.log(`Records: ${r.visits?.n ?? 0} visits in a day (${r.visits?.day ?? '—'}), ${r.installs?.n ?? 0} installs in a day (${r.installs?.day ?? '—'}).`)
}
