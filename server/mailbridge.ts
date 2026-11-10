// Le pont e-mail : des agents externes (un bot de CI, un autre agent IA…) écrivent dans les sessions weevils par e-mail.
//
//   Adresse         un alias de la boîte perso (moi+weevils@gmail.com) ; un filtre Gmail range ces mails sous le libellé « weevils »
//                   hors boîte de réception. Le pont ne surveille que ce libellé : aucun autre mail n'est lu, marqué ou déplacé.
//   Objet           « [shop] … » session disponible du projet (sinon une nouvelle) · « [session:2cbb0bbd] » cette session
//                   « [weevboss] » l'orchestrateur · « [new:projet] » (ou « [new:projet:codex] ») une nouvelle session
//   Corps           le message (citation du mail précédent et signature retirées)
//   Réponse         renvoyée à l'expéditeur dans le même fil (In-Reply-To / References) ; répondre à ce mail continue la même session.
//
// Réception : IMAP IDLE (push, quasi instantané), relancé toutes les 30 s, ce qui sert aussi de sondage de secours ;
// reconnexion automatique avec attente croissante ; déduplication par Message-ID ; tout est journalisé « [mail] ».
// Sécurité : seuls les expéditeurs déclarés (WEEVILS_AUTHOR_*) passent, et seulement si le serveur de réception atteste
// SPF ou DKIM aligné sur le domaine de l'expéditeur (Authentication-Results), ou si le secret partagé est présent.
// Anti-boucle : rien de l'adresse du pont, rien d'automatique (Auto-Submitted, X-Autoreply, Precedence: bulk…) ;
// chaque envoi porte Auto-Submitted: auto-replied et X-Weevils, à l'expéditeur seul, jamais au pont.
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
  /** Le seul dossier surveillé : le libellé Gmail posé par le filtre « à : +weevils ». Jamais INBOX. */
  label: string
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
  // Jamais la boîte de réception : le pont ne doit voir que les mails rangés sous son libellé.
  if (/^inbox$/i.test(label)) return null
  return {
    address,
    login: env.WEEVILS_MAIL_LOGIN?.trim().toLowerCase() || address.replace(/\+[^@]*@/, '@'),
    password,
    label,
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

export type Screen = { ok: true; author: AuthorConfig; how: string } | { ok: false; reason: string }

/** Qui écrit, et a-t-il le droit : expéditeur déclaré + (SPF/DKIM alignés ou secret partagé). */
export function screen(mail: Mail, cfg: Pick<MailConfig, 'address' | 'login' | 'authserv'>, list: AuthorConfig[]): Screen {
  if (!mail.from) return { ok: false, reason: tr(M).noSender }
  if (mail.from === cfg.address || mail.from === cfg.login) return { ok: false, reason: tr(M).fromBridge }
  if (!addressedTo(mail, cfg.address)) return { ok: false, reason: tr(M).notToBridge }
  const auto = isAutomatic(mail)
  if (auto) return { ok: false, reason: tr(M).automatic(auto) }
  const candidates = list.filter((a) => a.id !== BOSS && a.emails.includes(mail.from!))
  if (!candidates.length) return { ok: false, reason: tr(M).unknownSender }
  const given = KEY_SUBJECT.exec(mail.subject)?.[1] ?? KEY_BODY.exec(mail.text)?.[1]
  if (given) {
    const byKey = candidates.find((a) => a.secret && sameSecret(a.secret, given))
    if (byKey) return { ok: true, author: byKey, how: 'secret' }
    return { ok: false, reason: tr(M).wrongSecret }
  }
  if (candidates.length > 1) return { ok: false, reason: tr(M).sharedAddress(candidates.map((a) => a.id).join(', ')) }
  const auth = authCheck(mail, cfg.authserv)
  return auth.pass ? { ok: true, author: candidates[0], how: auth.detail } : { ok: false, reason: tr(M).authFailed(auth.detail) }
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
}

interface State {
  uidValidity: number
  lastUid: number
  /** Message-ID déjà traités (les plus récents). */
  seen: string[]
  /** Message-ID d'un fil (reçus et envoyés) → cible : « weevboss » ou l'id de session. */
  threads: Record<string, string>
}

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
    this.state = { uidValidity: s.uidValidity ?? 0, lastUid: s.lastUid ?? 0, seen: s.seen ?? [], threads: s.threads ?? {} }
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
    console.log('[mail]', `pont actif · ${this.cfg.address} · IMAP ${this.cfg.imap.host} « ${this.cfg.label} » · auteurs : ${ext.map((a) => `${a.id} (${a.emails.length ? a.emails.join(', ') : 'aucune adresse'}${a.secret ? ', secret' : ''})`).join(' · ') || 'aucun'}`)
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
        // Seulement le libellé du pont (absent : erreur et nouvel essai, jamais de repli sur INBOX).
        const box = await c.select(this.cfg.label)
        if (box.uidValidity !== this.state.uidValidity) {
          // Première connexion (ou boîte recréée) : on part de maintenant, l'historique n'est pas rejoué.
          console.log('[mail]', `boîte ${this.state.uidValidity ? 'recréée' : 'découverte'} : on part du message ${box.uidNext}`)
          this.state.uidValidity = box.uidValidity
          this.state.lastUid = Math.max(0, box.uidNext - 1)
          this.persist()
        }
        console.log('[mail]', `connecté · IDLE`)
        backoff = 2000
        let dirty = true
        c.on('exists', () => (dirty = true))
        while (!this.stopped && !c.closed) {
          if (dirty) {
            dirty = false
            await this.check(c)
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

  private async check(c: Imap) {
    const uids = await c.uidsAfter(this.state.lastUid)
    for (const uid of uids) {
      const raw = await c.fetch(uid)
      this.state.lastUid = uid
      this.persist()
      if (!raw) continue
      let accepted = false
      try {
        accepted = this.handle(parseMail(raw), uid)
      } catch (e) {
        console.log('[mail]', `message ${uid} illisible : ${(e as Error).message}`)
      }
      // Lu seulement s'il a été pris en compte : les mails ignorés restent visibles, non lus, dans la boîte.
      if (accepted) await c.markSeen(uid).catch(() => undefined)
    }
  }

  /** Un message reçu : vérifié, dédupliqué, limité, routé. true s'il est pris en compte. */
  handle(mail: Mail, uid = 0): boolean {
    const mid = mail.messageId ?? `<uid-${this.state.uidValidity}-${uid}@weevils>`
    const what = `${mail.from ?? '?'} · « ${oneLine(mail.subject.replace(KEY_SUBJECT, '[key:…]'), 60)} » · ${mid}`
    if (this.state.seen.includes(mid)) {
      console.log('[mail]', `doublon ignoré · ${what}`)
      return false
    }
    this.state.seen.push(mid)
    this.persist()
    const v = screen(mail, this.cfg, authors())
    if (!v.ok) {
      console.log('[mail]', `ignoré · ${v.reason} · ${what}`)
      return false
    }
    if (!this.limiter.allow(v.author.id)) {
      console.log('[mail]', `ignoré · limite de débit de ${v.author.id} (${this.cfg.perMinute}/min, ${this.cfg.perHour}/h) · ${what}`)
      return false
    }
    console.log('[mail]', `reçu de ${v.author.id} (${v.how}) · ${what}`)
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
    const target = this.threadTarget(mail) ?? parseTarget(mail.subject)
    const text = messageText(mail)
    if (!target) return this.reply(mail, mid, author, null, tr(M).noTarget)
    if (!text) return this.reply(mail, mid, author, null, tr(M).emptyMessage)
    const since = Date.now()

    if (target.kind === 'boss') {
      this.state.threads[mid] = BOSS
      await this.deps.sendMain(signAs(author.id, text))
      console.log('[mail]', `→ weevboss · de ${author.id}`)
      const r = await this.deps.waitMainReply(since, this.cfg.replyTimeoutMs)
      return this.reply(mail, mid, author, BOSS, r ?? tr(M).bossStillWorking)
    }

    const snap = this.deps.snapshot()
    let sessionId: string
    if (target.kind === 'session') {
      const hits = snap.sessions.filter((s) => s.id.toLowerCase().startsWith(target.id))
      if (hits.length !== 1) return this.reply(mail, mid, author, null, hits.length ? tr(M).ambiguousSession(target.id) : tr(M).noSession(target.id))
      sessionId = (await this.deps.send(hits[0].id, text, author.id)).id
    } else if (target.kind === 'project') {
      const p = snap.projects.find((x) => x.id.toLowerCase() === target.id.toLowerCase() || x.repos.some((r) => r.toLowerCase() === target.id.toLowerCase()))
      if (!p) return this.reply(mail, mid, author, null, tr(M).unknownProject(target.id, snap.projects.map((x) => x.id).join(', ')))
      // La session disponible du projet : pilotable, au repos, la plus récente ; sinon une nouvelle.
      const free = snap.sessions
        .filter((s) => s.projectId === p.id && s.controllable && s.status === 'idle')
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0]
      sessionId = free ? (await this.deps.send(free.id, text, author.id)).id : (await this.deps.create({ projectId: p.id, tool: 'claude', text, from: author.id })).id
    } else {
      sessionId = (await this.deps.create({ projectId: target.project, tool: target.tool, text, from: author.id })).id
    }
    this.state.threads[mid] = sessionId
    this.persist()
    console.log('[mail]', `→ session ${sessionId.slice(0, 8)} · de ${author.id}`)
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
    if (to === this.cfg.address || to === this.cfg.login) return console.log('[mail]', 'réponse annulée : destinataire = adresse du pont')
    const domain = this.cfg.address.split('@')[1]
    const messageId = `<weevils-${crypto.randomUUID()}@${domain}>`
    const footer = sessionId ? `\n\n${tr(M).footer(sessionId.slice(0, 8))}` : ''
    const subject = mail.subject.replace(KEY_SUBJECT, '').replace(/\s{2,}/g, ' ').trim()
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
        'X-Weevils': `author=${author.id}; target=${target ?? 'none'}`,
      },
    })
    if (target) this.state.threads[messageId] = target
    this.persist()
    await smtpSend({ ...this.cfg.smtp, user: this.cfg.login, pass: this.cfg.password, from: this.cfg.address, to, data })
    console.log('[mail]', `réponse envoyée à ${to} · ${!target ? 'erreur' : target === BOSS ? BOSS : `session ${target.slice(0, 8)}`} · ${oneLine(text, 60)}`)
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
