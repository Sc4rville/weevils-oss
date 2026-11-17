import { defineMessages } from './index'
export default defineMessages({
 fr: {
  source: 'Progression du rendu', working: 'Rendu en cours', waiting: 'En attente du rendu', done: 'Rendu prêt à vérifier', error: 'Rendu en pause', stale: 'Suivi du rendu indisponible', offline: 'Connexion au suivi interrompue',
  workerStopped: 'La machine de rendu s’est arrêtée. Demande dans le fil de la relancer.', capacity: 'Aucune machine libre pour l’instant. Demande dans le fil de réessayer plus tard.', pausedUnknown: 'Le rendu s’est arrêté. Demande dans le fil ce qui s’est passé.',
  reported: (n: string) => `${n} image${n === '1' ? '' : 's'} annoncée${n === '1' ? '' : 's'}`, verified: (n: string) => `${n} image${n === '1' ? '' : 's'} vérifiée${n === '1' ? '' : 's'} et récupérée${n === '1' ? '' : 's'}`, fraction: (n: string, total: string) => `${n} / ${total} images annoncées`, updated: (ago: string) => `mis à jour ${ago}`,
 },
 en: {
  source: 'Render progress', working: 'Rendering', waiting: 'Waiting for render progress', done: 'Render ready to review', error: 'Render paused', stale: 'Render updates unavailable', offline: 'Tracking connection lost',
  workerStopped: 'The render machine stopped. Ask in the chat to restart it.', capacity: 'No machine free right now. Ask in the chat to retry later.', pausedUnknown: 'The render stopped. Ask in the chat what went wrong.',
  reported: (n: string) => `${n} reported frame${n === '1' ? '' : 's'}`, verified: (n: string) => `${n} frame${n === '1' ? '' : 's'} verified and downloaded`, fraction: (n: string, total: string) => `${n} / ${total} reported frames`, updated: (ago: string) => `updated ${ago}`,
 },
})
