import { sourceAccessIssue, sourceForRepo, sourceForSession } from './source-access'
import { useEffect, useRef, useState } from 'react'
import type { Message } from '../../shared/api'
import { api } from '../api'
import { useT } from '../i18n'
import M from '../i18n/preview'
import { Composer, Messages } from './bits'
import { useApp } from './app-context'
import { OutboxStatus } from './outbox-status'
import { capturePreview } from './preview-capture'
import { deliverFeedback, feedbackDelivered, freezeFeedback, readFeedback, type FrozenFeedback, type PreviewTarget } from './preview-feedback'
import './preview-chat.css'

interface Watch { target: PreviewTarget; at: number }
export function PreviewChat({ viewerId, projectId, sessionId, repo, frame }: {
  viewerId: string; projectId?: string; sessionId?: string; repo?: string; frame: React.RefObject<HTMLIFrameElement | null>
}) {
  const t = useT(M)
  const { snap } = useApp()
  const saved = useRef<FrozenFeedback | null>(null)
  const panel = useRef<HTMLElement>(null)
  const transcript = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const watchKey = `weevils-preview-replies:${viewerId}`
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [watch, setWatch] = useState<Watch | null>(() => {
    try { return JSON.parse(sessionStorage.getItem(watchKey) ?? 'null') } catch { return null }
  })
  const [messages, setMessages] = useState<Message[]>([])
  const [author, setAuthor] = useState<'codex' | 'claude' | 'weevboss'>('weevboss')
  useEffect(() => {
    let off = false
    readFeedback(viewerId).then(value => {
      if (off) return
      saved.current = value; setReady(true)
    }).catch(() => { if (!off) setError(t.storageUnavailable) })
    return () => { off = true }
  }, [viewerId, t.storageUnavailable])
  useEffect(() => {
    const el = panel.current
    const stop = (e: PointerEvent) => e.stopPropagation()
    el?.addEventListener('pointerdown', stop)
    return () => el?.removeEventListener('pointerdown', stop)
  }, [])
  useEffect(() => {
    if (!watch?.target.sessionId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        const detail = await api.session(watch.target.sessionId!)
        if (!cancelled) { setMessages(detail.messages); setAuthor(detail.session.tool); setError('') }
      } catch (e) { if (!cancelled) setError((e as Error).message) }
      if (!cancelled) timer = setTimeout(() => void refresh(), 3000)
    }
    void refresh()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [watch, t])
  const shown = watch ? (watch.target.sessionId ? messages : snap.main).filter(m => m.at >= watch.at && m.role !== 'event') : []
  useEffect(() => {
    if (following.current && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight
  }, [shown.at(-1)?.id, shown.at(-1)?.text])
  const knownSession = snap.sessions.find(s => s.id === sessionId)
  const sourceIssue = sourceAccessIssue(knownSession ? sourceForSession(snap.projects, knownSession) : sourceForRepo(snap.projects, repo, snap.projects.find(p => p.id === projectId)?.where[repo ?? '']))
  const send = async (text: string) => {
    if (sourceIssue) throw new Error(sourceIssue)
    setError('')
    let frozen = saved.current
    if (frozen && frozen.draft !== text && !feedbackDelivered(frozen)) throw new Error(t.retryOriginal)
    if (!frozen || frozen.draft !== text) {
      // Start capture from the send gesture; routing cannot turn into a new agent/session.
      const capture = capturePreview(frame.current, { unavailable: t.captureUnavailable, unreadable: t.captureUnreadable, changed: t.captureChanged, failed: t.captureFailed })
      const [image, result] = await Promise.all([capture, api.previewTarget({ projectId: projectId ?? '', sessionId, repo })])
      if (!result.session) throw new Error(t.noTarget)
      const targetIssue = sourceAccessIssue(result.session)
      if (targetIssue) throw new Error(targetIssue)
      const target = { sessionId: result.session.id, title: result.session.title }
      frozen = await freezeFeedback(viewerId, text, target, image, t.pageContext)
      saved.current = frozen
    }
    const next = { target: frozen.target, at: frozen.at }
    setWatch(next)
    try { sessionStorage.setItem(watchKey, JSON.stringify(next)) } catch { /* Delivery payload is already durable. */ }
    await deliverFeedback(viewerId, frozen, t.noTarget)
    saved.current = null
  }
  return <section ref={panel} className="preview-chat">
    {!!shown.length && <div ref={transcript} className="preview-chat-messages session-thread" onScroll={e => { const el = e.currentTarget; following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64 }}>
      <Messages session messages={shown} author={watch?.target.sessionId ? author : 'weevboss'} />
    </div>}
    {watch && <OutboxStatus scope={watch.target.sessionId ? `/api/sessions/${encodeURIComponent(watch.target.sessionId)}/` : '/api/main'} />}
    {error && <div className="in meta" role="alert">{error}</div>}
    {sourceIssue && <div className="in meta" role="status">{sourceIssue}</div>}
    <Composer draftKey={`preview:${sessionId ?? viewerId}`} placeholder={t.message} label={t.message} onSend={send} disabled={!ready || !!sourceIssue} sayErrors />
  </section>
}
