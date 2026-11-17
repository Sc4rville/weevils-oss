import { expect, it } from 'vitest'
import type { Project, Session } from '../shared/api.ts'
import { previewTarget } from './preview-target.ts'
const projects = [{id:'site'}] as Project[]
const session = (id:string, patch:Partial<Session> = {}):Session => ({id,projectId:'site',repo:'web',live:true,status:'idle',controllable:true,lastActivityAt:100,...patch}) as Session
it('routes within the real project/repo, preferring a live active owner without changing the source list',()=>{
 const sessions=[session('other',{projectId:'other',lastActivityAt:900}),session('old',{live:false,lastActivityAt:800}),session('idle'),session('working',{status:'working'}),session('archived',{archived:true,status:'working',lastActivityAt:900}),session('wrong-repo',{repo:'api',status:'working',lastActivityAt:900})]
 expect(previewTarget(projects,sessions,{projectId:'site',repo:'web'}).session?.id).toBe('working')
 expect(sessions[0].id).toBe('other')
})
it('keeps the current target and never substitutes another session when it disappears or becomes read-only',()=>{
 const sessions=[session('current'),session('new',{status:'working'})]
 expect(previewTarget(projects,sessions,{projectId:'site',sessionId:'current'}).session?.id).toBe('current')
 expect(previewTarget(projects,[session('current',{controllable:false}),sessions[1]],{projectId:'site',sessionId:'current'})).toEqual({session:null,reason:'no-session'})
 expect(previewTarget(projects,sessions,{projectId:'site',repo:'different',sessionId:'current'}).session).toBeNull()
})
it('has a stable tie-break and never falls back to a global session or creates one',()=>{
 expect(previewTarget(projects,[session('b'),session('a')],{projectId:'site'}).session?.id).toBe('a')
 expect(previewTarget(projects,[session('other',{projectId:'other'})],{projectId:'site'})).toEqual({session:null,reason:'no-session'})
 expect(previewTarget(projects,[session('a')],{projectId:'unknown'})).toEqual({session:null,reason:'no-project'})
})
