import { sourceAccessIssue, sourceForSession } from './source-access'
import { interceptModelControl } from '../model-controls'
import { dismissNotice } from './notice-store'
import { noticeKey, sessionNoticeKey } from '../../shared/notices.ts'
import { Notice } from './notice'
import { motion } from 'motion/react'
import { useEffect, useMemo, useRef, useState, type TouchEvent } from 'react'
import type { Message, SessionDetail } from '../../shared/api.ts'
import { api } from '../api'
import { useT } from '../i18n'
import { useFollow } from './follow'
import M from '../i18n/calm'
import { useApp } from './app-context'
import { Collapse, Composer, Messages, Working, type Attachment } from './bits'
import { Preview, guessPreviewUrl, urlsInMessages, usePreviewState } from './preview'
import { Settings } from './settings'
import { SidePane, usePageChrome, useSplit } from './shell'
import { FollowDown } from './followdown'
import { markSeen } from './seen'
import { Icon } from './icons'
import { SessionQuestion } from './session-question'
import { CutBand } from './cut-band'
import type { Session } from '../../shared/api.ts'

// Legacy focused conversation routes remain available without the retired overview.

const soft = { type: 'tween', duration: 0.38, ease: [0.22, 1, 0.36, 1] } as const

/** Pincement à deux doigts (dans un sens ou l'autre) : une fois par geste. */
export function usePinch(onPinch: () => void) {
  const start = useRef<number | null>(null)
  const fired = useRef(false)
  const dist = (e: TouchEvent) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY)
  return {
    onTouchStart: (e: TouchEvent) => {
      if (e.touches.length === 2) {
        start.current = dist(e)
        fired.current = false
      }
    },
    onTouchMove: (e: TouchEvent) => {
      if (e.touches.length !== 2 || start.current == null || fired.current) return
      const r = dist(e) / start.current
      if (r < 0.72 || r > 1.4) {
        fired.current = true
        onPinch()
      }
    },
    onTouchEnd: () => {
      start.current = null
    },
  }
}

/** Compatibility for a legacy overview already present in an in-memory navigation stack.
 * No replacement dashboard and no mutation of sessions or their history. */
export function CalmGrid() {
  const { back } = useApp()
  const returned = useRef(false)
  useEffect(() => {
    if (returned.current) return
    returned.current = true
    back()
  }, [back])
  return null
}

export function CalmConv({ id }: { id: string }) {
  const t = useT(M)
  const { snap, back, replace } = useApp()
  const page = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  usePageChrome('calm', page)
  const pinch = usePinch(back)
  const main = id === 'main'
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [more, setMore] = useState(false)
  const [preview, setPreview] = usePreviewState(id)

  useEffect(() => {
    if (main) return
    let off = false
    api
      .session(id)
      .then((d) => {
        if (off) return
        setDetail(d)
        if (d.session.id !== id) replace({ kind: 'calmconv', id: d.session.id })
      })
      .catch((e) => !off && setErr((e as Error).message))
    return () => {
      off = true
    }
  }, [id, main, snap.version, replace])

  const s = main ? undefined : (snap.sessions.find((x) => x.id === id) ?? detail?.session)
  useEffect(() => {
    if (s) markSeen(s.id, s.lastActivityAt)
  }, [s, s?.id, s?.lastActivityAt])
  const raw: Message[] = main ? snap.main : (detail?.messages ?? [])
  const messages = useMemo(() => raw.filter((m) => m.role !== 'event'), [raw])
  const working = main ? snap.mainWorking : s?.status === 'working'
  const author = main ? 'weevboss' : (s?.tool ?? 'claude')
  const title = main ? 'weevboss' : (s?.title ?? '')
  // A question waiting on the screen (a permission, a menu, the agent's own question): its plain words and buttons.
  const mq = snap.mainQuestion
  const question = main ? (mq ? ({ id: mq.id, tool: 'claude', title: 'weevboss', status: 'needs_user', attention: mq.attention, attentionDetail: mq.attentionDetail, choices: mq.choices } as Session) : undefined) : s?.status === 'needs_user' ? s : undefined
  const last = messages.at(-1)
  const follow = useFollow(body, messages.length > 0, 80, `${messages.length}:${last?.id}:${last?.text.length}:${working}`)
  const [split, unsplit] = useSplit(!!preview.open)

  const sourceIssue = main ? null : sourceAccessIssue(sourceForSession(snap.projects, s))
  const send = async (text: string, files: Attachment[] = []) => {
    if(interceptModelControl(main?'__main':id,text,files.length))return
    if (sourceIssue) throw new Error(sourceIssue)
    setErr(null)
    follow.toEnd()
    try {
      if (main) {
        if (files.length) await api.mainAttach(text, files)
        else await api.main(text)
      } else if (s) {
        const r = files.length ? await api.attach(s.id, text, files) : await api.send(s.id, text)
        if (s.status === 'needs_user' || s.status === 'interrupted') dismissNotice(sessionNoticeKey(s))
        if (r.id !== id) replace({ kind: 'calmconv', id: r.id })
      }
    } catch (e) {
      setErr((e as Error).message)
      throw e
    }
  }
  const suggestions = useMemo(() => urlsInMessages(messages, snap.config), [messages])
  const previewUrl = preview.url ?? (s ? guessPreviewUrl(messages, s, snap.projects.find((p) => p.id === s.projectId), snap.config) : '')

  return (
    <motion.div
      ref={page}
      className={split ? 'page calm split' : 'page calm'}
      {...pinch}
      initial={{ opacity: 0, scale: 0.985 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.985 }}
      transition={soft}
      drag="y"
      dragDirectionLock
      dragConstraints={{ top: 0, bottom: 0 }}
      dragElastic={{ top: 0, bottom: 0.6 }}
      dragSnapToOrigin
      onDragEnd={(_, info) => {
        if (info.offset.y > 140 || info.velocity.y > 700) back()
      }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="calm-top">
        <button className="ch" onClick={back} aria-label={t.back}>
          <Icon name="chevron" dir="left" />
        </button>
        <button className="ch" onClick={() => setMore((v) => !v)} aria-label={t.options} aria-expanded={more}>
          <Icon name="more" />
        </button>
      </div>
      <Collapse open={more}>
        {/* weevboss has no app of its own to show: the preview only exists for a session. */}
        {!main && (
          <div className="in inline-actions" style={{ paddingBottom: 6 }}>
            <button className="link inline" onClick={() => setPreview({ open: !preview.open })} aria-pressed={!!preview.open}>
              {preview.open ? t.closeApp : t.seeApp}
            </button>
          </div>
        )}
        <Settings userName={snap.config.userName} id={main ? '__main' : id} />
      </Collapse>
      <div className="page-cols">
        <div className="page-main">
          <div ref={body} className="page-body" data-scroll>
            {err && (
              <Notice eventId={noticeKey('error:calm', location.pathname, location.hash, err)} className="in meta" role="alert">
                ! {err}
              </Notice>
            )}
            <Messages plain={!main} messages={messages} author={author} working={!!working} />
            {working && <Working author={author} since={s?.workStartedAt} />}
            {question && <SessionQuestion session={question} onError={(e) => setErr(e || null)} />}
            {s?.status === 'interrupted' && <CutBand session={s} onError={(e) => setErr(e || null)} />}
            <div className="fill" />
          </div>
          <div className="page-float">
            <FollowDown show={follow.behind} urgent={s?.status === 'needs_user'} body={body} toEnd={follow.toEnd} />
          </div>
          <div className="page-foot">
            {sourceIssue && <div className="in meta" role="status">{sourceIssue}</div>}
            <Composer draftKey={`session:${main ? '__main' : id}`} placeholder={sourceIssue ? '' : t.writeTo(author)} label={t.messageTo(title)} onSend={send} onAttach={send} voice anyFile={main} disabled={!!sourceIssue || (!main && s ? !s.controllable : false)} />
          </div>
        </div>
        <SidePane
          side={preview.open ? <Preview session={s} project={snap.projects.find((p) => p.id === s?.projectId)} url={previewUrl} suggestions={suggestions} onUrl={(url) => setPreview({ url })} onClose={() => setPreview({ open: false })} /> : undefined}
          onGone={unsplit}
        />
      </div>
    </motion.div>
  )
}
