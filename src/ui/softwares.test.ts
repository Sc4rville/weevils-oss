import { describe, expect, it } from 'vitest'
import { TYPING0, frame, fromLinear, keepOrder, linear, sameOrigin, segFill, step, tapToFix, termLines, type Typing } from './softwares'

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

describe('aperçu terminal', () => {
  it('garde les vraies lignes, précédées de la commande pour git', () => {
    expect(termLines({ tail: ['a', '', 'b'], tailSource: 'log' })).toEqual(['a', 'b'])
    expect(termLines({ tail: ['abc fix'], tailSource: 'git' })).toEqual(['$ git log', 'abc fix'])
    expect(termLines({ tail: [], tailSource: 'git' })).toEqual([])
  })

  it('tape chaque ligne en quelques pas, passe à la suivante, puis recommence', () => {
    const lines = ['hello', 'x'.repeat(80)]
    let s: Typing = TYPING0
    const seen: Typing[] = []
    for (let i = 0; i < 200; i++) {
      s = step(s, lines)
      seen.push(s)
    }
    // Une ligne de 80 caractères prend au plus 8 pas.
    const firstPass = seen.slice(0, seen.findIndex((x) => x.line === 2))
    const longSteps = firstPass.filter((x) => x.line === 1 && x.wait === 0 && x.ch > 0).length
    expect(longSteps).toBeLessThanOrEqual(8)
    // La boucle revient au début.
    expect(seen.some((x, i) => i > 0 && x.line === 0 && x.ch === 0 && seen[i - 1].line === 2)).toBe(true)
    expect(step(TYPING0, [])).toEqual(TYPING0)
  })

  it('montre les lignes tapées et celle en cours, les dernières seulement', () => {
    const lines = ['a1', 'b2', 'c3', 'd4']
    expect(frame(lines, { line: 2, ch: 1, wait: 0 }, 10)).toEqual({ lines: ['a1', 'b2', 'c'], typing: true })
    expect(frame(lines, { line: 2, ch: 1, wait: 0 }, 2)).toEqual({ lines: ['b2', 'c'], typing: true })
    expect(frame(lines, { line: 4, ch: 0, wait: 3 }, 3)).toEqual({ lines: ['b2', 'c3', 'd4'], typing: false })
    // La sortie a raccourci entre deux pas : jamais de ligne fantôme.
    expect(frame(['a'], { line: 3, ch: 2, wait: 0 }, 5)).toEqual({ lines: ['a'], typing: false })
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
