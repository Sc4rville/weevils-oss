import { useSyncExternalStore } from 'react'

// Devil mode : mémorisé sur l'appareil. Allumé, les messages à weevboss partent vers l'autre modèle, la bande et la
// barre d'état passent en orange. Sans modèle branché côté serveur (snap.devil.enabled), il reste éteint, même si un
// ancien « 1 » traîne sur l'appareil.

const KEY = 'weevils-devil'
const CHANGE = 'weevils-devil-change'

const read = () => {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function setDevil(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? '1' : '0')
  } catch {
    /* stockage indisponible */
  }
  window.dispatchEvent(new Event(CHANGE))
}

const subscribe = (f: () => void) => {
  window.addEventListener(CHANGE, f)
  window.addEventListener('storage', f)
  return () => {
    window.removeEventListener(CHANGE, f)
    window.removeEventListener('storage', f)
  }
}

/** Le devil mode effectif : choisi sur l'appareil et branché sur le serveur. */
export const useDevil = (enabled: boolean) => useSyncExternalStore(subscribe, read, () => false) && enabled
