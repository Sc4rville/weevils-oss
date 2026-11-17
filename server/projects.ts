import fs from 'node:fs'
import { automationSourceRoot } from './automation-workspaces.ts'
// Où range-t-on une session ? Étage déterministe du classement : dossier → repo → famille de repos.

import path from 'node:path'
import { tr } from './i18n.ts'
import M from './i18n/projects.ts'

export interface Placement {
  projectId: string
  projectName: string
  kind: 'repo' | 'invented'
  repo: string | null
}

/** Projet des sessions hors de tout repo : id stable, nom affiché selon la langue (projectLabel). */
export const MISC = 'divers' // i18n-ignore : identifiant, jamais affiché tel quel

/** Nom affiché d'un projet : les ids réservés (divers, general) ont un libellé dans la langue de l'utilisateur, les autres sont leur nom. */
export const projectLabel = (id: string) => (id === MISC ? tr(M).misc : id === 'general' ? tr(M).general : id)

/** shop-api, shop-web → shop ; blog → blog. */
export function familyOf(repo: string): string {
  return (repo.split(/[-_.]/)[0] || repo).toLowerCase()
}

/** roots : dossiers de projets de la machine (~/projects, ~/Documents/projects…). */
export function place(cwd: string, roots: string[]): Placement {
  if (cwd) {
    for(const root of roots){
      const source=automationSourceRoot(root)
      if(!source)continue
      const rel=path.relative(source,cwd)
      if(rel.startsWith('..')||path.isAbsolute(rel))continue
      const repo=rel.split(path.sep)[0]
      if(!repo)continue
      try{
        const m=JSON.parse(fs.readFileSync(path.join(source,repo,'automation.json'),'utf8'))
        if(m.kind==='automation'&&repo===`auto-${m.id}`)return {projectId:repo,projectName:repo,kind:'repo',repo}
      }catch{}
    }
    for (const root of roots) {
      const rel = path.relative(root, cwd)
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue
      // On saute les dossiers cachés (.archive/shop → shop).
      const repo = rel.split(path.sep).find((seg) => seg && !seg.startsWith('.'))
      if (repo) {
        const fam = familyOf(repo)
        return { projectId: fam, projectName: fam, kind: 'repo', repo }
      }
      return { projectId: MISC, projectName: projectLabel(MISC), kind: 'invented', repo: null }
    }
  }
  return { projectId: MISC, projectName: projectLabel(MISC), kind: 'invented', repo: null }
}
