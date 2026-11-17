import type { Project, Session } from '../../shared/api'

/** Server identity, never a project name, message substring or historical automation association. */
export function selfProject(project: Project): boolean {
  return !!project.installation || project.workstream?.kind === 'self-improvement' && project.workstream.target.projectId === project.id
}
export function improvingProject(project: Project, sessions: Session[]): boolean {
  if (!selfProject(project)) return false
  const identity = project.workstream
  if (!identity) return false
  return sessions.some(s => !s.archived && s.live && s.status === 'working'
    && s.projectId === project.id && s.workstream?.kind === 'self-improvement'
    && s.workstream.installationId === identity.installationId
    && s.workstream.target.projectId === project.id
    && s.workstream.target.repo === identity.target.repo
    && s.workstream.target.machineId === identity.target.machineId)
}
/** A task or proposal working on weevils itself: its repo belongs to the self project. */
export function selfRepo(projects: Project[], repo: string | null | undefined): boolean {
  return !!repo && projects.some((p) => selfProject(p) && (p.repos.includes(repo) || p.name === repo))
}
/** Applied only by the main project list; feed cards retain their chronological order. */
export const mainProjectRank = (project: Project, ordinaryRank: number) => selfProject(project) ? -1 : ordinaryRank
