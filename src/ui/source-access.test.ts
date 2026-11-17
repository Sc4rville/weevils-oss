import { afterEach, expect, it } from 'vitest'
import type { Project, Session, SourceAccess, WorkstreamIdentity } from '../../shared/api'
import { setLang } from '../i18n'
import { sourceAccessIssue, sourceForRepo, sourceForSession } from './source-access'
const workstream: WorkstreamIdentity = { kind: 'self-improvement', installationId: 'install', target: { repo: 'renamed', machineId: 'm', projectId: 'p' }, evidence: 'repository-identity' }
const denied: SourceAccess = { repo: 'renamed', machineId: 'm', canExecute: false, reason: 'not-writable' }
const project: Project = { id: 'p', name: 'Project', kind: 'repo', repos: ['renamed', 'other'], where: { renamed: 'm', other: 'm' }, lastActivityAt: 0, workstream, sourceAccess: denied }
afterEach(() => setLang(null))
it('separates canonical identity from explicit execution policy and does not restrict unrelated unknown sources', () => {
 setLang('en')
 expect(sourceAccessIssue({ workstream })).toContain('not been verified')
 expect(sourceAccessIssue({ sourceAccess: denied })).toContain('Read-only')
 expect(sourceAccessIssue({ sourceAccess: { ...denied, canExecute: true, reason: 'owned-writable' } })).toBeNull()
 expect(sourceAccessIssue({})).toBeNull()
 expect(sourceAccessIssue(undefined)).toBeNull()
 for (const lang of ['en', 'fr', 'en'] as const) {
  setLang(lang)
  expect(sourceAccessIssue({ sourceAccess: denied })).toContain(lang === 'fr' ? 'lecture seule' : 'Read-only')
 }
})
it('matches selected machine and repository, never an entire multi-repository group or missing selection', () => {
 expect(sourceForRepo([project], 'renamed', 'm')).toBe(project)
 expect(sourceForRepo([project], 'other', 'm')).toBeUndefined()
 expect(sourceForRepo([project], 'renamed', 'remote')).toBeUndefined()
 expect(sourceForRepo([project, { ...project, sourceAccess: undefined, workstream: undefined }], undefined, undefined)).toBeUndefined()
})
it('prefers an explicit session policy to older project metadata and retains identity when the project is unavailable', () => {
 const session = { repo: 'renamed', machineId: 'm', workstream } as Session
 expect(sourceAccessIssue(sourceForSession([project], session))).toContain('Read-only')
 const allowed = { ...session, sourceAccess: { ...denied, canExecute: true, reason: 'owned-writable' as const } }
 expect(sourceAccessIssue(sourceForSession([project], allowed))).toBeNull()
 expect(sourceAccessIssue(sourceForSession([], session))).toContain('not been verified')
})
