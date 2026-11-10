// Messages of server/mux.ts (tmux panes).
import { defineMessages } from '../i18n.ts'

export default defineMessages({
  fr: {
    newSession: 'nouvelle session',
    keyRefused: (key: string) => `touche refusée : ${key}`,
    /** A menu is on screen but no question could be read. */
    choiceWaiting: 'un choix t’attend',
  },
  en: {
    newSession: 'new session',
    keyRefused: (key: string) => `key not allowed: ${key}`,
    choiceWaiting: 'a choice is waiting for you',
  },
})
