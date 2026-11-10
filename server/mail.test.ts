import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadAuthors, parseSigned, signAs } from './authors.ts'
import { splitUnits } from './imap.ts'
import { buildMail, decodeWords, parseMail, stripQuoted } from './mime.ts'

const sent: { to: string; data: string }[] = []
vi.mock('./smtp.ts', () => ({ smtpSend: async (o: { to: string; data: string }) => void sent.push({ to: o.to, data: o.data }) }))
vi.mock('./authors.ts', async (orig) => {
  const real = await orig<typeof import('./authors.ts')>()
  const list = real.loadAuthors({
    WEEVILS_AUTHOR_GEPETTO: 'gepetto | #4fb3ff | gepetto@example.com',
    WEEVILS_AUTHOR_INSTINCT: 'instinct | #ff6f91 | instinct@agents.example.org | s3cret',
  })
  return { ...real, authors: () => list }
})
const { MailBridge, authCheck, isAutomatic, mailConfig, parseTarget, RateLimiter, screen, messageText } = await import('./mailbridge.ts')

const AR_OK = 'mx.google.com; dkim=pass header.i=@example.com header.s=s1 header.b=abc; spf=pass (google.com: domain of gepetto@example.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=gepetto@example.com; dmarc=pass (p=REJECT) header.from=example.com'
const mail = (o: { from?: string; subject?: string; body?: string; headers?: string[]; id?: string; to?: string }) =>
  parseMail(
    [
      ...(o.headers ?? [`Authentication-Results: ${AR_OK}`]),
      `From: Gepetto <${o.from ?? 'gepetto@example.com'}>`,
      `To: ${o.to ?? 'Weevils <alex+weevils@gmail.com>'}`,
      `Subject: ${o.subject ?? '[mygame] salut'}`,
      `Message-ID: ${o.id ?? '<m1@example.com>'}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      o.body ?? 'Fais le menu.',
    ].join('\r\n'),
  )
const CFG = { address: 'alex+weevils@gmail.com', login: 'alex@gmail.com', authserv: 'mx.google.com' }
const AUTHORS = loadAuthors({
  WEEVILS_AUTHOR_GEPETTO: 'gepetto | #4fb3ff | gepetto@example.com',
  WEEVILS_AUTHOR_INSTINCT: 'instinct | #ff6f91 | instinct@agents.example.org | s3cret',
})

describe('auteurs', () => {
  it('lit la config : weevboss d’abord, puis les agents externes avec nom, couleur, adresses et secret', () => {
    expect(AUTHORS.map((a) => a.id)).toEqual(['weevboss', 'gepetto', 'instinct'])
    expect(AUTHORS[1]).toMatchObject({ name: 'gepetto', color: '#4fb3ff', emails: ['gepetto@example.com'], secret: undefined })
    expect(AUTHORS[2].secret).toBe('s3cret')
  })
  it('signe en [from:<id>] et relit l’ancien [weevils] comme weevboss', () => {
    expect(signAs('gepetto', 'hello')).toBe('[from:gepetto] hello')
    expect(signAs('gepetto', '[from:instinct] déjà signé')).toBe('[from:instinct] déjà signé')
    expect(parseSigned('[from:gepetto] hello')).toEqual({ author: 'gepetto', text: 'hello' })
    expect(parseSigned('[weevils] fais ça')).toEqual({ author: 'weevboss', text: 'fais ça' })
    expect(parseSigned('un message normal')).toBeNull()
    // Le préfixe part par motif, pas par longueur : rien du message n'est mangé, quel que soit l'auteur.
    const body = 'ultracode — Job de nuit, demandé par Yann'
    for (const id of ['weevboss', 'gepetto', 'a', 'weevils-content-agent']) expect(parseSigned(`[from:${id}] ${body}`)).toEqual({ author: id, text: body })
    expect(parseSigned(`[weevils] ${body}`)).toEqual({ author: 'weevboss', text: body })
    expect(parseSigned(`[from:weevboss]${body}`)?.text).toBe(body)
    expect(parseSigned(`[from:weevboss] [from:gepetto] ${body}`)?.text).toBe(`[from:gepetto] ${body}`)
    expect(parseSigned(`[weevils]ultracode`)?.text).toBe('ultracode')
  })
})

describe('mime', () => {
  it('décode objet, multipart, quoted-printable et base64', () => {
    const raw = [
      'From: =?UTF-8?B?R8OpcGV0dG8=?= <Gepetto@Example.com>',
      'Subject: =?utf-8?Q?[mygame]_d=C3=A9j=C3=A0?=',
      'Message-ID: <a@b>',
      'In-Reply-To: <x@y>',
      'References: <w@y> <x@y>',
      'Content-Type: multipart/alternative; boundary="B"',
      '',
      '--B',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'caf=C3=A9 =',
      'ok',
      '--B',
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('<p>html</p>').toString('base64'),
      '--B--',
    ].join('\r\n')
    const m = parseMail(raw)
    expect(m.from).toBe('gepetto@example.com')
    expect(m.fromName).toBe('Gépetto')
    expect(m.subject).toBe('[mygame] déjà')
    expect(m.text).toBe('café ok')
    expect(m.inReplyTo).toBe('<x@y>')
    expect(m.references).toEqual(['<w@y>', '<x@y>'])
    expect(decodeWords('=?iso-8859-1?Q?caf=E9?=')).toBe('café')
  })
  it('retire la citation du message précédent', () => {
    expect(stripQuoted('Oui, vas-y.\n\nLe lun. 9 nov. 2026 à 10:00, weevils <x@y> a écrit :\n> avant')).toBe('Oui, vas-y.')
    expect(stripQuoted('Go.\nOn Mon, Nov 9, 2026 at 10:00 AM weevils <x@y>\nwrote:\n> before')).toBe('Go.')
  })
  it('écrit un mail relisible (UTF-8, en-têtes du fil)', () => {
    const data = buildMail({ from: 'a@b.c', to: 'd@e.f', subject: 'Re: [mygame] déjà', text: 'réponse', messageId: '<1@b.c>', inReplyTo: '<0@e.f>', references: ['<0@e.f>'], extraHeaders: { 'Auto-Submitted': 'auto-replied' } })
    const m = parseMail(data)
    expect(m.subject).toBe('Re: [mygame] déjà')
    expect(m.text).toBe('réponse')
    expect(m.inReplyTo).toBe('<0@e.f>')
    expect(m.get('auto-submitted')).toBe('auto-replied')
  })
})

describe('imap', () => {
  it('découpe les réponses, littéraux compris, et garde la fin incomplète', () => {
    const body = 'Subject: x\r\n\r\nhé'
    const len = Buffer.byteLength(body)
    const buf = Buffer.concat([Buffer.from(`* 3 FETCH (UID 9 BODY[] {${len}}\r\n`), Buffer.from(body), Buffer.from(')\r\nW4 OK done\r\nW5 OK par'), Buffer.from('tial')])
    const { units, rest } = splitUnits(buf)
    expect(units.map((u) => u.line)).toEqual([`* 3 FETCH (UID 9 BODY[] {${len}})`, 'W4 OK done'])
    expect(units[0].literals[0].toString()).toBe(body)
    expect(rest.toString()).toBe('W5 OK partial')
  })
})

describe('sécurité du pont', () => {
  it('accepte un expéditeur déclaré dont le DKIM / SPF est aligné', () => {
    expect(authCheck(mail({}), 'mx.google.com').pass).toBe(true)
    expect(screen(mail({}), CFG, AUTHORS)).toMatchObject({ ok: true, author: { id: 'gepetto' } })
  })
  it('alias Gmail : connexion au compte sans « +weevils », seul le libellé est surveillé, jamais INBOX', () => {
    const c = mailConfig({ WEEVILS_MAIL_ADDRESS: 'Alex+weevils@gmail.com', WEEVILS_MAIL_PASSWORD: 'abcd efgh ijkl mnop' })
    expect(c).toMatchObject({ address: 'alex+weevils@gmail.com', login: 'alex@gmail.com', password: 'abcdefghijklmnop', label: 'weevils', imap: { host: 'imap.gmail.com' }, smtp: { host: 'smtp.gmail.com' }, authserv: 'mx.google.com' })
    expect(mailConfig({ WEEVILS_MAIL_ADDRESS: 'y+w@gmail.com', WEEVILS_MAIL_PASSWORD: 'x', WEEVILS_MAIL_LABEL: 'INBOX' })).toBeNull()
  })
  it('ne traite que les mails adressés à l’alias du pont (To, Cc ou Delivered-To)', () => {
    expect(screen(mail({ to: 'alex@gmail.com' }), CFG, AUTHORS)).toMatchObject({ ok: false })
    expect(screen(mail({ to: 'alex+autre@gmail.com' }), CFG, AUTHORS)).toMatchObject({ ok: false })
    expect(screen(mail({ to: 'alex@gmail.com', headers: [`Authentication-Results: ${AR_OK}`, 'Delivered-To: alex+weevils@gmail.com'] }), CFG, AUTHORS).ok).toBe(true)
    expect(screen(mail({ to: 'a@b.c, "W" <alex+weevils@gmail.com>' }), CFG, AUTHORS).ok).toBe(true)
  })
  it('refuse un inconnu, l’adresse du pont, et tout mail automatique', () => {
    expect(screen(mail({ from: 'alex@gmail.com' }), CFG, AUTHORS).ok).toBe(false)
    expect(screen(mail({ from: 'x@evil.com' }), CFG, AUTHORS).ok).toBe(false)
    expect(screen(mail({ from: 'alex+weevils@gmail.com' }), CFG, AUTHORS)).toMatchObject({ ok: false })
    for (const h of ['Auto-Submitted: auto-replied', 'X-Autoreply: yes', 'Precedence: bulk', 'X-Weevils: author=gepetto']) {
      const m = mail({ headers: [`Authentication-Results: ${AR_OK}`, h] })
      expect(isAutomatic(m)).not.toBeNull()
      expect(screen(m, CFG, AUTHORS).ok).toBe(false)
    }
    expect(isAutomatic(mail({ headers: [`Authentication-Results: ${AR_OK}`, 'Auto-Submitted: no'] }))).toBeNull()
  })
  it('refuse un expéditeur usurpé : pas de pass aligné, ou un Authentication-Results ajouté plus bas par l’attaquant', () => {
    const spoof = mail({ headers: ['Authentication-Results: mx.google.com; dkim=fail header.i=@example.com; spf=softfail smtp.mailfrom=evil.com; dmarc=fail header.from=example.com', `Authentication-Results: ${AR_OK}`] })
    expect(screen(spoof, CFG, AUTHORS)).toMatchObject({ ok: false })
    const unaligned = mail({ headers: ['Authentication-Results: mx.google.com; dkim=pass header.i=@evil.com; spf=pass smtp.mailfrom=bounce@evil.com'] })
    expect(screen(unaligned, CFG, AUTHORS).ok).toBe(false)
    const foreign = mail({ headers: [`Authentication-Results: ${AR_OK.replace('mx.google.com', 'mx.evil.com')}`] })
    expect(screen(foreign, CFG, AUTHORS).ok).toBe(false)
  })
  it('le secret partagé remplace SPF / DKIM ; un secret faux est refusé', () => {
    const noAuth = ['X-Nothing: 1']
    expect(screen(mail({ from: 'instinct@agents.example.org', headers: noAuth }), CFG, AUTHORS).ok).toBe(false)
    expect(screen(mail({ from: 'instinct@agents.example.org', headers: noAuth, subject: '[mygame] [key:s3cret] go' }), CFG, AUTHORS)).toMatchObject({ ok: true, author: { id: 'instinct' }, how: 'secret' })
    const inBody = mail({ from: 'instinct@agents.example.org', headers: noAuth, body: 'key: s3cret\nFais le menu.' })
    expect(screen(inBody, CFG, AUTHORS).ok).toBe(true)
    expect(messageText(inBody)).toBe('Fais le menu.')
    expect(screen(mail({ from: 'instinct@agents.example.org', subject: '[mygame] [key:nope] go' }), CFG, AUTHORS)).toMatchObject({ ok: false })
  })
  it('limite le débit par auteur', () => {
    const r = new RateLimiter(2, 3)
    expect([r.allow('a', 0), r.allow('a', 1), r.allow('a', 2)]).toEqual([true, true, false])
    expect(r.allow('b', 2)).toBe(true)
    expect(r.allow('a', 61_000)).toBe(true)
    expect(r.allow('a', 122_000)).toBe(false)
    expect(r.allow('a', 3_700_000)).toBe(true)
  })
})

describe('cibles', () => {
  it('lit la cible dans l’objet', () => {
    expect(parseTarget('[mygame] le menu')).toEqual({ kind: 'project', id: 'mygame' })
    expect(parseTarget('Re: [session:2CBB0BBD] suite')).toEqual({ kind: 'session', id: '2cbb0bbd' })
    expect(parseTarget('[weevboss] question')).toEqual({ kind: 'boss' })
    expect(parseTarget('[new:replay] idée')).toEqual({ kind: 'new', project: 'replay', tool: 'claude' })
    expect(parseTarget('[key:abc] [new:replay:codex] idée')).toEqual({ kind: 'new', project: 'replay', tool: 'codex' })
    expect(parseTarget('sans cible')).toBeNull()
  })
})

describe('le pont, de bout en bout (SMTP simulé)', () => {
  let dir: string
  const calls: string[] = []
  const deps = {
    snapshot: () =>
      ({
        projects: [{ id: 'mygame', repos: ['mygame'] }],
        sessions: [
          { id: '2cbb0bbd-1111', projectId: 'mygame', controllable: true, status: 'working', lastActivityAt: 5 },
          { id: 'aaaa0000-2222', projectId: 'mygame', controllable: true, status: 'idle', lastActivityAt: 3 },
        ],
      }) as any,
    send: async (id: string, text: string, from?: string) => (calls.push(`send ${id} ${from} ${text}`), { id }),
    create: async (i: { projectId: string; text: string; from?: string }) => (calls.push(`new ${i.projectId} ${i.from} ${i.text}`), { id: 'new-session-id' }),
    sendMain: async (text: string) => (calls.push(`main ${text}`), { id: 'boss' }),
    waitMainReply: async () => 'réponse de weevboss',
    waitReply: async (id: string) => ({ id, text: 'C’est fait.', done: true }),
  }
  const cfg = { ...CFG, password: 'x', label: 'weevils', imap: { host: 'h', port: 993 }, smtp: { host: 'h', port: 465 }, perMinute: 5, perHour: 30, replyTimeoutMs: 1000 }
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-mail-'))
    sent.length = 0
    calls.length = 0
  })
  const settle = () => new Promise((r) => setTimeout(r, 20))

  it('projet → session disponible ; réponse à l’expéditeur seul, dans le fil, marquée anti-boucle ; la réponse suivante revient à la même session', async () => {
    const b = new MailBridge(cfg, deps, dir)
    expect(b.handle(mail({}))).toBe(true)
    await settle()
    expect(calls).toEqual(['send aaaa0000-2222 gepetto Fais le menu.'])
    expect(sent).toHaveLength(1)
    const r = parseMail(sent[0].data)
    expect(sent[0].to).toBe('gepetto@example.com')
    expect(r.get('to')).toBe('<gepetto@example.com>')
    expect(r.get('cc')).toBeUndefined()
    expect(r.inReplyTo).toBe('<m1@example.com>')
    expect(r.subject).toBe('Re: [mygame] salut')
    expect(r.get('auto-submitted')).toBe('auto-replied')
    expect(r.get('x-weevils')).toContain('author=gepetto')
    expect(r.text).toContain('C’est fait.')
    // Réponse au mail du pont, objet hérité : même session, pas de nouvelle.
    b.handle(mail({ id: '<m2@example.com>', subject: 'Re: [new:mygame] salut', headers: [`Authentication-Results: ${AR_OK}`, `In-Reply-To: ${r.messageId}`] }))
    await settle()
    expect(calls[1]).toBe('send aaaa0000-2222 gepetto Fais le menu.')
  })
  it('déduplique par Message-ID, route weevboss, new et session, et ignore sans répondre un mail refusé', async () => {
    const b = new MailBridge(cfg, deps, dir)
    b.handle(mail({ subject: '[weevboss] dis bonjour' }))
    expect(b.handle(mail({ subject: '[weevboss] dis bonjour' }))).toBe(false)
    b.handle(mail({ id: '<n@x>', subject: '[new:mygame] idée' }))
    b.handle(mail({ id: '<s@x>', subject: '[session:2cbb] suite' }))
    expect(b.handle(mail({ id: '<e@x>', from: 'intrus@evil.com' }))).toBe(false)
    await settle()
    expect(calls).toEqual(['main [from:gepetto] Fais le menu.', 'new mygame gepetto Fais le menu.', 'send 2cbb0bbd-1111 gepetto Fais le menu.'])
    expect(sent.map((s) => s.to)).toEqual(['gepetto@example.com', 'gepetto@example.com', 'gepetto@example.com'])
    // La déduplication survit au redémarrage.
    expect(new MailBridge(cfg, deps, dir).handle(mail({ id: '<n@x>', subject: '[new:mygame] idée' }))).toBe(false)
  })
})
