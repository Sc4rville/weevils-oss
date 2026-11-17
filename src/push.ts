import { api } from './api'
import { tr } from './i18n'
import M from './i18n/app'

const b64 = (s: string) => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4)
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

export const pushSupported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

/** Abonne (ou ré-abonne) cet appareil au serveur : à chaque lancement si l'autorisation est déjà donnée, sinon au tap. */
export async function ensurePush(opts: { ask?: boolean; test?: boolean } = {}): Promise<boolean> {
  if (!pushSupported()) return false
  const info = await api.push()
  if (!info.enabled) throw new Error(tr(M).pushUnavailable)
  let perm = Notification.permission
  if (perm !== 'granted' && opts.ask) perm = await Notification.requestPermission()
  if (perm !== 'granted') {
    if (opts.ask) throw new Error(tr(M).pushDenied)
    return false
  }
  const reg = await navigator.serviceWorker.ready
  let sub = await reg.pushManager.getSubscription()
  // Une clé serveur qui a changé rend l'ancien abonnement muet : on le refait.
  const key = sub?.options?.applicationServerKey
  const same = key && btoa(String.fromCharCode(...new Uint8Array(key))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') === info.publicKey
  if (sub && !same) {
    await sub.unsubscribe().catch(() => undefined)
    sub = null
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(info.publicKey) })
  await api.pushSubscribe(sub.toJSON())
  if (opts.test) await api.pushTest()
  return true
}
