import type { ForYouItem } from './foryou.ts'
import { asksUser } from './asks.ts'
import { acknowledgementOnly, humanFeedText, rawEngineeringNotice } from './feed-text.ts'

/** A notification needs an understandable completed outcome, not a transcript fragment. */
export function notificationText(raw: string): string {
  if (acknowledgementOnly(raw) || rawEngineeringNotice('', raw)) return ''
  const clean = humanFeedText(raw).replace(/\*\*|__/g, '').trim().replace(/^(?:compris|bien reçu|got it|ok)[.!,:]\s*/i, '')
  const lines = clean.split(/\n+|(?<=[.!?])\s+/).map(s => s.replace(/^[-*]\s*/, '').trim())
  const outcome = /\b(?:corrigee?s?|reparee?s?|livree?s?|terminee?s?|achevee?s?|ajoutee?s?|creee?s?|supprimee?s?|disponibles?|fonctionne(?:nt)?|pret(?:e)?s?|ready|fixed|works|shipped|completed|available|created|added|removed)\b|\ben ligne\b|\bare in\b/i
  const progress = /^(?:je vais|je (?:vérifie|prépare|continue|lance|regarde)|en cours|prochaine étape|i(?:'ll| will)|checking|working on|next step)/i
  const engineering = /^(?:tests?|typecheck|lint|build|commit|git|[0-9]+ tests?|[0-9]+\/\d+|sha|hash)\b/i
  const found = lines.find(s => !progress.test(s) && !engineering.test(s) && !/^(?:si|quand|lorsque|if|when)\b|\b(?:sera|seront|serait|seraient|pourrait|pourraient|will|would|could)\b/i.test(s) && outcome.test(s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')) && !/pas (?:encore )?(?:prêt|terminé|corrigé)|not (?:yet )?(?:ready|done|fixed)|ne.{0,35}fonctionne pas/i.test(s) && s.split(/\s+/).length >= 3)
  if (!found) return ''
  if (found.length <= 220) return found
  return found.slice(0, 217).replace(/\s+\S*$/, '') + '…'
}

export function notificationQuestion(text: string): string {
  if (acknowledgementOnly(text) && /transmission d['’]agent|autorisation relayée/i.test(text)) return ''
  return asksUser(text)?.text || (/^(?:Claude|Codex) needs your permission to \S/i.test(text.trim()) ? text.trim() : '')
}

/** Editorial content remains in the voluntarily opened feed, never in intrusive previews. */
export function notificationEligible(item: ForYouItem): boolean {
  if (item.visualProposal || item.composition) return false
  if (/^(?:r:|d:|commit:|deploy:)/.test(item.id)) return false
  if (['boss', 'insight', 'improve', 'stat', 'proposals', 'mail'].includes(item.kind)) return false
  if (item.kind === 'alert') return !!(item.open || item.reply || item.actions?.length)
  if (item.kind === 'session' && item.tone === 'question') return !!notificationQuestion(item.body || item.text)
  if (item.kind === 'session' && item.tone === 'alert') return !!(item.open || item.reply || item.actions?.length)
  if (item.kind === 'session' && item.tone !== 'result') return false
  return !!notificationText(item.body || item.text || item.title || '')
}
