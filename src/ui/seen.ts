import { useSyncExternalStore } from 'react'
import type { Session } from '../../shared/api.ts'

// Lu / non lu : une session qui a répondu depuis la dernière fois que sa conversation a été ouverte est « non lue ».
// Mémoire locale à l'appareil ; au premier lancement, tout ce qui existe déjà compte comme lu.

const KEY = 'weevils-seen'
let seen: Record<string, number> = {}
try {
  seen = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, number>
} catch {
  /* stockage indisponible */
}
let version = 0
const listeners = new Set<() => void>()
const save = () => {
  version++
  try {
    localStorage.setItem(KEY, JSON.stringify(seen))
  } catch {
    /* ignoré */
  }
  for (const l of listeners) l()
}

export function markSeen(id: string, at: number) {
  if ((seen[id] ?? 0) >= at) return
  seen[id] = at
  save()
}

/** Les sessions inconnues de cet appareil sont considérées lues telles quelles (pas de rafale de points au premier lancement). */
export function adoptUnknown(sessions: Session[]) {
  let changed = false
  for (const s of sessions) {
    if (seen[s.id] == null) {
      seen[s.id] = s.lastActivityAt
      changed = true
    }
  }
  if (changed) save()
}

export const isUnread = (s: Session) => s.status !== 'working' && s.messageCount > 0 && !!s.lastMessage && s.lastActivityAt > (seen[s.id] ?? 0)

export function useSeen() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => version,
  )
}
