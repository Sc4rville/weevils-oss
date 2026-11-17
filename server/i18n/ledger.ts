// weevboss's request ledger (server/boss-ledger.ts, server/boss-ledger-http.ts): API errors.
import { defineMessages } from '../i18n.ts'

export default defineMessages({
  fr: {
    noRequest: 'demande introuvable',
    noGoal: 'objectif introuvable',
    noMemory: 'note introuvable',
    empty: 'texte vide',
    badAction: 'action inconnue',
    secret: 'ça ressemble à un secret : pas retenu',
  },
  en: {
    noRequest: 'request not found',
    noGoal: 'goal not found',
    noMemory: 'note not found',
    empty: 'empty text',
    badAction: 'unknown action',
    secret: 'looks like a secret: not kept',
  },
})
