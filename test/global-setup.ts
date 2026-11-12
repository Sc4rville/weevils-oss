// Un dossier racine par lancement de vitest : chaque fichier de test y prend son HOME jetable (setup-env.ts), et tout
// part à la fin, même les fichiers entièrement sautés (dont afterAll ne tourne pas).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function setup() {
  process.env.WEEVILS_TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-test-'))
}

export function teardown() {
  if (process.env.WEEVILS_TEST_ROOT) fs.rmSync(process.env.WEEVILS_TEST_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
