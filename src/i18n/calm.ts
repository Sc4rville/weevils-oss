import { defineMessages } from './index'

export default defineMessages({
  fr: {
    back: 'retour',
    options: 'options',
    /** Le volet qui montre l'appli en cours de construction (pas pour weevboss). */
    seeApp: 'voir l’appli',
    closeApp: 'fermer l’appli',
    writeTo: (who: string) => `écris à ${who}`,
    messageTo: (who: string) => `message à ${who}`,
  },
  en: {
    back: 'back',
    options: 'options',
    seeApp: 'see the app',
    closeApp: 'close the app',
    writeTo: (who: string) => `write to ${who}`,
    messageTo: (who: string) => `message to ${who}`,
  },
})
