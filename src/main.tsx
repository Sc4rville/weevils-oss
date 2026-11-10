import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

// Service worker : seulement pour les notifications (aucun cache). À chaque ouverture, on revérifie sw.js sans cache HTTP.
if ('serviceWorker' in navigator)
  void navigator.serviceWorker
    .register('/sw.js', { updateViaCache: 'none' })
    .then((r) => r.update())
    .catch(() => undefined)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
