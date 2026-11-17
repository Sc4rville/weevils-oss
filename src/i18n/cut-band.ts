import { defineMessages } from './index'

export default defineMessages({
  fr: {
    cutWhy: (reason: string) =>
      ({ died: 'arrêt inattendu', dirty: 'changements non enregistrés', quota: 'limite d’usage atteinte', auth: 'compte déconnecté', api: 'le service a échoué' })[reason] ?? 'arrêtée',
    /** Le message d'erreur brut de l'outil, replié. */
    cutDetail: 'détails',
    dismiss: 'laisser',
    /** Compte déconnecté : la connexion se fait dans le fil de weevboss (un lien, puis un code à coller). */
    signInAgain: 'me reconnecter',
    signInAria: (tool: string) => `reconnecter ${tool} dans le fil de weevboss`,
  },
  en: {
    cutWhy: (reason: string) =>
      ({ died: 'unexpected stop', dirty: 'unsaved changes', quota: 'usage limit reached', auth: 'signed out', api: 'the service failed' })[reason] ?? 'stopped',
    cutDetail: 'details',
    dismiss: 'dismiss',
    signInAgain: 'sign in again',
    signInAria: (tool: string) => `sign ${tool} in again in weevboss’s thread`,
  },
})
