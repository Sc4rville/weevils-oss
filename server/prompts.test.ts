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
      // « pour toi » : les deux verbes, dans la liste des commandes et dans la consigne
      for (const verb of ['weevils post "', 'weevils show <']) expect(md.split(verb).length, `${l} ${verb}`).toBeGreaterThan(2)
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

it('carries the shared machine prose convention into project handoffs without rewriting their evidence', async()=>{
 const R=(await import('./i18n/relay.ts')).default
 const convention=(await import('./i18n/machine-prose.ts')).default
 const evidence='> [VPS] verbatim quotation\n```text\n[PC] raw transcript\n```\nID: [GPU]-job-123'
 for(const lang of ['fr','en'] as const){
  const common={why:'quota',cwd:'/workspace/project',file:'/archive/thread.jsonl',title:'Render project',auto:false}
  const go=R[lang].go({...common,plan:evidence})
  const plan=R[lang].plan({...common,marker:'[test-plan]',ask:evidence,last:evidence,replies:evidence,steps:evidence,background:'render host and browser host differ',git:'clean'})
  for(const prompt of [go,plan]){expect(prompt).toContain(convention[lang].rule);expect(prompt).toContain(evidence)}
  expect(plan.startsWith('[test-plan]')).toBe(true)
 }
})
