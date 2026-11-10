// « Attend l'utilisateur » sans dialogue à l'écran : le tour de l'agent principal est fini sur une question ou une demande
// d'action (lien à ouvrir, valeur à coller, choix à faire), et l'utilisateur n'a rien répondu. Ses sous-agents peuvent
// encore tourner : la session attend quand même (TLO, 2026-11-10 : six agents en arrière-plan cachaient une question).

export interface Ask {
  /** link : un lien à ouvrir ; paste : une valeur à coller (adresse, clé, code) ; question : une réponse ou un choix. */
  kind: 'link' | 'paste' | 'question'
  /** La phrase qui demande, courte (notification, ligne de la bande). */
  text: string
  url?: string
}

const URL_RE = /https?:\/\/[^\s<>()"'`]+/g
/** Une demande adressée à l'utilisateur (impératif ou formule de demande), en français ou en anglais. */
const REQUEST =
  /^(?:(?:s['’]il (?:te|vous) pla[iî]t|please|merci de|pour continuer[, :]*)\s+)?(?:colle[sz]?(?:-moi)?|valide[sz]?|confirme[sz]?|choisis|choisissez|dis-moi|dites-moi|réponds|répondez|ouvre[sz]?|clique[sz]?|envoie-moi|donne-moi|autorise[sz]?|approuve[sz]?|tape[sz]?|à toi de|j['’]ai besoin de toi|j['’]ai besoin que tu|il me faut (?:ton|ta|tes|votre)|paste|confirm|approve|choose|pick one|let me know|tell me|open (?:this|the)|click|send me|give me|reply|i need you to|your call|waiting for you)(?=[\s,:;.!?—-]|$)/iu
/** Discard terminal tags and Markdown layout, but never turn quoted/reported speech into a request. */
const plainSentence = (s: string) => s.replace(/^\[[^\]\n]{1,12}\]\s*/, '').replace(/^(?:[-*]|\d+[.)])\s+/, '').replace(/\*\*|__/g, '').trim()
const REPORTED = /^(?:je (?:confirme|demande|vais)|(?:l['’]agent|claude|codex|runpod|weevboss|the agent)\s|question (?:réglée|résolue|précédente)|(?:le|la) (?:message|question) (?:dit|était)|(?:the|previous) (?:question|message) (?:was|said))/iu
const directRequest = (s: string) => REQUEST.test(plainSentence(s))
const directQuestion = (s: string) => {
  const prose = plainSentence(s).replace(URL_RE, ' ')
  return /\?(?:[\s»”"']|$)/.test(prose) && !REPORTED.test(prose) && !/^[>«”"']/.test(prose)
}
const PASTE = /\b(colle[sz]?|coller|paste|adresse|address|clé|cle|key|token|jeton|code|mot de passe|password|identifiant|id)\b/i

/** Les dernières phrases d'un message, sans les blocs de code ni les URL (dont le « ? » n'est pas une question). */
function tail(text: string): string {
  const prose = text.replace(/```[\s\S]*?```/g, ' ').trim()
  const paras = prose.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  return paras.slice(-2).join('\n')
}

const sentences = (s: string) => s.split(/(?<=[.!?…])\s+|\n+/).map((x) => x.trim()).filter(Boolean)

/** Le dernier message de l'agent demande-t-il quelque chose à l'utilisateur ? */
export function asksUser(text: string): Ask | null {
  const end = tail(text)
  if (!end) return null
  const list = sentences(end)
  const asking = list.filter((s) => directQuestion(s) || directRequest(s))
  if (!asking.length) return null
  const said = asking.at(-1)!.replace(/\s+/g, ' ').slice(0, 180)
  const url = [...end.matchAll(URL_RE)].map((m) => m[0].replace(/[.,;:!?»”’"')\]]+$/, '')).at(-1)
  const req = asking.join(' ')
  if (url && /\b(ouvre[sz]?|clique[sz]?|valide[sz]?|autorise[sz]?|approuve[sz]?|connecte|open|click|approve|visit|sign in|log in)\b/i.test(req)) return { kind: 'link', text: said, url }
  if (PASTE.test(req) && asking.some(directRequest)) return { kind: 'paste', text: said }
  return { kind: 'question', text: said, ...(url ? { url } : {}) }
}
