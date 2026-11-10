const KEY = 'weevils-dismissed-notices-v1'
let cache: string | null | undefined
let hidden = new Set<string>()
let version = 0
const listeners = new Set<() => void>()
function read() {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw !== cache) {
      cache = raw
      const list: unknown = raw ? JSON.parse(raw) : []
      hidden = new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [])
    }
  } catch { /* Storage unavailable: the in-memory choice still works. */ }
}
const emit = () => { version++; for (const listener of listeners) listener() }
export const isNoticeDismissed = (id: string) => { read(); return hidden.has(id) }
export function dismissNotice(id: string) {
  read()
  hidden.add(id)
  const raw = JSON.stringify([...hidden].slice(-5000))
  try { localStorage.setItem(KEY, raw); cache = raw } catch { /* Keep the in-memory choice. */ }
  emit()
}
export const subscribeNotices = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export const noticeVersion = () => version
if (typeof window !== 'undefined') window.addEventListener('storage', (e) => { if (e.key === KEY || e.key === null) { read(); emit() } })
/** Test isolation; the app never clears a user's choices. */
export function resetNotices() { hidden = new Set(); cache = undefined; try { localStorage.removeItem(KEY) } catch {} emit() }
