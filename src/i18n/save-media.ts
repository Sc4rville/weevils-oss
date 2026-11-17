import { defineMessages } from './index'

export default defineMessages({
  en: {
    save: (video: boolean): string => (video ? 'Save video' : 'Save photo'),
    saving: (pct?: number): string => (pct === undefined ? 'Preparing…' : `Preparing… ${pct}%`),
    again: 'Ready: tap to save',
    failed: 'Couldn’t get the file. Tap to try again.',
  },
  fr: {
    save: (video: boolean): string => (video ? 'Enregistrer la vidéo' : 'Enregistrer la photo'),
    saving: (pct?: number): string => (pct === undefined ? 'Préparation…' : `Préparation… ${pct} %`),
    again: 'Prêt : touche pour enregistrer',
    failed: 'Fichier introuvable. Touche pour réessayer.',
  },
})
