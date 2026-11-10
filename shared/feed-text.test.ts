import { describe, expect, it } from 'vitest'
import { humanFeedText, rawEngineeringNotice } from './feed-text.ts'

describe('human outcomes in the feed', () => {
  it.each([
    ['commit:repo:435cf0d', 'anything'],
    ['deploy:435cf0d', 'anything'],
    ['b:legacy', 'weevils a un nouveau commit (435cf0d) : fix(auto): propColors kept (auto-model.ts)'],
    ['d:legacy', 'weevils has a new commit (4c8a736): fix(auto): complete first runs'],
    ['b:raw', 'fix(auto): complete first runs'],
  ])('blocks retired engineering posts even under another id: %s', (id, text) => expect(rawEngineeringNotice(id, text)).toBe(true))
  it('keeps useful grouped outcomes and working links while removing implementation evidence', () => {
    const text = 'Le thème est en ligne (commit 2d5496f, poussé sur main).\nLes notifications sont corrigées. Voir https://weevils.example.com/?v=123.\nDétail : src/ui/h24-tree.ts et auto-model.ts.\n```sh\ngit log --oneline\n435cf0d fix(auto): propColors\n```'
    const clean = humanFeedText(text)
    expect(clean).toContain('Le thème est en ligne.')
    expect(clean).toContain('Les notifications sont corrigées.')
    expect(clean).toContain('https://weevils.example.com/?v=123.')
    expect(clean).not.toMatch(/2d5496f|435cf0d|h24-tree|auto-model|git log|fix\(auto\)/)
    expect(rawEngineeringNotice('d:outcomes', clean)).toBe(false)
    expect(humanFeedText('Node.js fonctionne.')).toBe('Node.js fonctionne.')
    expect(humanFeedText('Dépense actuelle : 0 $/h.')).toBe('Dépense actuelle : 0 $/h.')
  })
})
