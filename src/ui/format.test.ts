import { afterAll, describe, expect, it } from 'vitest'
import { setLang } from '../i18n'
import { ago, dur, durLong, inline, isCommand, plain, status, step } from './format'
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
    expect(H.fr.summary(1, 1)).toBe('1 en cours · 1 récent')
    expect(H.fr.summary(2, 2)).toBe('2 en cours · 2 récents')
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
})
