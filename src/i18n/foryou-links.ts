import { defineMessages } from './index'
export default defineMessages({
  fr: {
    open: (name: string) => name ? `Ouvrir ${name}` : 'Ouvrir l’aperçu',
    conversation: 'Conversation',
    unavailable: 'Cet aperçu n’est pas disponible actuellement.',
  },
  en: {
    open: (name: string) => name ? `Open ${name}` : 'Open preview',
    conversation: 'Conversation',
    unavailable: 'This preview is currently unavailable.',
  },
})
