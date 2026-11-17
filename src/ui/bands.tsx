import { sourceAccessIssue } from './source-access'
import { selfProject, improvingProject } from './recursive-identity'
import { interceptModelControl, openModelControls } from '../model-controls'
import { effortLabel, modelLabel } from './settings'
import ModelM from '../i18n/model-controls'
import { OutboxStatus } from './outbox-status'
import { useOutbox } from '../outbox'
import { createPortal } from 'react-dom'
import { AnimatePresence, animate, motion, useMotionValue, type MotionValue } from 'motion/react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { Message, Project } from '../../shared/api.ts'
import type { Brick } from '../../shared/setup.ts'
import { api } from '../api'
import { tr, useT } from '../i18n'
import M from '../i18n/bands'
import RM from '../i18n/requests'
import D from '../i18n/devil'
import { prefetchRepo } from './pages'
import { THEMES, stableOrder, useApp, useSettled } from './app-context'
import { VoiceLogo } from './voice'
import { useThreadAsk } from './askthread'
import { isUnread, useSeen } from './seen'
import { Collapse, Composer, INSTANT, Line, Messages, SessionRow, Working, authorTone, spring, useAuthors } from './bits'
import B from '../i18n/bits'
import { plain, userText, type ChipId } from './format'
import { AutoMark, FilledIcon, G, Icon } from './icons'
import { KeepSessionOrder } from './session-order'
import PM from '../i18n/project-screen'
import { autoOfSession } from './auto-model'
import { ThreadPlans } from './relay'
import { LanguageLine } from './prefs'
import { UsageLine } from './infra'
import { TokenMeter } from './rate'
import { setDevil, useDevil } from './devil'
import { markSeen, tapHint } from './hints'
import { flash, keepInPlace, reveal, useFollow } from './follow'
import { mergePending, type Pending } from './pending'
import { Chip, KeyChip, SetupChips, SetupComposer, askSetup, flowVoice, useFlow, useWelcome } from './setup'
import { ForYouPeek, TopWords, useTop, type Top } from './foryou-top'
import { SleepButton } from './night'

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

/** L'aperçu vivant du fil, dans la bande réduite : les derniers messages, les récents en bas, les anciens remontent et s'estompent. */
/** Au plus près du bas (px) : l'aperçu suit les nouveaux messages ; plus haut, l'utilisateur remonte l'historique et on le laisse lire. */
const PEEK_STICK = 48
/** Le dernier message de l'aperçu montre sa fin (la réponse qui s'écrit), pas son début coupé : au plus tant de caractères. */
const PEEK_TAIL = 280

/**
 * L'aperçu vivant du fil, dans la bande réduite : les récents en bas, les anciens remontent et s'estompent.
 * Il défile au doigt pour remonter l'historique (sans entraîner la page) ; un tap simple ouvre la conversation.
 */
function Peek({ onOpen, visible, sent, messages, pendingLabel }: { onOpen: () => void; visible: boolean; sent: number; messages: Message[]; pendingLabel: (id: string) => string }) {
  const t = useT(M)
  const tb = useT(B)
  const td = useT(D)
  const authorOf = useAuthors()
  const { snap } = useApp()
  const items = messages.filter((m) => m.role !== 'event' && m.text.trim()).slice(-60)
  const working = snap.mainWorking || !!snap.devil?.working
  const soft = { type: 'spring', stiffness: 160, damping: 26, mass: 1 } as const
  const box = useRef<HTMLDivElement>(null)
  // Suit la fin de l'aperçu (nouveau message, réponse qui s'écrit, étoile) ; remonter au doigt pour relire décroche.
  const last = items.at(-1)
  const follow = useFollow(box, visible, PEEK_STICK, `${items.length}:${last?.id}:${last?.text.length}:${working}`)
  // Un envoi : on redescend, même si on relisait plus haut, pour voir partir le message et arriver la réponse.
  useEffect(() => {
    if (sent) follow.toEnd()
  }, [sent]) // eslint-disable-line react-hooks/exhaustive-deps
  // A dictated message may arrive via the voice endpoint / another device rather than this form.
  // It must release a preview left in reading mode, just like a local submit does.
  const lastUser = items.filter((m) => m.role === 'user').at(-1)?.id
  const previousUser = useRef(lastUser)
  useEffect(() => {
    if (visible && lastUser && lastUser !== previousUser.current) follow.toEnd()
    previousUser.current = lastUser
  }, [lastUser, visible]) // eslint-disable-line react-hooks/exhaustive-deps
  // La bulle « envoi… » remplacée par le vrai message : l'une s'efface sans animation et l'autre prend sa place sans entrer,
  // sinon la sortie de l'une (retirée du flux, popLayout) se dessine par-dessus la réponse qui arrive.
  const isPending = (m: Message) => m.id.startsWith('pending-')
  const prev = useRef<{ ids: Set<string>; pending: Message[] }>({ ids: new Set(), pending: [] })
  const taken = new Set(
    items
      .filter((m) => m.role === 'user' && !isPending(m) && !prev.current.ids.has(m.id))
      .filter((m) => prev.current.pending.some((p) => !items.includes(p) && userText(m.text).startsWith(userText(p.text).slice(0, 40))))
      .map((m) => m.id),
  )
  useEffect(() => {
    prev.current = { ids: new Set(items.map((m) => m.id)), pending: items.filter(isPending) }
  })
  return (
    <>
    <motion.div
      ref={box}
      layoutScroll
      className="peek"
      role="button"
      tabIndex={0}
      aria-label={t.openChat}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onOpen()}
    >
      <div className="peek-list">
        <AnimatePresence initial={false} mode="popLayout">
          {items.map((m) => {
            const tone = m.role === 'orchestrator' ? authorTone(authorOf(m.author)) : null
            const who = `${m.role === 'user' ? tb.you : m.role === 'orchestrator' ? authorOf(m.author).name : m.devil ? td.devil : 'weevboss'}${m.id.startsWith('pending-') ? ` · ${pendingLabel(m.id)}` : ''}`
            const full = (m.role === 'user' ? userText(m.text) : plain(m.text)).replace(/\s+/g, ' ')
            // Le dernier : sa fin, entière (la réponse qui s'écrit reste lisible, en bas, là où l'aperçu la suit).
            const isLast = m.id === last?.id
            const text = isLast && full.length > PEEK_TAIL ? `… ${full.slice(-PEEK_TAIL).replace(/^\S*\s/, '')}` : full
            return (
              <motion.div
                key={m.id}
                layout="position"
                className={`peek-item ${m.role === 'user' ? '' : tone ? tone.className.replace('tone ', '') : m.devil ? 'devil' : 'base'} ${isLast ? 'last' : ''}`}
                style={tone?.style}
                initial={taken.has(m.id) ? false : { opacity: 0, y: 18 }}
                animate={{ opacity: 1, y: 0 }}
                exit={isPending(m) ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: -18 }}
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
    {visible && follow.behind && <button type="button" className="peek-behind" aria-label={t.toEnd} onClick={() => follow.toEnd()}><Icon name="arrow" dir="down" /></button>}
    </>
  )
}

/** La barre de questions et sa réponse, sous un message du fil ouvert : amenées sous les yeux quand elles apparaissent
 * ou changent d'état (question posée, réponse qui commence, puis finie) ; mises en avant la première fois seulement. */
function QaInView({ k, children }: { k: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  const first = useRef(true)
  useEffect(() => {
    const el = box.current?.firstElementChild
    if (!el) return
    const f = first.current
    first.current = false
    requestAnimationFrame(() => reveal(el, { block: 'nearest', flash: f }))
  }, [k])
  return (
    <div ref={box} className="qa-in-view">
      {children}
    </div>
  )
}
const qa = (node: ReactNode, k: string) => (node ? <QaInView k={k}>{node}</QaInView> : null)

export function AgentBand() {
  const t = useT(M)
  const td = useT(D)
  const { snap, expanded, setExpanded, push } = useApp()
  const open = expanded === 'agent'
  // « weevboss · pour toi » : ce que montre l'aperçu de la bande réduite, mémorisé sur l'appareil. Sans flux côté
  // serveur (snap.foryou absent), c'est toujours weevboss et les mots n'existent pas.
  const [top, setTop] = useTop()
  const pickTop = (x: Top) => {
    // Fil ouvert, ou « pour toi » déjà choisi : le mot ouvre le flux en plein écran (le fil reste tel quel dessous).
    if (x === 'foryou' && (open || top === 'foryou')) return push({ kind: 'foryou' })
    if (!open) setTop(x)
  }
  // Devil mode : le diablotin, toujours là à droite du logo. Branché, un tap bascule (bande orange, réponses en vert,
  // même fil) ; pas branché, un tap demande à weevboss de proposer le branchement, dans son fil.
  const devilOn = useDevil(!!snap.devil?.enabled)
  const flow = useFlow()
  useWelcome()
  const tapDevil = (el: Element) => {
    if (!snap.devil?.enabled) {
      void askSetup('devil')
      return
    }
    if (tapHint('devil', el)) return
    setDevil(!devilOn)
  }
  const body = useRef<HTMLDivElement>(null)
  const form = useRef<HTMLFormElement>(null)
  const [draft, setDraft] = useState({ text: '', n: 0, reset: false })
  const heard = useRef('')
  // Le message envoyé s'affiche tout de suite (aperçu et fil), avant que Claude Code l'écrive dans son transcript (qui
  // peut attendre la fin de la réponse en cours) : une bulle « envoi… », remplacée par la vraie quand elle arrive.
  const [pending, setPending] = useState<Pending[]>([])
  const main = useMemo(() => mergePending(snap.main, pending), [snap.main, pending])
  useEffect(() => {
    // Arrivées (ou perdues depuis longtemps) : on les oublie. Une bulle reçue par weevboss reste jusqu'à son transcript
    // (Claude Code n'y écrit un message glissé en plein tour qu'en le lisant) : elle ne disparaît pas au bout de 15 min.
    setPending((p) => {
      const left = new Set(mergePending(snap.main, p).map((m) => m.id))
      const next = p.filter((x) => left.has(x.id) && Date.now() - x.at < (x.accepted ? 24 * 3600_000 : 15 * 60_000))
      return next.length === p.length ? p : next
    })
  }, [snap.main])
  // Chaque bulle suit son reçu (src/outbox.ts) : « envoi… » tant que le serveur ne l'a pas, « en attente » tant qu'il ne
  // l'a pas mise dans la pane, puis « reçu », ou « en file » si weevboss travaille. Jamais « envoi… » pour un message reçu.
  const receipts = useOutbox()
  const pendingLabel = (id: string) => {
    const p = pending.find((x) => x.id === id)
    if (!p?.accepted) return t.sending
    const status = p.messageId ? (receipts.find((r) => r.messageId === p.messageId)?.status ?? 'accepted') : 'delivered'
    if (status !== 'delivered') return t.queued
    return snap.mainWorking || snap.mainQueued > 0 ? t.readsSoon : t.received
  }
  const tail = main.at(-1)
  // Le fil ouvert s'interroge comme un fichier ; avec une sélection, le logo pose sa question dessus (réponse sur place).
  const th = useThreadAsk(main, { title: 'weevboss', tool: 'weevboss' })
  const onSel = open && th.selected
  // Un mot sélectionné et sa réponse, sous un message : le suivi ne les pousse pas hors de l'écran.
  const chat = useFollow(body, open, 80, `${main.length}:${tail?.id}:${tail?.text.length}:${snap.mainWorking}:${!!snap.devil?.working}`, open && th.hold)
  // Chaque envoi (clavier, logo, pièce jointe) : l'aperçu et le fil redescendent pour montrer le message et sa réponse.
  const [sent, setSent] = useState(0)
  const mainReply = snap.main.filter((m) => m.role === 'assistant').at(-1)

  // Envoyer (clavier, logo vocal, pièce jointe) n'ouvre jamais le plein écran : le message et la réponse s'affichent dans l'aperçu.
  // Garanti par bands.test.tsx (déjà régressé deux fois).
  // La bulle et le glissé partent au tap, pas au retour du serveur ; un échec retire la bulle (le champ rend le texte).
  const sending = async (text: string, shown: string, go: () => Promise<unknown>) => {
    const tmp: Pending = { id: `pending-${Date.now()}`, role: 'user', text: shown, at: Date.now(), typed: text, after: snap.main.at(-1)?.id, known: snap.main.filter((m) => m.role === 'user' || m.role === 'orchestrator').map((m) => m.id), ...(devilOn ? { devil: true } : {}) }
    setPending((p) => [...p, tmp])
    setSent((n) => n + 1)
    // Le champ écrit toujours à weevboss : envoyé depuis « pour toi », l'aperçu revient sur son fil, où la bulle et la
    // réponse se voient. Jamais setExpanded('agent').
    if (top === 'foryou') setTop('boss')
    if (open) chat.toEnd()
    try {
      const r = (await go()) as { delivery?: { messageId?: string } } | undefined
      const messageId = r?.delivery?.messageId
      setPending((p) => p.map((x) => (x.id === tmp.id ? { ...x, accepted: true, ...(messageId ? { messageId } : {}) } : x)))
    } catch (e) {
      setPending((p) => p.filter((x) => x.id !== tmp.id))
      throw e
    }
  }
  const send = (text: string) => interceptModelControl('__main',text) ? Promise.resolve() : sending(text, text, () => (devilOn ? api.devil(text) : api.main(text)))
  const attach = (text: string, files: { name: string; type: string; data: string }[]) =>
    sending(text, `${text ? `${text} ` : ''}${t.withFiles(files.length)}`, () => api.mainAttach(text, files))
  // Les puces de branchement d'un message de weevboss ([[setup:x]]) : un bouton à leur place dans la phrase, sur le
  // dernier message qui les porte seulement (les anciens gardent le libellé, lisible, sans boutons qui doublonnent).
  // Le QR du téléphone, retiré du texte, s'affiche sous le message.
  const lastWith = new Map<string, string>()
  for (const m of main) for (const c of m.chips ?? []) lastWith.set(c, m.id)
  const chipsOf = (id: string) => {
    const m = main.find((x) => x.id === id)
    const list = (m?.chips ?? []).filter((c) => lastWith.get(c) === id && !m?.text.includes(`[[setup:${c}]]`))
    return list.length ? <SetupChips chips={list} /> : null
  }
  // Un secret demandé ([[setup:key:NOM]]) : toujours un bouton (le recoller remplace l'ancienne valeur).
  const chipIn = (b: ChipId, id: string) => (b.startsWith('key:') ? <KeyChip name={b.slice(4)} /> : lastWith.get(b) === id ? <Chip brick={b as Brick} inline /> : null)

  const devilButton = (
    <button className={`devil-btn ${devilOn ? 'on' : ''}`} onClick={(e) => tapDevil(e.currentTarget)} aria-pressed={devilOn} aria-label={devilOn ? td.on : td.off}>
      <FilledIcon name="devil" />
    </button>
  )

  // With the main controls: sleep mode (one tap before bed), then the devil.
  const controls = (
    <span className="agent-ctrls">
      <SleepButton />
      {devilButton}
    </span>
  )

  const dr = useBossDrawer(open, () => setExpanded('agent'), () => setExpanded(null))
  const band = (
    <motion.section ref={dr.box} className={`band agent tone ${snap.foryou ? 'has-foryou' : ''} ${devilOn ? 'devil-on' : ''} ${open || dr.shown ? 'open' : ''}`} style={{ ...color(devilOn ? 'devil' : 'agent'), y: dr.y }} aria-label={t.agentBand}>
      {/* En haut : le logo (dicter), sous la barre d'état. Réduite : l'aperçu vivant du fil ; un tap l'ouvre.
          Ouverte : un tap dans l'espace vide, le chevron, ou glisser vers le bas la réduit. */}
      <div className="agent-space" onClick={(e) => open && e.target === e.currentTarget && dr.close()}>
        {open && (
          <button className="agent-close" onClick={() => dr.close()} aria-label={t.collapseChat}>
            <Icon name="chevron" dir="left" />
          </button>
        )}
        <TokenMeter />
        <div className="agent-top">
          {/* Pendant un branchement, la dictée va dans le champ du parcours (src/ui/setup.tsx), et le 3e tap y répond. */}
          <VoiceLogo
            recordingScope="weevboss"
            take={() => { if (onSel || flow) return ''; const h = heard.current; heard.current = ''; setDraft((d) => ({ text: '', n: d.n + 1, reset: true })); return h }}
            onText={(x) => { if (onSel) return th.a.voiceText(x); if (flow) return flowVoice.add(x); heard.current = heard.current ? `${heard.current} ${x}` : x; setDraft((d) => ({ text: x, n: d.n + 1, reset: false })) }}
            onSend={() => (onSel ? th.a.voiceSend() : flow ? flowVoice.send() : form.current?.requestSubmit())}
            replyKey={th.a.replyKey ?? mainReply?.id}
            replyText={th.a.replyKey ? th.a.shown : mainReply?.text}
            working={snap.mainWorking || th.a.waiting}
          />
          {!snap.foryou && controls}
        </div>
        {/* L'aperçu et le fil restent rendus : ouvrir ou fermer ne fait que les montrer ou les cacher (immédiat). */}
        {/* Les deux mots, sous la ligne du logo ; ils restent quand le fil est ouvert (weevboss y est le mot actif). */}
        <div className="agent-nav">
          <TopWords active={open ? 'boss' : top} onPick={pickTop} />
          {snap.foryou && !open && controls}
        </div>
        <div className="peek-wrap" hidden={open || dr.shown || top !== 'boss'}>
          <Peek onOpen={() => setExpanded('agent')} visible={!open && top === 'boss'} sent={sent} messages={main} pendingLabel={pendingLabel} />
        </div>
        {/* L'aperçu de « pour toi » : à côté de celui du fil, dans la même boîte ; l'un ou l'autre est caché, aucun démonté. */}
        {snap.foryou && (
          <div className="fyt-wrap" hidden={open || dr.shown || top !== 'foryou'}>
            <ForYouPeek />
          </div>
        )}
      </div>
      <div id="agent-body" hidden={!(open || dr.shown)}>
        <div className="in agent-model"><MainModelControl model={snap.mainSettings?.model} effort={snap.mainSettings?.effort}/></div>
        <motion.div
          ref={body}
          className="chat"
          aria-live="polite"
        >
          <div ref={th.ref} className="ask-thread">
            <Messages messages={main} author="weevboss" working={snap.mainWorking || !!snap.devil?.working} pendingLabel={pendingLabel} after={(id) => <>{qa(th.after(id), `${th.a.asking}:${!!th.a.shown}:${th.a.waiting}`)}{chipsOf(id)}</>} chip={chipIn} />
          </div>
          <ThreadPlans />
          <OutboxStatus scope="/api/main" />
          {snap.mainWorking && <Working author="weevboss" />}
          {snap.devil?.working && <Working author="devil" />}
        </motion.div>
        {/* Du nouveau en bas pendant qu'on relit plus haut : un « ↓ » flottant y redescend en douceur. */}
        <AnimatePresence>
          {open && chat.behind && (
            <motion.button
              key="behind"
              type="button"
              className="agent-behind"
              aria-label={t.toEnd}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.16 }}
              onClick={() => {
                chat.toEnd()
                window.setTimeout(() => flash([...(body.current?.querySelectorAll('[data-mid]') ?? [])].at(-1)), 450)
              }}
            >
              <Icon name="arrow" dir="down" />
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      {/* Écrire ici n'ouvre pas la conversation : elle s'ouvre à l'envoi, pour lire la réponse. Pendant un branchement,
          le champ pose les questions du parcours, une à la fois (src/ui/setup.tsx). */}
      {/* The handle, about a centimetre above the field (Yann, 2026-11-17): pull it down to open, push it up to close, or
          tap it. Under the field it sat on the keyboard's toolbar and the home indicator, where closing failed. */}
      <div className="agent-grip" onPointerDown={dr.grab} aria-hidden><span /></div>
      {flow ? <SetupComposer /> : <Composer placeholder={t.agentPlaceholder} label={t.agentLabel} onSend={send} onAttach={attach} anyFile voice sayErrors horizontal captureSuggestions draft={draft} formRef={form} prompt={snap.mainWorking ? <span className="spin fluo"><Icon name="star" /></span> : <Icon name="chevron" dir="right" />} />}
    </motion.section>
  )
  // Escape the draggable home stack: its transform makes fixed descendants smaller than the viewport. While it is
  // pulled or springs back, a spacer keeps the closed band's height so nothing below moves.
  if (open || dr.shown) return <>{dr.shown && !open && <div style={{ height: dr.spacer }} />}{createPortal(band, document.body)}</>
  return band
}

/**
 * weevboss is a real drawer coming down from the top, the automations drawer mirrored (Yann, 2026-11-17): the whole
 * open conversation hangs above the screen with only its bottom edge showing where the band was; its handle at the bottom
 * follows the finger 1:1 and the release springs it open or closed with the automations spring. Nothing scrolls during
 * the pull. A tap on the handle opens or closes it too.
 */
function useBossDrawer(open: boolean, onOpen: () => void, onClose: () => void) {
  const box = useRef<HTMLElement>(null)
  const y = useMotionValue(0)
  const [shown, setShown] = useState(false)
  const [spacer, setSpacer] = useState(0)
  const closedOff = useRef(0)
  const anim = useRef<{ stop: () => void } | null>(null)
  const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches
  const H = () => window.visualViewport?.height ?? window.innerHeight
  const go = (to: number, done?: () => void) => {
    anim.current?.stop()
    if (still()) { y.set(to); done?.(); return }
    anim.current = animate(y, to, { ...spring, onComplete: done })
  }
  // The offset where the open drawer shows only the strip the closed band covered.
  const measure = () => {
    const r = box.current?.getBoundingClientRect()
    if (r && !open) {
      closedOff.current = -(H() - Math.max(0, r.bottom))
      setSpacer(r.height)
    }
  }
  const finishClose = () => { setShown(false); y.set(0) }
  const openIt = () => { onOpen(); go(0, () => setShown(false)) }
  const closeIt = () => {
    setShown(true)
    onClose()
    go(closedOff.current || -H(), finishClose)
  }
  // Opened elsewhere (a link, a notification): it comes down from the same place.
  const wasOpen = useRef(open)
  useLayoutEffect(() => {
    if (open && !wasOpen.current && !shown) { y.set(closedOff.current || -H()); go(0) }
    wasOpen.current = open
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { if (!open && !shown) measure() })
  const grab = (e: ReactPointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    // Listened on the window: the band moves into its portal as the pull starts, which replaces the handle element.
    const el = window
    const id = e.pointerId
    anim.current?.stop()
    if (!open && !shown) measure()
    const startOff = open ? y.get() : closedOff.current
    const y0 = e.clientY
    let moved = false
    let last = { y: e.clientY, t: performance.now() }
    let v = 0
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return
      const d = ev.clientY - y0
      if (!moved && Math.abs(d) < 6) return
      // Pushing it up shows the real home screen behind it, as the automations drawer does: the open state is let go
      // as the drag starts (the drawer stays drawn until it lands), and taken back if it is released open.
      if (!moved) { moved = true; setShown(true); if (open) onClose() }
      const t = performance.now()
      v = (ev.clientY - last.y) / Math.max(1, t - last.t) * 1000
      last = { y: ev.clientY, t }
      const raw = startOff + d
      y.set(raw > 0 ? raw * 0.15 : raw < closedOff.current ? closedOff.current + (raw - closedOff.current) * 0.2 : raw)
    }
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      // The click that follows lands on whatever the drawer just moved under the finger: swallowed.
      const at = { x: ev.clientX, y: ev.clientY }
      const swallow = (c: MouseEvent) => {
        if (Math.abs(c.clientX - at.x) > 40 || Math.abs(c.clientY - at.y) > 40) return
        window.removeEventListener('click', swallow, { capture: true })
        c.stopPropagation()
        c.preventDefault()
      }
      window.addEventListener('click', swallow, { capture: true })
      window.setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 450)
      if (!moved) return open ? closeIt() : (setShown(true), y.set(closedOff.current), openIt())
      const next = v > 300 ? true : v < -300 ? false : y.get() > closedOff.current / 2
      if (next) openIt()
      else go(closedOff.current, finishClose)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }
  return { box, y: y as MotionValue<number>, shown, spacer, grab, close: closeIt }
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

/** Une ligne de session dans sa bande : apparaît comme Appear (bits.tsx) et glisse quand elle change de place. */
function RowSlot({ children }: { children: ReactNode }) {
  return (
    <motion.div layout="position" className="clip" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={spring}>
      {children}
    </motion.div>
  )
}

// Actual work first; requests keep their priority over idle and relay sessions.
const sessionRank = (s: { status: string }) => s.status === 'working' ? 0 : s.status === 'needs_user' || s.status === 'interrupted' ? 1 : 2

export function ProjectBand({ project }: { project: Project }) {
  const settled = useSettled()
  const t = useT(M)
  const pt = useT(PM)
  const { snap, expanded, setExpanded, push, colors, instant } = useApp()
  const tx = instant ? INSTANT : spring
  const mode = expanded === null ? 'normal' : expanded === project.id ? 'open' : 'mini'
  const sessions = snap.sessions.filter((s) => !s.archived && s.projectId === project.id)
  // Une ligne ne change pas de place parce qu'une autre session écrit (le serveur les range par activité) : ce qui
  // travaille en tête, puis l'ordre déjà affiché, une nouvelle session en tête des siennes. Rien ne bouge sous le doigt.
  const shownRows = useRef<string[]>([])
  const active = stableOrder(sessions.filter((s) => s.status !== 'done'), (s) => s.id, sessionRank, (a, b) => b.openedAt - a.openedAt, shownRows.current, !settled)
  const rowKey = active.map((s) => s.id).join('|')
  useLayoutEffect(() => {
    shownRows.current = rowKey ? rowKey.split('|') : []
  }, [rowKey])
  const att = active.filter((s) => s.status === 'needs_user')
  const cut = active.filter((s) => s.status === 'interrupted')
  const convCount = snap.conversationCounts.byProject[project.id] ?? 0
  // Réduit ou déplié, au choix, mémorisé par projet ; par défaut réduit quand rien ne tourne.
  const [pref, setPref] = useState<boolean | undefined>(() => collapsedPrefs()[project.id])
  const collapsed = mode === 'normal' && (pref ?? active.length === 0)
  const remember = (v: boolean) => {
    setPref(v)
    saveCollapsed(project.id, v)
  }
  // Un tap sur le nom : la bande reste sous le doigt pendant que les autres se replient ou se déplient autour
  // (keepInPlace) ; ce qui s'ouvre sous le bas de l'écran y est amené ; si elle a dû bouger malgré tout (haut du flux,
  // fil de weevboss qui se referme d'un coup), elle s'éclaire un instant.
  const sec = useRef<HTMLElement>(null)
  const head = useRef<HTMLDivElement>(null)
  const pin = useRef<{ fix: () => void; top: number; grow: boolean; at: number } | null>(null)
  const toggle = () => {
    markSeen('g-fold')
    const grow = mode === 'mini' || (mode === 'normal' && collapsed)
    pin.current = { fix: keepInPlace(head.current, 480), top: head.current?.getBoundingClientRect().top ?? 0, grow, at: Date.now() }
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
  useLayoutEffect(() => {
    const p = pin.current
    pin.current = null
    if (!p || Date.now() - p.at > 400) return
    p.fix() // avant l'affichage : une bascule instantanée ne se voit pas
    const timer = window.setTimeout(() => {
      const h = head.current
      const s = sec.current
      if (!h || !s) return
      if (Math.abs(h.getBoundingClientRect().top - p.top) > 24) flash(h)
      if (p.grow) reveal(s, { block: s.offsetHeight > window.innerHeight * 0.8 ? 'start' : 'nearest', flash: false })
    }, 500)
    return () => clearTimeout(timer)
  }, [mode, collapsed])
  // Réduit : une ligne, au format de la vue « mini » (nom, étoile verte, résumé).
  const shown = collapsed ? 'mini' : mode

  const recursive = selfProject(project)
  const improving = improvingProject(project, sessions)
  const busy = active.some((s) => s.status === 'working')
  useSeen()
  const unread = sessions.some(isUnread)
  const summary = [
    improving ? t.improvingWeevils : active.length > cut.length ? activity(active.filter((s) => s.status !== 'interrupted')) : null,
    att.length ? t.yours(att.length) : null,
    convCount ? t.conversations(convCount) : null,
    // A resting project says nothing: no « nothing running », no « 1 day ago » (Yann, 2026-11-16).
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <motion.section ref={sec} layout="position" transition={tx} className={`band ${recursive ? 'recursive-identity' : ''} ${improving ? 'recursive-active' : ''} ${busy ? 'busy' : ''} ${cut.length ? 'has-cut' : ''}`} style={color(colors[project.id] ?? 'p0')} aria-label={t.projectBand(project.name)} data-project={project.id}>
      <KeepSessionOrder order={rowKey} within={sec} />
      <motion.div ref={head} className="in head" initial={false} animate={{ minHeight: shown === 'mini' ? 50 : 64, paddingTop: shown === 'mini' ? 0 : 8 }} transition={tx}>
        <button className="head-name" onClick={toggle} aria-expanded={mode === 'open'} aria-controls={`more-${project.id}`}>
          <motion.span className="name" title={improving ? t.improvingWeevils : undefined} initial={false} animate={{ fontSize: NAME_SIZE[shown] }} transition={tx}>
            {project.name}
            {unread && <span className="dot" aria-label={t.unread} />}
            {/* One sign by the name: the green star when one of yours works, else AutoMark when only automations do. */}
            {active.some((s) => s.status === 'working' && !autoOfSession(snap, s.id)) ? (
              <span aria-hidden onClick={(e) => tapHint('star', e.currentTarget) && e.stopPropagation()}>
                <span className="spin fluo"><Icon name="star" /></span>
              </span>
            ) : (
              active.some((s) => s.status === 'working') && <AutoMark />
            )}
          </motion.span>
          <AnimatePresence initial={false}>
            {shown === 'mini' && (
              <motion.span key="s" className="meta" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={tx}>
                {cut.length > 0 && <span className="alert-pill">× {t.cut(cut.length)}</span>}
                {cut.length > 0 && summary ? ' ' : ''}
                {summary}
              </motion.span>
            )}
          </AnimatePresence>
        </button>
        {/* Next to the name: nothing, unless a session was cut and needs a restart (Yann, 2026-11-16: the era of the big clean-up). */}
        {shown !== 'mini' && (
          <div className="chars">
            {project.repos.length > 0 && (
              <button className="ch" aria-label={t.filesOf(project.name)} onClick={() => push({ kind: 'files', projectId: project.id })}>
                <Icon name="slash" />
              </button>
            )}
            {/* The project's page: what runs now, its to-do, its sessions (Yann, 2026-11-17). */}
            <button className="ch" aria-label={pt.openAria(project.name)} onClick={() => push({ kind: 'project', projectId: project.id })}>
              <G c=">" />
            </button>
            {cut.length > 0 && (
            <button className="ch alert-ch" aria-label={t.cutAria(cut.length)} onClick={() => push({ kind: 'session', id: cut[0].id })}>
              <span>
                <G c="×" />
                <sup>{cut.length}</sup>
              </span>
            </button>
            )}
          </div>
        )}
      </motion.div>

      <Collapse open={shown !== 'mini'} transition={tx}>
        {sourceAccessIssue(project) && <div className="in meta" role="status">{sourceAccessIssue(project)}</div>}
        <AnimatePresence initial={false}>
          {active.map((s) => (
            <RowSlot key={s.id}>
              <SessionRow session={s} />
            </RowSlot>
          ))}
        </AnimatePresence>
        {/* Finished sessions are not listed on the home screen (Yann, 2026-11-17): the conversations page keeps them. */}
        <div style={{ height: 12 }} />
      </Collapse>

    </motion.section>
  )
}

// ---------------------------------------------------------------------------
// Bande de fin : réglages et état de la connexion. Elle remplit l'espace jusqu'au rail H24.


/** Only what matters: offline for one machine, how many are online for several. */
function machinesMeta(machines: { online?: boolean }[]) {
  const t = tr(M)
  const on = machines.filter((m) => m.online !== false).length
  if (machines.length === 1) return on ? undefined : t.offline
  return t.onlineOf(on, machines.length)
}

export function FootBand() {
  const t = useT(M)
  const { snap, theme, setTheme, offline, colors, logout, push } = useApp()
  // The relay writes « until 6 pm » in this device's time zone (the Codex relay row moved to the subscriptions page).
  useEffect(() => {
    try {
      void api.relaySet({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone }).catch(() => undefined)
    } catch {
      /* no time zone: the server's */
    }
  }, [])
  // Four sections, language and log out (Yann, 2026-11-17): everything else lives where it is used — notifications, the phone and
  // old conversations through weevboss's chips, memory through weevboss, finished sessions on their project's page.
  return (
    <section className="band demo settings-band" style={color(colors.__foot ?? 'p3')} aria-label={t.settings}>
      <div className="in head">
        <h2 className="h2" style={{ margin: 0 }}>
          {t.settings}
        </h2>
        <span className="chars meta strong">{offline ? t.reconnecting : ''}</span>
      </div>
      {snap.machines.length > 0 && (
        <Line ch="@" value={snap.machines.length === 1 ? (snap.machines[0].online === false ? `${snap.machines[0].name} · ${t.offline}` : snap.machines[0].name) : machinesMeta(snap.machines)} onClick={() => push({ kind: 'machine', projectId: '' })}>
          {t.machines}
        </Line>
      )}
      <UsageLine />
      <Line ch="~" go={null} value={t.themeName(theme)} onClick={() => setTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length])}>
        {t.themeLabel}
      </Line>
      <LanguageLine />
      {snap.asksOpen !== undefined && (
        <Line ch="!" value={snap.asksOpen ? String(snap.asksOpen) : undefined} onClick={() => push({ kind: 'requests' })}>
          {tr(RM).menu}
        </Line>
      )}
      <Line ch="x" go={null} onClick={logout}>
        {t.logout}
      </Line>
    </section>
  )
}

function MainModelControl({model,effort}:{model?:string;effort?:string}) {
 const t=useT(ModelM)
 return <button type="button" className="link" onClick={()=>openModelControls('__main')} aria-label={t.title}>{[modelLabel(model),effortLabel(effort)].filter(Boolean).join(' · ')||t.title}</button>
}
