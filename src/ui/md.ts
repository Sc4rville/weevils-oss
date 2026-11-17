/**
 * Agent replies as structure, the way a chat app reads them: headings, paragraphs, lists, quotes, tables and code.
 * Line based and forgiving (an agent's markdown is never strict); no HTML is ever produced, only these blocks.
 */
export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'para'; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { kind: 'quote'; text: string }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'code'; body: string; lang: string }
  | { kind: 'rule' }

export type ListItem = { text: string; sub: string[] }

const FENCE = /^\s*(```|~~~)\s*([\w+-]*)/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const ITEM = /^(\s*)(?:([-*+•])|(\d{1,3})[.)])\s+(.*)$/
const QUOTE = /^\s{0,3}>\s?(.*)$/
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
/** A line that is only bold (« **Next steps** » or « **Next steps:** ») reads as a small heading. */
const BOLD_LINE = /^\s*\*\*([^*\n]{1,80}?)\*\*\s*:?\s*$/

const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())

export function blocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out: Block[] = []
  let para: string[] = []
  const flush = () => {
    const t = para.join('\n').trim()
    if (t) out.push({ kind: 'para', text: t })
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = FENCE.exec(line)
    if (fence) {
      flush()
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++])
      out.push({ kind: 'code', body: body.join('\n').replace(/\s+$/, ''), lang: fence[2] })
      continue
    }
    if (!line.trim()) { flush(); continue }
    const h = HEADING.exec(line)
    if (h) {
      flush()
      out.push({ kind: 'heading', level: Math.min(3, h[1].length) as 1 | 2 | 3, text: h[2] })
      continue
    }
    const b = BOLD_LINE.exec(line)
    if (b && !para.length) {
      out.push({ kind: 'heading', level: 3, text: b[1].replace(/:$/, '') })
      continue
    }
    if (RULE.test(line)) { flush(); out.push({ kind: 'rule' }); continue }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('|')) {
      flush()
      const head = cells(line)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]))
      i--
      out.push({ kind: 'table', head, rows })
      continue
    }
    if (QUOTE.test(line)) {
      flush()
      const q: string[] = []
      while (i < lines.length && QUOTE.test(lines[i])) q.push(QUOTE.exec(lines[i++])![1])
      i--
      out.push({ kind: 'quote', text: q.join('\n').trim() })
      continue
    }
    const it = ITEM.exec(line)
    if (it) {
      flush()
      const ordered = !!it[3]
      const base = it[1].length
      const items: ListItem[] = []
      while (i < lines.length) {
        const l = lines[i]
        const m = ITEM.exec(l)
        if (m && m[1].length <= base + 1 && !!m[3] === ordered) items.push({ text: m[4], sub: [] })
        else if (m && m[1].length > base + 1 && items.length) items[items.length - 1].sub.push(m[4])
        else if (l.trim() && /^\s+\S/.test(l) && items.length && !m) items[items.length - 1].text += `\n${l.trim()}`
        else break
        i++
      }
      i--
      out.push({ kind: 'list', ordered, start: ordered ? Number(it[3]) : 1, items })
      continue
    }
    para.push(line)
  }
  flush()
  return out
}

/** Inline emphasis around the bits Rich already reads (links, `code`, chips): bold and italic, never inside code. */
export type Span = { kind: 'text' | 'strong' | 'em'; s: string }

const EMPH = /(`[^`\n]+`)|\*\*(?=\S)(.+?)(?<=\S)\*\*|__(?=\S)(.+?)(?<=\S)__|(?<![\w*])\*(?=[^\s*])([^*\n]+?)(?<=\S)\*(?![\w*])|(?<![\w_])_(?=[^\s_])([^_\n]+?)(?<=\S)_(?![\w_])/g

export function spans(text: string): Span[] {
  const out: Span[] = []
  let last = 0
  const push = (kind: Span['kind'], s: string) => {
    const prev = out[out.length - 1]
    if (kind === 'text' && prev?.kind === 'text') prev.s += s
    else if (s) out.push({ kind, s })
  }
  for (const m of text.matchAll(EMPH)) {
    const i = m.index ?? 0
    // A link's target may hold underscores or stars: a match inside « (http…) » is left as text.
    if (!m[1] && /\]\([^)\s]*$/.test(text.slice(0, i))) continue
    push('text', text.slice(last, i))
    if (m[1]) push('text', m[1])
    else if (m[2] ?? m[3]) push('strong', (m[2] ?? m[3])!)
    else push('em', (m[4] ?? m[5])!)
    last = i + m[0].length
  }
  push('text', text.slice(last))
  return out
}
