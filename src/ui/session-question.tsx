import { sessionNoticeKey } from '../../shared/notices.ts'
import { dismissNotice } from './notice-store'
import { Notice } from './notice'
import { useEffect, useState } from 'react'
import type { Session } from '../../shared/api.ts'
import { api } from '../api'
import { useT } from '../i18n'
import M from '../i18n/pages'

/** A real question and its labeled answers. Terminal input and key names never belong here. */
export function SessionQuestion({ session: s, onError }: { session: Session; onError: (text: string) => void }) {
  const t = useT(M)
  const [busy, setBusy] = useState(false)
  const choices = s.choices?.map((c) => c.id).join(',')
  useEffect(() => setBusy(false), [s.id, s.status, choices])
  if (s.status !== 'needs_user' || /^[›❯>]\s/.test(s.attention ?? '')) return null
  const choose = async (id: string) => {
    if (busy) return
    setBusy(true)
    onError('')
    try { await api.key(s.id, `choice:${id}`); dismissNotice(sessionNoticeKey(s)) }
    catch (e) { setBusy(false); onError((e as Error).message) }
  }
  return (
    <Notice closable={false} eventId={sessionNoticeKey(s)} about={s.title} className="msg band tone ask">
      <div className="in">
        <span className="who">! {t.asks(s.tool)}</span>
        <div className="text">{s.ask?.text ?? s.attention ?? t.waitingForYou}</div>
        {s.choices?.map((choice) => (
          <button key={choice.id} disabled={busy} className="choice-band" onClick={() => void choose(choice.id)}>{choice.label}</button>
        ))}
      </div>
    </Notice>
  )
}
