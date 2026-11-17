import { defineMessages } from './index'
// One short human line per action (session threads). No path, command, flag or tool name ever goes in here.
export default defineMessages({
  fr: {
    read: (s: string) => (s ? `Lecture de ${s}` : 'Lecture d’un fichier'), readMany: 'Lecture du code',
    search: 'Recherche dans le code',
    edit: (s: string) => (s ? `Modification de ${s}` : 'Modification du code'), editMany: 'Modification du code',
    write: (s: string) => (s ? `Création de ${s}` : 'Création d’un fichier'), writeMany: 'Création de fichiers',
    test: 'Tests en cours', build: 'Compilation du projet', git: 'Vérification du dépôt', install: 'Installation des dépendances',
    run: 'Commande en cours', web: 'Recherche sur le web', delegate: 'Tâche déléguée', plan: 'Mise à jour du plan',
    ask: 'Question pour toi', skill: 'Méthode appliquée', look: 'Lecture d’une image', wait: 'En attente d’un résultat',
    message: 'Coordination', other: 'Travail en cours',
    code: (n: string) => `le code « ${n} »`, doc: (n: string) => `la doc « ${n} »`, settings: (n: string) => `les réglages « ${n} »`,
    count: (n: number) => ` · ${n}`, more: ' …',
    liveWaiting: 't’attend', liveStopped: 'interrompue', liveDone: 'terminée', liveIdle: 'au repos', liveLabel: (t: string) => `En ce moment : ${t}`,
    rawTitle: 'Action enregistrée', unverified: 'Aucun résultat enregistré : rien n’est affirmé sur son issue.',
  },
  en: {
    read: (s: string) => (s ? `Reading ${s}` : 'Reading a file'), readMany: 'Reading the code',
    search: 'Searching the code',
    edit: (s: string) => (s ? `Editing ${s}` : 'Editing the code'), editMany: 'Editing the code',
    write: (s: string) => (s ? `Creating ${s}` : 'Creating a file'), writeMany: 'Creating files',
    test: 'Running tests', build: 'Building the project', git: 'Checking the repository', install: 'Installing dependencies',
    run: 'Running command', web: 'Searching the web', delegate: 'Delegating a task', plan: 'Updating the plan',
    ask: 'Question for you', skill: 'Applying a method', look: 'Viewing an image', wait: 'Waiting for a result',
    message: 'Coordinating', other: 'Working',
    code: (n: string) => `the ${n} code`, doc: (n: string) => `the ${n} notes`, settings: (n: string) => `the ${n} settings`,
    count: (n: number) => ` · ${n}`, more: ' …',
    liveWaiting: 'waiting for you', liveStopped: 'stopped', liveDone: 'done', liveIdle: 'idle', liveLabel: (t: string) => `Right now: ${t}`,
    rawTitle: 'Recorded action', unverified: 'No result recorded: nothing is claimed about how it went.',
  },
})
