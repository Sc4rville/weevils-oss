// Garde-fous de l'i18n : aucune chaîne en dur ne revient (détecteur scripts/check-i18n.mjs), et chaque catalogue
// a exactement les mêmes clés, de même forme, en français et en anglais (TypeScript le vérifie déjà ; ce test
// protège aussi ce qui échappe au typage).

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '..')

describe('i18n detector', () => {
  it('finds no hardcoded user-facing string', () => {
    let out = ''
    let code = 0
    try {
      out = execFileSync(process.execPath, [path.join(ROOT, 'scripts/check-i18n.mjs')], { cwd: ROOT, encoding: 'utf8' })
    } catch (e) {
      const err = e as { status?: number; stdout?: string }
      code = err.status ?? 1
      out = err.stdout ?? ''
    }
    // En cas d'échec, la sortie liste « fichier:ligne: extrait » : mettre le texte dans un catalogue
    // (src/i18n/<zone>.ts, server/i18n/<zone>.ts), ou « // i18n-ignore » si ce n'est pas affiché.
    expect(out.trim(), out).toBe('i18n: no hardcoded strings')
    expect(code).toBe(0)
  })
})

const catalogs = ['src/i18n', 'server/i18n'].flatMap((dir) =>
  fs
    .readdirSync(path.join(ROOT, dir))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'index.ts')
    .map((f) => `${dir}/${f}`),
)

type Shape = Record<string, string>
/** Clé → « string » ou « function/<nombre d'arguments> ». */
const shape = (m: Record<string, unknown>): Shape =>
  Object.fromEntries(
    Object.keys(m)
      .sort()
      .map((k) => {
        const v = m[k]
        return [k, typeof v === 'function' ? `function/${v.length}` : typeof v]
      }),
  )

describe('i18n catalogs', () => {
  it('are found', () => {
    expect(catalogs.length).toBeGreaterThan(10)
  })

  it.each(catalogs)('%s has the same keys in fr and en', async (file) => {
    const mod = (await import(pathToFileURL(path.join(ROOT, file)).href)) as { default?: { fr?: Record<string, unknown>; en?: Record<string, unknown> } }
    const m = mod.default
    expect(m, `${file}: default export defineMessages({ fr, en })`).toBeTruthy()
    expect(Object.keys(m!).sort()).toEqual(['en', 'fr'])
    const fr = shape(m!.fr!)
    const en = shape(m!.en!)
    expect(en).toEqual(fr)
  })
})
