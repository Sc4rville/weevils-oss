import { motion } from 'motion/react'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type TouchEvent } from 'react'
import type { Message, SessionDetail } from '../../shared/api.ts'
import { api } from '../api'
import { useT } from '../i18n'
import M from '../i18n/calm'
import { useApp } from './app-context'
import { Collapse, Composer, Messages, Working, type Attachment } from './bits'
import { ago, plain } from './format'
import { Preview, guessPreviewUrl, urlsInMessages, usePreviewState } from './preview'
import { Settings } from './settings'
import { usePageChrome } from './shell'
import { markSeen } from './seen'
import { Icon } from './icons'
import { useViewHint } from './hints'

// Le mode conversation : pincer le fil → une grille de conversations, un tap → l'immersion. Rien d'autre que les messages.

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

function useStickToBottom(count: number, ref: React.RefObject<HTMLElement | null>) {
  const first = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (!el || count === 0) return
    const go = (smooth: boolean) => el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
    go(!first.current)
    const t = setTimeout(() => go(!first.current), 420)
    first.current = false
    return () => clearTimeout(t)
  }, [count, ref])
}

const color = (slot: string) => ({ '--c': `var(--${slot})` }) as CSSProperties

// ---------------------------------------------------------------------------
// La grille : l'orchestrateur en premier, puis les conversations actives, puis par activité.

export function CalmGrid() {
  const t = useT(M)
  const { snap, push, home, colors, now } = useApp()
  const page = useRef<HTMLDivElement>(null)
  usePageChrome('calm', page)
  const pinch = usePinch(home)
  useViewHint('calm')
  const rank = (s: { status: string }) => (s.status === 'needs_user' ? 0 : s.status === 'working' ? 1 : s.status === 'idle' ? 2 : 3)
  const sessions = useMemo(() => [...snap.sessions].sort((a, b) => rank(a) - rank(b) || b.lastActivityAt - a.lastActivityAt), [snap.sessions])
  const last = snap.main.filter((m) => m.role !== 'event').at(-1)
  const names = new Map(snap.projects.map((p) => [p.id, p.name]))

  return (
    <motion.div ref={page} className="page calm" {...pinch} initial={{ opacity: 0, scale: 0.985 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.985 }} transition={soft} role="dialog" aria-modal="true" aria-label={t.conversations}>
      <div className="calm-top">
        <button className="ch" onClick={home} aria-label={t.backToFeed}>
          <Icon name="chevron" dir="left" />
        </button>
      </div>
      <div className="page-body" data-scroll>
        <div className="calm-grid">
          <button className="calm-cell" style={color('agent')} onClick={() => push({ kind: 'calmconv', id: 'main' })}>
            <span className="calm-title">weevboss</span>
            <span className="meta">{snap.mainWorking ? t.working : last ? plain(last.text).split('\n')[0] : ''}</span>
          </button>
          {sessions.map((s) => (
            <button key={s.id} className="calm-cell" style={color(colors[s.projectId] ?? 'p0')} onClick={() => push({ kind: 'calmconv', id: s.id })}>
              <span className="calm-title">{s.title}</span>
              <span className="meta">
                {names.get(s.projectId) ?? s.projectId} · {s.status === 'working' ? (s.now ?? t.working) : s.status === 'needs_user' ? t.yourTurn : ago(now - s.lastActivityAt)}
                {s.background > 0 && <span className="strong"> · {t.background(s.background)}</span>}
              </span>
            </button>
          ))}
        </div>
        <div className="fill" />
      </div>
    </motion.div>
  )
}

// ---------------------------------------------------------------------------
// L'immersion : une couleur, les messages, le champ. Retour par la flèche, un pincement ou en tirant vers le bas.

export function CalmConv({ id }: { id: string }) {
  const t = useT(M)
  const { snap, back, home, replace } = useApp()
  const page = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  usePageChrome('calm', page)
  const pinch = usePinch(home)
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
  const settings = main ? snap.mainSettings : s?.settings
  const canCommand = main ? snap.mainHasScreen : !!s?.hasScreen
  useStickToBottom(messages.length, body)

  const send = async (text: string, files: Attachment[] = []) => {
    setErr(null)
    try {
      if (main) {
        if (files.length) await api.mainAttach(text, files)
        else await api.main(text)
      } else if (s) {
        const r = files.length ? await api.attach(s.id, text, files) : await api.send(s.id, text)
        if (r.id !== id) replace({ kind: 'calmconv', id: r.id })
      }
    } catch (e) {
      setErr((e as Error).message)
      throw e
    }
  }
  const run = (c: string) => (main ? api.mainCommand(c) : api.command(id, c))
  const suggestions = useMemo(() => urlsInMessages(messages, snap.config), [messages])
  const previewUrl = preview.url ?? (s ? guessPreviewUrl(messages, s, snap.projects.find((p) => p.id === s.projectId), snap.config) : '')

  return (
    <motion.div
      ref={page}
      className={preview.open ? 'page calm split' : 'page calm'}
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
        if (info.offset.y > 140 || info.velocity.y > 700) home()
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
        <div className="in inline-actions" style={{ paddingBottom: 6 }}>
          <button className="link inline" onClick={() => setPreview({ open: !preview.open })} aria-pressed={!!preview.open}>
            {t.browser}
          </button>
        </div>
        <Settings userName={snap.config.userName} id={main ? '__main' : id} tool={main ? 'claude' : (s?.tool ?? 'claude')} settings={settings} canCommand={canCommand} run={run} />
      </Collapse>
      <div className="page-cols">
        <div className="page-main">
          <div ref={body} className="page-body" data-scroll>
            {err && (
              <div className="in meta" role="alert">
                ! {err}
              </div>
            )}
            <Messages messages={messages} author={author} working={!!working} />
            {working && <Working author={author} since={s?.workStartedAt} />}
            <div className="fill" />
          </div>
          <div className="page-foot">
            <Composer placeholder={t.writeTo(author)} label={t.messageTo(title)} onSend={send} onAttach={send} voice anyFile={main} disabled={!main && s ? !s.controllable : false} />
          </div>
        </div>
        {preview.open && (
          <aside className="page-side">
            <Preview url={previewUrl} suggestions={suggestions} onUrl={(url) => setPreview({ url })} onClose={() => setPreview({ open: false })} />
          </aside>
        )}
      </div>
    </motion.div>
  )
}
