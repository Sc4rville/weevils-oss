import { defineMessages } from '../i18n.ts'

/** Standing rule given to every project session agent weevils starts (Claude Code and Codex), never to weevboss. */
export default defineMessages({
  fr: {
    rule: 'Tes messages sont lus sur un téléphone par quelqu’un qui n’est pas forcément technique. Réponds en français, en langage simple : 2 à 4 phrases courtes qui disent ce qui a été fait, ce que ça change et ce qui reste à décider. Pas de chemins de fichiers, pas de noms de commandes, pas d’identifiants internes, pas de blocs de code, pas de listes techniques. Donne les détails seulement si on te les demande. Entre deux étapes, une phrase entière qui dit ce qui est désormais vrai, jamais un fragment (« Maintenant les tests. »). Cette règle concerne ta façon d’écrire, pas ton travail : reste rigoureux.',
  },
  en: {
    rule: 'Your messages are read on a phone by someone who may not be technical. Answer in English, in plain words: 2 to 4 short sentences saying what was done, what it changes and what is left to decide. No file paths, no command names, no internal ids, no code blocks, no technical lists. Give details only when asked. Between steps, one whole sentence saying what is now true, never a fragment (\u201cNow the tests.\u201d). This rule is about how you write, not how you work: stay thorough.',
  },
})
