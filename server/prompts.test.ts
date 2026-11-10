// Prompts des agents en FR/EN : gabarits de weevboss présents dans les deux langues, clés JSON des prompts français inchangées.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import Classify from './i18n/classify.ts'
import Github from './i18n/github.ts'
import Titles from './i18n/titles.ts'

describe('prompts FR/EN', () => {
  it('weevboss a un gabarit par langue, avec les mêmes emplacements', () => {
    for (const l of ['fr', 'en']) {
      const md = fs.readFileSync(path.join(import.meta.dirname, `orchestrator.${l}.md`), 'utf8')
      expect(md).toContain('{{user}}')
      expect(md).toContain('{{owner}}')
      expect(md).toContain('weevils send')
    }
  })

  it('les prompts français gardent leurs clés, les anglais demandent l’anglais', () => {
    expect(Object.keys(JSON.parse(Titles.fr.item('a', 'claude', 'x', 'd', ['r'])))).toEqual(['id', 'outil', 'ou', 'debut', 'derniers_echanges'])
    expect(Object.keys(JSON.parse(Classify.fr.item('a', 't', 'e')))).toEqual(['id', 'titre', 'extrait'])
    expect(Object.keys(JSON.parse(Github.fr.blurbItem('n', 'd', 'r', 'TS')))).toEqual(['name', 'description', 'readme', 'langage'])
    expect(Titles.en.prompt('the user', '[]')).toContain('in English')
    expect(Classify.en.task('the user')).toContain('in English')
    expect(Github.en.blurbPrompt('the user', '[]')).toContain('in English')
  })
})
