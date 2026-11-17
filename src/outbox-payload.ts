/** Attachments remain on this device until durable server acceptance; never put base64 photos in localStorage. */
let opened: Promise<IDBDatabase> | undefined
function database() {
  opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error())
    const req = indexedDB.open('weevils-outbox', 1)
    req.onupgradeneeded = () => req.result.createObjectStore('payloads')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  }).catch(e => { opened = undefined; throw e })
  return opened
}
export async function storePayload(id: string, body: unknown) {
  const db = await database()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('payloads', 'readwrite'); tx.objectStore('payloads').put(body, id)
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error)
  })
}
export async function loadPayload(id: string): Promise<unknown> {
  const db = await database()
  return new Promise((resolve, reject) => { const r = db.transaction('payloads').objectStore('payloads').get(id); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
}
export async function removePayload(id: string) {
  const db = await database()
  await new Promise<void>((resolve, reject) => { const tx = db.transaction('payloads', 'readwrite'); tx.objectStore('payloads').delete(id); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error) })
}
