import { defineMessages } from '../i18n.ts'

// server/tips.ts: personalized cards built from the real state (GET /api/tips), their actions and feedback.
export default defineMessages({
  fr: {
    saturated: (machine: string) => `ton ${machine} sature souvent — un palier au-dessus l’aiderait`,
    askBoss: 'demander à weevboss',
    saturatedAsk: (machine: string, pct: number, hours: number) =>
      `mon ${machine} sature souvent (${pct} % du temps sur les dernières ${hours} h). regarde ce qui le charge et dis-moi s’il faut passer à un palier supérieur.`,
    idleSessions: (n: number, sinceYesterday: boolean) =>
      `${n > 1 ? `${n} sessions dorment` : 'une session dort'} ${sinceYesterday ? 'depuis hier' : 'depuis plus de 12 h'} — je ${n > 1 ? 'les' : 'la'} ferme ?`,
    closeThem: (n: number): string => (n > 1 ? 'les fermer' : 'la fermer'),
    idleUnmanaged: (n: number, sinceYesterday: boolean) =>
      `${n > 1 ? `${n} sessions de terminal dorment` : 'une session de terminal dort'} ${sinceYesterday ? 'depuis hier' : 'depuis plus de 12 h'} — weevils ne peut pas ${n > 1 ? 'les' : 'la'} fermer`,
    unmanagedLine: (title: string, machine: string, cwd: string, id: string, since: string) => `- « ${title} » sur ${machine}, dans ${cwd} (session ${id}, rien depuis ${since})`,
    idleUnmanagedAsk: (n: number, lines: string) =>
      `${n > 1 ? 'ces sessions sont ouvertes' : 'cette session est ouverte'} dans un terminal que weevils ne pilote pas, et ${n > 1 ? 'ne font' : 'ne fait'} plus rien depuis plus de 12 h :\n${lines}\nregarde ce que c’est (processus, terminal) et dis-moi ${n > 1 ? 'lesquelles on peut fermer' : 'si on peut la fermer'} — ne ferme rien sans mon accord.`,
    closed: (n: number): string => (n > 1 ? `${n} sessions fermées` : 'session fermée'),
    waiting: (title: string, since: string) => `« ${title} » t’attend depuis ${since}`,
    openIt: 'y aller',
    minutes: (n: number) => `${n} min`,
    hours: (n: number) => `${n} h`,
    unsorted: (n: number): string => (n > 1 ? `${n} conversations importées attendent d’être rangées` : 'une conversation importée attend d’être rangée'),
    sortThem: 'les ranger',
    oneMachine: 'branche ta deuxième machine, weevils pilote tout',
    addMachine: 'ajouter une machine',
    noDictation: 'pour dicter, ajoute OPENAI_API_KEY dans ~/.config/weevils/env',
    gone: 'cette carte ne s’applique plus',
    notClosable: 'seule une session que weevils pilote (pane wv) peut être fermée',
  },
  en: {
    saturated: (machine: string) => `your ${machine} is often maxed out — a bigger plan would help`,
    askBoss: 'ask weevboss',
    saturatedAsk: (machine: string, pct: number, hours: number) =>
      `my ${machine} is often maxed out (${pct}% of the time over the last ${hours} h). look at what's loading it and tell me whether I need a bigger plan.`,
    idleSessions: (n: number, sinceYesterday: boolean) =>
      `${n > 1 ? `${n} sessions idle` : 'one session idle'} ${sinceYesterday ? 'since yesterday' : 'for over 12 h'} — close ${n > 1 ? 'them' : 'it'}?`,
    closeThem: (n: number): string => (n > 1 ? 'close them' : 'close it'),
    idleUnmanaged: (n: number, sinceYesterday: boolean) =>
      `${n > 1 ? `${n} terminal sessions idle` : 'one terminal session idle'} ${sinceYesterday ? 'since yesterday' : 'for over 12 h'} — weevils can’t close ${n > 1 ? 'them' : 'it'}`,
    unmanagedLine: (title: string, machine: string, cwd: string, id: string, since: string) => `- “${title}” on ${machine}, in ${cwd} (session ${id}, nothing for ${since})`,
    idleUnmanagedAsk: (n: number, lines: string) =>
      `${n > 1 ? 'these sessions are' : 'this session is'} open in a terminal weevils doesn't drive, and ${n > 1 ? 'have' : 'has'} done nothing for over 12 h:\n${lines}\nfind out what ${n > 1 ? 'they are' : 'it is'} (process, terminal) and tell me ${n > 1 ? 'which ones can be closed' : 'whether it can be closed'} — close nothing without my go-ahead.`,
    closed: (n: number): string => (n > 1 ? `${n} sessions closed` : 'session closed'),
    waiting: (title: string, since: string) => `“${title}” has been waiting for you for ${since}`,
    openIt: 'open it',
    minutes: (n: number) => `${n} min`,
    hours: (n: number) => `${n} h`,
    unsorted: (n: number): string => (n > 1 ? `${n} imported conversations are waiting to be sorted` : 'one imported conversation is waiting to be sorted'),
    sortThem: 'sort them',
    oneMachine: 'hook up a second machine: weevils drives them all',
    addMachine: 'add a machine',
    noDictation: 'to dictate, add OPENAI_API_KEY to ~/.config/weevils/env',
    gone: 'this card no longer applies',
    notClosable: 'only a session weevils drives (wv pane) can be closed',
  },
})
