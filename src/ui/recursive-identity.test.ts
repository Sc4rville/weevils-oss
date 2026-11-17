import { expect, it } from 'vitest'
import type { Project, Session, WorkstreamIdentity } from '../../shared/api'
import { selfProject, improvingProject, mainProjectRank } from './recursive-identity'
import { stableOrder } from './app-context'
const identity:WorkstreamIdentity={kind:'self-improvement',installationId:'own-install',target:{machineId:'machine',projectId:'p',repo:'renamed-checkout'},evidence:'repository-identity'}
const project={id:'p',name:'My workspace',workstream:identity} as Project
const working={id:'s',projectId:'p',live:true,status:'working',workstream:identity} as Session
it('recognizes structured identity independently of name and keeps it through reload',()=>{
 expect(selfProject(project)).toBe(true)
 expect(selfProject({id:'other',name:'weevils'} as Project)).toBe(false)
 expect(selfProject(JSON.parse(JSON.stringify(project)))).toBe(true)
})
it.each(['idle','done','needs_user','interrupted'] as const)('does not animate %s',status=>{
 expect(improvingProject(project,[{...working,status}])).toBe(false)
})
it('requires a live current session belonging to this exact installation and repository',()=>{
 expect(improvingProject(project,[working])).toBe(true)
 for(const over of [{live:false},{archived:true},{projectId:'elsewhere'},{workstream:undefined},{workstream:{...identity,installationId:'another-install'}},{workstream:{...identity,target:{...identity.target,repo:'another-repo'}}}]){
  expect(improvingProject(project,[{...working,...over}])).toBe(false)
 }
})
it('pins only the canonical project and retains ordinary stable order and gesture protection',()=>{
 const others=[{id:'a',lastActivityAt:10},{id:'b',lastActivityAt:20}] as Project[]
 const order=(frozen=false)=>stableOrder([...others,project],p=>p.id,p=>mainProjectRank(p,0),(a,b)=>b.lastActivityAt-a.lastActivityAt,['a','b','p'],frozen).map(p=>p.id)
 expect(order()).toEqual(['p','a','b'])
 expect(order(true)).toEqual(['a','b','p'])
})
it('pins a server-identified installation without inventing a source repo, workstream or activity', () => {
 const installed = { id: 'installation:own', name: 'weevils', kind: 'installation', installation: { id: 'own', machineId: 'm', source: 'artifact' }, repos: [], where: {}, lastActivityAt: 0 } as Project
 expect(selfProject(installed)).toBe(true)
 expect(mainProjectRank(installed, 4)).toBe(-1)
 expect(improvingProject(installed, [working])).toBe(false)
 expect(installed.workstream).toBeUndefined()
})
