import { describe, expect, it } from 'vitest'
import { parseTimerShow, periodOf, timerSpec, timespan } from './schedule.ts'

const MIN = 60_000
const H = 60 * MIN
const D = 24 * H

describe('schedule — period of a timer, cron line or « every N »', () => {
  it('systemd shorthands and calendar expressions', () => {
    expect(periodOf('daily')).toBe(D)
    expect(periodOf('hourly')).toBe(H)
    expect(periodOf('weekly')).toBe(7 * D)
    expect(periodOf('*-*-* 08:00:00')).toBe(D)
    expect(periodOf('OnCalendar=*-*-* 03:30:00')).toBe(D)
    expect(periodOf('*:0/15')).toBe(15 * MIN)
    expect(periodOf('*-*-* *:00/5:00')).toBe(5 * MIN)
    expect(periodOf('*-*-* *:00:00')).toBe(H)
    expect(periodOf('*-*-* 0/6:00:00')).toBe(6 * H)
    expect(periodOf('Mon *-*-* 09:00:00')).toBe(7 * D)
    expect(periodOf('*-*-01 00:00:00')).toBe(30 * D)
  })

  it('irregular calendars are not a period', () => {
    expect(periodOf('Mon,Wed *-*-* 09:00')).toBeNull()
    expect(periodOf('*-*-* 08,20:00:00')).toBeNull()
  })

  it('monotonic timers (OnUnitActiveSec) and time spans', () => {
    expect(periodOf('OnUnitActiveSec=15min')).toBe(15 * MIN)
    expect(periodOf('OnUnitActiveUSec=1h 30min')).toBe(90 * MIN)
    expect(timespan('2d')).toBe(2 * D)
    expect(timespan('90s')).toBe(90_000)
    expect(timespan('soon')).toBeNull()
    expect(periodOf('OnBootSec=5min')).toBeNull()
  })

  it('cron lines', () => {
    expect(periodOf('*/15 * * * *')).toBe(15 * MIN)
    expect(periodOf('0 8 * * *')).toBe(D)
    expect(periodOf('0 */6 * * *')).toBe(6 * H)
    expect(periodOf('0 9 * * 1')).toBe(7 * D)
    expect(periodOf('0 9 * * 1-5')).toBeNull()
  })

  it('« every N » in English and French', () => {
    expect(periodOf('every 6h')).toBe(6 * H)
    expect(periodOf('every 30 min')).toBe(30 * MIN)
    expect(periodOf('toutes les 2 heures')).toBe(2 * H)
    expect(periodOf('chaque jour')).toBe(D)
  })

  it('anything else is null', () => {
    expect(periodOf('')).toBeNull()
    expect(periodOf(null)).toBeNull()
    expect(periodOf('lancé à la main')).toBeNull()
    expect(periodOf('started by hand')).toBeNull()
  })

  it('reads systemctl show for several timers', () => {
    expect(timerSpec('{ OnCalendar=*-*-* 08:00:00 ; next_elapse=Wed 2026-11-11 08:00:00 UTC }')).toBe('OnCalendar=*-*-* 08:00:00')
    const out = parseTimerShow(
      [
        'Id=wv-backup.timer',
        'TimersMonotonic=',
        'TimersCalendar={ OnCalendar=*-*-* 03:00:00 ; next_elapse=Wed 2026-11-11 03:00:00 UTC }',
        '',
        'Id=wv-poll.timer',
        'TimersMonotonic={ OnUnitActiveUSec=10min ; next_elapse=1h 2min }',
        'TimersCalendar=',
        '',
        'Id=wv-odd.timer',
        'TimersCalendar={ OnCalendar=Mon,Fri *-*-* 09:00:00 ; next_elapse=… }',
      ].join('\n'),
    )
    expect(out.get('wv-backup.timer')).toBe(D)
    expect(out.get('wv-poll.timer')).toBe(10 * MIN)
    expect(out.get('wv-odd.timer')).toBeNull()
  })
})
