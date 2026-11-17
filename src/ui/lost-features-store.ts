import { useMemo, useSyncExternalStore } from 'react'
import type { Snapshot } from '../../shared/api'

const CHANGE = 'weevils-lost-features-change'
export const lostFeaturesKey = (scope: string) => `weevils-lost-features-v1:${scope}`
export function initialThinkEnabled(snap: Snapshot): boolean {
  return !!snap.setup?.welcomed
}
export function readThinkEnabled(scope: string, fallback = false): boolean {
  try {
    const value = localStorage.getItem(lostFeaturesKey(scope))
    return value === null ? fallback : JSON.parse(value).think === true
  } catch { return fallback }
}
export function setThinkEnabled(scope: string, enabled: boolean) {
  // A failed write is an error, not a successful persistent toggle.
  localStorage.setItem(lostFeaturesKey(scope), JSON.stringify({ think: enabled }))
  window.dispatchEvent(new Event(CHANGE))
}
const subscribe = (notify: () => void) => {
  window.addEventListener(CHANGE, notify); window.addEventListener('storage', notify)
  return () => { window.removeEventListener(CHANGE, notify); window.removeEventListener('storage', notify) }
}
export function useThinkEnabled(snap: Snapshot) {
  // Browser/origin preference, partitioned by the reported machine name. This is not an account
  // or installation identity: two profiles with the same origin and machine id share this choice.
  const scope = snap.machines[0]?.id ?? 'local'
  // Freeze the migration before first-run completion can change the snapshot.
  const initial = useMemo(() => {
    let enabled = initialThinkEnabled(snap)
    try {
      const alreadyScoped = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).some(key => key?.startsWith('weevils-lost-features-v1:'))
      enabled ||= !alreadyScoped && localStorage.getItem('think-camera') !== null
      if (localStorage.getItem(lostFeaturesKey(scope)) === null) localStorage.setItem(lostFeaturesKey(scope), JSON.stringify({ think: enabled }))
    } catch { /* read-only storage: UI remains usable, writes report failure */ }
    return enabled
  }, [scope])
  const enabled = useSyncExternalStore(subscribe, () => readThinkEnabled(scope, initial), () => false)
  return [enabled, (value: boolean) => setThinkEnabled(scope, value)] as const
}
