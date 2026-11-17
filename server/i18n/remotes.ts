// Messages of server/remotes.ts (other machines' weevilsd).
import { defineMessages } from '../i18n.ts'

export default defineMessages({
  fr: {
    offline: (machine: string) => `${machine} hors ligne`,
    failed: (machine: string, status: number) => `${machine} : erreur ${status}`,
  },
  en: {
    offline: (machine: string) => `${machine} is offline`,
    failed: (machine: string, status: number) => `${machine}: error ${status}`,
  },
})
