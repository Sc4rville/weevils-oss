// The public setup page (get/server.mjs) keeps the new weevils' login link, sealed, until its first login here.
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './config.ts'

/** Installé depuis la page publique (get/bootstrap.sh laisse ce fichier) : à la première connexion, on le lui dit une
 * fois, pour qu'elle cesse de garder le lien de connexion (chiffré) qu'elle montrait encore. Rien d'autre ne lui est
 * jamais envoyé. Le fichier est effacé avant l'envoi : une seule tentative. */
export const GET_CLAIM_FILE = path.join(DATA_DIR, 'get-claim')
export function claimSetup(file = GET_CLAIM_FILE, post: typeof fetch = fetch) {
  let url = ''
  try {
    url = fs.readFileSync(file, 'utf8').trim()
    fs.rmSync(file, { force: true })
  } catch {
    return false
  }
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?\/r\/[a-z2-9]{10}$/.test(url)) return false
  post(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'event=claimed', signal: AbortSignal.timeout(10_000) }).catch(() => {})
  return true
}
