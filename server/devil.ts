// Devil mode : les messages de la bande du haut vont à un autre modèle (open-weight, hébergé par l'utilisateur),
// appelé par une API compatible OpenAI (chat/completions en streaming). Même fil que weevboss ; pas d'outils : il converse.
// Config : DEVIL_API_URL (ex. http://pc:8000/v1), DEVIL_API_KEY, DEVIL_MODEL dans ~/.config/weevils/env.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Message } from '../shared/api.ts'
import { DATA_DIR } from './config.ts'
import { tr } from './i18n.ts'
import M from './i18n/devil.ts'

const FILE = path.join(DATA_DIR, 'devil.json')

export const devilConfig = () => {
  const url = process.env.DEVIL_API_URL?.trim()
  return url ? { url: url.replace(/\/+$/, ''), key: process.env.DEVIL_API_KEY?.trim() ?? '', model: process.env.DEVIL_MODEL?.trim() || 'default' } : null
}

let log: Message[] = (() => {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8')) as Message[]
  } catch {
    return []
  }
})()
let working = false

/** Les messages du devil mode, à mêler au fil de weevboss (marqués devil). */
export const devilMessages = () => log
export const devilWorking = () => working

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(FILE, JSON.stringify(log.slice(-200)))
  } catch {
    /* disque plein : on garde en mémoire */
  }
}

/** Le texte part au modèle avec l'historique récent du fil ; la réponse arrive en flux et s'écrit au fur et à mesure. */
export async function devilSend(text: string, history: Message[], bump: () => void): Promise<{ id: string }> {
  const cfg = devilConfig()
  const t = text.trim()
  if (!t) throw new Error(tr(M).empty)
  if (working) throw new Error(tr(M).busy)
  const now = Date.now()
  log.push({ id: `devil-${now}-u`, role: 'user', text: t, at: now, devil: true })
  const reply: Message = { id: `devil-${now}-${crypto.randomBytes(3).toString('hex')}`, role: 'assistant', text: '', at: now + 1, devil: true }
  log.push(reply)
  working = true
  bump()
  const context = history
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-20)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.text.slice(0, 4000) }))
  if (!cfg) {
    // Pas de modèle configuré : le fil le dit, en vert, à la place de la réponse.
    reply.text = tr(M).notReady
    working = false
    save()
    bump()
    return { id: reply.id }
  }
  void (async () => {
    const t0 = Date.now()
    try {
      const res = await fetch(`${cfg.url}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.key ? { authorization: `Bearer ${cfg.key}` } : {}) },
        body: JSON.stringify({ model: cfg.model, stream: true, messages: [...context, { role: 'user', content: t }] }),
        signal: AbortSignal.timeout(180_000),
      })
      if (!res.ok || !res.body) throw new Error(`${res.status} ${(await res.text().catch(() => '')).slice(0, 160)}`)
      let buf = ''
      let last = 0
      const dec = new TextDecoder()
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          const m = /^data: (.*)$/.exec(line.trim())
          if (!m || m[1] === '[DONE]') continue
          try {
            reply.text += JSON.parse(m[1]).choices?.[0]?.delta?.content ?? ''
          } catch {
            /* ligne partielle */
          }
        }
        if (Date.now() - last > 150) {
          last = Date.now()
          bump()
        }
      }
      console.log(`[devil] réponse en ${Date.now() - t0} ms`)
    } catch (e) {
      // Injoignable (PC éteint, adresse vide) : une phrase simple dans le fil, pas l'erreur brute.
      const unreachable = /fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|timeout/i.test(`${(e as Error).message} ${String((e as { cause?: unknown }).cause ?? '')}`)
      reply.text = reply.text || (unreachable ? tr(M).notReady : tr(M).failed((e as Error).message))
      console.error(`[devil] ${(e as Error).message}`)
    } finally {
      working = false
      save()
      bump()
    }
  })()
  return { id: reply.id }
}
