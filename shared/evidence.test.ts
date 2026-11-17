// Evidence labels: the level comes from supplied, structured evidence only; an open limitation is never « verified ».
import { describe, expect, it } from 'vitest'
import { evidenceInput, evidenceLabel, evidenceTag, mergeEvidence, shownEvidence } from './evidence.ts'

describe('evidence labels', () => {
  it('nothing supplied: implemented at most', () => {
    expect(evidenceLabel(undefined)).toEqual({ level: 'implemented' })
    expect(evidenceLabel({})).toEqual({ level: 'implemented' })
    expect(evidenceInput(null)).toBeUndefined()
    expect(evidenceInput('verified on a real iPhone')).toBeUndefined()
  })

  it('demonstrated needs a where, verified an environment; a yes is neither', () => {
    expect(evidenceLabel({ demonstrated: 'test server, emulated iPhone' })).toEqual({ level: 'demonstrated', where: 'test server, emulated iPhone' })
    expect(evidenceLabel({ verified: 'real iPhone, Safari PWA' })).toEqual({ level: 'verified', environment: 'real iPhone, Safari PWA' })
    for (const v of ['yes', 'true', 'ok', 'Verified', 'works', '  ', 'oui']) expect(evidenceLabel({ verified: v, demonstrated: v }).level).toBe('implemented')
  })

  it('a « level » sent by the publisher is ignored: only observations count', () => {
    expect(evidenceInput({ level: 'verified' })).toBeUndefined()
    expect(evidenceLabel({ level: 'verified' } as never)).toEqual({ level: 'implemented' })
  })

  it('an open limitation caps the label below verified and stays word for word', () => {
    const limit = 'Interruption not tested on a real iPhone'
    expect(evidenceLabel({ verified: 'real iPhone, Safari PWA', limits: [limit] })).toEqual({ level: 'demonstrated', where: 'real iPhone, Safari PWA', limits: [limit] })
    expect(evidenceLabel({ limits: [limit] })).toEqual({ level: 'implemented', limits: [limit] })
  })

  it('a later publication never loses a limitation', () => {
    const first = evidenceInput({ demonstrated: 'emulated iPhone', limits: ['No sound in the clip'] })
    const later = evidenceInput({ verified: 'real iPhone, Safari PWA' })
    expect(evidenceLabel(mergeEvidence(first, later))).toEqual({ level: 'demonstrated', where: 'real iPhone, Safari PWA', limits: ['No sound in the clip'] })
  })

  it('the app re-applies the rule to whatever it receives', () => {
    expect(shownEvidence({ level: 'verified', environment: 'real iPhone', limits: ['not tested offline'] })).toEqual({ level: 'demonstrated', where: 'real iPhone', limits: ['not tested offline'] })
    expect(shownEvidence({ level: 'verified' })).toEqual({ level: 'implemented' })
    expect(shownEvidence({ level: 'demonstrated' })).toEqual({ level: 'implemented' })
    expect(shownEvidence({ level: 'proven' } as never)).toBeUndefined()
  })

  it('the curator tag carries the level and every limit', () => {
    expect(evidenceTag({ level: 'demonstrated', where: 'emulated iPhone', limits: ['a', 'b'] })).toBe('[evidence=demonstrated · where=emulated iPhone · limit=a · limit=b]')
    expect(evidenceTag(undefined)).toBe('')
  })
})
