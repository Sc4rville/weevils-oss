import type { Project, Session, SourceAccess, WorkstreamIdentity } from '../../shared/api'
import { tr } from '../i18n'
import M from '../i18n/source-access'
export type SourceTarget = { sourceAccess?: SourceAccess; workstream?: WorkstreamIdentity }
/** Identity identifies the subject requiring a check, never grants execution rights. */
export function sourceAccessIssue(target: SourceTarget | null | undefined): string | null {
 const access=target?.sourceAccess
 if(access?.canExecute===true)return null
 if(access?.canExecute===false)return tr(M)[access.reason==='owned-writable'?'unavailable':access.reason]
 return target?.workstream?.kind==='self-improvement'?tr(M).unknown:null
}
/** Match the actual selected repository and machine; never block unrelated repositories in the same group. */
export function sourceForRepo(projects: Project[], repo: string | undefined, machine: string | undefined): SourceTarget | undefined {
 if (!repo || !machine) return undefined
 return projects.find(p=>p.sourceAccess?.repo===repo && p.sourceAccess.machineId===machine)
  ?? projects.find(p=>p.workstream?.target.repo===repo && p.workstream.target.machineId===machine)
}

/** A session's explicit server policy wins over older project metadata. */
export function sourceForSession(projects: Project[], session: Session | null | undefined): SourceTarget | undefined {
 if (session?.sourceAccess) return session
 return sourceForRepo(projects, session?.repo ?? undefined, session?.machineId) ?? session ?? undefined
}
