// Messages of server/index.ts: HTTP API errors shown in the app.
import { defineMessages } from '../i18n.ts'

export default defineMessages({
  fr: {
    bodyTooLarge: 'corps trop grand',
    badJson: 'JSON invalide',
    notBuilt: 'l’app n’est pas encore construite : relance l’installation de weevils',
    wrongCode: 'code incorrect',
    sessionNotFound: 'session introuvable',
    conversationNotFound: 'conversation introuvable',
    fileTooLarge: 'fichier trop gros (1 Go max)',
    signInRequired: 'connexion requise',
    unknownRoute: 'route inconnue',
    /** Siri asked for a voice clip that is no longer kept. */
    clipExpired: 'son expiré',
  },
  en: {
    bodyTooLarge: 'request too large',
    badJson: 'invalid JSON',
    notBuilt: 'the app isn’t built yet: run the weevils installer again',
    wrongCode: 'wrong code',
    sessionNotFound: 'session not found',
    conversationNotFound: 'conversation not found',
    fileTooLarge: 'file too large (1 GB max)',
    signInRequired: 'sign-in required',
    unknownRoute: 'unknown route',
    clipExpired: 'clip expired',
  },
})
