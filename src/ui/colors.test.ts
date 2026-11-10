import { describe, expect, it } from 'vitest'
import { colorSlots } from './app-context'

const slot = (v: string) => Number(v.slice(1))
const dist = (a: number, b: number) => Math.min((a - b + 16) % 16, (b - a + 16) % 16)

describe('couleurs des projets', () => {
  it('sont stables : même projet, même couleur, quel que soit l’ordre ou les voisins affichés', () => {
    const a = colorSlots(['weevils', 'mygame', 'replay', 'geste', 'divers'])
    const b = colorSlots(['geste', 'divers', 'weevils', 'replay', 'mygame'])
    for (const id of Object.keys(a)) if (id !== '__foot') expect(a[id]).toBe(b[id])
  })
  it('jusqu’à 8 projets, deux projets ne sont jamais à moins de 2 emplacements (teintes proches)', () => {
    for (const n of [2, 4, 5, 7, 8]) {
      const ids = Array.from({ length: n }, (_, i) => `projet-${i * 7}`)
      const slots = Object.entries(colorSlots(ids)).filter(([k]) => k !== '__foot').map(([, v]) => slot(v))
      for (let i = 0; i < slots.length; i++) for (let j = i + 1; j < slots.length; j++) expect(dist(slots[i], slots[j])).toBeGreaterThanOrEqual(2)
    }
  })
  it('jusqu’à 16 projets, toutes différentes', () => {
    const ids = Array.from({ length: 16 }, (_, i) => `p${i}`)
    const slots = Object.entries(colorSlots(ids)).filter(([k]) => k !== '__foot').map(([, v]) => v)
    expect(new Set(slots).size).toBe(16)
  })
})
