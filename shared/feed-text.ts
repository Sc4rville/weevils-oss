import { withoutMachinePrefix } from './machine-prefix.ts'
import type { ForYouItem } from './foryou.ts'

/** Retired per-commit announcements, including older posts with an ordinary post/digest id. */
export function rawEngineeringNotice(id: string, text = ''): boolean {
  return /^(?:commit|deploy):/.test(id)
    || /(?:\ba un nouveau commit\b|\bhas a new commit\b|\bweevils (?:version|build) [a-f\d]{7,40}\b)/i.test(text)
    || /^\s*(?:[a-f\d]{7,40}\s+)?(?:fix|feat|chore|refactor|test|docs|build|ci|perf|style)(?:\([^\n)]*\))?!?:\s/i.test(text)
}

/** Keep the human result in the feed; technical evidence stays in the session itself. */
export function humanFeedText(text: string): string {
  text = withoutMachinePrefix(text)
  const urls: string[] = []
  text = text.replace(/https?:\/\/[^\s<>"']+|\/p\/(?:opportunities|library|preview|report|render)\/[a-z0-9][a-z0-9-]{0,79}/g, (url) => `§LINK${urls.push(url) - 1}§`)
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^\s*(?:[a-f\d]{7,40}\s+)?(?:fix|feat|chore|refactor|test|docs|build|ci|perf|style)(?:\([^\n)]*\))?!?:[^\n]*$/gmi, '')
    .replace(/^\s*(?:diff --git|@@|\+\+\+ |--- |\$ |git (?:log|show|status|diff|commit)\b|at \S+\([^)]*:\d+)[^\n]*$/gm, '')
    .replace(/\([^()\n]*(?:\bcommit\b|\b[a-f\d]{7,40}\b)[^()\n]*\)/gi, '')
    .replace(/\b[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\b/gi, '')
    .replace(/\b(?=[a-f\d]{7,40}\b)(?=[a-f\d]*[a-f])[a-f\d]{7,40}\b/gi, '')
    .replace(/(?<![\w:/])(?:(?:~|\.{1,2})\/(?:[\w.@~+-]+\/)*[\w.@~+-]+|\/(?:[\w.@~+-]+\/)+[\w.@~+-]+)/g, '')
    .replace(/\b(?:[\w.@+-]+\/)+[\w.@+-]+\.(?:tsx?|jsx?|mjs|cjs|json|ya?ml|md|sh|py|log|lock)\b/g, '')
    .replace(/\b(?!Node\.js\b)[\w-]+\.(?:tsx?|jsx?|mjs|cjs|json|ya?ml|md|sh|py|log|lock)\b/g, '')
    // Test runs and shell commands: evidence for the session, never words for the stream.
    .replace(/^\s*(?:[✓✔✗×]\s|(?:PASS|FAIL)\s|Tests?:\s|Test Files\s)[^\n]*$/gm, '')
    .replace(/^\s*(?:npm|npx|pnpm|yarn|tsc|vitest|sudo|docker|ssh|curl)\s[^\n]*$/gm, '')
    .replace(/`(?:npm|npx|pnpm|yarn|node|tsc|vitest|git|cd|ssh|curl|sudo|docker|make)\s[^`\n]*`/g, '')
    .replace(/[(,;]?\s*\b\d+\s*(?:\/\s*\d+\s*)?(?:tests?|specs?)\s+(?:passed|passing|failed|green|pass(?:ent)?|réussis|verts?)\b\)?/gi, '')
    .replace(/[(,;]?\s*\bexit code\s+\d+\)?/gi, '')
    .replace(/`\s*`/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]+([,.;])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .replace(/§LINK(\d+)§/g, (_, n: string) => urls[Number(n)] ?? '')
}

export function humanFeedItem(item: ForYouItem): ForYouItem {
  return { ...item, text: humanFeedText(item.text),
    ...(item.title ? { title: humanFeedText(item.title) } : {}),
    ...(item.body ? { body: humanFeedText(item.body) } : {}),
    ...(item.moreText ? { moreText: humanFeedText(item.moreText) } : {}),
  }
}


/** Coordination acknowledgements are not product outcomes. No minimum length: short facts survive. */
export function acknowledgementOnly(text: string): boolean {
  const prose = humanFeedText(text).replace(/\*\*|__/g, '').replace(/\[(?:PC|VPS)\]/gi, '').trim()
  // Administrative handoffs refusing another agent's message are not a user-facing outcome.
  // A real question or a product blocker without these handoff markers stays visible.
  const handoff = /(?:transmission d['’]agent|autorisation relayée|audit en lecture seule|consigne.{0,50}lecture seule)/i.test(prose)
  const refusal = /(?:fichiers inchangés|aucune (?:publication|modification)|je ne (?:modifie|publie|change)|incompatible avec cette restriction|ne (?:sera|seront) (?:copié|modifié)|ne modifie pas)/i.test(prose)
  if (handoff && refusal) return true
  const acknowledgement = /^(?:compris|bien (?:reçu|noté)|reçu|noté|ok(?:ay)?|d['’]accord|merci|aucun (?:conflit|chevauchement|travail en cours)|coordination confirmée|réception confirmée|understood|got it|noted|acknowledged|no (?:conflict|overlap)|état git et transcript relus)(?=$|[\s.!,:])/i.test(prose)
    || /^(?:depuis weevils|pont codex) ok[.!\s]*$/i.test(prose)
  if (!acknowledgement) return false
  const outcome = /https?:\/\/|\b(?:corrigée?s?|livrée?s?|déployée?s?|ajoutée?s?|supprimée?s?|retirée?s?|créée?s?|réparée?s?|en ligne|fonctionne|fixed|deployed|shipped|removed|created|works)(?=$|[^\p{L}])/iu.test(prose)
  return !outcome
}

/** Source-level editorial gate: an agent's bookkeeping is not a product result. */
export function internalFeedUpdate(text: string): boolean {
  const plain = humanFeedText(text).replace(/\*\*|__/g, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  const clauses = plain.split(/(?<=[.!?;])\s+|\n+/)
  const product = /\b(?:image|images|rendu|rendus|render|renders|video|clip|galerie|gallery|interface|bouton|button|navigation|notification|notifications|feed|flux|export|import|logo|audio|son|sound|preview|apercu|animation|search|recherche|upload|attachment|piece jointe|jump|saut|game|jeu)\b/
  const delivered = /\b(?:pret|prets|prete|ready|livre|livree|shipped|corrige|corrigee|fixed|repare|reparee|repaired|affiche|affichee|displayed|ajoute|ajoutee|added|removed|retire|retiree|supprime|supprimee|fonctionne|works|disponible|available|ralenti|slowed|synchronise|synchronized)\b|\ben ligne\b|\bis (?:back|in)\b/
  const useful = clauses.some(s => product.test(s) && delivered.test(s) && !/\b(?:pas encore|not yet|aucun resultat|no result|sera|seront|will be|would be|pourrait|could be)\b/.test(s))
    || /(?:voici|voir|essayer|here|view|try).{0,60}(?:resultat|rendu|preview|apercu|demo).{0,60}https?:\/\//.test(plain)
  if (useful) return false
  const administrative = /\b(?:relais automatique|autorisation durable|automatic (?:agent )?handoff|persistent handoff authorization|branche confirmee|branch confirmed|confirmed branch|preparation confirmee|preparation confirmed|coordination|handoff|passation|aucun conflit|no overlap|no conflict|points de revue|review points|cadre.{0,30}(?:pose|defini)|scope.{0,30}(?:defined|confirmed)|nothing left to check|work (?:was )?already finished|task (?:was )?already done|tache (?:etait )?deja terminee|pr privee.{0,20}brouillon|private draft pr)\b/.test(plain)
  const configuration = /\b(?:niveau (?:de )?(?:raisonnement|reflexion)|reasoning(?: effort| level)?|raisonnement.{0,40}(?:low|high|regle)|(?:modele|model) (?:actif|active|courant|current|confirme|confirmed)|(?:monter|augmenter|raise|increase).{0,40}(?:effort|reflexion|raisonnement)|(?:gpt[ -]?[0-9]|codex|claude).{0,60}\b(?:low|high|effort))\b/.test(plain)
  return /^(?:confirme|confirmed)[.!\s]*$/.test(plain.trim()) || administrative || configuration || acknowledgementOnly(text)
}

/** Remove internal sentences from a mixed editorial recap, keeping the actual useful outcome verbatim. */
export function editorialFeedText(text: string): string {
  const parts = text.split(/(?<=[.!?;])(?=\s)|(?=\n)/)
  const kept = parts.filter(s => !internalFeedUpdate(s))
  return kept.length === parts.length ? text : kept.join('').replace(/\n{3,}/g, '\n\n').trim()
}
