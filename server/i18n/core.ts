// Messages of server/core.ts: errors shown in the app, labels in the snapshot, and the bits weevilsd writes
// into agents' messages (attached files, « continue here »).
import { defineMessages } from '../i18n.ts'

export default defineMessages({
  fr: {
    appLocale: 'Langue explicite de l’app : français (fr). Écris les libellés, titres générés de sessions et de projets et publications Pour toi en français naturel. Le chat peut suivre la langue du message utilisateur ; ne déduis jamais la langue de l’app du chat. Préserve les identifiants, noms propres de dépôts, citations et noms de marque explicitement imposés, y compris pour les automatisations. Garde le sujet des titres stable entre les micro-actions. Pour une présentation filmée, respecte le pays cible explicite du brief ; ne déduis aucun pays de la langue du chat ou du code fr.',

    // Attached files: what the agent receives.
    fileName: 'fichier',
    lookPhoto: 'Regarde cette photo.',
    lookPhotos: 'Regarde ces photos.',
    oneFile: 'Voici un fichier.',
    someFiles: 'Voici des fichiers.',
    attached: (image: boolean, path: string) => `(${image ? 'photo' : 'fichier'} : ${path})`,
    longMessage: (path: string) => `[message trop long pour le terminal, la suite et le texte intégral sont dans ${path} : lis-le en entier avant de répondre]`,
    commandRefused: (c: string) => `commande refusée : ${c}`,

    badRepo: 'repo invalide',
    sourceReadOnly: 'Ce dépôt source est en lecture seule pour weevils. Aucun travail n’a été lancé ; les sessions déjà actives continuent.',
    installationReadOnly: 'Cette installation ne contient pas de dépôt source. Elle est consultable, mais aucun travail ne peut y être lancé.',
    repoNotFound: 'repo introuvable',
    pathRefused: 'chemin refusé',
    starting: 'démarrage…',
    newSession: 'nouvelle session',
    missingProject: 'projet manquant',
    /** Classification reason of a conversation too old to be sorted. */
    oldUnsorted: 'ancienne, non classée',
    conversationNotFound: 'conversation introuvable',
    unknownMachine: (id: string) => `machine inconnue : ${id}`,
    sessionNotFound: 'session introuvable',
    emptyMessage: 'message vide',
    /** A test session (its brief starts with [test]) tried to write to weevboss. */
    testNotInBoss: 'un test n’écrit jamais dans le fil de weevboss',
    // Keeps its opening words: src/ui/outbox-status.tsx recognises this refusal by them.
    unmanaged: 'Cette session a été ouverte ailleurs, hors de weevils : je peux la lire, pas lui écrire. Ouvre-en une depuis le + du projet pour lui parler d’ici.',
    noScreen: 'weevils ne joint pas cette session pour l’instant',
    escWouldClose: 'ça fermerait la session : choisis plutôt une réponse',
    dirNotFound: (dir: string) => `dossier introuvable : ${dir}`,
    onlyInPane: 'réglable seulement pour une session ouverte depuis weevils',
    orchNotRunning: 'l’orchestrateur ne tourne pas : envoie-lui d’abord un message',
    orchNotHere: 'l’orchestrateur ne tourne pas sur cette machine',
    noConfirmation: 'envoyé, pas encore confirmé · regarde le fil avant de renvoyer',
    notReceived: (why: string) => `message non reçu par la session · ${why}`,
    /** First message of the top band, before the user ever wrote to weevboss. */
    hello: 'Dis-moi quoi faire : je lis tes sessions, j’écris dedans, je te résume.',

    // « Continue here »: an imported conversation handed to a new agent session.
    me: 'Moi',
    said: (who: string, text: string) => `${who} : ${text}`,
    continuePrompt: (source: string, title: string, context: string, text: string) =>
      `Contexte : suite de ma conversation ${source} « ${title} » (fin de l'échange ci-dessous).\n\n${context}---\n${text}`,

    // 24/7 band: long jobs (WEEVILS_LOGS_DIR, else ~/logs and weevils' own folder) and systemd timers.
    manualJob: 'job lancé à la main',
    nextRun: (when: string) => `prochaine : ${when}`,
    scheduled: 'planifié',
    lastRun: (when: string) => `dernière : ${when}`,
    neverRun: 'jamais lancé',
    cantPause: 'cette activité ne se met pas en pause',

    // Session cut off mid-work (status « interrupted »): why, the line posted in weevboss' thread, the resume message.
    cutWhy: (reason: string) =>
      ({ died: 'arrêt inattendu', dirty: 'changements pas encore enregistrés', quota: 'limite d’usage atteinte', auth: 'déconnectée', api: 'erreur du service' })[reason] ?? 'arrêtée',
    cutSaid: (title: string, project: string, why: string) => `La session « ${title} » (${project}) a été coupée en plein travail : ${why}.`,
    /** Several sessions stopped at the same moment (their terminal server closed): resumed by weevils, one calm line. */
    healed: (n: number) => `${n} sessions se sont arrêtées en même temps : weevils les a relancées, elles reprennent là où elles en étaient.`,
    resumePrompt: (why: string, cwd: string) =>
      `Ta session a été coupée en plein travail (${why}). Reprends là où tu en étais : ton travail est sur disque dans ${cwd} (git status, git diff, fichiers non commités), relis tes derniers messages et relance ce qui tournait en arrière-plan et a été tué. Puis termine la tâche ; si elle était déjà finie, dis-le en une phrase.`,
  },
  en: {
    appLocale: 'Explicit app locale: English (en). Write UI labels, generated session and project titles and For you publications in natural English. Chat replies may follow the user’s message language; never infer the app locale from chat. Preserve identifiers, proper repository names, verbatim user quotations and explicitly specified branding, including automation names. Keep title topics stable across micro-actions. For a screen-recording presentation, follow the explicitly named target country in the brief; never infer a country from chat language or the en locale code.',

    fileName: 'file',
    lookPhoto: 'Look at this photo.',
    lookPhotos: 'Look at these photos.',
    oneFile: 'Here is a file.',
    someFiles: 'Here are some files.',
    attached: (image: boolean, path: string) => `(${image ? 'photo' : 'file'}: ${path})`,
    longMessage: (path: string) => `[message too long for the terminal, the rest and the full text are in ${path}: read all of it before answering]`,
    commandRefused: (c: string) => `command not allowed: ${c}`,

    badRepo: 'invalid repo',
    sourceReadOnly: 'This source repository is read-only for weevils. No work was started; existing active sessions continue.',
    installationReadOnly: 'This installation has no source checkout. It is available to view, but work cannot be started here.',
    repoNotFound: 'repo not found',
    pathRefused: 'path not allowed',
    starting: 'starting…',
    newSession: 'new session',
    missingProject: 'missing project',
    oldUnsorted: 'old, unsorted',
    conversationNotFound: 'conversation not found',
    unknownMachine: (id: string) => `unknown machine: ${id}`,
    sessionNotFound: 'session not found',
    emptyMessage: 'empty message',
    testNotInBoss: 'a test never writes to weevboss’s thread',
    unmanaged: 'This session was opened elsewhere, outside weevils: I can read it but not write to it. Start one from the project’s + to talk to it here.',
    noScreen: 'weevils can’t reach this session right now',
    escWouldClose: 'that would close the session: pick an answer instead',
    dirNotFound: (dir: string) => `folder not found: ${dir}`,
    onlyInPane: 'only adjustable for a session opened from weevils',
    orchNotRunning: 'the orchestrator isn’t running: send it a message first',
    orchNotHere: 'the orchestrator doesn’t run on this machine',
    noConfirmation: 'sent, not confirmed yet · check the thread before resending',
    notReceived: (why: string) => `the session didn’t get the message · ${why}`,
    hello: 'Tell me what to do: I read your sessions, write in them, and sum things up.',

    me: 'Me',
    said: (who: string, text: string) => `${who}: ${text}`,
    continuePrompt: (source: string, title: string, context: string, text: string) =>
      `Context: this continues my ${source} conversation “${title}” (end of the exchange below).\n\n${context}---\n${text}`,

    manualJob: 'job started manually',
    nextRun: (when: string) => `next: ${when}`,
    scheduled: 'scheduled',
    lastRun: (when: string) => `last: ${when}`,
    neverRun: 'never run',
    cantPause: 'this activity can’t be paused',

    cutWhy: (reason: string) =>
      ({ died: 'unexpected stop', dirty: 'changes not saved yet', quota: 'usage limit reached', auth: 'signed out', api: 'service error' })[reason] ?? 'stopped',
    cutSaid: (title: string, project: string, why: string) => `The session “${title}” (${project}) was cut off mid-work: ${why}.`,
    healed: (n: number) => `${n} sessions stopped at the same moment: weevils restarted them and they pick up where they were.`,
    resumePrompt: (why: string, cwd: string) =>
      `Your session was cut off mid-work (${why}). Pick up where you left off: your work is on disk in ${cwd} (git status, git diff, uncommitted files), reread your last messages and restart whatever was running in the background and got killed. Then finish the task; if it was already done, say so in one sentence.`,
  },
})
