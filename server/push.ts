// Notifications push (Web Push, gratuit) vers l'app installée sur l'iPhone.
// web-push est chargé à la demande : sur le PC (relais sans dépendances), le push est simplement désactivé.

import fs from 'node:fs'
import crypto from 'node:crypto'
import { acknowledgementOnly, humanFeedText } from '../shared/feed-text.ts'
import { notificationText } from '../shared/notification-policy.ts'
import path from 'node:path'
import { CONFIG_DIR, DATA_DIR, PUBLIC_URL } from './config.ts'
import { tr } from './i18n.ts'
import M from './i18n/push.ts'
import { sleepAllowsPush } from './sleep.ts'

interface Subscription {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

export interface PushPayload {
  title: string
  body: string
  url: string
  tag: string
  category?: 'question' | 'result' | 'milestone' | 'warning' | 'test'
  sessionId?: string
  eventAt?: number
}

const SUBS_FILE = path.join(DATA_DIR, 'push.json')

export class Push {
  private wp: any = null
  private subs: Subscription[] = []
  publicKey = ''
  private sent: Record<string, number> = {}
  private pending = new Set<string>()
  private readonly sentFile: string
  /** Sleep mode (server/sleep.ts): while it holds, only real blockers are sent. */
  asleep: () => boolean = () => false
  constructor(sentFile = path.join(DATA_DIR, 'push-sent.json')) {
    this.sentFile = sentFile
    try { this.sent = JSON.parse(fs.readFileSync(sentFile, 'utf8')) } catch { /* no previous sends */ }
  }

  async init() {
    try {
      const mod = await import('web-push' as string)
      this.wp = mod.default ?? mod
    } catch {
      return
    }
    const file = path.join(CONFIG_DIR, 'vapid.json')
    let keys: { publicKey: string; privateKey: string }
    try {
      keys = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      keys = this.wp.generateVAPIDKeys()
      fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600 })
    }
    this.wp.setVapidDetails(PUBLIC_URL || 'https://localhost', keys.publicKey, keys.privateKey)
    this.publicKey = keys.publicKey
    try {
      this.subs = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'))
    } catch {
      /* aucun appareil abonné */
    }
  }

  get enabled() {
    return !!this.wp
  }

  get count() {
    return this.subs.length
  }

  subscribe(sub: Subscription) {
    if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error(tr(M).badSubscription)
    const fresh = !this.subs.some((s) => s.endpoint === sub.endpoint)
    this.subs = [...this.subs.filter((s) => s.endpoint !== sub.endpoint), { endpoint: sub.endpoint, keys: sub.keys }]
    this.save()
    if (fresh) console.log(`[push] nouvel appareil abonné (${this.subs.length} au total)`)
  }

  async send(input: PushPayload) {
    const p = { ...input }
    // Automatic relay progress and editorial cards never interrupt the user.
    if (/^(?:r:|d:|commit:|deploy:)/.test(p.tag) || p.tag === 'relay') return
    if (p.tag === 'relay-warn') {
      if (!/pas de relais prêt|no relay ready/i.test(p.body)) return
      p.category = 'warning'
    }
    if (p.tag === 'relay-plans') { p.category = 'question'; p.body = tr(M).relayPlansBody(p.body) }
    if (p.tag.startsWith('cut-')) { p.category = 'warning'; p.sessionId = p.tag.slice(4); p.tag = p.sessionId }
    if (p.tag === 'test') p.category = 'test'
    if (!p.category || acknowledgementOnly(p.body)) return
    if (!sleepAllowsPush(this.asleep(), p.category)) return console.log(`[push] sommeil · « ${p.title} » gardée pour le réveil`)
    if ((p.category === 'result' || p.category === 'milestone') && !notificationText(p.body)) return
    p.title = humanFeedText(p.title)
    p.body = humanFeedText(p.body)
    if (!p.title || !p.body) return
    if (!this.wp) return console.log(`[push] module web-push absent · « ${p.title} » non envoyée`)
    if (!this.subs.length) return console.log(`[push] aucun appareil abonné · « ${p.title} » non envoyée`)
    const now = Date.now()
    const key = crypto.createHash('sha256').update(JSON.stringify([p.tag, p.category, p.body, p.category === 'question' || p.category === 'warning' ? (p.eventAt ?? Math.floor(now / 60_000)) : null])).digest('hex')
    if ((this.sent[key] && now - this.sent[key] < 24 * 3600_000) || this.pending.has(key)) return
    this.pending.add(key)
    const dead: string[] = []
    let ok = 0
    await Promise.all(
      this.subs.map((s) =>
        this.wp
          .sendNotification(s, JSON.stringify(p), { TTL: 3600, urgency: 'high' })
          .then(() => ok++)
          .catch((e: { statusCode?: number; body?: string; message?: string }) => {
            console.error(`[push] échec ${e.statusCode ?? ''} ${s.endpoint.slice(0, 40)}… ${e.body ?? e.message ?? ''}`.trim())
            if (e.statusCode === 404 || e.statusCode === 410) dead.push(s.endpoint)
          }),
      ),
    )
    this.pending.delete(key)
    if (ok) {
      this.sent = Object.fromEntries(Object.entries(this.sent).filter(([, at]) => now - at < 24 * 3600_000).slice(-999))
      this.sent[key] = now
      try {
        fs.mkdirSync(path.dirname(this.sentFile), { recursive: true })
        fs.writeFileSync(this.sentFile + '.tmp', JSON.stringify(this.sent), { mode: 0o600 })
        fs.renameSync(this.sentFile + '.tmp', this.sentFile)
      } catch { console.error('[push] deduplication persistence unavailable') }
    }
    console.log(`[push] « ${p.title} » → ${ok}/${this.subs.length} appareils`)
    if (dead.length) {
      this.subs = this.subs.filter((s) => !dead.includes(s.endpoint))
      this.save()
    }
  }

  private save() {
    fs.writeFileSync(SUBS_FILE, JSON.stringify(this.subs), { mode: 0o600 })
  }
}
