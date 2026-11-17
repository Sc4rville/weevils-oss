import type { Project, Session } from '../shared/api.ts'

/** Resolve once before capture/outbox persistence. Never retarget an accepted delivery on retry. */
export function previewTarget(projects: readonly Project[], sessions: readonly Session[], input: {projectId: string; repo?: string; sessionId?: string}): {session: Session|null; reason?: 'no-project'|'no-session'} {
  const project = projects.find(p => p.id === input.projectId)
  if (!project) return {session:null, reason:'no-project'}
  const candidates = sessions.filter(s => s.projectId === project.id && s.controllable && !s.archived && (!input.repo || s.repo === input.repo))
  if (input.sessionId) return {session:candidates.find(s => s.id === input.sessionId) ?? null, ...(candidates.some(s => s.id === input.sessionId) ? {} : {reason:'no-session' as const})}
  const ordered = [...candidates].sort((a,b) => Number(b.live)-Number(a.live) || Number(b.status==='working')-Number(a.status==='working') || b.lastActivityAt-a.lastActivityAt || a.id.localeCompare(b.id))
  return ordered.length ? {session:ordered[0]} : {session:null, reason:'no-session'}
}
