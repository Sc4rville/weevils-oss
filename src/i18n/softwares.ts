import { defineMessages } from './index'

export default defineMessages({
  fr: {
    title: 'logiciels',
    kicker: 'logiciels',
    count: (n: number) => `${n} logiciel${n > 1 ? 's' : ''}`,
    idle: 'arrêté',
    starting: 'démarre',
    running: 'tourne',
    failed: 'en échec',
    stop: 'arrêter',
    openTab: 'ouvrir dans un nouvel onglet',
    frame: 'interface du logiciel',
    shot: (name: string) => `capture de ${name}`,
    terminal: (name: string) => `sortie de ${name}`,
    progress: (phase: number, percent: number) =>
      `${phase === 1 ? 'vers une première version' : phase === 2 ? 'version utilisable' : 'utilisateurs'}, phase ${phase} sur 3, ${percent} %`,
    fix: 'toucher pour corriger, appui long pour revenir à l’estimation',
    corrected: 'corrigé à la main, toucher pour revenir à l’estimation',
    notFound: 'introuvable',
  },
  en: {
    title: 'software',
    kicker: 'software',
    count: (n: number) => `${n} app${n === 1 ? '' : 's'}`,
    idle: 'stopped',
    starting: 'starting',
    running: 'running',
    failed: 'failed',
    stop: 'stop',
    openTab: 'open in a new tab',
    frame: 'software interface',
    shot: (name: string) => `screenshot of ${name}`,
    terminal: (name: string) => `output of ${name}`,
    progress: (phase: number, percent: number) =>
      `${phase === 1 ? 'toward a first version' : phase === 2 ? 'usable version' : 'users'}, phase ${phase} of 3, ${percent}%`,
    fix: 'tap to correct, long press to go back to the estimate',
    corrected: 'corrected by hand, tap to go back to the estimate',
    notFound: 'not found',
  },
})
