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
      `${n > 1 ? `${n} sessions lancées hors de weevils dorment` : 'une session lancée hors de weevils dort'} ${sinceYesterday ? 'depuis hier' : 'depuis plus de 12 h'}`,
    unmanagedLine: (title: string, machine: string, cwd: string, id: string, since: string) => `- « ${title} » sur ${machine}, dans ${cwd} (session ${id}, rien depuis ${since})`,
    idleUnmanagedAsk: (n: number, lines: string) =>
      `${n > 1 ? 'ces sessions ont été lancées' : 'cette session a été lancée'} hors de weevils, et ${n > 1 ? 'ne font' : 'ne fait'} plus rien depuis plus de 12 h :\n${lines}\nregarde ce que c’est (le processus derrière) et dis-moi ${n > 1 ? 'lesquelles on peut fermer' : 'si on peut la fermer'} — ne ferme rien sans mon accord.`,
    closed: (n: number): string => (n > 1 ? `${n} sessions fermées` : 'session fermée'),
    waiting: (title: string, since: string) => `« ${title} » t’attend depuis ${since}`,
    openIt: 'y aller',
    minutes: (n: number) => `${n} min`,
    hours: (n: number) => `${n} h`,
    unsorted: (n: number): string => (n > 1 ? `${n} conversations importées attendent d’être rangées` : 'une conversation importée attend d’être rangée'),
    sortThem: 'les ranger',
    oneMachine: 'branche ta deuxième machine, weevils pilote tout',
    addMachine: 'ajouter une machine',
    noDictation: 'dicte tes messages au lieu de les taper : il suffit d’une clé OpenAI',
    plugVoice: 'brancher la dictée',
    gone: 'cette carte ne s’applique plus',
    notClosable: 'seule une session ouverte depuis weevils peut être fermée d’ici',
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
      `${n > 1 ? `${n} sessions started outside weevils are idle` : 'one session started outside weevils is idle'} ${sinceYesterday ? 'since yesterday' : 'for over 12 h'}`,
    unmanagedLine: (title: string, machine: string, cwd: string, id: string, since: string) => `- “${title}” on ${machine}, in ${cwd} (session ${id}, nothing for ${since})`,
    idleUnmanagedAsk: (n: number, lines: string) =>
      `${n > 1 ? 'these sessions were' : 'this session was'} started outside weevils, and ${n > 1 ? 'have' : 'has'} done nothing for over 12 h:\n${lines}\nfind out what ${n > 1 ? 'they are' : 'it is'} (the process behind ${n > 1 ? 'them' : 'it'}) and tell me ${n > 1 ? 'which ones can be closed' : 'whether it can be closed'} — close nothing without my go-ahead.`,
    closed: (n: number): string => (n > 1 ? `${n} sessions closed` : 'session closed'),
    waiting: (title: string, since: string) => `“${title}” has been waiting for you for ${since}`,
    openIt: 'open it',
    minutes: (n: number) => `${n} min`,
    hours: (n: number) => `${n} h`,
    unsorted: (n: number): string => (n > 1 ? `${n} imported conversations are waiting to be sorted` : 'one imported conversation is waiting to be sorted'),
    sortThem: 'sort them',
    oneMachine: 'hook up a second machine: weevils drives them all',
    addMachine: 'add a machine',
    noDictation: 'dictate your messages instead of typing: all it takes is an OpenAI key',
    plugVoice: 'plug in dictation',
    gone: 'this card no longer applies',
    notClosable: 'only a session opened from weevils can be closed from here',
  },
})
