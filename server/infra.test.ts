import { describe, expect, it } from 'vitest'
import { episodes, levelOf, sizing } from './infra.ts'
import { claudeWindows, codexWindows } from './usage.ts'
import type { InfraPoint } from '../shared/infra.ts'

const pt = (min: number, cpu: number, mem: number, extra: Partial<InfraPoint> = {}): InfraPoint => ({
  at: Date.UTC(2026, 10, 9, 10, min),
  cpu,
  cpuMax: cpu,
  mem,
  swap: null,
  load: 1,
  agents: 0,
  agentMem: 0,
  agentCpu: 0,
  ...extra,
})

describe('quotas', () => {
  it('lit la réponse de /api/oauth/usage comme /usage', () => {
    const w = claudeWindows({
      five_hour: { utilization: 42.4, resets_at: '2026-11-09T15:00:00+00:00' },
      seven_day: { utilization: 51, resets_at: '2026-11-13T16:00:00+00:00' },
      limits: [
        { kind: 'weekly_all', percent: 51, resets_at: '2026-11-13T16:00:00+00:00' },
        { kind: 'weekly_scoped', percent: 18, resets_at: '2026-11-13T16:00:00+00:00', scope: { model: { display_name: 'Fable' } } },
      ],
    })
    expect(w.map((x) => [x.kind, x.percent, x.label])).toEqual([
      ['session', 42, undefined],
      ['week', 51, undefined],
      ['model', 18, 'Fable'],
    ])
    expect(w[0].resetsAt).toBe(Date.parse('2026-11-09T15:00:00Z'))
  })
  it('sans fenêtre de 5 h, seulement la semaine', () => {
    expect(claudeWindows({ five_hour: null, seven_day: { utilization: 10, resets_at: null } }).map((x) => x.kind)).toEqual(['week'])
  })
  it('lit wham/usage de Codex', () => {
    const w = codexWindows({ primary_window: { used_percent: 5, limit_window_seconds: 604800, reset_at: 1794494774 }, secondary_window: { used_percent: 30, limit_window_seconds: 18000, reset_at: 1794400000 } })
    expect(w.map((x) => [x.kind, x.percent])).toEqual([
      ['session', 30],
      ['week', 5],
    ])
    expect(w[1].resetsAt).toBe(1794494774000)
  })
})

describe('mesures', () => {
  it('niveaux', () => {
    expect(levelOf(10, 50)).toBe('ok')
    expect(levelOf(75, 50)).toBe('warn')
    expect(levelOf(10, 95)).toBe('crit')
  })
  it('regroupe les minutes saturées en épisodes et retient le coupable', () => {
    const pts = [pt(0, 20, 50), pt(1, 95, 50, { top: [['docker', 300]] }), pt(2, 97, 60, { top: [['docker', 280], ['vitest', 50]] }), pt(4, 92, 60, { top: [['vitest', 200]] }), pt(30, 20, 50), pt(40, 30, 95)]
    const e = episodes(pts)
    expect(e).toHaveLength(2)
    expect(e[0].culprit).toBe('docker')
    expect(e[0].cpu).toBe(97)
    expect(e[1].mem).toBe(95)
  })
  it('estime le matériel pour la prochaine marche de sessions', () => {
    const pts = Array.from({ length: 60 }, (_, i) => pt(i, 30, 50, { agents: 5, agentMem: 2000, agentCpu: 50 }))
    const s = sizing(pts, 16 * 1024 ** 3, 4)!
    expect(s.perMem).toBe(400)
    expect(s.target).toBeGreaterThan(s.capacity)
    expect(s.vcpu).toBeGreaterThanOrEqual(2)
    expect(s.ram).toBeGreaterThanOrEqual(8)
  })
})
