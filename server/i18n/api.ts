// Messages of server/index.ts: HTTP API errors shown in the app.
import { defineMessages } from '../i18n.ts'

export default defineMessages({
  fr: {
    bodyTooLarge: 'corps trop grand',
    badJson: 'JSON invalide',
    notBuilt: 'l’app n’est pas encore construite : relance l’installation de weevils',
    wrongCode: 'code incorrect',
    sessionNotFound: 'session introuvable',
    subagentNotFound: 'sous-agent introuvable',
    conversationNotFound: 'conversation introuvable',
    fileTooLarge: 'fichier trop gros (1 Go max)',
    signInRequired: 'connexion requise',
    localTokenMissing: 'connexion requise : cette commande de la machine n’envoie pas le jeton local de weevils (~/.local/share/weevils/local-token). Mets weevils à jour (~/weevils/install.sh), ou relance la commande.',
    localTokenWrong: 'connexion requise : le jeton local envoyé n’est pas celui de ce weevils (~/.local/share/weevils/local-token).',
    unknownRoute: 'route inconnue',
    /** Siri asked for a voice clip that is no longer kept. */
    clipExpired: 'son expiré',
    /** A script or an automated browser on this machine tried to write to weevboss as the user. */
    bossUserOnly: 'toi seul peux écrire à weevboss : les tests passent par une copie de test',
  },
  en: {
    bodyTooLarge: 'request too large',
    badJson: 'invalid JSON',
    notBuilt: 'the app isn’t built yet: run the weevils installer again',
    wrongCode: 'wrong code',
    sessionNotFound: 'session not found',
    subagentNotFound: 'subagent not found',
    conversationNotFound: 'conversation not found',
    fileTooLarge: 'file too large (1 GB max)',
    signInRequired: 'sign-in required',
    localTokenMissing: 'sign-in required: this command on the machine does not send weevils’ local token (~/.local/share/weevils/local-token). Update weevils (~/weevils/install.sh), or run the command again.',
    localTokenWrong: 'sign-in required: the local token sent is not this weevils’ (~/.local/share/weevils/local-token).',
    unknownRoute: 'unknown route',
    clipExpired: 'clip expired',
    bossUserOnly: 'only you can write to weevboss: tests and scripts use a test copy',
  },
})
