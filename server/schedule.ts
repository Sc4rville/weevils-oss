// How often a scheduled task runs, read from its schedule as written: systemd (OnCalendar shorthands and expressions,
// OnUnitActiveSec time spans), cron, or a plain « every N » / « toutes les N ». For the « auto » band (core.ts
// refreshH24): « / 6 h » next to a timer. Null when it can't be told (an irregular calendar, a one-shot).

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const SHORTHAND: Record<string, number> = {
  minutely: MIN,
  hourly: HOUR,
  daily: DAY,
  weekly: 7 * DAY,
  monthly: 30 * DAY,
  quarterly: 91 * DAY,
  semiannually: 182 * DAY,
  yearly: 365 * DAY,
  annually: 365 * DAY,
}

const UNIT: [RegExp, number][] = [
  [/^(us|usec|µs)$/, 0.001],
  [/^(ms|msec)$/, 1],
  [/^(s|sec|secs|second|seconds|seconde|secondes)$/, 1000],
  [/^(m|min|mins|minute|minutes)$/, MIN],
  [/^(h|hr|hrs|hour|hours|heure|heures)$/, HOUR],
  [/^(d|day|days|j|jour|jours)$/, DAY],
  [/^(w|week|weeks|semaine|semaines)$/, 7 * DAY],
  [/^(M|month|months|mois)$/, 30 * DAY],
]

/** « 1h 30min », « 15min », « 2d », « 90s » (systemd time span) → ms ; null when unreadable. */
export function timespan(s: string): number | null {
  const parts = [...s.trim().matchAll(/(\d+(?:\.\d+)?)\s*([a-zA-Zµ]+)/g)]
  if (!parts.length || parts.map((p) => p[0]).join('').replace(/\s/g, '') !== s.replace(/\s/g, '')) return null
  let ms = 0
  for (const [, n, u] of parts) {
    const hit = UNIT.find(([re]) => re.test(u === 'M' ? u : u.toLowerCase()))
    if (!hit) return null
    ms += Number(n) * hit[1]
  }
  return ms > 0 ? ms : null
}

// Period of one field: « * » → every unit, « */N » or « 0/N » → N units, a fixed value → null (not repeating here).
const step = (field: string): number | 'all' | null => {
  if (field === '*') return 'all'
  const m = /^(?:\*|\d+)\/(\d+)$/.exec(field)
  return m ? Number(m[1]) : null
}

/** systemd OnCalendar: « *-*-* 08:00:00 », « Mon *-*-* 09:00 », « *:0/15 », « *-*-* *:00:00 ». */
function calendar(spec: string): number | null {
  const s = spec.trim().replace(/\s+/g, ' ')
  const short = SHORTHAND[s.toLowerCase()]
  if (short) return short
  const tokens = s.split(' ')
  let weekdays: string | null = null
  if (/^[A-Za-z]/.test(tokens[0])) weekdays = tokens.shift()!
  let date = '*-*-*'
  let time = tokens[0] ?? ''
  if (tokens.length >= 2) [date, time] = tokens
  else if (/^[\d*/,.]+-[\d*/,.]+(-[\d*/,.]+)?$/.test(time)) [date, time] = [time, '00:00:00']
  if (!/^[\d*/,.:]+$/.test(time) || !/^[\d*/,.-]+$/.test(date)) return null
  if (weekdays && !/^(mon|tue|wed|thu|fri|sat|sun)/i.test(weekdays)) return null
  const [h = '*', m = '0', sec = '0'] = time.split(':')
  const d = date.split('-')
  const day = d[d.length - 1]
  // Several days of the week (« Mon..Fri ») or several times (« 08,20 »): not one regular period.
  if (weekdays && /[,.]/.test(weekdays)) return null
  if ([h, m].some((f) => f.includes(','))) return null
  const ss = step(sec)
  const ms = step(m)
  const hs = step(h)
  if (ss === 'all') return 1000
  if (typeof ss === 'number') return ss * 1000
  if (ms === 'all') return MIN
  if (typeof ms === 'number') return ms * MIN
  if (hs === 'all') return HOUR
  if (typeof hs === 'number') return hs * HOUR
  // A fixed time of day: daily, weekly with a weekday, monthly with a fixed day.
  if (weekdays) return 7 * DAY
  if (day !== '*' && !day.includes('/')) return d[d.length - 2] === '*' ? 30 * DAY : 365 * DAY
  const ds = step(day)
  if (typeof ds === 'number') return ds * DAY
  return DAY
}

// cron: « */15 * * * * », « 0 8 * * * », « 0 9 * * 1 », « 0 */6 * * * ».
function cron(spec: string): number | null {
  const f = spec.trim().split(/\s+/)
  if (f.length !== 5 || !f.every((x) => /^[\d*/,-]+$|^[A-Za-z]{3}(-[A-Za-z]{3})?$/.test(x))) return null
  const [m, h, dom, mon, dow] = f
  if ([m, h].some((x) => x.includes(',') || x.includes('-'))) return null
  const ms = step(m)
  const hs = step(h)
  if (ms === 'all') return MIN
  if (typeof ms === 'number') return ms * MIN
  if (hs === 'all') return HOUR
  if (typeof hs === 'number') return hs * HOUR
  if (dow !== '*') return /[,-]/.test(dow) ? null : 7 * DAY
  if (dom !== '*') return mon === '*' ? 30 * DAY : 365 * DAY
  return DAY
}

/**
 * The period of a schedule in ms, or null. Accepts « OnCalendar=… », « OnUnitActiveSec=… », a bare calendar
 * expression or shorthand, a cron line, « every 6h », « toutes les 30 min ».
 */
export function periodOf(schedule: string | null | undefined): number | null {
  if (!schedule) return null
  const s = schedule.trim()
  const kv = /^(\w+)\s*=\s*(.+)$/.exec(s)
  if (kv) {
    if (/^On(UnitActive|UnitInactive)(U?Sec)$/.test(kv[1])) return timespan(kv[2])
    if (kv[1] === 'OnCalendar') return calendar(kv[2])
    return null
  }
  // i18n-ignore : mots-clés reconnus dans un planning écrit à la main (jamais affichés)
  const every = /^(?:every|toutes? les|chaque)\s+(.+)$/i.exec(s)
  if (every) return timespan(/^\D/.test(every[1]) ? `1${every[1]}` : every[1])
  return /^\S+(\s+\S+){4}$/.test(s) && !/:/.test(s) ? cron(s) : calendar(s)
}

/** systemctl show … -p TimersCalendar -p TimersMonotonic: « { OnCalendar=*-*-* 08:00:00 ; next_elapse=… } » → the spec. */
export function timerSpec(prop: string): string | null {
  const m = /\{\s*(On\w+)\s*=\s*([^;}]+?)\s*;/.exec(prop)
  return m ? `${m[1]}=${m[2]}` : null
}

/**
 * `systemctl --user show <units> -p Id -p TimersCalendar -p TimersMonotonic` output → the period of each timer unit
 * (null when its schedule can't be read as one).
 */
export function parseTimerShow(stdout: string): Map<string, number | null> {
  const out = new Map<string, number | null>()
  for (const block of stdout.split(/\n\s*\n/)) {
    const id = /^Id=(.+)$/m.exec(block)?.[1]?.trim()
    if (!id) continue
    let every: number | null = null
    for (const m of block.matchAll(/^Timers(?:Calendar|Monotonic)=(.+)$/gm)) {
      every = periodOf(timerSpec(m[1]))
      if (every) break
    }
    out.set(id, every)
  }
  return out
}
