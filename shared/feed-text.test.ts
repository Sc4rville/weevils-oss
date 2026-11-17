import { describe, expect, it } from 'vitest'
import { acknowledgementOnly, humanFeedText, rawEngineeringNotice } from './feed-text.ts'

describe('human outcomes in the feed', () => {
  it.each([
    ['commit:repo:435cf0d', 'anything'],
    ['deploy:435cf0d', 'anything'],
    ['b:legacy', 'weevils a un nouveau commit (435cf0d) : fix(auto): propColors kept (auto-model.ts)'],
    ['d:legacy', 'weevils has a new commit (4c8a736): fix(auto): complete first runs'],
    ['b:raw', 'fix(auto): complete first runs'],
  ])('blocks retired engineering posts even under another id: %s', (id, text) => expect(rawEngineeringNotice(id, text)).toBe(true))
  it('keeps useful grouped outcomes and working links while removing implementation evidence', () => {
    const text = 'Le thème est en ligne (commit 2d5496f, poussé sur main).\nLes notifications sont corrigées. Voir https://weevils.scarville.tech/?v=123.\nDétail : src/ui/h24-tree.ts et auto-model.ts.\n```sh\ngit log --oneline\n435cf0d fix(auto): propColors\n```'
    const clean = humanFeedText(text)
    expect(clean).toContain('Le thème est en ligne.')
    expect(clean).toContain('Les notifications sont corrigées.')
    expect(clean).toContain('https://weevils.scarville.tech/?v=123.')
    expect(clean).not.toMatch(/2d5496f|435cf0d|h24-tree|auto-model|git log|fix\(auto\)/)
    expect(rawEngineeringNotice('d:outcomes', clean)).toBe(false)
    expect(humanFeedText('Node.js fonctionne.')).toBe('Node.js fonctionne.')
    expect(humanFeedText('Dépense actuelle : 0 $/h.')).toBe('Dépense actuelle : 0 $/h.')
  })
})


describe('acknowledgements versus outcomes', () => {
  it.each(['Compris.', 'Bien reçu, aucun conflit.', 'OK, je garde la clé telle quelle.', 'Coordination confirmée : aucune modification de mon côté.', 'Compris : bêtas inchangées, suivi dans la PR. Je remonterai uniquement un livrable important ou un blocage.'])('excludes coordination: %s', (text) => expect(acknowledgementOnly(text)).toBe(true))
  it.each(['Corrigé.', 'OK, le bouton est réparé.', 'Bien reçu. Les notifications sont corrigées.', '0 erreur.', 'Le serveur fonctionne.', 'Compris. Voici le résultat : https://example.com/demo'])('keeps short concrete results: %s', (text) => expect(acknowledgementOnly(text)).toBe(false))
})

it('filters administrative refusals of agent handoffs without hiding real user questions', () => {
  expect(acknowledgementOnly('Le message n’apparaît ici que dans une transmission d’agent. Je conserve les fichiers inchangés; aucune publication effectuée.')).toBe(true)
  expect(acknowledgementOnly('Autorisation relayée : je ne modifie pas la licence sans confirmation directe.')).toBe(true)
  expect(acknowledgementOnly('Quelle licence veux-tu utiliser pour le projet ?')).toBe(false)
  expect(acknowledgementOnly('La publication est bloquée : le dépôt contient encore une clé privée.')).toBe(false)
})

it('removes only leading machine tags from presentation and spoken feed text', () => {
  expect(humanFeedText('[VPS] [GPU] Le rendu est prêt.')).toBe('Le rendu est prêt.')
  expect(humanFeedText('Le GPU coûte 0,50 €/h.')).toBe('Le GPU coûte 0,50 €/h.')
  expect(humanFeedText('Exemple : [VPS] résultat')).toBe('Exemple : [VPS] résultat')
  expect(humanFeedText('[INFO] Résultat')).toBe('[INFO] Résultat')
})

it('keeps a genuine consent question even when it asks for direct confirmation', () => {
  expect(acknowledgementOnly('Je ne publie pas sans confirmation directe : veux-tu publier ce résultat ?')).toBe(false)
})

import { internalFeedUpdate, editorialFeedText } from './feed-text.ts'
describe('product outcomes instead of internal agent chatter',()=>{
 it.each(['Confirmé', 'Confirmed.', 'Bien noté pour le relais automatique : je ne touche pas à ces fichiers. Le relais Codex est en ligne. Autorisation durable enregistrée.', 'Branche confirmée. Aucun conflit.', 'Branch confirmed.', 'Préparation confirmée : PR privée brouillon, 1216 tests verts.', 'Modèle actif confirmé : GPT-6 Astra. Niveau de raisonnement actuel : Low.', 'TLO: raise the reasoning level to High.', 'The private draft PR can be prepared once the check passes.', 'Côté TLO, le raisonnement est réglé sur Low ; High est recommandé.'])('excludes %s',text=>expect(internalFeedUpdate(text)).toBe(true))
 it.each(['Le rendu est prêt.', 'Les images se rechargent après erreur : le bouton est réparé.', 'The model picker button is fixed and available in the interface.', 'La publication est bloquée : une clé privée est encore présente.', 'Veux-tu publier cette vidéo ?', 'The render stopped because the GPU budget ran out.'])('preserves useful results or real blockers: %s',text=>expect(internalFeedUpdate(text)).toBe(false))
 it('keeps the result while removing an adjacent model recommendation',()=>{
  expect(editorialFeedText('Le rendu est prêt. TLO: raise the reasoning level to High.')).toBe('Le rendu est prêt.')
 })
})

describe('humanFeedText: test runs and commands', () => {
  it('drops test output, shell commands and command spans, keeps the human sentence', () => {
    const t = humanFeedText('The menu opens again on the phone (42 tests passed).\n✓ src/ui/menu.test.tsx (3)\nnpx vitest run\nRun `npm run build` to see it.')
    expect(t).toContain('The menu opens again on the phone')
    expect(t).not.toMatch(/tests passed|vitest|npm run|✓/)
  })
})
