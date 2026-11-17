import type { ForYouItem } from '../shared/foryou.ts'
import reviewed from './foryou-editorial-reviewed.json' with { type: 'json' }

/** Reviewed against the original sources, not inferred from a headline. Exact source
 * matching makes this an editorial revision, never an overwrite of a later update. */
export function reviewedEditorial(item: ForYouItem, original: string): ForYouItem {
  const edit = reviewed.find(e => e.id === item.id && e.kind === item.kind && e.source === original)
  if (!edit) return item
  return { ...item, text: edit.text, editorial: { original: { text: original } } }
}

/** No lossy clipping: a final sentence can contain the blocker or qualification.
 * The only automatic fallback removes delegation scaffolding; all facts stay.
 * Quoted content is never edited by that fallback. Rejected output waits for the
 * next normal curator pass; it must not trigger another model call. */
export function editorialText(value: string, max: number): string {
  let text = value.trim()
  if (!/[«»“”"`]/u.test(text)) {
    // i18n-ignore: bilingual recognition of generated delegation scaffolding
    text = text.replace(/\b(?:I suggest asking|Ask) weevboss to (prepare|review|show|check)\b/giu, (_, verb: string) => verb[0].toUpperCase() + verb.slice(1).toLowerCase())
      .replace(/\b(?:Je te propose de demander|Demande) à weevboss de (préparer|vérifier|montrer|revoir)\b/giu, (_, verb: string) => verb[0].toUpperCase() + verb.slice(1))
  }
  // i18n-ignore: internal quality patterns, not displayed text
  const machinery = /\b(?:\d[\d, ]* tests? (?:passed|passent|verts)|commit [a-f0-9]{7,40}|I suggest asking|demander à weevboss de|great progress|belle progression)\b/iu
  if (!text || text.length > max || machinery.test(text)) return ''
  // Sentence counting ignores URLs, quoted material and decimal points. Never
  // truncate to meet the default: keep necessary decision/alert detail or skip.
  const prose = text.replace(/https?:\/\/\S+|«[^»]*»|“[^”]*”|"[^"\n]*"|`[^`]*`/gu, '')
  const sentences = prose.split(/(?<=[.!?])\s+/u).filter(Boolean)
  // i18n-ignore: bilingual qualification recognition
  const qualified = /\b(?:before|until|unless|blocked|needs?|still|not|avant|tant que|sauf|bloqu|reste|pas)\b/iu.test(prose)
  if (sentences.length > (qualified ? 4 : 2)) return ''
  return text
}
