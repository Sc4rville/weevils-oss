import { useState } from 'react'
import { forgetReceipt, retryReceipt, useOutbox, type LocalReceipt } from '../outbox'
import { useT } from '../i18n'
import M from '../i18n/outbox'
import { copyText } from './copy'
const recoverable = (status: string) => ['failed', 'uncertain', 'sending'].includes(status)
/** The server never took it and nothing is trying right now: say « not sent yet », never an endless « sending… ». */
const notSent = (r: LocalReceipt) => r.status === 'sending' && !!(r.stuck || r.trackingLost)
/** A new attempt is safe only when nothing can have reached the agent: never for « uncertain ». */
const retryable = (r: LocalReceipt) => r.status === 'failed' || notSent(r)
/** A reply is not delivery evidence. Only an exact receipt or identical payload with confirmed delivery resolves an error. */
export function OutboxStatus({ scope, eventId }: { scope: string; eventId?: string }) {
 const rows = useOutbox()
 const t = useT(M)
 const [copied, setCopied] = useState('')
 const [retrying, setRetrying] = useState('')
 const retry = (id: string) => { setRetrying(id); void retryReceipt(id).catch(() => undefined).finally(() => setRetrying(r => r === id ? '' : r)) }
 // Accepted: the server has it, even while the agent is busy. Held (OutboxDeferred): it has it and will try again itself.
 const label = (r: LocalReceipt) => notSent(r) ? t.notSentYet : r.status === 'accepted' && (r.retryAt || r.error) ? t.waiting : t[r.status]
 // Old receipts may contain obsolete advice to open a new session. Keep recovery in the existing conversation.
 const errorText = (error: string) => /^(This session was opened elsewhere,|Cette session a été ouverte ailleurs,)/.test(error) ? t.unavailable : error
 const relevant = rows.filter(r => r.url.startsWith(scope) && (!eventId || !r.eventId || r.eventId === eventId))
 const visible = relevant.filter(r => !r.dismissed && r.status !== 'delivered' && !(r.status === 'failed' && r.fingerprint && relevant.some(done => done.status === 'delivered' && done.fingerprint === r.fingerprint && done.updatedAt >= r.updatedAt)))
 if (!visible.length) return null
 return <div className="outbox-status in" aria-live="polite">{visible.map(r => {
  const problem = r.status === 'failed' || r.status === 'uncertain' || !!r.stuck
  return <details key={r.messageId} data-delivery={r.status}>
   <summary>{label(r)}{r.text && <span className="outbox-excerpt"> — {r.text.slice(0, 100)}{r.text.length > 100 ? '…' : ''}</span>}</summary>
   {r.text && <blockquote>{r.text}</blockquote>}
   {r.error && <p className="meta">{errorText(r.error)}</p>}
   <div className="outbox-recovery">
    {retryable(r) && <button type="button" className="link" disabled={retrying === r.messageId} onClick={() => retry(r.messageId)}>{t.retry}</button>}
    {r.text && recoverable(r.status) && <button type="button" className="link" onClick={() => void copyText(r.text!).then(ok => ok && setCopied(r.messageId))}>{copied === r.messageId ? t.copied : t.recover}</button>}
    {problem && <button type="button" className="link" aria-label={t.closeError} onClick={() => forgetReceipt(r.messageId)}>{t.closeError}</button>}
   </div>
  </details>
 })}</div>
}
