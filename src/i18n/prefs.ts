import { defineMessages } from './index'

export default defineMessages({
  fr: {
    language: 'langue',
    closeLanguage: 'fermer le choix de langue',
    followsBrowser: 'comme le navigateur',
    chosen: 'choisie ici',
    followBrowser: (name: string) => `comme le navigateur (${name})`,
  },
  en: {
    language: 'language',
    closeLanguage: 'close language choices',
    followsBrowser: 'same as the browser',
    chosen: 'chosen here',
    followBrowser: (name: string) => `same as the browser (${name})`,
  },
})
