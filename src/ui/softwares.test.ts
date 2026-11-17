import { describe, expect, it } from 'vitest'
import { fromLinear, keepOrder, linear, sameOrigin, segFill, tapToFix } from './softwares'

describe('barre d’avancement', () => {
  it('remplit les segments avant, dans et après la phase', () => {
    expect([1, 2, 3].map((k) => segFill(k, 2, 40))).toEqual([100, 40, 0])
    expect([1, 2, 3].map((k) => segFill(k, 1, 0))).toEqual([0, 0, 0])
    expect([1, 2, 3].map((k) => segFill(k, 3, 100))).toEqual([100, 100, 100])
    expect(segFill(1, 1, 140)).toBe(100)
  })

  it('un tap donne la phase du segment touché et la position dans le segment, arrondie à 5', () => {
    expect(tapToFix(0, 300)).toEqual({ phase: 1, percent: 0 })
    expect(tapToFix(50, 300)).toEqual({ phase: 1, percent: 50 })
    expect(tapToFix(99, 300)).toEqual({ phase: 1, percent: 100 })
    expect(tapToFix(100, 300)).toEqual({ phase: 2, percent: 0 })
    expect(tapToFix(142, 300)).toEqual({ phase: 2, percent: 40 })
    expect(tapToFix(290, 300)).toEqual({ phase: 3, percent: 90 })
    expect(tapToFix(300, 300)).toEqual({ phase: 3, percent: 100 })
    expect(tapToFix(-20, 300)).toEqual({ phase: 1, percent: 0 })
    expect(tapToFix(900, 300)).toEqual({ phase: 3, percent: 100 })
    expect(tapToFix(10, 0)).toEqual({ phase: 1, percent: 0 })
  })

  it('le clavier avance de 5 en 5 d’une phase à l’autre', () => {
    expect(linear({ phase: 2, percent: 40 })).toBe(140)
    expect(fromLinear(140)).toEqual({ phase: 2, percent: 40 })
    expect(fromLinear(linear({ phase: 1, percent: 100 }) + 5)).toEqual({ phase: 2, percent: 5 })
    expect(fromLinear(-5)).toEqual({ phase: 1, percent: 0 })
    expect(fromLinear(305)).toEqual({ phase: 3, percent: 100 })
  })
})

describe('la grille', () => {
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id)

  it('première liste : l’ordre du serveur ; ensuite chacun garde sa place, les nouveaux au bout, les disparus partent', () => {
    expect(ids(keepOrder(null, [{ id: 'b' }, { id: 'a' }]))).toEqual(['b', 'a'])
    const prev = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    expect(ids(keepOrder(prev, [{ id: 'c' }, { id: 'd' }, { id: 'a' }]))).toEqual(['a', 'c', 'd'])
    expect(ids(keepOrder(prev, []))).toEqual([])
  })

  it('garde les données fraîches, pas les anciennes', () => {
    const out = keepOrder([{ id: 'a', v: 1 }], [{ id: 'a', v: 2 }])
    expect(out).toEqual([{ id: 'a', v: 2 }])
  })

  it('ne met jamais l’appli elle-même dans un cadre', () => {
    const o = 'https://weevils.example.tech'
    expect(sameOrigin('https://weevils.example.tech/', o)).toBe(true)
    expect(sameOrigin('/x', o)).toBe(true)
    // Les pages statiques servies en bac à sable par weevils se montrent dans un cadre.
    expect(sameOrigin('/api/site/abcdefghijklmnopqrstuv/jeu/', o)).toBe(false)
    expect(sameOrigin('https://other.example.tech/', o)).toBe(false)
    expect(sameOrigin('http://weevils.example.tech/', o)).toBe(false)
    expect(sameOrigin('http://[', o)).toBe(false)
  })
})
