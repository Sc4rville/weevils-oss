import { defineMessages } from '../i18n.ts'
export default defineMessages({
  en: {
    invalid: 'Only complete UTF-8 Markdown files inside this repository can be edited.',
    conflict: 'This file changed elsewhere. Your draft is kept. Read the latest version before saving again.',
    readonly: 'This file is read-only. Your draft is kept.',
  },
  fr: {
    invalid: 'Seuls les fichiers Markdown UTF-8 complets de ce dépôt peuvent être modifiés.',
    conflict: 'Ce fichier a changé ailleurs. Votre brouillon est conservé. Consultez la dernière version avant de réessayer.',
    readonly: 'Ce fichier est en lecture seule. Votre brouillon est conservé.',
  },
})
