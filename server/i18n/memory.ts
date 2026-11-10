// Memory (server/memory.ts): API errors (empty, unknown, a secret refused) and the marker of an unanswered question in prompts.
import { defineMessages } from '../i18n.ts'

export default defineMessages({
  fr: {
    empty: 'souvenir vide',
    notFound: 'souvenir introuvable',
    secret: 'ça ressemble à un secret : pas retenu',
    noAnswer: ' (pas de réponse)',
  },
  en: {
    empty: 'empty memory',
    notFound: 'memory not found',
    secret: 'looks like a secret: not kept',
    noAnswer: ' (no answer)',
  },
})
