// Sélection dans la vue d'un fichier : mots, plages de mots, lignes entières. Pur, testé (codesel.test.ts).

export interface Pos {
  line: number
  col: number
}

/** Une sélection : de start (inclus) à end (exclu), sur des lignes numérotées à partir de 0. */
export interface Sel {
  start: Pos
  end: Pos
  /** Lignes entières (choisies dans la marge des numéros). */
  lines?: boolean
}

/** Un mot : identifiant (lettres, chiffres, _ et $), ou suite de signes (=>, !==, …). Les espaces ne sont jamais un mot. */
const TOKEN = /[\p{L}\p{N}_$]+|[^\s\p{L}\p{N}_$]+/gu

/** Le mot qui contient la colonne col (le caractère à cet index), ou null sur un espace / hors de la ligne. */
export function wordAt(text: string, col: number): [number, number] | null {
  if (col < 0 || col >= text.length) return null
  for (const m of text.matchAll(TOKEN)) {
    const s = m.index ?? 0
    if (s > col) break
    if (col < s + m[0].length) return [s, s + m[0].length]
  }
  return null
}

const before = (a: Pos, b: Pos) => a.line < b.line || (a.line === b.line && a.col < b.col)

/** Glissé depuis le mot d'ancrage jusqu'au doigt : la plage s'étend aux mots entiers, dans un sens comme dans l'autre. */
export function spanWords(lines: string[], anchor: Pos, focus: Pos): Sel {
  const a = wordAt(lines[anchor.line] ?? '', anchor.col) ?? [anchor.col, anchor.col]
  const ftext = lines[focus.line] ?? ''
  const f = wordAt(ftext, focus.col) ?? wordAt(ftext, focus.col - 1) ?? [focus.col, focus.col]
  const aStart = { line: anchor.line, col: a[0] }
  const fStart = { line: focus.line, col: f[0] }
  if (before(fStart, aStart)) return { start: fStart, end: { line: anchor.line, col: a[1] } }
  return { start: aStart, end: { line: focus.line, col: Math.max(f[1], focus.line === anchor.line ? a[1] : 0) } }
}

/** Lignes entières de a à b (dans n'importe quel ordre). */
export function spanLines(lines: string[], a: number, b: number): Sel {
  const [s, e] = a <= b ? [a, b] : [b, a]
  return { start: { line: s, col: 0 }, end: { line: e, col: (lines[e] ?? '').length }, lines: true }
}

/** Partie sélectionnée d'une ligne [début, fin), ou null si la ligne est hors de la sélection. */
export function lineRange(sel: Sel | null, i: number, len: number): [number, number] | null {
  if (!sel || i < sel.start.line || i > sel.end.line) return null
  return [i === sel.start.line ? sel.start.col : 0, i === sel.end.line ? sel.end.col : len]
}

export function selText(lines: string[], sel: Sel): string {
  const out: string[] = []
  for (let i = sel.start.line; i <= sel.end.line; i++) {
    const r = lineRange(sel, i, (lines[i] ?? '').length)!
    out.push((lines[i] ?? '').slice(r[0], r[1]))
  }
  return out.join('\n')
}

/** Les lignes autour de [from, to] (0-based), numérotées à partir de 1, pour donner le contexte au modèle. */
export function around(lines: string[], from: number, to: number, pad = 20, max = 80): string {
  const s = Math.max(0, from - pad)
  const e = Math.min(lines.length - 1, Math.max(to, from) + pad, s + max - 1)
  const out: string[] = []
  for (let i = s; i <= e; i++) out.push(`${i + 1}│ ${lines[i]}`)
  return out.join('\n')
}
