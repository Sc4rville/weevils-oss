// Test d'intégration contre le weevilsd qui tourne sur cette machine (et, à travers lui, GitHub via gh).
// Jamais dans `npm test` : WEEVILS_LIVE_TEST=1 npx vitest run test/live
// setup-env remplace HOME par un dossier jetable : le secret se lit dans le vrai dossier de l'utilisateur (passwd).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe.skipIf(process.env.WEEVILS_LIVE_TEST !== '1')('routes repos (daemon local)', () => {
  const base = process.env.WEEVILS_LIVE_URL || 'http://127.0.0.1:4179'
  const secret = () => fs.readFileSync(path.join(os.userInfo().homedir, '.config', 'weevils', 'secret'), 'utf8').trim()

  it('GET /api/github/repos renvoie la liste, et un repo non cloné se lit sur GitHub', async () => {
    const h = { authorization: `Bearer ${secret()}` }
    const r = (await (await fetch(`${base}/api/github/repos`, { headers: h })).json()) as any
    expect(r.error).toBeUndefined()
    expect(Array.isArray(r.repos) && r.repos.length > 0).toBe(true)
    const files = (await (await fetch(`${base}/api/repos/${r.repos[0].name}/files`, { headers: h })).json()) as any
    expect(Array.isArray(files.files)).toBe(true)
  }, 30_000)
})
