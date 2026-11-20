import { describe, expect, it } from 'vitest'
import { asksUser } from './asks.ts'

describe('une session qui attend l’utilisateur', () => {
  it('TLO : valider RunPod et coller une adresse → coller ; un lien à ouvrir → lien', () => {
    expect(asksUser('J’ai préparé le pod.\n\nValide la facturation sur RunPod, puis colle-moi l’adresse du pod ici.')).toMatchObject({ kind: 'paste' })
    expect(asksUser('Ouvre ce lien pour autoriser l’accès : https://www.runpod.io/console/user/settings?x=1. Je reprends ensuite.')).toMatchObject({ kind: 'link', url: 'https://www.runpod.io/console/user/settings?x=1' })
  })
  it('une question ou un choix → question', () => {
    expect(asksUser('Deux options :\n- A : rapide\n- B : propre\n\nTu préfères laquelle ?')).toMatchObject({ kind: 'question', text: 'Tu préfères laquelle ?' })
    expect(asksUser('Done. Should I push to main?')).toMatchObject({ kind: 'question' })
  })
  it('un compte rendu sans demande n’attend rien ; un « ? » dans une URL ou du code non plus', () => {
    expect(asksUser('Tout est fait : 12 tests verts, poussé sur main.')).toBeNull()
    expect(asksUser('Déployé sur https://x.example.com/?v=2 et vérifié.')).toBeNull()
    expect(asksUser('Corrigé :\n```js\nconst a = b ? c : d\n```\nC’est en ligne.')).toBeNull()
  })
})


describe('declarative reports never ask for an answer', () => {
  it.each([
    '[VPS] TLO repris par Codex à 16 h 32 : session liée et lecture des fichiers confirmées.\nClaude était bloqué derrière un panneau ; les six workflows ont fini en erreur de quota.\nPod supprimé par le watchdog à 16 h 22, dépense actuelle 0 $/h ; weevboss informé, aucune nouvelle dépense ni publication autorisée.',
    'RunPod confirme qu’il ne reste aucun pod actif et aucune dépense horaire.',
    'Je confirme la mise en ligne, aucune confirmation attendue.',
    'Les autorisations et interdictions sont documentées. La validation est terminée.',
    'The logs confirm the deployment. No approval is needed.',
    'La consigne était de coller le code, elle a été exécutée.',
    'The agent asked: Should I push?',
    '« Tu préfères laquelle ? » était la question précédente. Tout est réglé.',
  ])('%s', (text) => expect(asksUser(text)).toBeNull())
  it.each(['Confirme ce choix.', 'Please confirm the deployment.', 'Valide le plan avant de continuer.', 'J’ai besoin que tu choisisses une option.', 'Peux-tu choisir entre A et B ?', 'Can you approve this command?'])('keeps a direct request: %s', (text) => expect(asksUser(text)).not.toBeNull())
})

describe('a recap table is never a question', () => {
  it('ignores the « ? » of a Markdown table header, keeps a real question after it', () => {
    const table = 'Done.\n\n| Demande | Visible avant ? | Corrigé |\n|---|---|---|\n| Bande weevils | Non | Oui |\n- tests verts, tout est en ligne.'
    expect(asksUser(table)).toBeNull()
    expect(asksUser(`${table}\n\nTu veux que je corrige aussi le reste ?`)?.text).toBe('Tu veux que je corrige aussi le reste ?')
  })
})

it('technical or broken text is never a question (in doubt, no question mark)', () => {
  expect(asksUser('La carte « | Demande | Visible avant ?')).toBeNull()
  expect(asksUser('Faut-il garder `foo.bar()` ?')).toBeNull()
  expect(asksUser('src/ui/app.tsx ?')).toBeNull()
  expect(asksUser('OK ?')).toBeNull()
  expect(asksUser('Je peux dépenser 2 $ de GPU sur RunPod ?')).toMatchObject({ kind: 'question' })
})
