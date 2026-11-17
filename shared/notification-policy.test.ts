import { expect, it } from 'vitest'
import type { ForYouItem } from './foryou.ts'
import { notificationEligible, notificationText } from './notification-policy.ts'
const item = (over: Partial<ForYouItem>): ForYouItem => ({ id: 's:one', kind: 'session', tone: 'result', at: 1, who: 'session', text: 'Le bouton fonctionne.', ...over })
it.each(['Compris.', 'Corrigé.', 'Je vais vérifier le bouton.', 'Tests : 180 vérifications passées.', 'feat(feed): add output', 'Le paiement ne fonctionne pas.', 'Le projet n’est pas encore prêt.', 'La vidéo sera prête demain.', 'Si la vidéo est prête, on publiera.'])('does not interrupt for a fragment, ACK, micro-step or unsupported completion: %s', text => expect(notificationText(text)).toBe(''))
it.each(['Le bouton fonctionne.', 'Les notifications sont corrigées.', 'La page est en ligne.', 'All three buttons are in.', 'The checkout is fixed.', 'La vidéo est prête.', 'Les vidéos sont prêtes.', 'Les résultats sont prêts.', 'Les fichiers sont disponibles.', 'Les téléchargements fonctionnent.'])('keeps a concrete completed outcome: %s', text => expect(notificationText(text)).toBe(text))
it('keeps voluntary editorial content out of intrusive previews, even when it cites a completion', () => {
 for (const kind of ['boss', 'insight', 'improve', 'stat', 'proposals'] as const) expect(notificationEligible(item({kind}))).toBe(false)
 expect(notificationEligible(item({id:'r:abc'}))).toBe(false)
 expect(notificationEligible(item({}))).toBe(true)
})
it('keeps genuine questions and actionable alerts, without elevating neutral progress', () => {
 expect(notificationEligible(item({tone:'question',text:'Quelle couleur veux-tu utiliser ?'}))).toBe(true)
 expect(notificationEligible(item({tone:'question',text:'Compris. Quelle couleur veux-tu utiliser ?'}))).toBe(true)
 expect(notificationEligible(item({tone:'question',text:'Ça avance.'}))).toBe(false)
 expect(notificationEligible(item({kind:'alert',tone:'alert',text:'La connexion a expiré.',open:{page:'machine'}}))).toBe(true)
 expect(notificationEligible(item({tone:'neutral'}))).toBe(false)
})

it('keeps the useful outcome after an acknowledgement without carrying that acknowledgement into the notification', () => {
 expect(notificationText('Compris, le bouton fonctionne.')).toBe('le bouton fonctionne.')
})

it('never interrupts for explicitly published visual compositions, even with outcome-like captions',()=>{
 expect(notificationEligible(item({kind:'media',composition:{layout:'rail',panels:[{mediaId:'a',title:'Ready',text:'The scene is ready.'}]}}))).toBe(false)
})
