// Messages of server/config.ts. defineMessages comes straight from shared/ (not ../i18n.ts): server/i18n.ts
// imports this catalog, so going through it would make an import cycle.
import { defineMessages } from '../../shared/i18n.ts'

export default defineMessages({
  fr: {
    /** How agents call the user when no name is configured. */
    theUser: 'l’utilisateur',
  },
  en: {
    theUser: 'the user',
  },
})
