// Service worker weevils : les notifications push, et rien en cache. Il garde aussi l'app à jour : iOS peut garder une
// page en mémoire des heures et la réveiller sans la recharger (ancienne interface revenue alors que main est à jour).

// Nom du bundle d'entrée, écrit au build (vite.config.ts, swBuild) : chaque build change ce fichier, le navigateur
// installe alors ce service worker, qui recharge chaque page ouverte sur une autre version.
const BUILD = '__WEEVILS_BUILD__'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => {
  const claimed = self.clients.claim()
  e.waitUntil(claimed)
  // Hors de waitUntil : la navigation d'une page attend la fin de l'activation (sinon interblocage, rien ne recharge).
  void claimed.then(reloadStale)
})

// La page répond avec son bundle (src/main.tsx) ; sans réponse (code d'avant cette vérification, ou page gelée), ou avec
// une autre version, on attend une autorisation explicite de la page avant toute navigation.
function versionOf(client) {
  return new Promise((resolve) => {
    const ch = new MessageChannel()
    const timer = setTimeout(() => resolve(null), 2000)
    ch.port1.onmessage = (m) => {
      clearTimeout(timer)
      resolve(m.data)
    }
    client.postMessage({ type: 'build?' }, [ch.port2])
  })
}

let retryUpdate
async function reloadStale() {
  if (BUILD.startsWith('__')) return // serveur de dev : pas de version
  const list = await self.clients.matchAll({ type: 'window' })
  await Promise.all(
    list.map(async (c) => {
      const version = await versionOf(c)
      // Never navigate away from an unacknowledged send, a draft or attached photos.
      if ((version?.build ?? version) === BUILD) return
      // Old/frozen clients cannot attest that their microphone is safely persisted.
      // No reply is never evidence that navigation is safe.
      if (version?.safeToReload !== true || version?.editing) {
        if (!retryUpdate) retryUpdate = setTimeout(() => { retryUpdate = null; void reloadStale() }, 5000)
        return
      }
      if ('navigate' in c) await c.navigate(c.url).catch(() => undefined)
    }),
  )
}

const notificationKinds = new Set(['result', 'milestone', 'warning', 'question', 'test'])
const notificationNoise = (n) => /^(?:r:|d:|commit:|deploy:)/.test(n.tag || '') || n.tag === 'relay'
  || /^(?:compris|bien reçu|coordination confirmée|je vais|je vérifie|got it|understood)(?=$|[.! ,])/i.test(n.body || '')
  || /^(?:corrigé|fait|done|fixed)[.! ]*$/i.test(n.body || '')

function requestResolved(n, state) {
  const data = n.data || n
  const id = data.sessionId || (n.tag || '').replace(/^cut-/, '')
  const sessions = state.sessions || []
  const session = sessions.find(s => s.id === id)
  const question = data.category === 'question' || /t[’']attend|needs you/i.test(n.title || '')
  const cut = data.category === 'warning' && data.sessionId || (n.tag || '').startsWith('cut-')
  if (question && n.tag !== 'relay-plans') return !session || session.archived || session.status !== 'needs_user'
  if (cut) return !session || session.archived || session.status !== 'interrupted'
  if (n.tag === 'relay-plans' && typeof state.relayNeedsApproval === 'boolean') return !state.relayNeedsApproval
  return false
}

// Foreground snapshots remove old noise and questions already answered, without sending a silent push.
self.addEventListener('message', e => {
  if (e.data?.type === 'check-build') {
    e.waitUntil(reloadStale())
    return
  }
  if (e.data?.type !== 'notification-state') return
  // Old bundles already send this after a foreground snapshot. Recover even when
  // activation happened in the background and the worker's retry timer was lost.
  e.waitUntil(Promise.all([reloadStale(), self.registration.getNotifications().then(list => {
    for (const n of list) if (notificationNoise(n) || requestResolved(n, e.data)) n.close()
  })]))
})

self.addEventListener('push', e => {
  let d = {}
  try { d = e.data ? e.data.json() : {} } catch { return }
  e.waitUntil((async () => {
    if (!d.category && /^(?:cut-)/.test(d.tag || '')) { d.category = 'warning'; d.sessionId = d.tag.slice(4) }
    if (!d.category && /t[’']attend|needs you/i.test(d.title || '')) { d.category = 'question'; d.sessionId = d.tag }
    if (!d.category && d.tag === 'relay-plans') d.category = 'question'
    if (!notificationKinds.has(d.category) || notificationNoise(d)) return
    if (d.sessionId && (d.category === 'question' || d.category === 'warning')) {
      try {
        const res = await fetch('/api/snapshot', { credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(3000) })
        if (res.ok && requestResolved(d, await res.json())) return
      } catch { /* an unavailable snapshot does not prove a real alert is resolved */ }
    }
    await self.registration.showNotification(d.title || 'weevboss', {
      body: d.body || '', tag: d.tag, renotify: false,
      data: { url: d.url || '/', category: d.category, sessionId: d.sessionId, eventAt: d.eventAt },
      icon: '/icon-192.png?v=7097fb6eff20', badge: '/badge-96.png?v=a391e6f73e13',
    })
  })())
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const url = (e.notification.data && e.notification.data.url) || '/'
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) {
          c.postMessage({ type: 'open', url })
          return c.focus()
        }
      }
      return self.clients.openWindow(url)
    }),
  )
})
