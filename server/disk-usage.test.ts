import { describe, expect, it } from 'vitest'
import { buildView, dockerBytes, parseDockerDf, parseDu, parseRecent, type DiskSnapshot } from './disk-usage.ts'

const GB = 1024 ** 3
const H = 3600_000
const home = '/home/user'
const opts = { home, measuring: false, next: null }

const snap = (at: number, used: number, items: Record<string, number>, extra: Partial<DiskSnapshot> = {}): DiskSnapshot => ({ at, total: 200 * GB, used, items, ...extra })

describe('parsing', () => {
  it('keeps home folders one level down, and two levels down from 10 MB', () => {
    const out = ['70000000\t/home/user', '30000000\t/home/user/projects', '20000000\t/home/user/projects/big', '5000\t/home/user/projects/tiny', '4\t/home/user/.ssh', 'du: cannot read', '9\t/elsewhere/x'].join('\n')
    expect(parseDu(out, home)).toEqual({ 'h:projects': 30000000 * 1024, 'h:projects/big': 20000000 * 1024, 'h:.ssh': 4096 })
  })
  it('reads Docker sizes, which are decimal', () => {
    expect(dockerBytes('14.46GB')).toBe(14_460_000_000)
    expect(dockerBytes('972.6MB')).toBe(972_600_000)
    expect(dockerBytes('0B')).toBe(0)
    const rows = parseDockerDf('{"Type":"Build Cache","Size":"21GB","Reclaimable":"12.9GB"}\n{"Type":"Images","Size":"14.46GB","Reclaimable":"6.631GB (45%)"}\nnot json')
    expect(rows).toEqual([
      { type: 'Build Cache', size: 21e9, reclaimable: 12.9e9 },
      { type: 'Images', size: 14.46e9, reclaimable: 6.631e9 },
    ])
  })
  it('sums recent writes by folder, without the home root nor tiny folders', () => {
    expect(parseRecent(`${20 * 1024 ** 2}\twork/trailer\n${1024}\twork/small\n999999999\t.\n`)).toEqual({ 'work/trailer': 20 * 1024 ** 2 })
  })
})

describe('view', () => {
  it('says nothing is measured yet, without numbers', () => {
    const v = buildView([], { ...opts, next: 123 })
    expect(v).toMatchObject({ at: null, folders: [], growth: null, recent: [], next: 123 })
  })

  it('lists the largest folders; what du cannot reach is the rest, so the list adds up to the disk used', () => {
    const s = snap(0, 100 * GB, { 'h:projects': 40 * GB, 'h:projects/a': 30 * GB, 'h:projects/b': 5 * GB, 'h:work': 10 * GB, 's:usr': 4 * GB, 'f:swapfile': 8 * GB }, { docker: [{ type: 'Build Cache', size: 21e9, reclaimable: 12e9 }, { type: 'Images', size: 14e9, reclaimable: 0 }] })
    const v = buildView([s], opts)
    expect(v.folders.map((f) => [f.kind, f.name, f.bytes / GB])).toEqual([
      ['folder', 'projects', 40],
      ['rest', 'rest', 38],
      ['folder', 'work', 10],
      ['swap', 'swap', 8],
      ['system', 'usr', 4],
    ])
    expect(v.folders.reduce((a, f) => a + f.bytes, 0)).toBe(100 * GB)
    expect(v.folders[0]).toMatchObject({ path: '/home/user/projects', inside: [{ name: 'a', bytes: 30 * GB }, { name: 'b', bytes: 5 * GB }] })
    expect(v.folders[1].inside.map((i) => i.name)).toEqual(['Build Cache', 'Images'])
    expect(v.growth).toBeNull()
  })

  it('has no growth from one measurement, nor from two taken less than 12 h apart', () => {
    const a = snap(0, 50 * GB, { 'h:work': 10 * GB })
    const b = snap(6 * H, 52 * GB, { 'h:work': 12 * GB })
    expect(buildView([a], opts).growth).toBeNull()
    expect(buildView([a, b], opts).growth).toBeNull()
  })

  it('ranks folders by growth per day, finest folder first, and counts loose files and the rest', () => {
    const a = snap(0, 50 * GB, { 'h:work': 10 * GB, 'h:work/trailer': 8 * GB, 'h:projects': 20 * GB, 'h:projects/x': 5 * GB, 's:var': 1 * GB })
    const b = snap(12 * H, 54 * GB, { 'h:work': 12 * GB, 'h:work/trailer': 8 * GB, 'h:work/new': 1 * GB, 'h:projects': 20.5 * GB, 'h:projects/x': 5 * GB, 's:var': 1 * GB })
    const c = snap(24 * H, 56 * GB, { 'h:work': 14 * GB, 'h:work/trailer': 9 * GB, 'h:work/new': 2 * GB, 'h:projects': 20.5 * GB, 'h:projects/x': 5 * GB, 's:var': 1 * GB })
    const g = buildView([a, b, c], opts).growth!
    expect(g.since).toBe(0)
    expect(g.perDay).toBe(6 * GB)
    expect(g.items.map((x) => [x.kind, x.parent ?? '', x.name, x.perDay / GB])).toEqual([
      ['rest', '', 'rest', 1.5],
      ['folder', 'work', 'new', 2],
      ['folder', 'work', 'trailer', 1],
      ['loose', '', 'work', 1],
      ['loose', '', 'projects', 0.5],
    ].sort((p, q) => (q[3] as number) - (p[3] as number)))
    expect(g.items.find((x) => x.name === 'new')).toMatchObject({ path: '/home/user/work/new', bytes: 2 * GB })
  })

  it('measures growth over the last week only', () => {
    const old = snap(0, 10 * GB, { 'h:work': 1 * GB })
    const a = snap(10 * 24 * H, 50 * GB, { 'h:work': 40 * GB })
    const b = snap(11 * 24 * H, 51 * GB, { 'h:work': 41 * GB })
    const g = buildView([old, a, b], opts).growth!
    expect(g.since).toBe(a.at)
    expect(g.items.find((x) => x.name === 'work')?.perDay).toBe(1 * GB)
  })

  it('shows recent writes by folder, never more than the folder holds', () => {
    const s = snap(0, 50 * GB, { 'h:work': 12 * GB, 'h:work/trailer': 9 * GB, 'h:work/b': 9.5 * GB }, { recent: { 'work/trailer': 10 * GB, 'work/b': 9.2 * GB, 'work/': 200 * 1024 ** 2, 'x/y': 1024 } })
    expect(buildView([s], opts).recent).toEqual([
      { name: 'b', parent: 'work', bytes: 9.2 * GB, path: '/home/user/work/b' },
      { name: 'trailer', parent: 'work', bytes: 9 * GB, path: '/home/user/work/trailer' },
      { name: 'work', loose: true, bytes: 200 * 1024 ** 2, path: '/home/user/work' },
    ])
  })
})
