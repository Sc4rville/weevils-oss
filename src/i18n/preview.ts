import { defineMessages } from './index'

export default defineMessages({
  fr: {
    close: 'fermer le navigateur',
    address: 'adresse à afficher',
    reload: 'recharger',
    openTab: 'ouvrir dans un onglet',
    frame: 'aperçu de l’application',
    grow: 'la page en grand',
    shrink: 'revoir la session',
    /** Aucune adresse devinée (ni dans la conversation, ni de domaine de preview) : le volet n'est pas vide sans raison. */
    noUrl: 'aucune adresse trouvée dans la session : tape celle de l’appli',
  },
  en: {
    close: 'close the browser',
    address: 'address to show',
    reload: 'reload',
    openTab: 'open in a new tab',
    frame: 'app preview',
    grow: 'page full screen',
    shrink: 'back to the session',
    noUrl: 'no address found in the session: type the app’s address',
  },
})
