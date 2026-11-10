// Devil mode (server/devil.ts) : erreurs renvoyées à l'app.
import { defineMessages } from '../i18n.ts'

export default defineMessages({
  fr: {
    notConnected: 'modèle non branché',
    /** Dit dans le fil quand le modèle n'est pas configuré ou injoignable. */
    notReady: 'abli n’est pas encore branché',
    empty: 'message vide',
    busy: 'il répond encore',
    failed: (why: string) => `(pas de réponse du modèle : ${why})`,
  },
  en: {
    notConnected: 'model not connected',
    notReady: 'abli isn’t connected yet',
    empty: 'empty message',
    busy: 'still answering',
    failed: (why: string) => `(no answer from the model: ${why})`,
  },
})
