import { tr } from './i18n'
import M from './i18n/voice'
/** Voice is journalled independently of the message outbox. A transcript is not a sent message.
 * Keep originals after errors and after insertion in the draft; never clear them on navigation. */
export interface VoiceRecording {
  id: string
  scope: string
  type: string
  lang: string
  startedAt: number
  stoppedAt?: number
  count: number
  text?: string
  insertedAt?: number
}
// Last-resort copy if IndexedDB fills up. Survives in-app navigation, never claimed durable.
export const volatileVoiceRecordings = new Map<string, { recording: VoiceRecording; parts: Blob[] }>()
let opening: Promise<IDBDatabase> | undefined
function database() {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error(tr(M).storageUnavailable))
    const r = indexedDB.open('weevils-voice', 1)
    r.onupgradeneeded = () => {
      r.result.createObjectStore('recordings', { keyPath: 'id' })
      r.result.createObjectStore('chunks')
    }
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  }).catch(e => { opening = undefined; throw e })
  return opening
}
export async function saveRecording(value: VoiceRecording) {
  const db = await database()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('recordings', 'readwrite')
    tx.objectStore('recordings').put(value)
    tx.oncomplete = () => resolve()
    tx.onerror = tx.onabort = () => reject(tx.error)
  })
}
export async function saveVoiceChunk(recording: VoiceRecording, seq: number, chunk: Blob) {
  const db = await database()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['recordings', 'chunks'], 'readwrite')
    tx.objectStore('chunks').put(chunk, [recording.id, seq])
    tx.objectStore('recordings').put(recording)
    tx.oncomplete = () => resolve()
    tx.onerror = tx.onabort = () => reject(tx.error)
  })
}
export async function voiceRecordings(scope: string): Promise<VoiceRecording[]> {
  const db = await database()
  const all = await new Promise<VoiceRecording[]>((resolve, reject) => {
    const r = db.transaction('recordings').objectStore('recordings').getAll()
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
  return all.filter(r => r.scope === scope).sort((a, b) => b.startedAt - a.startedAt)
}
export async function recordedChunks(recording: VoiceRecording): Promise<Blob[]> {
  const db = await database()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('chunks')
    const parts: Blob[] = []
    const r = tx.objectStore('chunks').openCursor(IDBKeyRange.bound([recording.id, 0], [recording.id, recording.count]))
    r.onsuccess = () => {
      const cur = r.result
      if (!cur) return
      const key = cur.key as [string, number]
      parts[key[1]] = cur.value
      cur.continue()
    }
    tx.oncomplete = () => {
      if (parts.length !== recording.count || Array.from({ length: recording.count }, (_, i) => parts[i]).some(p => !(p instanceof Blob))) reject(new Error(tr(M).incompleteAudio))
      else resolve(parts)
    }
    tx.onerror = tx.onabort = () => reject(tx.error)
  })
}

/** Safari may emit one large final blob. Split bytes, never independently encode/decode audio. */
export function splitVoiceChunk(blob: Blob): Blob[] {
  const parts: Blob[] = []
  for (let at = 0; at < blob.size; at += 512 * 1024) parts.push(blob.slice(at, at + 512 * 1024, blob.type))
  return parts
}
