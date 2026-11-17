// Evidence labels of « for you » results: how far a result was seen working.
//
// The label comes ONLY from evidence supplied with the publication, as structured fields (weevils show / post
// --demonstrated <where> · --verified <environment> · --limit <text>). It is never read from a caption, the item's
// words, a commit message, a PR title, a branch name or the agent's own wording (« works », « tested », « verified »):
// those are claims, not evidence. Nothing supplied: at most « implemented ».
//
// - implemented: the code exists / is merged, nothing observed running;
// - demonstrated: shown running somewhere (a clip, a screenshot, a test server), with where;
// - verified: checked in a stated environment (« real iPhone, Safari PWA »), shown next to the label.
// An explicit limitation is kept word for word and always shown beside the claim. While one is open, the result is
// never shown as verified: it stays « demonstrated » in the environment it was seen in.

export type EvidenceLevel = 'implemented' | 'demonstrated' | 'verified'

/** What a publisher supplies (stored as is, normalized): observations, never a level. */
export interface EvidenceInput {
  /** Where it was shown running: « emulated iPhone, test server ». */
  demonstrated?: string
  /** The environment it was checked in: « real iPhone, Safari PWA ». */
  verified?: string
  /** Explicit limitations, verbatim: « interruption not tested on a real iPhone ». */
  limits?: string[]
}

/** What the app shows (ForYouItem.evidence). */
export interface ForYouEvidence {
  level: EvidenceLevel
  /** demonstrated: where it ran. */
  where?: string
  /** verified: the environment it was checked in. */
  environment?: string
  /** Open limitations, verbatim, never dropped. */
  limits?: string[]
}

export const EVIDENCE_PLACE_MAX = 120
export const EVIDENCE_LIMIT_MAX = 200
export const EVIDENCE_LIMITS_MAX = 4

/** A yes/no is not a place: « --verified yes » says nothing about where. */
const NOT_A_PLACE = /^(?:y|n|yes|no|true|false|ok|okay|done|works|tested|verified|oui|non|vrai|faux|fait|testé|vérifié|1|0|-|—|\?)$/i

const clean = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max).trim() : '')
const place = (v: unknown): string => {
  const s = clean(v, EVIDENCE_PLACE_MAX)
  return s && !NOT_A_PLACE.test(s) ? s : ''
}

/** The supplied evidence, normalized; undefined when nothing usable was supplied. Any other key (a « level ») is ignored. */
export function evidenceInput(raw: unknown): EvidenceInput | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const list = Array.isArray(r.limits) ? r.limits : typeof r.limits === 'string' ? [r.limits] : []
  const limits = [...new Set(list.map((l) => clean(l, EVIDENCE_LIMIT_MAX)).filter(Boolean))].slice(0, EVIDENCE_LIMITS_MAX)
  const demonstrated = place(r.demonstrated)
  const verified = place(r.verified)
  if (!demonstrated && !verified && !limits.length) return undefined
  return { ...(demonstrated ? { demonstrated } : {}), ...(verified ? { verified } : {}), ...(limits.length ? { limits } : {}) }
}

/** A later publication on the same item: newer places win, limitations add up (one is never lost by a later file). */
export function mergeEvidence(prev: EvidenceInput | undefined, next: EvidenceInput | undefined): EvidenceInput | undefined {
  if (!prev || !next) return next ?? prev
  return evidenceInput({
    demonstrated: next.demonstrated ?? prev.demonstrated,
    verified: next.verified ?? prev.verified,
    limits: [...(prev.limits ?? []), ...(next.limits ?? [])],
  })
}

/** The label of a result from its supplied evidence alone. */
export function evidenceLabel(input: EvidenceInput | undefined): ForYouEvidence {
  const e = evidenceInput(input)
  if (!e) return { level: 'implemented' }
  const limits = e.limits?.length ? { limits: e.limits } : {}
  if (e.verified && !e.limits?.length) return { level: 'verified', environment: e.verified, ...(e.demonstrated ? { where: e.demonstrated } : {}) }
  // An open limitation: seen running where it was checked, never « verified ».
  const where = e.verified ?? e.demonstrated
  return where ? { level: 'demonstrated', where, ...limits } : { level: 'implemented', ...limits }
}

/** What the app may draw from what it received: the same rule again, so no « verified » ever stands next to an open limit. */
export function shownEvidence(e: ForYouEvidence | undefined): ForYouEvidence | undefined {
  if (!e || !['implemented', 'demonstrated', 'verified'].includes(e.level)) return undefined
  const limits = (e.limits ?? []).filter((l) => typeof l === 'string' && l.trim())
  if (e.level === 'verified' && (limits.length || !e.environment?.trim())) {
    const where = e.environment?.trim() || e.where?.trim()
    return { level: where ? 'demonstrated' : 'implemented', ...(where ? { where } : {}), ...(limits.length ? { limits } : {}) }
  }
  if (e.level === 'demonstrated' && !e.where?.trim()) return { level: 'implemented', ...(limits.length ? { limits } : {}) }
  const { limits: _given, ...rest } = e
  return { ...rest, ...(limits.length ? { limits } : {}) }
}

/** A short machine tag for the curator's model inputs, so a summary never says more than the evidence. */
export function evidenceTag(e: ForYouEvidence | undefined): string {
  const s = shownEvidence(e)
  if (!s) return ''
  const parts = [`evidence=${s.level}`]
  if (s.environment) parts.push(`environment=${s.environment}`)
  if (s.where) parts.push(`where=${s.where}`)
  for (const l of s.limits ?? []) parts.push(`limit=${l}`)
  return `[${parts.join(' · ')}]`
}
