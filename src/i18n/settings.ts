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
    /** Session endormie : ses réglages reviennent quand elle tourne. */
    unavailable: 'envoie un message pour reprendre la session, puis change ces réglages',
    model: 'modèle',
    effort: 'effort',
    fastMode: 'mode rapide',
    on: 'activé',
    off: 'désactivé',
    /** Résumer la conversation pour libérer de la place (la commande /compact). */
    compact: 'alléger la conversation',
    /** Tout effacer et repartir (la commande /clear ou /new), avec une confirmation. */
    clear: 'repartir de zéro',
    confirmClear: 'effacer cette conversation',
    cancel: 'la garder',
  },
  en: {
    effortWord: (e: string) => EN_WORD[e] ?? e,
    effortLabel: (e: string) => EN_LABEL[e] ?? `${e} effort`,
    unavailable: 'send a message to resume the session, then change these',
    model: 'model',
    effort: 'effort',
    fastMode: 'fast mode',
    on: 'on',
    off: 'off',
    compact: 'tidy up the conversation',
    clear: 'start over',
    confirmClear: 'erase this conversation',
    cancel: 'keep it',
  },
})
