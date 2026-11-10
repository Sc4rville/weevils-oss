import { defineMessages } from './index'

export default defineMessages({
  fr: {
    conversations: 'conversations',
    backToFeed: 'retour au fil',
    back: 'retour',
    options: 'options',
    working: 'travaille',
    yourTurn: 'à toi',
    background: (n: number) => `${n} en arrière-plan`,
    browser: 'navigateur',
    writeTo: (who: string) => `écris à ${who}`,
    messageTo: (who: string) => `message à ${who}`,
  },
  en: {
    conversations: 'conversations',
    backToFeed: 'back to the feed',
    back: 'back',
    options: 'options',
    working: 'working',
    yourTurn: 'your turn',
    background: (n: number) => `${n} in background`,
    browser: 'browser',
    writeTo: (who: string) => `write to ${who}`,
    messageTo: (who: string) => `message to ${who}`,
  },
})
