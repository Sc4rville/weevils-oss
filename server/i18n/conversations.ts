// Messages of server/conversations.ts (imported ChatGPT / Claude conversations).
import { defineMessages } from '../i18n.ts'

export default defineMessages({
  fr: {
    noJsonInZip: 'conversations.json introuvable dans le zip',
    notFound: 'conversation introuvable',
    /** Speakers in the excerpt given to the classifier. */
    me: 'Moi',
    ai: 'IA',
    said: (who: string, text: string) => `${who} : ${text}`,
  },
  en: {
    noJsonInZip: 'conversations.json not found in the zip',
    notFound: 'conversation not found',
    me: 'Me',
    ai: 'AI',
    said: (who: string, text: string) => `${who}: ${text}`,
  },
})
