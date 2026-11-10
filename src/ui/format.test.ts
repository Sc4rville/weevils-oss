import { afterAll, describe, expect, it } from 'vitest'
import { setLang } from '../i18n'
import { ago, chipLabels, dur, durLong, inline, isCommand, plain, status, step, userText, userPhotos, userCaption } from './format'
import B from '../i18n/bits'
import H from '../i18n/h24'

const MIN = 60_000

describe('format', () => {
  afterAll(() => setLang(null))

  it('parle français', () => {
    setLang('fr')
    expect(dur(12 * MIN)).toBe('12m')
    expect(dur(96 * MIN)).toBe('1h36')
    expect(dur(50 * 60 * MIN)).toBe('2j')
    expect(durLong(30_000)).toBe('moins d’une minute')
    expect(durLong(65 * MIN)).toBe('1 h 05')
    expect(durLong(25 * 60 * MIN)).toBe('1 jour')
    expect(ago(10_000)).toBe('à l’instant')
    expect(ago(5 * MIN)).toBe('il y a 5 min')
    expect(status.needs_user.label).toBe('à toi')
    expect(step('Bash · Show hostname')).toBe('lance · Show hostname')
    expect(step('mcp__github__create_issue')).toBe('create issue')
    expect(step('constructor')).toBe('constructor')
  })

  it('speaks English', () => {
    setLang('en')
    expect(dur(50 * 60 * MIN)).toBe('2d')
    expect(durLong(65 * MIN)).toBe('1h 05m')
    expect(durLong(50 * 60 * MIN)).toBe('2 days')
    expect(ago(10_000)).toBe('just now')
    expect(ago(5 * MIN)).toBe('5 min ago')
    expect(status.needs_user.label).toBe('your turn')
    expect(status.working.ch).toBe('*')
    expect(step('Read · /home/me/x.ts')).toBe('reads · ~/x.ts')
  })

  it('accorde les pluriels des catalogues voisins', () => {
    expect(B.fr.older(1)).toBe('1 message plus ancien')
    expect(B.fr.older(3)).toBe('3 messages plus anciens')
    expect(B.en.older(1)).toBe('1 older message')
    expect(B.en.older(3)).toBe('3 older messages')
    expect(H.fr.finishedN(1)).toBe('1 terminée')
    expect(H.fr.finishedN(2)).toBe('2 terminées')
    expect(H.en.filesN(1)).toBe('1 file')
    expect(H.en.filesN(3)).toBe('3 files')
    expect(B.fr.rowAria('claude', 't', 'à toi', 'q', '2m')).toBe('claude, t, à toi : q, 2m')
    expect(B.en.rowAria('claude', 't', 'your turn', 'q', '2m')).toBe('claude, t, your turn: q, 2m')
  })
})

describe('inline : liens et commandes du fil', () => {
  it('rend les URL nues cliquables, sans la ponctuation de fin de phrase', () => {
    expect(inline('va sur https://weevils.example.com/a?b=1. merci')).toEqual([
      { kind: 'text', s: 'va sur ' },
      { kind: 'url', href: 'https://weevils.example.com/a?b=1', label: 'https://weevils.example.com/a?b=1' },
      { kind: 'text', s: '. merci' },
    ])
  })
  it('garde la parenthèse fermante quand elle appartient à l’URL', () => {
    expect(inline('(voir https://fr.wikipedia.org/wiki/Paris_(ville))')[1]).toEqual({ kind: 'url', href: 'https://fr.wikipedia.org/wiki/Paris_(ville)', label: 'https://fr.wikipedia.org/wiki/Paris_(ville)' })
  })
  it('domaine nu courant : lien en https ; pas les fichiers ni les e-mails', () => {
    expect(inline('tape myaccount.google.com/apppasswords dans Safari')[1]).toEqual({ kind: 'url', href: 'https://myaccount.google.com/apppasswords', label: 'myaccount.google.com/apppasswords' })
    expect(inline('voir weevils.example.com.')[1]).toEqual({ kind: 'url', href: 'https://weevils.example.com', label: 'weevils.example.com' })
    for (const t of ['dans server/core.ts et index.html', 'écris à y.nom@gmail.com', 'le fichier README.md', 'v1.2.3', '~/projects/site.com/x', 'lance install.sh']) expect(inline(t).every((p) => p.kind === 'text')).toBe(true)
  })
  it('lien markdown : le libellé, vers l’URL', () => {
    expect(inline('[la PR](https://github.com/o/r/pull/3)')).toEqual([{ kind: 'url', href: 'https://github.com/o/r/pull/3', label: 'la PR' }])
  })
  it('commandes entre accents graves, sauf dans le texte brut', () => {
    expect(inline('lance `npm run build` puis')).toEqual([
      { kind: 'text', s: 'lance ' },
      { kind: 'cmd', s: 'npm run build' },
      { kind: 'text', s: ' puis' },
    ])
    expect(inline('lance `npm run build`', false)).toEqual([{ kind: 'text', s: 'lance `npm run build`' }])
    expect(isCommand('npm run build')).toBe(true)
    expect(isCommand('core.ts')).toBe(false)
  })
  it('plain(keep) garde liens et accents graves ; plain seul les retire', () => {
    expect(plain('**voir** `ls -la` et [doc](https://x.io)', true)).toBe('voir `ls -la` et [doc](https://x.io)')
    expect(plain('**voir** `ls -la` et [doc](https://x.io)')).toBe('voir ls -la et doc')
  })

  it('reads a setup chip in the middle of a sentence as a button at its place, its label in plain text', () => {
    setLang('fr')
    const t = 'le mot de passe Gmail de 16 lettres via [[setup:mail]]. Le pont démarrera alors tout seul.'
    expect(inline(t)).toEqual([
      { kind: 'text', s: 'le mot de passe Gmail de 16 lettres via ' },
      { kind: 'chip', brick: 'mail' },
      { kind: 'text', s: '. Le pont démarrera alors tout seul.' },
    ])
    expect(plain(t)).toBe('le mot de passe Gmail de 16 lettres via brancher le pont e-mail. Le pont démarrera alors tout seul.')
    expect(chipLabels('[[setup:nope]] [[setup:github]]')).toBe('[[setup:nope]] brancher github')
    expect(plain(t)).not.toMatch(/via \./)
  })
})

describe('modèle dans l’en-tête de session', async () => {
  const { modelLabel } = await import('./settings')
  it('montre le modèle avec sa version exacte', () => {
    expect(modelLabel('claude-fable-5-1')).toBe('fable 5.1')
    expect(modelLabel('claude-opus-5-5')).toBe('opus 5.5')
    expect(modelLabel('claude-opus-5-5[1m]')).toBe('opus 5.5')
    expect(modelLabel('claude-haiku-4-5-20251001')).toBe('haiku 4.5')
    expect(modelLabel('claude-sonnet-5')).toBe('sonnet 5')
    expect(modelLabel('claude-3-5-sonnet-20241022')).toBe('sonnet 3.5')
    expect(modelLabel('gpt-5.1-codex')).toBe('gpt-5.1-codex')
    expect(modelLabel(undefined)).toBeUndefined()
  })
})

describe('puce de secret', () => {
  it('[[setup:key:NOM]] devient un bouton à sa place ; un nom hors liste reste du texte', () => {
    setLang('fr')
    expect(inline('Colle-la ici : [[setup:key:RUNPOD_API_KEY]]. Merci.')).toEqual([
      { kind: 'text', s: 'Colle-la ici : ' },
      { kind: 'chip', brick: 'key:RUNPOD_API_KEY' },
      { kind: 'text', s: '. Merci.' },
    ])
    expect(plain('via [[setup:key:HF_TOKEN]].')).toBe('via coller HF_TOKEN.')
    expect(inline('[[setup:key:WEEVILS_X_TOKEN]]')).toEqual([{ kind: 'text', s: '[[setup:key:WEEVILS_X_TOKEN]]' }])
  })
})


 it('hides injected context in complete and terminal-truncated user messages without changing photo markers', () => {
   const typed = 'regarde (photo : /home/user/inbox/photo.jpg)'
   expect(userText(`${typed} ⟦weevils — what weevils remembers: private⟧`)).toBe(typed)
   expect(userText(`${typed} ⟦weevils — what weevils remembers: pri…`)).toBe(typed)
   expect(userText('oui ⟦weevils — one⟧ ⟦weevils — two⟧')).toBe('oui')
   expect(userText('⟦une citation⟧')).toBe('⟦une citation⟧')
 })

it('separates photo previews from the caption without reading paths from injected context', () => {
  const raw = 'Regarde (photo : /home/user/inbox/a.jpg) (photo : /home/user/inbox/b.png) ⟦weevils — private (photo : /secret.jpg)⟧'
  expect(userPhotos(raw)).toEqual(['/home/user/inbox/a.jpg', '/home/user/inbox/b.png'])
  expect(userCaption(raw)).toBe('Regarde')
  expect(raw).toContain('⟦weevils') // parsing is display-only
})
