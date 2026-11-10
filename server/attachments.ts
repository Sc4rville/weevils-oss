// Read-only photo previews for the authenticated thread. Never publish them into « for you ».
import fs from 'node:fs'
import path from 'node:path'
import type { ServerResponse } from 'node:http'

const TYPES: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic' }

export function attachmentFile(raw: string, roots: string[]): { file: string; type: string } | null {
  try {
    const file = fs.realpathSync(raw)
    const type = TYPES[path.extname(file).toLowerCase()]
    if (!type || !fs.statSync(file).isFile()) return null
    const inside = roots.some((root) => {
      try { return file.startsWith(fs.realpathSync(root) + path.sep) } catch { return false }
    })
    return inside ? { file, type } : null
  } catch { return null }
}

export function serveAttachment(res: ServerResponse, raw: string, roots: string[]) {
  const found = attachmentFile(raw, roots)
  if (!found) { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'content-type': found.type, 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-cache' })
  const stream = fs.createReadStream(found.file)
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}
