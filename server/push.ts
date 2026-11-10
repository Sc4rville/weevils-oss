// Notifications push (Web Push, gratuit) vers l'app installée sur l'iPhone.
// web-push est chargé à la demande : sur le PC (relais sans dépendances), le push est simplement désactivé.

import fs from 'node:fs'
import path from 'node:path'
import { CONFIG_DIR, DATA_DIR, PUBLIC_URL } from './config.ts'
import { tr } from './i18n.ts'
import M from './i18n/push.ts'

interface Subscription {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

export interface PushPayload {
  title: string
  body: string
  url: string
  tag: string
}

const SUBS_FILE = path.join(DATA_DIR, 'push.json')

export class Push {
  private wp: any = null
  private subs: Subscription[] = []
  publicKey = ''

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

  async send(p: PushPayload) {
    if (!this.wp) return console.log(`[push] module web-push absent · « ${p.title} » non envoyée`)
    if (!this.subs.length) return console.log(`[push] aucun appareil abonné · « ${p.title} » non envoyée`)
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
