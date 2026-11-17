// Le pont e-mail : des agents externes (un bot de CI, un autre agent IA…) écrivent dans les sessions weevils par e-mail.
//
//   Adresse         un alias de la boîte perso (moi+weevils@gmail.com), sans filtre à créer. Le pont surveille INBOX, mais
//                   le serveur IMAP cherche lui-même les mails adressés à l'alias (To, Cc ou Delivered-To) : seuls ceux-là
//                   sont récupérés (BODY.PEEK), et aucun autre mail n'est lu, marqué, déplacé ni supprimé. Le libellé
//                   « weevils » (ancien filtre Gmail), s'il existe et contient des mails, est lu aussi, avec la même recherche.
//   Objet           « [shop] … » session disponible du projet (sinon une nouvelle) · « [session:2cbb0bbd] » cette session
//                   « [weevboss] » l'orchestrateur · « [new:projet] » (ou « [new:projet:codex] ») une nouvelle session
//                   · sans cible : weevboss, qui répond ou transmet
//   Corps           le message (citation du mail précédent et signature retirées)
//   Réponse         renvoyée à l'expéditeur dans le même fil (In-Reply-To / References) ; répondre à ce mail continue la même session.
//
// Réception : IMAP IDLE sur INBOX (push, quasi instantané), relancé toutes les 30 s, ce qui sert aussi de sondage de secours ;
// reprise au dernier UID traité (persisté) ; un dossier jamais vu reprend les mails à l'alias des dernières 24 h ;
// reconnexion automatique avec attente croissante ; déduplication par Message-ID ; tout est journalisé « [mail] ».
// Sécurité : seuls les expéditeurs déclarés (WEEVILS_AUTHOR_*) passent, et seulement si le serveur de réception atteste
// SPF ou DKIM aligné sur le domaine de l'expéditeur (Authentication-Results), ou si le secret partagé est présent.
// Adresse partagée : plusieurs auteurs peuvent écrire depuis la même adresse (typiquement celle du compte du pont :
// ChatGPT avec son connecteur Gmail, un agent…). L'auteur se reconnaît alors à une étiquette : « [gepetto] » dans l'objet,
// « [from:gepetto] » ou « from: gepetto » en début de corps, « — gepetto » en signature (casse indifférente). Sans
// étiquette, un mail du compte du pont vient de l'utilisateur lui-même, pour weevboss par défaut.
// Un mail du compte du pont est authentifié par SPF/DKIM, ou par le libellé Gmail \Sent (seul le compte peut l'avoir envoyé).
// Anti-boucle : nos propres envois sont reconnus à leurs en-têtes (X-Weevils, Auto-Submitted, Message-ID <weevils-…>),
// pas à l'adresse ; rien d'automatique (Auto-Submitted, X-Autoreply, Precedence: bulk…) ;
// chaque envoi porte Auto-Submitted: auto-replied et X-Weevils, à l'expéditeur seul, jamais à l'alias du pont.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Snapshot, Tool } from '../shared/api.ts'
import { type AuthorConfig, BOSS, authors, signAs } from './authors.ts'
import { Imap } from './imap.ts'
import { type Mail, buildMail, parseMail, stripQuoted } from './mime.ts'
import { smtpSend } from './smtp.ts'
import { tr } from './i18n.ts'
import M from './i18n/mail.ts'

export interface MailConfig {
  /** Adresse du pont : reçoit et répond (From). Typiquement un alias « +weevils » de la boîte perso. */
  address: string
  /** Compte qui se connecte (IMAP / SMTP) : l'adresse sans « +alias », sauf WEEVILS_MAIL_LOGIN. */
  login: string
  password: string
  /** Un dossier lu en plus d'INBOX s'il existe et contient des mails (le libellé d'un ancien filtre Gmail) ; null : aucun. */
  label: string | null
  imap: { host: string; port: number }
  smtp: { host: string; port: number }
  /** Serveur dont on croit l'en-tête Authentication-Results (le premier du message). */
  authserv: string
  perMinute: number
  perHour: number
  /** Délai max d'attente de la réponse d'une session avant de répondre « toujours en cours ». */
  replyTimeoutMs: number
}

const hostPort = (v: string | undefined, def: string, port: number) => {
  const [h, p] = (v?.trim() || def).split(':')
  return { host: h, port: Number(p) || port }
}

/** La config du pont (fichier ~/.config/weevils/env) ; null tant que l'adresse et le mot de passe ne sont pas remplis. */
export function mailConfig(env: Record<string, string | undefined> = process.env): MailConfig | null {
  const address = env.WEEVILS_MAIL_ADDRESS?.trim().toLowerCase()
  const password = env.WEEVILS_MAIL_PASSWORD?.replace(/\s+/g, '')
  if (!address || !password) return null
  const gmail = /@(gmail|googlemail)\.com$/.test(address)
  const label = env.WEEVILS_MAIL_LABEL?.trim() || 'weevils'
  return {
    address,
    login: env.WEEVILS_MAIL_LOGIN?.trim().toLowerCase() || address.replace(/\+[^@]*@/, '@'),
    password,
    // INBOX est toujours surveillée ; « none » : pas de libellé en plus.
    label: /^(inbox|none|-)$/i.test(label) ? null : label,
    imap: hostPort(env.WEEVILS_MAIL_IMAP, gmail ? 'imap.gmail.com' : `imap.${address.split('@')[1]}`, 993),
    smtp: hostPort(env.WEEVILS_MAIL_SMTP, gmail ? 'smtp.gmail.com' : `smtp.${address.split('@')[1]}`, 465),
    authserv: (env.WEEVILS_MAIL_AUTHSERV?.trim() || (gmail ? 'mx.google.com' : '')).toLowerCase(),
    perMinute: Number(env.WEEVILS_MAIL_PER_MINUTE) || 5,
    perHour: Number(env.WEEVILS_MAIL_PER_HOUR) || 30,
    replyTimeoutMs: (Number(env.WEEVILS_MAIL_REPLY_MIN) || 45) * 60_000,
  }
}

// ---------------------------------------------------------------- vérifications (pures, testées)

const domainOf = (s: string) => s.replace(/^.*@/, '').replace(/[>\s;].*$/, '').toLowerCase()
/** Alignement « relâché » à la DMARC : même domaine, ou l'un sous-domaine de l'autre. */
const aligned = (d: string, from: string) => !!d && (d === from || d.endsWith(`.${from}`) || from.endsWith(`.${d}`))

/** SPF / DKIM / DMARC selon le premier Authentication-Results (celui du serveur de réception, ajouté en haut). */
export function authCheck(mail: Mail, authserv: string): { pass: boolean; detail: string } {
  const from = mail.from ? domainOf(mail.from) : ''
  const header = mail.all('authentication-results')[0]
  if (!header || !authserv) return { pass: false, detail: tr(M).noAuthResults }
  const [serv, ...clauses] = header.split(';')
  if (serv.trim().split(/\s+/)[0].toLowerCase() !== authserv) return { pass: false, detail: tr(M).foreignAuthResults(serv.trim().slice(0, 40)) }
  const seen: string[] = []
  for (const c of clauses) {
    const m = /^\s*(dkim|spf|dmarc)\s*=\s*(\w+)/i.exec(c)
    if (!m) continue
    const method = m[1].toLowerCase()
    const result = m[2].toLowerCase()
    seen.push(`${method}=${result}`)
    if (result !== 'pass') continue
    const prop = (name: string) => new RegExp(`${name.replace('.', '\\.')}=([^\\s;]+)`, 'i').exec(c)?.[1]
    if (method === 'dmarc' && aligned(domainOf(prop('header.from') ?? ''), from)) return { pass: true, detail: 'dmarc=pass' }
    if (method === 'dkim' && aligned(domainOf(prop('header.i') ?? prop('header.d') ?? ''), from)) return { pass: true, detail: 'dkim=pass' }
    if (method === 'spf' && aligned(domainOf(prop('smtp.mailfrom') ?? ''), from)) return { pass: true, detail: 'spf=pass' }
  }
  return { pass: false, detail: seen.join(' ') || tr(M).noResult }
}

/** Un message automatique (réponse d'absence, liste, bounce) : jamais traité, pour ne pas boucler. */
export function isAutomatic(mail: Mail): string | null {
  const auto = mail.get('auto-submitted')
  if (auto && auto.trim().toLowerCase() !== 'no') return `Auto-Submitted: ${auto}`
  if (mail.get('x-autoreply') !== undefined || mail.get('x-autorespond') !== undefined) return 'X-Autoreply'
  const prec = mail.get('precedence')?.trim().toLowerCase()
  if (prec && /^(bulk|junk|list|auto_reply)$/.test(prec)) return `Precedence: ${prec}`
  if (mail.get('x-weevils') !== undefined) return 'X-Weevils'
  if (mail.from && /^(mailer-daemon|postmaster)@/.test(mail.from)) return 'bounce'
  return null
}

/** Adressé à l'alias du pont (To, Cc, Delivered-To, X-Original-To) : le reste de la boîte ne le concerne pas. */
export function addressedTo(mail: Mail, address: string): boolean {
  const all = ['to', 'cc', 'delivered-to', 'x-original-to'].flatMap((h) => mail.all(h)).join(',').toLowerCase()
  return [...all.matchAll(/[^\s<>"',;:]+@[^\s<>"',;]+/g)].some((m) => m[0] === address)
}

const KEY_SUBJECT = /\[key:([^\]\s]+)\]/i
const KEY_BODY = /^[ \t]*(?:key|clé|cle|secret)[ \t]*:[ \t]*(\S+)[ \t]*$/im

const sameSecret = (a: string, b: string) => {
  const x = crypto.createHash('sha256').update(a).digest()
  const y = crypto.createHash('sha256').update(b).digest()
  return crypto.timingSafeEqual(x, y)
}

/** L'utilisateur lui-même (un mail de son propre compte, sans étiquette d'auteur) : ses messages ne sont pas signés. */
export const OWNER: AuthorConfig = { id: '', name: '', color: '', emails: [] }

export type Screen = { ok: true; author: AuthorConfig; how: string } | { ok: false; reason: string }

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Les façons de signer un mail au nom d'un auteur (objet ou corps), pour son id et son nom affiché. */
function markers(a: AuthorConfig): { subject: RegExp; body: RegExp } {
  const n = [...new Set([a.id, a.name.toLowerCase()].filter(Boolean))].map(esc).join('|')
  return {
    subject: new RegExp(`\\[\\s*(?:from\\s*:\\s*)?(?:${n})\\s*\\]`, 'i'),
    // i18n-ignore : motif de reconnaissance (« de : », « par : »), jamais affiché
    body: new RegExp(`^[ \\t>]*(?:\\[\\s*(?:from\\s*:\\s*)?(?:${n})\\s*\\]|(?:from|de|par)\\s*:\\s*(?:${n})\\b|(?:—|–|--?)\\s*(?:${n})[ \\t]*[.!]?[ \\t]*$)`, 'im'),
  }
}

/** L'auteur qui signe le mail parmi ceux qui partagent l'adresse : la première étiquette trouvée (objet, puis corps). */
export function signedBy(mail: Mail, candidates: AuthorConfig[]): AuthorConfig | undefined {
  let best: { a: AuthorConfig; at: number } | undefined
  for (const a of candidates) {
    const m = markers(a)
    const s = m.subject.exec(mail.subject)
    const b = s ? null : m.body.exec(mail.text)
    const at = s ? s.index : b ? 10_000 + b.index : -1
    if (at >= 0 && (!best || at < best.at)) best = { a, at }
  }
  return best?.a
}

/** Retire l'étiquette d'auteur de l'objet (pour lire la cible) ou du corps (pour le message transmis). */
export function dropMarker(text: string, a: AuthorConfig, where: 'subject' | 'body'): string {
  if (!a.id) return text
  const m = markers(a)
  return where === 'subject' ? text.replace(m.subject, ' ').replace(/\s{2,}/g, ' ').trim() : text.replace(new RegExp(m.body.source, 'gim'), '').replace(/\n{3,}/g, '\n\n').trim()
}

/** Un de nos propres envois (réponse du pont) : jamais retraité, quelle que soit l'adresse. */
export const fromBridge = (mail: Mail, cfg: Pick<MailConfig, 'address'>) =>
  mail.get('x-weevils') !== undefined || (!!mail.messageId && mail.messageId.startsWith('<weevils-') && mail.messageId.endsWith(`@${cfg.address.split('@')[1]}>`))

/**
 * Qui écrit, et a-t-il le droit : expéditeur déclaré + (SPF/DKIM alignés ou secret partagé). Le compte du pont
 * (login ou alias) vaut l'utilisateur ; il est aussi authentifié par `sent` (le libellé Gmail \Sent du message).
 */
export function screen(mail: Mail, cfg: Pick<MailConfig, 'address' | 'login' | 'authserv'>, list: AuthorConfig[], sent = false): Screen {
  if (!mail.from) return { ok: false, reason: tr(M).noSender }
  if (fromBridge(mail, cfg)) return { ok: false, reason: tr(M).fromBridge }
  if (!addressedTo(mail, cfg.address)) return { ok: false, reason: tr(M).notToBridge }
  const auto = isAutomatic(mail)
  if (auto) return { ok: false, reason: tr(M).automatic(auto) }
  const own = mail.from === cfg.login || mail.from === cfg.address
  const candidates = list.filter((a) => a.id !== BOSS && a.emails.includes(mail.from!))
  if (!candidates.length && !own) return { ok: false, reason: tr(M).unknownSender }
  const given = KEY_SUBJECT.exec(mail.subject)?.[1] ?? KEY_BODY.exec(mail.text)?.[1]
  if (given) {
    const byKey = candidates.find((a) => a.secret && sameSecret(a.secret, given))
    if (byKey) return { ok: true, author: byKey, how: 'secret' }
    return { ok: false, reason: tr(M).wrongSecret }
  }
  // Plusieurs auteurs sur cette adresse, ou celle du compte du pont : l'étiquette dit qui signe.
  const author = candidates.length > 1 || own ? (signedBy(mail, candidates) ?? (own ? OWNER : undefined)) : candidates[0]
  if (!author) return { ok: false, reason: tr(M).sharedAddress(candidates.map((a) => a.id).join(', ')) }
  if (own && sent) return { ok: true, author, how: 'gmail \\Sent' }
  const auth = authCheck(mail, cfg.authserv)
  return auth.pass ? { ok: true, author, how: auth.detail } : { ok: false, reason: tr(M).authFailed(auth.detail) }
}

export type Target = { kind: 'boss' } | { kind: 'session'; id: string } | { kind: 'project'; id: string } | { kind: 'new'; project: string; tool: Tool }

/** La cible, d'après la première étiquette entre crochets de l'objet. */
export function parseTarget(subject: string): Target | null {
  for (const m of subject.matchAll(/\[([^\]]+)\]/g)) {
    const tag = m[1].trim()
    if (/^key:/i.test(tag)) continue
    if (/^(weevboss|boss|weevils)$/i.test(tag)) return { kind: 'boss' }
    const s = /^session:\s*([\w-]{4,})$/i.exec(tag)
    if (s) return { kind: 'session', id: s[1].toLowerCase() }
    const n = /^new:\s*([\w.@+-]+)(?::(claude|codex))?$/i.exec(tag)
    if (n) return { kind: 'new', project: n[1], tool: (n[2]?.toLowerCase() as Tool) ?? 'claude' }
    if (/^[\w.@+-]+$/.test(tag)) return { kind: 'project', id: tag }
  }
  return null
}

/** Le message à transmettre : sans citation, sans signature, sans le secret. */
export function messageText(mail: Mail): string {
  return stripQuoted(mail.text).replace(KEY_BODY, '').replace(/\n{3,}/g, '\n\n').trim()
}

/** Limite de débit par auteur : N par minute et M par heure, fenêtres glissantes. */
export class RateLimiter {
  private hits = new Map<string, number[]>()
  private perMinute: number
  private perHour: number
  constructor(perMinute: number, perHour: number) {
    this.perMinute = perMinute
    this.perHour = perHour
  }
  allow(key: string, now = Date.now()): boolean {
    const h = (this.hits.get(key) ?? []).filter((t) => now - t < 3600_000)
    const lastMin = h.filter((t) => now - t < 60_000).length
    if (lastMin >= this.perMinute || h.length >= this.perHour) {
      this.hits.set(key, h)
      return false
    }
    h.push(now)
    this.hits.set(key, h)
    return true
  }
}

// ---------------------------------------------------------------- le pont

/** Ce dont le pont a besoin du cœur de weevils. */
export interface BridgeDeps {
  snapshot(): Snapshot
  send(id: string, text: string, from?: string): Promise<{ id: string }>
  create(input: { projectId: string; tool: Tool; text: string; from?: string }): Promise<{ id: string }>
  sendMain(text: string): Promise<{ id: string }>
  waitMainReply(since: number, timeoutMs: number): Promise<string | null>
  waitReply(id: string, since: number, timeoutMs: number): Promise<{ id: string; text: string; done: boolean; attention?: string }>
  /** Un mail accepté vient d'être routé (flux « pour toi », server/foryou.ts). target : « weevboss » ou l'id de la session.
   *  address reste côté serveur : elle sert à répondre par mail, jamais à l'app. */
  mailed?(m: { author: string; subject: string; text: string; target: string; mid: string; address: string }): void
}

interface Box {
  uidValidity: number
  lastUid: number
}

interface State {
  /** Par dossier (INBOX, le libellé) : où on en est. */
  boxes: Record<string, Box>
  /** Message-ID déjà traités (les plus récents). */
  seen: string[]
  /** Message-ID d'un fil (reçus et envoyés) → cible : « weevboss » ou l'id de session. */
  threads: Record<string, string>
}

/** Rattrapage d'un dossier jamais vu : les mails à l'alias de cette période. */
const CATCH_UP_MS = 24 * 3600_000
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const oneLine = (s: string, n = 80) => s.replace(/\s+/g, ' ').trim().slice(0, n)

export class MailBridge {
  private cfg: MailConfig
  private deps: BridgeDeps
  private file: string
  private state: State
  private limiter: RateLimiter
  private imap?: Imap
  private stopped = false

  constructor(cfg: MailConfig, deps: BridgeDeps, dataDir: string) {
    this.cfg = cfg
    this.deps = deps
    this.file = path.join(dataDir, 'mail.json')
    this.limiter = new RateLimiter(cfg.perMinute, cfg.perHour)
    let s: Partial<State> = {}
    try {
      s = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      /* premier lancement */
    }
    // Avant 2026-11-10, un seul dossier : le libellé.
    const old = s as Partial<State> & Partial<Box>
    const boxes = s.boxes ?? (old.uidValidity ? { [cfg.label ?? 'weevils']: { uidValidity: old.uidValidity, lastUid: old.lastUid ?? 0 } } : {})
    this.state = { boxes, seen: s.seen ?? [], threads: s.threads ?? {} }
  }

  private persist() {
    this.state.seen = this.state.seen.slice(-2000)
    const t = Object.entries(this.state.threads)
    if (t.length > 1000) this.state.threads = Object.fromEntries(t.slice(-1000))
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify(this.state))
    } catch (e) {
      console.log('[mail]', 'état non enregistré :', (e as Error).message)
    }
  }

  start() {
    const ext = authors().filter((a) => a.id !== BOSS)
    console.log('[mail]', `pont actif · ${this.cfg.address} · IMAP ${this.cfg.imap.host} INBOX${this.cfg.label ? ` + « ${this.cfg.label} »` : ''} (seulement les mails à l'alias) · auteurs : ${ext.map((a) => `${a.id} (${a.emails.length ? a.emails.join(', ') : 'aucune adresse'}${a.secret ? ', secret' : ''})`).join(' · ') || 'aucun'}`)
    void this.run()
  }

  stop() {
    this.stopped = true
    this.imap?.close()
  }

  private async run() {
    let backoff = 2000
    while (!this.stopped) {
      const c = new Imap({ ...this.cfg.imap, user: this.cfg.login, pass: this.cfg.password })
      this.imap = c
      try {
        await c.connect()
        await c.login()
        console.log('[mail]', `connecté · IDLE sur INBOX`)
        backoff = 2000
        let dirty = true
        let labelAt = 0
        c.on('exists', () => (dirty = true))
        while (!this.stopped && !c.closed) {
          if (dirty) {
            dirty = false
            // Le libellé (s'il existe), de temps en temps ; INBOX en dernier, c'est elle qu'on écoute en IDLE.
            if (this.cfg.label && Date.now() - labelAt > 5 * 60_000) {
              labelAt = Date.now()
              await this.scan(c, this.cfg.label, true)
            }
            await this.scan(c, 'INBOX')
            continue
          }
          // Push : l'IDLE rend la main dès qu'un message arrive ; sinon au bout de 30 s, et on revérifie (sondage de secours).
          await c.idle(30_000)
          dirty = true
        }
      } catch (e) {
        const msg = (e as Error).message
        console.log('[mail]', `erreur : ${msg}`)
        // Mauvais identifiants : on n'insiste pas toutes les deux secondes (Google bloquerait la boîte).
        if (/AUTHENTICATIONFAILED|Invalid credentials|LOGIN/i.test(msg)) backoff = Math.max(backoff, 15 * 60_000)
      } finally {
        c.close()
      }
      if (this.stopped) break
      console.log('[mail]', `reconnexion dans ${Math.round(backoff / 1000)} s`)
      await sleep(backoff)
      backoff = Math.min(backoff * 2, 15 * 60_000)
    }
  }

  /** Un dossier : ses nouveaux mails adressés à l'alias, cherchés par le serveur ; rien d'autre n'est récupéré ni touché.
   * optional : un dossier absent ou vide est passé sans erreur (le libellé d'un ancien filtre). */
  async scan(c: Pick<Imap, 'select' | 'uidsTo' | 'fetch' | 'gmLabels' | 'markSeen'>, name: string, optional = false) {
    let box: { uidValidity: number; uidNext: number; exists: number }
    try {
      box = await c.select(name)
    } catch (e) {
      if (optional) return
      throw e
    }
    let known = this.state.boxes[name]
    // Jamais « à partir de maintenant » : on reprend au dernier UID traité. Un dossier jamais vu (premier lancement,
    // dossier ajouté) ou recréé (UIDVALIDITY changé) : les mails à l'alias des dernières 24 h, dédoublonnés par
    // Message-ID — un mail arrivé pendant un redémarrage n'est jamais sauté.
    let since: Date | undefined
    if (!known || box.uidValidity !== known.uidValidity) {
      console.log('[mail]', `${name} ${known ? 'recréé' : 'découvert'} : reprise des mails à l'alias des dernières 24 h`)
      known = this.state.boxes[name] = { uidValidity: box.uidValidity, lastUid: 0 }
      since = new Date(Date.now() - CATCH_UP_MS)
      this.persist()
    }
    if (optional && !box.exists) return
    for (const uid of await c.uidsTo(this.cfg.address, known.lastUid, since)) {
      const raw = await c.fetch(uid)
      known.lastUid = Math.max(known.lastUid, uid)
      this.persist()
      if (!raw) continue
      let accepted = false
      try {
        const mail = parseMail(raw)
        // Rattrapage : SINCE est à la journée près ; au-delà de 24 h, laissé tel quel.
        const at = Date.parse(mail.get('date') ?? '')
        if (since && at && at < since.getTime()) continue
        // Du compte du pont : le libellé \Sent prouve qu'il a été envoyé depuis ce compte (Gmail seulement).
        const sent = mail.from === this.cfg.login || mail.from === this.cfg.address ? (await c.gmLabels(uid).catch(() => [] as string[])).some((l) => /^\\?\\Sent$/i.test(l)) : false
        accepted = this.handle(mail, uid, sent, `${box.uidValidity}-${name}`)
      } catch (e) {
        console.log('[mail]', `message ${uid} illisible : ${(e as Error).message}`)
      }
      // Lu seulement s'il a été pris en compte : les mails ignorés restent visibles, non lus, dans la boîte.
      if (accepted) await c.markSeen(uid).catch(() => undefined)
    }
  }

  /** Un message reçu : vérifié, dédupliqué, limité, routé. true s'il est pris en compte. */
  handle(mail: Mail, uid = 0, sent = false, box = '0'): boolean {
    const mid = mail.messageId ?? `<uid-${box}-${uid}@weevils>`
    const what = `${mail.from ?? '?'} · « ${oneLine(mail.subject.replace(KEY_SUBJECT, '[key:…]'), 60)} » · ${mid}`
    if (this.state.seen.includes(mid)) {
      console.log('[mail]', `doublon ignoré · ${what}`)
      return false
    }
    this.state.seen.push(mid)
    this.persist()
    const v = screen(mail, this.cfg, authors(), sent)
    if (!v.ok) {
      console.log('[mail]', `ignoré · ${v.reason} · ${what}`)
      return false
    }
    const who = v.author.id || 'owner'
    if (!this.limiter.allow(who)) {
      console.log('[mail]', `ignoré · limite de débit de ${who} (${this.cfg.perMinute}/min, ${this.cfg.perHour}/h) · ${what}`)
      return false
    }
    console.log('[mail]', `reçu de ${who} (${v.how}) · ${what}`)
    void this.dispatch(mail, mid, v.author).catch((e) => console.log('[mail]', `échec · ${(e as Error).message} · ${what}`))
    return true
  }

  private threadTarget(mail: Mail): Target | null {
    for (const id of [mail.inReplyTo, ...[...mail.references].reverse()]) {
      const t = id && this.state.threads[id]
      if (t) return t === BOSS ? { kind: 'boss' } : { kind: 'session', id: t }
    }
    return null
  }

  private async dispatch(mail: Mail, mid: string, author: AuthorConfig) {
    // Réponse dans un fil connu : même cible (une étiquette héritée « [new:x] » ne rouvre pas une session à chaque fois).
    // L'utilisateur lui-même, sans cible : weevboss.
    const target = this.threadTarget(mail) ?? parseTarget(dropMarker(mail.subject, author, 'subject')) ?? ({ kind: 'boss' } as const)
    const text = dropMarker(messageText(mail), author, 'body')
    const from = author.id || undefined
    if (!text) return this.reply(mail, mid, author, null, tr(M).emptyMessage)
    const since = Date.now()
    // L'objet sans la clé ni l'étiquette de l'auteur, comme dans la réponse.
    const told = (to: string) => {
      try {
        this.deps.mailed?.({ author: author.id, subject: dropMarker(mail.subject.replace(KEY_SUBJECT, ''), author, 'subject').replace(/\s{2,}/g, ' ').trim(), text, target: to, mid, address: mail.from ?? '' })
      } catch (e) {
        console.log('[mail]', `flux non prévenu : ${(e as Error).message}`)
      }
    }

    if (target.kind === 'boss') {
      this.state.threads[mid] = BOSS
      await this.deps.sendMain(from ? signAs(from, text) : text)
      console.log('[mail]', `→ weevboss · de ${from ?? 'owner'}`)
      told(BOSS)
      const r = await this.deps.waitMainReply(since, this.cfg.replyTimeoutMs)
      return this.reply(mail, mid, author, BOSS, r ?? tr(M).bossStillWorking)
    }

    const snap = this.deps.snapshot()
    let sessionId: string
    if (target.kind === 'session') {
      const hits = snap.sessions.filter((s) => s.id.toLowerCase().startsWith(target.id))
      if (hits.length !== 1) return this.reply(mail, mid, author, null, hits.length ? tr(M).ambiguousSession(target.id) : tr(M).noSession(target.id))
      sessionId = (await this.deps.send(hits[0].id, text, from)).id
    } else if (target.kind === 'project') {
      const p = snap.projects.find((x) => x.id.toLowerCase() === target.id.toLowerCase() || x.repos.some((r) => r.toLowerCase() === target.id.toLowerCase()))
      if (!p) return this.reply(mail, mid, author, null, tr(M).unknownProject(target.id, snap.projects.map((x) => x.id).join(', ')))
      // La session disponible du projet : pilotable, au repos, la plus récente ; sinon une nouvelle.
      const free = snap.sessions
        .filter((s) => s.projectId === p.id && s.controllable && s.status === 'idle')
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0]
      sessionId = free ? (await this.deps.send(free.id, text, from)).id : (await this.deps.create({ projectId: p.id, tool: 'claude', text, from })).id
    } else {
      sessionId = (await this.deps.create({ projectId: target.project, tool: target.tool, text, from })).id
    }
    this.state.threads[mid] = sessionId
    this.persist()
    console.log('[mail]', `→ session ${sessionId.slice(0, 8)} · de ${from ?? 'owner'}`)
    told(sessionId)
    const r = await this.deps.waitReply(sessionId, since, this.cfg.replyTimeoutMs)
    // Une session codex toute neuve est d'abord connue par le nom de sa pane : le fil retient le vrai id.
    this.state.threads[mid] = r.id
    const body = [
      r.text || tr(M).noReplyYet,
      !r.done ? tr(M).stillWorking(Math.round(this.cfg.replyTimeoutMs / 60_000)) : '',
      r.attention !== undefined ? tr(M).needsDecision(r.attention) : '',
    ].filter(Boolean)
    return this.reply(mail, mid, author, r.id, body.join('\n\n'), r.id)
  }

  /** Répond à l'expéditeur seul, dans le même fil. `target` null : message d'erreur, le fil ne mène nulle part. */
  private async reply(mail: Mail, mid: string, author: AuthorConfig, target: string | null, text: string, sessionId?: string) {
    const to = mail.from!
    // Au compte du pont (l'utilisateur, ou un agent qui écrit depuis son compte) : oui, la réponse va dans sa boîte, pas
    // sous le libellé (elle n'est pas adressée à l'alias) et porte X-Weevils. À l'alias lui-même : jamais.
    if (to === this.cfg.address) return console.log('[mail]', 'réponse annulée : destinataire = adresse du pont')
    const domain = this.cfg.address.split('@')[1]
    const messageId = `<weevils-${crypto.randomUUID()}@${domain}>`
    const footer = sessionId ? `\n\n${tr(M).footer(sessionId.slice(0, 8))}` : ''
    // Sans l'étiquette de l'auteur ni [weevboss] : l'agent qui lit sa boîte ne reprend pas la réponse pour une demande à
    // transmettre (boucle). Le fil suit In-Reply-To, la cible n'a pas besoin de l'objet.
    const subject = dropMarker(mail.subject.replace(KEY_SUBJECT, ''), author, 'subject').replace(/\[(weevboss|boss)\]/gi, ' ').replace(/\s{2,}/g, ' ').trim()
    const data = buildMail({
      from: this.cfg.address,
      fromName: 'weevils',
      to,
      subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
      text: text + footer,
      messageId,
      inReplyTo: mid,
      references: [...mail.references.filter((r) => r !== mid), mid].slice(-20),
      extraHeaders: {
        'Auto-Submitted': 'auto-replied',
        'X-Auto-Response-Suppress': 'All',
        'X-Weevils': `author=${author.id || 'owner'}; target=${target ?? 'none'}`,
      },
    })
    if (target) this.state.threads[messageId] = target
    this.persist()
    await smtpSend({ ...this.cfg.smtp, user: this.cfg.login, pass: this.cfg.password, from: this.cfg.address, to, data })
    console.log('[mail]', `réponse envoyée à ${to} · ${!target ? 'erreur' : target === BOSS ? BOSS : `session ${target.slice(0, 8)}`} · ${oneLine(text, 60)}`)
  }

  /**
   * Un mail écrit par l'utilisateur depuis l'app (réponse sous un item du flux « pour toi ») à l'auteur d'un mail reçu,
   * dans le même fil (In-Reply-To). Écrit par une personne : pas marqué « réponse automatique ». La réponse de l'auteur
   * reviendra à la même cible (weevboss ou la session). false : pas de destinataire (ou l'alias lui-même), rien n'est parti.
   */
  async write(o: { to: string; subject: string; text: string; inReplyTo: string; author: string; target: string }): Promise<boolean> {
    if (!o.to || o.to === this.cfg.address) return false
    const messageId = `<weevils-${crypto.randomUUID()}@${this.cfg.address.split('@')[1]}>`
    const subject = o.subject.replace(/\[(weevboss|boss)\]/gi, ' ').replace(/\s{2,}/g, ' ').trim()
    const data = buildMail({
      from: this.cfg.address,
      fromName: 'weevils',
      to: o.to,
      subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
      text: o.text,
      messageId,
      inReplyTo: o.inReplyTo,
      references: [o.inReplyTo],
      extraHeaders: { 'X-Weevils': `author=${o.author || 'owner'}; target=${o.target}; via=foryou` },
    })
    this.state.threads[messageId] = o.target
    this.persist()
    await smtpSend({ ...this.cfg.smtp, user: this.cfg.login, pass: this.cfg.password, from: this.cfg.address, to: o.to, data })
    console.log('[mail]', `écrit à ${o.to} depuis le flux · ${oneLine(o.text, 60)}`)
    return true
  }
}

/** Lance le pont si l'adresse et le mot de passe sont configurés. */
export function startMailBridge(deps: BridgeDeps, dataDir: string): MailBridge | null {
  const cfg = mailConfig()
  if (!cfg) return null
  const b = new MailBridge(cfg, deps, dataDir)
  b.start()
  return b
}
