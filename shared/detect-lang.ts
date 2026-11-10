// Langue d'un texte (fr ou en), pour que la voix parle la langue du message et non celle d'un réglage global.
// Mots outils et accents : assez pour une phrase de conversation ; null quand rien ne permet de trancher.

import type { Lang } from './i18n.ts'

const FR = new Set(
  // i18n-ignore : lexique de détection, jamais affiché
  "je j' tu il elle nous vous ils elles le la les l' un une des du de d' au aux et ou mais donc est sont suis es ai as a été être avoir pas ne n' plus que qu' qui quoi quand comment pourquoi où ce cet cette ces c' ça ca se s' sa son ses mon ma mes ton ta tes leur leurs pour avec dans sur sous chez par sans entre vers oui non merci bonjour salut voilà fais fait faire regarde lance dis peux veux va vais là ici aussi très bien encore déjà tout tous rien il y a".split(' '),
)
const EN = new Set(
  "i i'm i've i'll you you're he she we they it it's the a an and or but so is are was were be been being have has had do does did don't doesn't not no yes that this these those what when how why where who which to of in on at for with from by about into than then there here just also very well still already all nothing please thanks thank hello hi let's look can could will would should my your our their its".split(' '),
)

export function detectLang(text: string): Lang | null {
  const words = text
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/https?:\/\/\S+/g, ' ')
    .split(/[^a-zà-ÿœæ']+/)
    .filter(Boolean)
  let fr = 0
  let en = 0
  for (const w of words) {
    // « l'app », « c'est » : l'élision compte pour le français.
    const head = w.includes("'") ? `${w.split("'")[0]}'` : w
    if (FR.has(w) || (head !== w && FR.has(head))) fr++
    if (EN.has(w)) en++
  }
  fr += Math.min(4, (text.match(/[éèêàçùûôîœ]/gi) ?? []).length) * 0.5
  if (fr === en) return null
  return fr > en ? 'fr' : 'en'
}
