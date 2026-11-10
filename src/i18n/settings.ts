import { defineMessages } from './index'

const FR_WORD: Record<string, string> = { low: 'bas', medium: 'moyen', high: 'haut', max: 'max' }
const FR_LABEL: Record<string, string> = { low: 'effort faible', medium: 'effort moyen', high: 'effort élevé', max: 'effort max' }
const EN_WORD: Record<string, string> = { low: 'low', medium: 'medium', high: 'high', max: 'max' }
const EN_LABEL: Record<string, string> = { low: 'low effort', medium: 'medium effort', high: 'high effort', max: 'max effort' }

export default defineMessages({
  fr: {
    /** Mot court sur le bouton d'effort. */
    effortWord: (e: string) => FR_WORD[e] ?? e,
    /** Effort dans une ligne de résumé (« opus · effort élevé »). */
    effortLabel: (e: string) => FR_LABEL[e] ?? `effort ${e}`,
    unavailable: 'indisponible',
    model: 'modèle',
    effort: 'effort',
    fastMode: 'mode rapide',
    setHere: ' · réglé d’ici',
    toggle: 'basculer',
    on: 'activé',
    off: 'désactivé',
    approvals: 'approvals',
    confirm: 'confirmer',
    cancel: 'annuler',
  },
  en: {
    effortWord: (e: string) => EN_WORD[e] ?? e,
    effortLabel: (e: string) => EN_LABEL[e] ?? `${e} effort`,
    unavailable: 'unavailable',
    model: 'model',
    effort: 'effort',
    fastMode: 'fast mode',
    setHere: ' · set from here',
    toggle: 'toggle',
    on: 'on',
    off: 'off',
    approvals: 'approvals',
    confirm: 'confirm',
    cancel: 'cancel',
  },
})
