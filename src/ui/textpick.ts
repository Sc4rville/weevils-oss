// Le texte sous le doigt, dans n'importe quel bloc rendu : nœuds texte retenus, offsets « à plat », plages à l'écran.
// Partagé par la vue fichier (codeview.tsx) et les fils de conversation (askthread.tsx).

import { wordAt } from './codesel'

/** Ce qui ne fait pas partie du texte d'un message : le nom de l'auteur, les boutons, la barre de questions. */
const SKIP = '.who, button, .qa, .copy'

const keep = (n: Node) => !n.parentElement?.closest(SKIP)

export function textNodes(root: Element): Text[] {
  const out: Text[] = []
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walk.nextNode(); n; n = walk.nextNode()) if (keep(n)) out.push(n as Text)
  return out
}

export const flatText = (root: Element) => textNodes(root).map((n) => n.data).join('')

/** Le caractère d'insertion au point (x, y), quel que soit le navigateur. */
export function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const d = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null }
  if (d.caretPositionFromPoint) {
    const p = d.caretPositionFromPoint(x, y)
    return p ? { node: p.offsetNode, offset: p.offset } : null
  }
  const r = document.caretRangeFromPoint?.(x, y)
  return r ? { node: r.startContainer, offset: r.startOffset } : null
}

/** Offset « à plat » d'une position DOM dans root, ou null si elle tombe hors du texte retenu. */
export function offsetOf(root: Element, node: Node, offset: number): number | null {
  let pos = 0
  for (const n of textNodes(root)) {
    if (n === node) return pos + Math.min(offset, n.data.length)
    pos += n.data.length
  }
  return null
}

/** La plage DOM des caractères [s, e) de root (le texte peut être coupé en plusieurs nœuds). */
export function rangeOf(root: Element, s: number, e: number): Range | null {
  const r = document.createRange()
  let pos = 0
  let started = false
  for (const n of textNodes(root)) {
    const len = n.data.length
    if (!started && s <= pos + len) {
      r.setStart(n, s - pos)
      started = true
    }
    if (started && e <= pos + len) {
      r.setEnd(n, e - pos)
      return r
    }
    pos += len
  }
  return null
}

const inside = (r: Range, x: number, y: number) => {
  for (const rect of r.getClientRects()) if (x >= rect.left - 3 && x <= rect.right + 3 && y >= rect.top - 2 && y <= rect.bottom + 2) return true
  return false
}

/**
 * Le mot (ou le chemin) vraiment sous le doigt dans root : le curseur tombe entre deux caractères, on garde celui des
 * deux dont le rectangle contient le point. `pick` choisit l'unité (mot, chemin…) autour d'une colonne.
 */
export function wordUnder(root: Element, flat: string, x: number, y: number, pick: (text: string, col: number) => [number, number] | null = wordAt): { col: number; word: [number, number] | null } | null {
  const c = caretAt(x, y)
  if (!c) return null
  const col = offsetOf(root, c.node, c.offset)
  if (col == null) return null
  for (const k of [col, col - 1]) {
    const w = pick(flat, k)
    const r = w && rangeOf(root, w[0], w[1])
    if (w && r && inside(r, x, y)) return { col: k, word: w }
  }
  return { col, word: null }
}

const EXT = 'ts|tsx|js|jsx|mjs|cjs|json|md|css|scss|html|py|sh|rs|go|rb|java|kt|swift|c|h|cpp|yml|yaml|toml|txt|svg|env|sql|lock|vue|svelte|ini|conf|service|log'
const PATHISH = new RegExp(`^(?:[~.]?/)?(?:[\\w.@+-]+/)*[\\w.@+-]+(?:\\.(?:${EXT}))?(?::\\d+)?$`)

/**
 * Un chemin de fichier autour de col (« src/ui/x.tsx », « ~/projects/r/a.md:12 », « fast.ts ») : une suite sans espaces
 * qui contient un « / » ou finit par une extension connue. Sinon null.
 */
export function pathAt(text: string, col: number): [number, number] | null {
  if (col < 0 || col >= text.length || /[\s'"`()[\]{}<>,;|]/.test(text[col])) return null
  let s = col
  let e = col + 1
  while (s > 0 && !/[\s'"`()[\]{}<>,;|]/.test(text[s - 1])) s--
  while (e < text.length && !/[\s'"`()[\]{}<>,;|]/.test(text[e])) e++
  // Ponctuation de fin de phrase.
  while (e > s && /[.:!?]/.test(text[e - 1])) e--
  const tok = text.slice(s, e)
  if (col >= e || !PATHISH.test(tok)) return null
  const bare = tok.replace(/:\d+$/, '')
  if (!bare.includes('/') && !new RegExp(`\\.(?:${EXT})$`).test(bare)) return null
  if (!/[a-z]/i.test(bare) || /^\.+\/?$/.test(bare)) return null
  return [s, e]
}

/** Le chemin d'abord (pour « ouvre le fichier »), sinon le mot. */
export const pathOrWord = (text: string, col: number) => pathAt(text, col) ?? wordAt(text, col)
