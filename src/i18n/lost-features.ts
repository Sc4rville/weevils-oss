import { defineMessages } from './index'
export default defineMessages({
  en: {
    title: 'experiments', menuMeta: (state: string) => `Think · ${state.toLowerCase()}`, think: 'Think', description: 'An experimental canvas for notes, images and ideas.',
    scope: 'On this browser', enabled: 'Enabled', disabled: 'Disabled', toggle: 'Enable Think', open: 'Open Think',
    preserved: 'Turning this off keeps your board and history. Requests already sent can finish.',
    failed: 'Could not save this preference. Check browser storage and try again.',
  },
  fr: {
    title: 'expériences', menuMeta: (state: string) => `Think · ${state.toLowerCase()}`, think: 'Think', description: 'Un espace expérimental pour tes notes, images et idées.',
    scope: 'Sur ce navigateur', enabled: 'Activé', disabled: 'Désactivé', toggle: 'Activer Think', open: 'Ouvrir Think',
    preserved: 'Désactiver conserve ton tableau et son historique. Les demandes déjà envoyées peuvent se terminer.',
    failed: 'Impossible d’enregistrer cette préférence. Vérifie le stockage du navigateur et réessaie.',
  },
})
