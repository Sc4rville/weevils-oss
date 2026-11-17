// La liste des fichiers d'un repo, gardée en cache : l'explorateur, et « ouvre le fichier » dans les fils.
import { api } from '../api'

const fileLists = new Map<string, Promise<string[]>>()

export const listFiles = (repo: string, machine: string) => {
  const k = `${machine}:${repo}`
  if (!fileLists.has(k)) fileLists.set(k, api.files(repo, machine).then((r) => r.files).catch((e) => (fileLists.delete(k), Promise.reject(e))))
  return fileLists.get(k)!
}

/** Un chemin vu dans un message (« ~/projects/r/src/a.ts:12 », « src/a.ts », « a.ts ») : le repo, le fichier et la ligne s'ils existent. */
export function parsePath(raw: string, repo?: string): { repo: string; rel: string; line?: number } | null {
  const m = /^(.*?)(?::(\d+))?(?::\d+)?$/.exec(raw.trim())
  const p = (m?.[1] ?? raw).replace(/^\.\//, '')
  const line = m?.[2] ? Number(m[2]) : undefined
  const inProjects = /(?:^|\/)projects\/([\w.@+-]+)\/(.+)$/.exec(p)
  if (inProjects) return { repo: inProjects[1], rel: inProjects[2], line }
  if (!repo || p.startsWith('/') || p.startsWith('~')) return null
  return { repo, rel: p, line }
}

/** Le fichier du repo qui correspond à rel : exact, sinon le seul qui finit par /rel. */
export function matchFile(files: string[], rel: string): string | null {
  if (files.includes(rel)) return rel
  const ends = files.filter((f) => f.endsWith(`/${rel}`))
  return ends.length === 1 ? ends[0] : null
}
