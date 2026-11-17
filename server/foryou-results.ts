import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { ForYouItem, ForYouMedia } from '../shared/foryou.ts'
import type { MediaShelf } from './foryou-media.ts'

// Reviewed with the TLO source session. "final" is render quality, not user approval.
// Portrait: production/renders/alcove_p.png = review/assembly-20261110-173610/alcove_p.png.
// Landscape: production/renders/alcove_l.png = review/assembly-20261110-183822/alcove_l.png.
// batch.json quality=final; resume/runner.log records both final renders.
export const ALCOVE_SOURCE = 'v:4ee5bf13783a'
export const ALCOVE_PORTRAIT = 'b442c5405b86603a'
const FINAL_SHA = 'e3821d779a31d812f372ccbfe7402293baf35ae7baee007f226ba3e277bd0bd2'
export const ALCOVE_FINAL_AT = 1794337730636
const SESSION = '01a1c64d-6a79-78a3-b213-dbf5841b5d18'
type Shelf = Pick<MediaShelf, 'get' | 'add' | 'view'>
const verified = new Map<string, { stamp: string; valid: boolean }>()

export function alcoveFinal(shelf: Shelf | null, cwd: string | undefined): ForYouMedia | undefined {
  if (!shelf || !cwd) return
  const file = path.join(cwd, 'build/production-20261110/renders/alcove_l.png')
  try {
    const stat = fs.statSync(file)
    const stamp = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
    let check = verified.get(file)
    if (check?.stamp !== stamp) {
      check = { stamp, valid: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') === FINAL_SHA }
      verified.set(file, check)
    }
    // A replacement or regression must never silently inherit verified-final status.
    if (check.valid) return shelf.view(shelf.add(file))
  } catch { /* Missing final: keep the card and its source history. */ }
}

/** Only the reviewed alcove and exact alcove media updates from its source session.
 * No keyword grouping: a crypte caption mentioning the alcove is not an alcove update.
 * Never mutates source records, IDs, actions, timestamps, read state or media arrays. */
export function groupAlcove(items: ForYouItem[], final?: ForYouMedia): ForYouItem[] {
  const anchor = items.find(i => i.id === ALCOVE_SOURCE)
  if (!anchor || anchor.projectId !== 'tlo' || anchor.sessionId !== SESSION) return items
  const isAlcove = (m: ForYouMedia) => m.id === ALCOVE_PORTRAIT || m.id === final?.id || /^alcove_[pl]\.(?:png|webp)$/.test(m.name)
  const related = items.filter(i => i.kind === 'media' && i.projectId === 'tlo' && i.sessionId === SESSION &&
    (i.id === anchor.id || (!!i.media?.length && i.media.every(isAlcove))))
  const groupedIds = new Set(related.map(i => i.id))
  const history = related.map(i => ({ ...i, resultGroup: undefined, media: (i.media ?? []).filter(isAlcove) }))
    .sort((a,b) => b.at - a.at)
  const result: ForYouItem = { ...anchor, resultGroup: {
    key: 'tlo-alcove', final, finalAt: ALCOVE_FINAL_AT, history,
    otherMedia: (anchor.media ?? []).filter(m => !isAlcove(m)),
    newerUpdate: related.some(i => i.id !== anchor.id && i.at > ALCOVE_FINAL_AT),
  } }
  return items.flatMap(i => i.id === anchor.id ? [result] : groupedIds.has(i.id) ? [] : [i])
}
