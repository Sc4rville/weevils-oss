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
// une autre version, elle est rechargée.
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

async function reloadStale() {
  if (BUILD.startsWith('__')) return // serveur de dev : pas de version
  const list = await self.clients.matchAll({ type: 'window' })
  await Promise.all(
    list.map(async (c) => {
      if ((await versionOf(c)) !== BUILD && 'navigate' in c) await c.navigate(c.url).catch(() => undefined)
    }),
  )
}

self.addEventListener('push', (e) => {
  let d = {}
  try {
    d = e.data ? e.data.json() : {}
  } catch {
    d = { body: e.data ? e.data.text() : '' }
  }
  e.waitUntil(
    self.registration.showNotification(d.title || 'weevboss', {
      body: d.body || '',
      tag: d.tag,
      data: { url: d.url || '/' },
      icon: '/icon-192.png',
      badge: '/icon-192.png',
    }),
  )
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
