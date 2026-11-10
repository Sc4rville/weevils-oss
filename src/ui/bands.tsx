import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import type { Project } from '../../shared/api.ts'
import { api } from '../api'
import { tr, useT } from '../i18n'
import M from '../i18n/bands'
import D from '../i18n/devil'
import { prefetchRepo } from './pages'
import { ConvLine } from './convs'
import { THEMES, useApp } from './app-context'
import { ensurePush } from '../push'
import { VoiceLogo } from './voice'
import { useThreadAsk } from './askthread'
import { isUnread, useSeen } from './seen'
import { Appear, Collapse, Composer, INSTANT, Line, Messages, SessionRow, Working, authorTone, spring, useAuthors } from './bits'
import B from '../i18n/bits'
import { ago, plain, userText } from './format'
import { Icon } from './icons'
import { PrefLines } from './prefs'
import { useDevil } from './devil'
import { tapHint } from './hints'

const color = (slot: string) => ({ '--c': `var(--${slot})` }) as CSSProperties

/** Taille du nom selon l'état de la bande : ouverte = grosse, les autres = fines lanières. Rien ne passe derrière. */
const NAME_SIZE = { open: '3rem', normal: '2.125rem', mini: '1.375rem' } as const

/** « 2 travaillent », ou « 3 ouvertes » quand rien ne travaille. */
const activity = (list: { status: string }[]) => {
  const t = tr(M)
  const w = list.filter((s) => s.status === 'working').length
  return w ? t.working(w) : t.open(list.length)
}

// ---------------------------------------------------------------------------
// weevils, l'orchestrateur : la bande du haut est juste un chat. Lui écrit dans les sessions.

function useStickBottom(ref: React.RefObject<HTMLDivElement | null>, count: number, open: boolean) {
  // À l'ouverture : déjà en bas avant le premier affichage, sans défilement visible.
  useLayoutEffect(() => {
    const el = ref.current
    if (el && open) el.scrollTop = el.scrollHeight
  }, [ref, open])
  // Un nouveau message pendant qu'elle est ouverte : on descend en douceur.
  useEffect(() => {
    const el = ref.current
    if (!el || !open) return
    const t = setTimeout(() => el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }), 80)
    return () => clearTimeout(t)
  }, [ref, count]) // eslint-disable-line react-hooks/exhaustive-deps
}

/** L'aperçu vivant du fil, dans la bande réduite : les derniers messages, les récents en bas, les anciens remontent et s'estompent. */
/** Au plus près du bas (px) : l'aperçu suit les nouveaux messages ; plus haut, l'utilisateur remonte l'historique et on le laisse lire. */
const PEEK_STICK = 48

/**
 * L'aperçu vivant du fil, dans la bande réduite : les récents en bas, les anciens remontent et s'estompent.
 * Il défile au doigt pour remonter l'historique (sans entraîner la page) ; un tap simple ouvre la conversation.
 */
function Peek({ onOpen }: { onOpen: () => void }) {
  const t = useT(M)
  const tb = useT(B)
  const td = useT(D)
  const authorOf = useAuthors()
  const { snap } = useApp()
  const items = snap.main.filter((m) => m.role !== 'event' && m.text.trim()).slice(-60)
  const working = snap.mainWorking || !!snap.devil?.working
  const soft = { type: 'spring', stiffness: 160, damping: 26, mass: 1 } as const
  const box = useRef<HTMLDivElement>(null)
  const reading = useRef(false)
  const lastItem = items[items.length - 1]
  // Au montage : en bas, sans animation.
  useLayoutEffect(() => {
    const el = box.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])
  // Nouveau message, réponse qui s'allonge, étoile qui apparaît : on redescend, sauf si l'utilisateur remonte.
  useEffect(() => {
    const el = box.current
    if (!el || reading.current) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [items.length, lastItem?.id, lastItem?.text.length, working])
  return (
    <motion.div
      ref={box}
      layoutScroll
      className="peek"
      role="button"
      tabIndex={0}
      aria-label={t.openChat}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onOpen()}
      onScroll={(e) => {
        const el = e.currentTarget
        reading.current = el.scrollHeight - el.scrollTop - el.clientHeight > PEEK_STICK
      }}
    >
      <div className="peek-list">
        <AnimatePresence initial={false} mode="popLayout">
          {items.map((m) => {
            const tone = m.role === 'orchestrator' ? authorTone(authorOf(m.author)) : null
            const who = m.role === 'user' ? tb.you : m.role === 'orchestrator' ? authorOf(m.author).name : m.devil ? td.devil : 'weevboss'
            const text = (m.role === 'user' ? userText(m.text) : plain(m.text)).replace(/\s+/g, ' ')
            return (
              <motion.div
                key={m.id}
                layout="position"
                className={`peek-item ${m.role === 'user' ? '' : tone ? tone.className.replace('tone ', '') : m.devil ? 'devil' : 'base'}`}
                style={tone?.style}
                initial={{ opacity: 0, y: 18 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -18 }}
                transition={soft}
              >
                <div className="in">
                  <span className="txt">
                    <span className="strong">{who}</span> {text}
                  </span>
                </div>
              </motion.div>
            )
          })}
          {working && (
            <motion.div key="working" layout="position" className="peek-item" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={soft}>
              <div className="in">
                <span className="spin fluo" onClick={(e) => tapHint('star', e.currentTarget) && e.stopPropagation()}>
                  <Icon name="star" />
                </span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  )
}

export function AgentBand() {
  const t = useT(M)
  const { snap, expanded, setExpanded } = useApp()
  const open = expanded === 'agent'
  // Devil mode : réglé dans les préférences ; les messages vont à l'autre modèle, la bande passe en orange.
  const devilOn = useDevil(!!snap.devil?.enabled)
  const body = useRef<HTMLDivElement>(null)
  const form = useRef<HTMLFormElement>(null)
  const swipe = useRef<{ y: number; top: number } | null>(null)
  const [draft, setDraft] = useState({ text: '', n: 0, reset: false })
  const heard = useRef('')
  useStickBottom(body, snap.main.length, open)
  // Le fil ouvert s'interroge comme un fichier ; avec une sélection, le logo pose sa question dessus (réponse sur place).
  const th = useThreadAsk(snap.main, { title: 'weevboss', tool: 'weevboss' })
  const onSel = open && th.selected
  const mainReply = snap.main.filter((m) => m.role === 'assistant').at(-1)

  // Envoyer (clavier, logo vocal, pièce jointe) n'ouvre jamais le plein écran : le message et la réponse s'affichent dans l'aperçu.
  // Garanti par bands.test.tsx (déjà régressé deux fois).
  const send = async (text: string) => {
    if (devilOn) await api.devil(text)
    else await api.main(text)
  }
  const attach = async (text: string, files: { name: string; type: string; data: string }[]) => {
    await api.mainAttach(text, files)
  }

  return (
    <section className={`band agent tone ${devilOn ? 'devil-on' : ''} ${open ? 'open' : ''}`} style={color(devilOn ? 'devil' : 'agent')} aria-label={t.agentBand}>
      {/* En haut : le logo (dicter), sous la barre d'état. Réduite : l'aperçu vivant du fil ; un tap l'ouvre.
          Ouverte : un tap dans l'espace vide, le chevron, ou glisser vers le bas la réduit. */}
      <div className="agent-space" onClick={(e) => open && e.target === e.currentTarget && setExpanded(null)}>
        {open && (
          <button className="agent-close" onClick={() => setExpanded(null)} aria-label={t.collapseChat}>
            <Icon name="chevron" dir="down" />
          </button>
        )}
        <div className="agent-top">
          <VoiceLogo
            take={() => { if (onSel) return ''; const h = heard.current; heard.current = ''; setDraft((d) => ({ text: '', n: d.n + 1, reset: true })); return h }}
            onText={(x) => { if (onSel) return th.a.voiceText(x); heard.current = heard.current ? `${heard.current} ${x}` : x; setDraft((d) => ({ text: x, n: d.n + 1, reset: false })) }}
            onSend={() => (onSel ? th.a.voiceSend() : form.current?.requestSubmit())}
            replyKey={th.a.replyKey ?? mainReply?.id}
            replyText={th.a.replyKey ? th.a.shown : mainReply?.text}
            working={snap.mainWorking || th.a.waiting}
          />
        </div>
        {/* L'aperçu et le fil restent rendus : ouvrir ou fermer ne fait que les montrer ou les cacher (immédiat). */}
        <div className="peek-wrap" hidden={open}>
          <Peek onOpen={() => setExpanded('agent')} />
        </div>
      </div>
      <div id="agent-body" hidden={!open}>
        <motion.div
          ref={body}
          className="chat"
          aria-live="polite"
          onTouchStart={(e) => (swipe.current = { y: e.touches[0].clientY, top: body.current?.scrollTop ?? 0 })}
          onTouchEnd={(e) => {
            const s = swipe.current
            swipe.current = null
            // Tirer vers le bas depuis le haut du fil (déjà en haut) : réduit.
            if (s && s.top <= 0 && e.changedTouches[0].clientY - s.y > 90) setExpanded(null)
          }}
        >
          <div ref={th.ref} className="ask-thread">
            <Messages messages={snap.main} author="weevboss" working={snap.mainWorking || !!snap.devil?.working} after={th.after} />
          </div>
          {snap.mainWorking && <Working author="weevboss" />}
          {snap.devil?.working && <Working author="devil" />}
        </motion.div>
      </div>

      {/* Écrire ici n'ouvre pas la conversation : elle s'ouvre à l'envoi, pour lire la réponse. */}
      <Composer placeholder={t.agentPlaceholder} label={t.agentLabel} onSend={send} onAttach={attach} anyFile voice draft={draft} formRef={form} prompt={snap.mainWorking ? <span className="spin fluo"><Icon name="star" /></span> : <Icon name="chevron" dir="right" />} />
    </section>
  )
}

// ---------------------------------------------------------------------------
// Bande projet : nom fort, caractères-icônes, sessions. Elle s'ouvre, les autres se replient.

const COLLAPSED = 'weevils-collapsed'
function collapsedPrefs(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSED) ?? '{}') as Record<string, boolean>
  } catch {
    return {}
  }
}
function saveCollapsed(id: string, v: boolean) {
  try {
    localStorage.setItem(COLLAPSED, JSON.stringify({ ...collapsedPrefs(), [id]: v }))
  } catch {
    /* stockage indisponible */
  }
}

export function ProjectBand({ project }: { project: Project }) {
  const t = useT(M)
  const { snap, expanded, setExpanded, push, now, colors, setH24Open, instant } = useApp()
  const tx = instant ? INSTANT : spring
  const [showDone, setShowDone] = useState(false)
  const mode = expanded === null ? 'normal' : expanded === project.id ? 'open' : 'mini'
  const sessions = snap.sessions.filter((s) => s.projectId === project.id)
  const active = sessions.filter((s) => s.status !== 'done')
  const done = sessions.filter((s) => s.status === 'done')
  const att = active.filter((s) => s.status === 'needs_user')
  const jobs = snap.h24.filter((a) => a.projectId === project.id)
  const convCount = snap.conversationCounts.byProject[project.id] ?? 0
  const convs = snap.conversations.filter((c) => c.projectId === project.id)
  // Réduit ou déplié, au choix, mémorisé par projet ; par défaut réduit quand rien ne tourne.
  const [pref, setPref] = useState<boolean | undefined>(() => collapsedPrefs()[project.id])
  const collapsed = mode === 'normal' && (pref ?? active.length === 0)
  const remember = (v: boolean) => {
    setPref(v)
    saveCollapsed(project.id, v)
  }
  const toggle = () => {
    // Une autre bande est ouverte (le fil de weevboss en grand, un autre projet) : un tap saute directement ici.
    if (mode === 'mini') {
      for (const r of project.repos) prefetchRepo(r, project.where[r] ?? snap.machines[0]?.id ?? '')
      remember(false)
      setExpanded(project.id)
      return
    }
    if (mode === 'open') {
      setExpanded(null)
      remember(true)
      return
    }
    if (collapsed) {
      for (const r of project.repos) prefetchRepo(r, project.where[r] ?? snap.machines[0]?.id ?? '')
      remember(false)
      if (active.length === 0) setExpanded(project.id)
      return
    }
    remember(true)
  }
  // Réduit : une ligne, au format de la vue « mini » (nom, étoile verte, résumé).
  const shown = collapsed ? 'mini' : mode
  const doneOpen = showDone || (mode === 'open' && active.length === 0)

  const busy = active.some((s) => s.status === 'working')
  useSeen()
  const unread = sessions.some(isUnread)
  const summary = [
    active.length ? activity(active) : sessions.length ? t.nothingRunning : null,
    att.length ? t.yours(att.length) : null,
    convCount ? t.conversations(convCount) : null,
    // Sans activité connue (projet épinglé jamais lancé, horodatage 0) : rien, pas « il y a 20766 jours ».
    !active.length && project.lastActivityAt > 0 ? ago(now - project.lastActivityAt) : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <motion.section layout="position" transition={tx} className={`band ${busy ? 'busy' : ''}`} style={color(colors[project.id] ?? 'p0')} aria-label={t.projectBand(project.name)} data-project={project.id}>
      <motion.div className="in head" initial={false} animate={{ minHeight: shown === 'mini' ? 50 : 64, paddingTop: shown === 'mini' ? 0 : 8 }} transition={tx}>
        <button className="head-name" onClick={toggle} aria-expanded={mode === 'open'} aria-controls={`more-${project.id}`}>
          <motion.span className="name" initial={false} animate={{ fontSize: NAME_SIZE[shown] }} transition={tx}>
            {project.name}
            {unread && <span className="dot" aria-label={t.unread} />}
            {active.some((s) => s.status === 'working') && (
              <span aria-hidden onClick={(e) => tapHint('star', e.currentTarget) && e.stopPropagation()}>
                <span className="spin fluo"><Icon name="star" /></span>
              </span>
            )}
          </motion.span>
          <AnimatePresence initial={false}>
            {shown === 'mini' && (
              <motion.span key="s" className="meta" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={tx}>
                {summary}
              </motion.span>
            )}
          </AnimatePresence>
        </button>
        {shown !== 'mini' && (
          <div className="chars">
            {project.repos.length > 0 && (
              <button className="ch" aria-label={t.filesOf(project.name)} onClick={() => push({ kind: 'files', projectId: project.id })}>
                <Icon name="slash" />
              </button>
            )}
            <button className="ch" aria-label={t.machineOf(project.name)} onClick={() => push({ kind: 'machine', projectId: project.id })}>
              <Icon name="machine" />
            </button>
            <button
              className={`ch ${att.length ? '' : 'off'}`}
              disabled={!att.length}
              aria-label={att.length ? t.waiting(att.length) : t.nothingWaiting}
              onClick={(e) => tapHint('attention', e.currentTarget) || (att[0] && push({ kind: 'session', id: att[0].id }))}
            >
              <span>
                <Icon name="bang" />
                {att.length > 0 && <sup>{att.length}</sup>}
              </span>
            </button>
            {convCount > 0 && (
              <button className="ch" aria-label={t.conversationsOf(convCount, project.name)} onClick={() => push({ kind: 'conversations', projectId: project.id })}>
                <span>
                  <Icon name="quote" />
                  <sup>{convCount}</sup>
                </span>
              </button>
            )}
            {project.kind === 'repo' || project.repos.length > 0 ? (
              <button className="ch" aria-label={t.newSessionIn(project.name)} onClick={(e) => tapHint('newSession', e.currentTarget) || push({ kind: 'new', projectId: project.id })}>
                <Icon name="plus" />
              </button>
            ) : null}
          </div>
        )}
      </motion.div>

      <Collapse open={shown !== 'mini'} transition={tx}>
        <AnimatePresence initial={false}>
          {active.map((s) => (
            <Appear key={s.id}>
              <SessionRow session={s} />
            </Appear>
          ))}
        </AnimatePresence>
        {active.length === 0 && sessions.length > 0 && project.lastActivityAt > 0 && <div className="in meta empty">{t.idleSince(ago(now - project.lastActivityAt))}</div>}
        {sessions.length === 0 && mode === 'normal' && convs.slice(0, 3).map((c) => <ConvLine key={c.id} c={c} />)}
        {done.length > 0 && (
          <>
            <Line ch="✓" go={doneOpen ? '↑' : '↓'} onClick={() => setShowDone(!doneOpen)} label={t.done(done.length)}>
              <span className="meta">{t.done(done.length)}</span>
            </Line>
            <Collapse open={doneOpen}>
              {done.slice(0, 6).map((s) => (
                <SessionRow key={s.id} session={s} />
              ))}
            </Collapse>
          </>
        )}
        <div style={{ height: 12 }} />
      </Collapse>

      <Collapse open={mode === 'open'} id={`more-${project.id}`}>
        <div className="band tone">
          {convCount > 0 && <div className="in label">{t.conversationsLabel}</div>}
          {convs.slice(0, 4).map((c) => (
            <ConvLine key={c.id} c={c} />
          ))}
          {convCount > 4 && (
            <Line ch='"' onClick={() => push({ kind: 'conversations', projectId: project.id })}>
              <span className="meta">{t.allConversations(convCount)}</span>
            </Line>
          )}
          {project.repos.length > 0 && <div className="in label">{t.reposLabel}</div>}
          {project.repos.map((r) => (
            <Line key={r} ch="/" meta={project.where[r] ?? snap.machines[0]?.id ?? ''} onClick={() => push({ kind: 'files', projectId: project.id, repo: r })}>
              {r}
            </Line>
          ))}
          <div className="in label">{t.machinesLabel}</div>
          <Line ch="@" meta={t.openSessions(active.length)} onClick={() => push({ kind: 'machine', projectId: project.id })}>
            {[...new Set(sessions.map((s) => s.machineId))].join(' · ') || snap.machines[0]?.name}
          </Line>
          {jobs.length > 0 && <div className="in label">{t.h24Label}</div>}
          {jobs.map((a) => (
            <Line key={a.id} ch={a.runState === 'running' ? <span className="spin"><Icon name="star" /></span> : <Icon name="check" />} meta={a.runState === 'running' ? t.running : a.lastEvent} onClick={() => setH24Open(true)} go="↓">
              {a.title}
            </Line>
          ))}
          <div style={{ height: 14 }} />
        </div>
      </Collapse>
    </motion.section>
  )
}

// ---------------------------------------------------------------------------
// Bande de fin : réglages et état de la connexion. Elle remplit l'espace jusqu'au rail H24.


/** Notifications : abonnement Web Push (iPhone : seulement depuis l'app installée sur l'écran d'accueil). */
function NotifyLine() {
  const t = useT(M)
  const supported = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  const standalone = typeof window !== 'undefined' && (matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true)
  const ios = /iphone|ipad/i.test(navigator.userAgent)
  const [state, setState] = useState<'idle' | 'busy' | 'on' | 'error'>(supported && Notification.permission === 'granted' ? 'on' : 'idle')
  const [msg, setMsg] = useState<string | null>(null)
  // Un drapeau plutôt que le texte : « notification de test envoyée » suit un changement de langue.
  const [tested, setTested] = useState(false)
  const enable = async () => {
    setState('busy')
    setMsg(null)
    setTested(false)
    try {
      await ensurePush({ ask: true, test: true })
      setState('on')
      setTested(true)
    } catch (e) {
      setState('error')
      setMsg((e as Error).message)
    }
  }
  if (!supported || (ios && !standalone)) {
    return (
      <Line ch="!" go={null} disabled>
        {t.notifications}
      </Line>
    )
  }
  return (
    <Line ch="!" go={null} meta={msg ?? (tested ? t.testSent : state === 'on' ? t.notifyOn : t.notifyOff)} onClick={() => void enable()}>
      {t.notifications} {state === 'on' ? t.notifyOnSuffix : state === 'busy' ? '…' : ''}
    </Line>
  )
}

export function FootBand() {
  const t = useT(M)
  const { snap, theme, setTheme, offline, colors, logout, push } = useApp()
  return (
    <section className="band demo" style={color(colors.__foot ?? 'p3')} aria-label={t.settings}>
      <div className="in head">
        <h2 className="h2" style={{ margin: 0 }}>
          {t.machines}
        </h2>
        <span className="chars meta strong">{offline ? t.reconnecting : ''}</span>
      </div>
      {snap.machines.map((m) => (
        <Line key={m.id} ch="@" meta={m.online === false ? t.offline : t.online} onClick={() => push({ kind: 'machine', projectId: '' })}>
          {m.name}
        </Line>
      ))}
      <Line ch="+" onClick={() => push({ kind: 'new', projectId: '__any' })}>
        {t.newSessionElsewhere}
      </Line>
      <Line ch='"' meta={t.imported(snap.conversationCounts.total)} onClick={() => push({ kind: 'conversations' })}>
        {t.conversationsLabel}
      </Line>
      <Line ch="↑" onClick={() => push({ kind: 'import' })}>
        {t.importConversations}
      </Line>
      <NotifyLine />
      <Line ch="~" go={null} onClick={() => setTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length])}>
        {t.theme(theme)}
      </Line>
      <PrefLines />
      <Line ch="x" go={null} onClick={logout}>
        {t.logout}
      </Line>
    </section>
  )
}
