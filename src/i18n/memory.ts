import { defineMessages } from './index'

// The memory page (src/ui/memory.tsx): what weevils remembers about the user.
export default defineMessages({
  fr: {
    title: 'mémoire',
    count: (n: number) => `${n} souvenir${n > 1 ? 's' : ''}`,
    add: 'ajouter',
    addLabel: 'ajouter un souvenir',
    edit: 'souvenir',
    close: 'refermer',
    byHand: 'ajouté par toi',
    // Espaces insécables : « ? » ne passe jamais seul à la ligne.
    quote: (q: string) => `«\u00a0${q.replace(/ ([?!:;])/g, '\u00a0$1')}\u00a0»`,
    forget: 'oublier',
    sure: 'sûr ?',
    empty: 'aucun souvenir pour l’instant',
  },
  en: {
    title: 'memory',
    count: (n: number) => `${n} ${n === 1 ? 'memory' : 'memories'}`,
    add: 'add',
    addLabel: 'add a memory',
    edit: 'memory',
    close: 'close',
    byHand: 'added by you',
    quote: (q: string) => `“${q}”`,
    forget: 'forget',
    sure: 'sure?',
    empty: 'no memories yet',
  },
})
