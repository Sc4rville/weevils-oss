import { describe, expect, it } from 'vitest'
import { PAGE_KINDS } from './pages.ts'
import { contrast, hexToRgb, LINK_GROUNDS, LINK_HUES, LINK_THEMES, linkColors, linkCss, rgbToOklch, type Rgb } from './link-colors.ts'

const mid = (a: Rgb, b: Rgb): Rgb => a.map((v, i) => (v + b[i]) / 2) as Rgb

describe('living link colours', () => {
  it('every kind reads at WCAG AA on every ground of every theme, gradient included', () => {
    for (const theme of LINK_THEMES) {
      const colors = linkColors(theme)
      for (const kind of PAGE_KINDS) {
        const [a, b] = colors[kind].map(hexToRgb)
        for (const g of LINK_GROUNDS[theme]) {
          for (const c of [a, b, mid(a, b)]) expect(contrast(c, g), `${kind} on ${theme}`).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
  })

  it('keeps each kind in its own hue', () => {
    for (const theme of ['light', 'zen', 'graphite', 'page-light', 'page-dark'] as const) {
      for (const kind of PAGE_KINDS) {
        const [l, c, h] = rgbToOklch(hexToRgb(linkColors(theme)[kind][0]))
        expect(c, `${kind} in ${theme}`).toBeGreaterThan(0.05)
        const d = Math.abs(((h - LINK_HUES[kind][0] + 540) % 360) - 180)
        expect(d, `${kind} hue in ${theme} (l ${l.toFixed(2)})`).toBeLessThan(25)
      }
    }
  })

  it('gives the app one rule per kind and theme, and one inside weevboss bubbles', () => {
    const css = linkCss()
    for (const kind of PAGE_KINDS) {
      expect(css).toContain(`:root a.living.lk-${kind}{`)
      for (const t of ['dark', 'zen', 'graphite']) expect(css).toContain(`:root[data-theme='${t}'] a.living.lk-${kind}{`)
      expect(css).toContain(`:root[data-theme='graphite'] .msg.orch a.living.lk-${kind}{`)
    }
  })
})
