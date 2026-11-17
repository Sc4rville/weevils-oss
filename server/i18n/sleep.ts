// Sleep mode (server/sleep.ts): the morning recap's one line in the For you stream.
import { defineMessages } from '../i18n.ts'

export default defineMessages({
  fr: {
    /** The recap card's line: what the night amounts to, from the real states only. */
    recap: (n: { done: number; working: number; waiting: number; failed: number; retried?: number }) => {
      const parts = [
        n.done ? `${n.done} ${n.done > 1 ? 'résultats' : 'résultat'}` : '',
        n.working ? `${n.working} encore au travail` : '',
        n.waiting ? `${n.waiting} ${n.waiting > 1 ? 't’attendent' : 't’attend'}` : '',
        n.retried ? `${n.retried} ${n.retried > 1 ? 'relances' : 'relance'}` : '',
        n.failed ? `${n.failed} ${n.failed > 1 ? 'arrêtés' : 'arrêté'}` : '',
      ].filter(Boolean)
      return parts.length ? `Cette nuit : ${parts.join(', ')}.` : 'Nuit calme : rien n’a tourné pendant ton sommeil.'
    },
    recapTitle: 'Pendant ton sommeil',
    stoppedOnWake: 'arrêtée à ton réveil',
    /** The supervisor's decisions on a run line (optimizers.ts supervise). */
    relaunched: (n: number, why: string) => `relancée (${n === 1 ? '1re' : `${n}e`} fois) après : ${why}`,
    gaveUp: (why: string) => `toujours en échec après les relances : ${why}`,
    asked: (q: string) => `question envoyée dans « pour toi » : ${q}`,
  },
  en: {
    recap: (n: { done: number; working: number; waiting: number; failed: number; retried?: number }) => {
      const parts = [
        n.done ? `${n.done} ${n.done > 1 ? 'results' : 'result'}` : '',
        n.working ? `${n.working} still working` : '',
        n.waiting ? `${n.waiting} waiting for you` : '',
        n.retried ? `${n.retried} ${n.retried > 1 ? 'relaunches' : 'relaunch'}` : '',
        n.failed ? `${n.failed} stopped` : '',
      ].filter(Boolean)
      return parts.length ? `Overnight: ${parts.join(', ')}.` : 'A quiet night: nothing ran while you slept.'
    },
    recapTitle: 'While you slept',
    stoppedOnWake: 'stopped when you woke up',
    relaunched: (n: number, why: string) => `relaunched (${n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`} time) after: ${why}`,
    gaveUp: (why: string) => `still failing after its relaunches: ${why}`,
    asked: (q: string) => `question sent to For you: ${q}`,
  },
})
