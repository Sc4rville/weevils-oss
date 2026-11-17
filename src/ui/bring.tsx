import { useEffect, useState } from 'react'
import type { BringItem, BringView } from '../../shared/bring.ts'
import { api } from '../api'
import { useT } from '../i18n'
import M from '../i18n/setup'
import { useApp } from './app-context'
import { copyText } from './copy'
import { ago } from './format'
import { Icon } from './icons'

// Bring your conversations ([[setup:history]] under weevboss's message; server/bring.ts): the line to paste on the
// computer that has them, then that computer's conversations, one line each. A tap brings one; once here, a tap opens
// it like any session. A machine already connected to this weevils lists its own without the line.

export function Bring() {
  const t = useT(M)
  const { push } = useApp()
  const [code, setCode] = useState<string | null>(null)
  const [view, setView] = useState<BringView | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    let alive = true
    void api.bringLink().then((r) => alive && setCode(r.code), () => undefined)
    const tick = () => void api.bringView().then((v) => alive && setView(v), () => undefined)
    tick()
    const id = window.setInterval(tick, 2000)
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [])
  const line = code ? `curl -fsSL ${location.origin}/api/bring.sh | bash -s ${code}` : ''
  const sources = view?.sources ?? []
  const tap = (source: string, it: BringItem, live: boolean) => {
    if (it.state === 'here' && it.sessionId) return push({ kind: 'session', id: it.sessionId })
    if (it.state === 'moving' || !live) return
    setView((v) => v && { ...v, sources: v.sources.map((s) => (s.id !== source ? s : { ...s, items: s.items.map((i) => (i.key === it.key ? { ...i, state: 'moving' } : i)) })) })
    void api.bring(source, it.key).catch(() => undefined)
  }
  const now = Date.now()
  return (
    <div className="bring">
      {line && (
        <div className="bring-line">
          <span className="meta">{t.bringLine}</span>
          <code>{line}</code>
          <button type="button" className="setup-chip" onClick={async () => setCopied(await copyText(line))}>
            <Icon name={copied ? 'check' : 'copy'} /> {copied ? t.bringCopied : t.bringCopy}
          </button>
          {!sources.some((s) => s.id.startsWith('pc:')) && copied && <span className="meta">{t.bringWaiting}</span>}
        </div>
      )}
      {sources.map((s) => (
        <div className="bring-source" key={s.id}>
          <div className="bring-name">{s.name}</div>
          {!s.live && <div className="meta">{t.bringOff(s.name)}</div>}
          {!s.items.length && <div className="meta">{t.bringNone}</div>}
          <ul>
            {s.items.map((it) => (
              <li key={it.key}>
                <button type="button" className={`bring-row ${it.state ?? ''}`} onClick={() => tap(s.id, it, s.live)}>
                  <span className="bring-title">{it.title}</span>
                  <span className="bring-when">
                    {it.state === 'moving' ? t.bringMoving : it.state === 'here' ? <>{t.bringOpen} <Icon name="arrow" dir="right" /></> : it.state === 'failed' ? t.bringFailed : ago(now - it.at)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}
