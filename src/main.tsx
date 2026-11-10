import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

// Service worker : notifications et mise à jour (aucun cache). À chaque ouverture et à chaque retour au premier plan, on
// revérifie sw.js sans cache HTTP : après un build, le nouveau service worker recharge les pages restées sur l'ancien
// bundle (public/sw.js). Il demande à chaque page son bundle : celui-ci, qui contient ce module.
const BUILD = new URL(import.meta.url).pathname.split('/').pop()
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'build?') e.ports[0]?.postMessage(BUILD)
  })
  const check = () =>
    void navigator.serviceWorker
      .register('/sw.js', { updateViaCache: 'none' })
      .then((r) => r.update())
      .catch(() => undefined)
  check()
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check())
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
