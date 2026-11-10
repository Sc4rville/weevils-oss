// Messages of server/core.ts: errors shown in the app, labels in the snapshot, and the bits weevilsd writes
// into agents' messages (attached files, « continue here »).
import { defineMessages } from '../i18n.ts'

export default defineMessages({
  fr: {
    // Attached files: what the agent receives.
    fileName: 'fichier',
    lookPhoto: 'Regarde cette photo.',
    lookPhotos: 'Regarde ces photos.',
    oneFile: 'Voici un fichier.',
    someFiles: 'Voici des fichiers.',
    attached: (image: boolean, path: string) => `(${image ? 'photo' : 'fichier'} : ${path})`,
    commandRefused: (c: string) => `commande refusée : ${c}`,

    badRepo: 'repo invalide',
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
    unmanaged: 'Cette session est ouverte dans un terminal que weevils ne pilote pas. Ferme-la ou lance tes sessions avec wv pour leur écrire d’ici.',
    noScreen: 'weevils ne voit pas l’écran de cette session',
    escWouldClose: 'Échap ici fermerait la session : réponds 1 ou Entrée',
    dirNotFound: (dir: string) => `dossier introuvable : ${dir}`,
    onlyInPane: 'réglable seulement quand la session tourne dans une pane weevils (wv)',
    orchNotRunning: 'l’orchestrateur ne tourne pas : envoie-lui d’abord un message',
    orchNotHere: 'l’orchestrateur ne tourne pas sur cette machine',
    noConfirmation: 'rien ne confirme la réception',
    notReceived: (why: string) => `message non reçu par la session · ${why}`,
    /** First message of the top band, before the user ever wrote to weevboss. */
    hello: 'Dis-moi quoi faire : je lis tes sessions, j’écris dedans, je te résume. Les détails sont dans les bandes en dessous si tu veux les suivre.',

    // « Continue here »: an imported conversation handed to a new agent session.
    me: 'Moi',
    said: (who: string, text: string) => `${who} : ${text}`,
    continuePrompt: (source: string, title: string, context: string, text: string) =>
      `Contexte : suite de ma conversation ${source} « ${title} » (fin de l'échange ci-dessous).\n\n${context}---\n${text}`,

    // 24/7 band: long jobs (WEEVILS_LOGS_DIR) and systemd timers.
    manualJob: 'job lancé à la main',
    nextRun: (when: string) => `prochaine : ${when}`,
    scheduled: 'planifié',
    lastRun: (when: string) => `dernière : ${when}`,
    neverRun: 'jamais lancé',
    cantPause: 'cette activité ne se met pas en pause',
  },
  en: {
    fileName: 'file',
    lookPhoto: 'Look at this photo.',
    lookPhotos: 'Look at these photos.',
    oneFile: 'Here is a file.',
    someFiles: 'Here are some files.',
    attached: (image: boolean, path: string) => `(${image ? 'photo' : 'file'}: ${path})`,
    commandRefused: (c: string) => `command not allowed: ${c}`,

    badRepo: 'invalid repo',
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
    unmanaged: 'This session is open in a terminal weevils doesn’t drive. Close it, or start your sessions with wv to write to them from here.',
    noScreen: 'weevils can’t see this session’s screen',
    escWouldClose: 'Esc here would close the session: answer 1 or Enter',
    dirNotFound: (dir: string) => `folder not found: ${dir}`,
    onlyInPane: 'only adjustable when the session runs in a weevils pane (wv)',
    orchNotRunning: 'the orchestrator isn’t running: send it a message first',
    orchNotHere: 'the orchestrator doesn’t run on this machine',
    noConfirmation: 'nothing confirms it arrived',
    notReceived: (why: string) => `the session didn’t get the message · ${why}`,
    hello: 'Tell me what to do: I read your sessions, write in them, and sum things up for you. The details are in the bands below if you want to follow along.',

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
  },
})
