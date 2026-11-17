import { defineMessages } from './index'

export default defineMessages({
  fr: {
    // Session
    changeModel: 'changer le modèle ou l’effort',
    model: 'modèle',
    queued: (n: number) => (n > 1 ? `${n} messages en attente` : '1 message en attente'),
    since: (d: string) => ` depuis ${d}`,
    /** Le volet qui montre l'appli en cours de construction. */
    seeApp: 'voir l’appli',
    closeApp: 'fermer l’appli',
    /** Surtitre d'une session dont le projet n'est pas (encore) connu. */
    sessionsKicker: 'sessions',
    writeTo: (_tool: string) => 'écris un message',
    resumeWith: (_tool: string) => 'reprends la session',
    readOnly: 'ouverte hors de weevils : lecture seule',
    composerLabel: (title: string) => `message à la session ${title}`,
    /** Bulle provisoire d'un envoi avec photos. */
    photos: (n: number) => (n > 1 ? `${n} photos` : 'photo'),
    /** Bande du fil : les sous-agents, étapes de workflow et commandes qui tournent à côté de la session. */
    helpers: 'aides',
    helpersWorking: (n: number) => `${n} au travail`,
    helpersDone: 'tout est fini',
    /** En-tête d'un workflow dans la bande : en cours ou fini. */
    flowWorking: 'travaille',
    flowDone: 'fini',
    /** État d'un sous-agent, d'une étape de workflow ou d'une commande d'arrière-plan. */
    subStatus: (s: 'working' | 'done' | 'failed' | 'stopped') => ({ working: 'travaille', done: 'fini', failed: 'échoué', stopped: 'coupé' })[s],
    /** Lecteur d'écran, ligne de sous-agent : nom, état, durée, déplié ou non. */
    subAria: (label: string, state: string, d: string, open: boolean) => `${label}, ${state}, ${d}, ${open ? 'replier' : 'déplier'}`,
    asks: (_tool: string) => 'Question',
    waitingForYou: 'la session attend ta réponse',
    askDetails: 'détails',
    /** Session coupée en plein travail : pourquoi, et les deux gestes. */
    // Fichiers
    /** Titre de la liste des dossiers d'un projet qui en a plusieurs. */
    folders: 'Dossiers',
    files: (n: number) => `${n} ${n > 1 ? 'fichiers' : 'fichier'}`,
    emptyDir: 'Dossier vide.',
    /** Fichier trop gros : seul son début est lu. */
    truncated: 'seul le début est affiché',
    reading: 'chargement…',
    binary: 'binaire',
    offline: 'hors ligne',
    // Nouvelle session
    newSession: 'nouvelle session',
    newSessionTitle: 'Nouvelle session',
    pickRepoFirst: 'choisis d’abord un projet',
    firstMessage: 'premier message',
    firstMessageLabel: 'premier message de la session',
    tool: 'qui s’en charge',
    chosen: ', choisi',
    machine: 'machine',
    project: 'projet',
    /** Bouton flottant (lecteur d'écran) : du nouveau est arrivé en bas du fil pendant qu'on relisait plus haut. */
    newBelow: 'du nouveau en bas : y aller',
    /** Idem, quand la session attend une réponse. */
    waitsBelow: 'la session attend ta réponse, en bas : y aller',
    /** Dossier trop long : la liste s'arrête, un bouton montre la tranche suivante. */
    moreFiles: (n: number) => `en voir ${n} de plus`,
  },
  en: {
    changeModel: 'change model or effort',
    model: 'model',
    queued: (n: number) => (n === 1 ? '1 message waiting' : `${n} messages waiting`),
    since: (d: string) => ` for ${d}`,
    seeApp: 'see the app',
    closeApp: 'close the app',
    sessionsKicker: 'sessions',
    writeTo: (_tool: string) => 'write a message',
    resumeWith: (_tool: string) => 'resume the session',
    readOnly: 'opened outside weevils: read only',
    composerLabel: (title: string) => `message to session ${title}`,
    photos: (n: number) => (n > 1 ? `${n} photos` : 'photo'),
    helpers: 'helpers',
    helpersWorking: (n: number) => `${n} working`,
    helpersDone: 'all done',
    flowWorking: 'working',
    flowDone: 'done',
    subStatus: (s: 'working' | 'done' | 'failed' | 'stopped') => ({ working: 'working', done: 'done', failed: 'failed', stopped: 'stopped' })[s],
    subAria: (label: string, state: string, d: string, open: boolean) => `${label}, ${state}, ${d}, ${open ? 'collapse' : 'expand'}`,
    asks: (_tool: string) => 'Question',
    waitingForYou: 'the session is waiting for your answer',
    askDetails: 'details',
    folders: 'Folders',
    files: (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`,
    emptyDir: 'Empty folder.',
    truncated: 'only the beginning is shown',
    reading: 'loading…',
    binary: 'binary file',
    offline: 'offline',
    newSession: 'new session',
    newSessionTitle: 'New session',
    pickRepoFirst: 'pick a project first',
    firstMessage: 'first message',
    firstMessageLabel: 'first message of the session',
    tool: 'who works on it',
    chosen: ', selected',
    machine: 'machine',
    project: 'project',
    newBelow: 'new below: go there',
    waitsBelow: 'the session is waiting for your answer, below: go there',
    moreFiles: (n: number) => `show ${n} more`,
  },
})
