// A session working in a temporary folder (/tmp, /var/tmp, the system's TMPDIR, a Mac's /private/var/folders) is a
// probe or a throwaway test, run by an agent or a script: it stays visible in the app but never reaches For you, a
// notification or weevboss's thread. Real work lives in a project folder; nothing anybody keeps lives in /tmp.

import os from 'node:os'
import path from 'node:path'

const ROOTS = [...new Set(['/tmp', '/var/tmp', '/private/tmp', '/private/var/folders', '/var/folders', os.tmpdir()].map((d) => path.resolve(d)))]

const under = (dir: string, root: string) => dir === root || dir.startsWith(root + path.sep)

/** In a temporary folder and outside the user's home (a home that lives in a temporary folder, as in the tests or a
 *  throwaway copy, keeps its projects real). */
export const isScratchDir = (cwd?: string | null): boolean => {
  if (!cwd || under(cwd, path.resolve(os.homedir()))) return false
  return ROOTS.some((r) => under(cwd, r))
}
