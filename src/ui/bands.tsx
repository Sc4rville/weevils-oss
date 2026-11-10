import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { Message, Project } from '../../shared/api.ts'
import type { Brick } from '../../shared/setup.ts'
import { api } from '../api'
import { tr, useT } from '../i18n'
import M from '../i18n/bands'
import NM from '../i18n/notices'
import D from '../i18n/devil'
import { prefetchRepo } from './pages'
import { ConvLine } from './convs'
import { THEMES, stableOrder, useApp, useSettled } from './app-context'
import { ensurePush } from '../push'
import { VoiceLogo } from './voice'
import { useThreadAsk } from './askthread'
import { isUnread, useSeen } from './seen'
import { Collapse, Composer, INSTANT, Line, Messages, SessionRow, Working, authorTone, spring, useAuthors } from './bits'
import B from '../i18n/bits'
import { ago, plain, userText, type ChipId } from './format'
import { AutoMark, FilledIcon, G, Icon } from './icons'
import { KeepSessionOrder } from './session-order'
import { autoOfSession } from './auto-model'
import { PrefLines } from './prefs'
import { RelayPrefLine, ThreadPlans } from './relay'
import { UsageLine } from './infra'
import { TokenMeter } from './rate'
import { setDevil, useDevil } from './devil'
import { markSeen, tapHint } from './hints'
import { flash, keepInPlace, reveal, useFollow } from './follow'
import { mergePending, type Pending } from './pending'
import { Chip, KeyChip, SetupChips, SetupComposer, askSetup, flowVoice, useFlow, useWelcome } from './setup'
import { ForYouPeek, TopWords, useTop, type Top } from './foryou-top'

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
function Peek({ onOpen, visible, sent, messages, pendingLabel }: { onOpen: () => void; visible: boolean; sent: number; messages: Message[]; pendingLabel: string }) {
  const t = useT(M)
  const tb = useT(B)
  const td = useT(D)
  const authorOf = useAuthors()
  const { snap } = useApp()
  // Les démos des premiers pas passent dans l'aperçu le temps d'être vues, puis restent seulement dans le fil.
  const items = messages.filter((m) => m.role !== 'event' && m.text.trim() && (!m.demo || snap.now - m.at < 2 * 60_000)).slice(-60)
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
      onClick={onOpen}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onOpen()}
    >
      <div className="peek-list">
        <AnimatePresence initial={false} mode="popLayout">
          {items.map((m) => {
            const tone = m.role === 'orchestrator' ? authorTone(authorOf(m.author)) : null
            const who = `${m.role === 'user' ? tb.you : m.role === 'orchestrator' ? authorOf(m.author).name : m.devil ? td.devil : 'weevboss'}${m.demo ? ` · ${tb.demo}` : ''}${m.id.startsWith('pending-') ? ` · ${pendingLabel}` : ''}`
            const full = (m.role === 'user' ? userText(m.text) : plain(m.text)).replace(/\s+/g, ' ')
            // Le dernier : sa fin, entière (la réponse qui s'écrit reste lisible, en bas, là où l'aperçu la suit).
            const isLast = m.id === last?.id
            const text = isLast && full.length > PEEK_TAIL ? `… ${full.slice(-PEEK_TAIL).replace(/^\S*\s/, '')}` : full
            return (
              <motion.div
                key={m.id}
                layout="position"
                className={`peek-item ${m.role === 'user' ? '' : tone ? tone.className.replace('tone ', '') : m.devil ? 'devil' : 'base'} ${m.demo ? 'demo' : ''} ${isLast ? 'last' : ''}`}
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
  // Démo du diable (premiers pas) : la bande prend sa couleur quelques secondes, sans rien basculer.
  const [devilFlash, setDevilFlash] = useState(false)
  useEffect(() => {
    let id = 0
    const on = () => {
      setDevilFlash(true)
      window.clearTimeout(id)
      id = window.setTimeout(() => setDevilFlash(false), 2600)
    }
    window.addEventListener('weevils:devil-flash', on)
    return () => {
      window.removeEventListener('weevils:devil-flash', on)
      window.clearTimeout(id)
    }
  }, [])
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
  const swipe = useRef<{ y: number; top: number } | null>(null)
  const [draft, setDraft] = useState({ text: '', n: 0, reset: false })
  const heard = useRef('')
  // Le message envoyé s'affiche tout de suite (aperçu et fil), avant que Claude Code l'écrive dans son transcript (qui
  // peut attendre la fin de la réponse en cours) : une bulle « envoi… », remplacée par la vraie quand elle arrive.
  const [pending, setPending] = useState<Pending[]>([])
  const main = useMemo(() => mergePending(snap.main, pending), [snap.main, pending])
  useEffect(() => {
    // Arrivées (ou perdues depuis longtemps) : on les oublie.
    setPending((p) => {
      const left = new Set(mergePending(snap.main, p).map((m) => m.id))
      const next = p.filter((x) => left.has(x.id) && Date.now() - x.at < 15 * 60_000)
      return next.length === p.length ? p : next
    })
  }, [snap.main])
  const pendingLabel = snap.mainQueued > 0 ? t.queued : t.sending
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
    const tmp: Pending = { id: `pending-${Date.now()}`, role: 'user', text: shown, at: Date.now(), typed: text, after: snap.main.at(-1)?.id, ...(devilOn ? { devil: true } : {}) }
    setPending((p) => [...p, tmp])
    setSent((n) => n + 1)
    // Le champ écrit toujours à weevboss : envoyé depuis « pour toi », l'aperçu revient sur son fil, où la bulle et la
    // réponse se voient. Jamais setExpanded('agent').
    if (top === 'foryou') setTop('boss')
    if (open) chat.toEnd()
    try {
      await go()
    } catch (e) {
      setPending((p) => p.filter((x) => x.id !== tmp.id))
      throw e
    }
  }
  const send = (text: string) => sending(text, text, () => (devilOn ? api.devil(text) : api.main(text)))
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

  const band = (
    <section className={`band agent tone ${snap.foryou ? 'has-foryou' : ''} ${devilOn || devilFlash ? 'devil-on' : ''} ${open ? 'open' : ''}`} style={color(devilOn || devilFlash ? 'devil' : 'agent')} aria-label={t.agentBand}>
      {/* En haut : le logo (dicter), sous la barre d'état. Réduite : l'aperçu vivant du fil ; un tap l'ouvre.
          Ouverte : un tap dans l'espace vide, le chevron, ou glisser vers le bas la réduit. */}
      <div className="agent-space" onClick={(e) => open && e.target === e.currentTarget && setExpanded(null)}>
        {open && (
          <button className="agent-close" onClick={() => setExpanded(null)} aria-label={t.collapseChat}>
            <Icon name="chevron" dir="left" />
          </button>
        )}
        <TokenMeter />
        <div className="agent-top">
          {/* Pendant un branchement, la dictée va dans le champ du parcours (src/ui/setup.tsx), et le 3e tap y répond. */}
          <VoiceLogo
            take={() => { if (onSel || flow) return ''; const h = heard.current; heard.current = ''; setDraft((d) => ({ text: '', n: d.n + 1, reset: true })); return h }}
            onText={(x) => { if (onSel) return th.a.voiceText(x); if (flow) return flowVoice.add(x); heard.current = heard.current ? `${heard.current} ${x}` : x; setDraft((d) => ({ text: x, n: d.n + 1, reset: false })) }}
            onSend={() => (onSel ? th.a.voiceSend() : flow ? flowVoice.send() : form.current?.requestSubmit())}
            replyKey={th.a.replyKey ?? mainReply?.id}
            replyText={th.a.replyKey ? th.a.shown : mainReply?.text}
            working={snap.mainWorking || th.a.waiting}
          />
          {!snap.foryou && devilButton}
        </div>
        {/* L'aperçu et le fil restent rendus : ouvrir ou fermer ne fait que les montrer ou les cacher (immédiat). */}
        {/* Les deux mots, sous la ligne du logo ; ils restent quand le fil est ouvert (weevboss y est le mot actif). */}
        <div className="agent-nav">
          <TopWords active={open ? 'boss' : top} onPick={pickTop} />
          {snap.foryou && !open && devilButton}
        </div>
        <div className="peek-wrap" hidden={open || top !== 'boss'}>
          <Peek onOpen={() => setExpanded('agent')} visible={!open && top === 'boss'} sent={sent} messages={main} pendingLabel={pendingLabel} />
        </div>
        {/* L'aperçu de « pour toi » : à côté de celui du fil, dans la même boîte ; l'un ou l'autre est caché, aucun démonté. */}
        {snap.foryou && (
          <div className="fyt-wrap" hidden={open || top !== 'foryou'}>
            <ForYouPeek />
          </div>
        )}
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
            if (s && s.top <= 0 && e.changedTouches[0].clientY - s.y > 90) {
              markSeen('g-collapse')
              setExpanded(null)
            }
          }}
        >
          <div ref={th.ref} className="ask-thread">
            <Messages messages={main} author="weevboss" working={snap.mainWorking || !!snap.devil?.working} pendingLabel={pendingLabel} after={(id) => <>{qa(th.after(id), `${th.a.asking}:${!!th.a.shown}:${th.a.waiting}`)}{chipsOf(id)}</>} chip={chipIn} />
          </div>
          <ThreadPlans />
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
      {flow ? <SetupComposer /> : <Composer placeholder={t.agentPlaceholder} label={t.agentLabel} onSend={send} onAttach={attach} anyFile voice sayErrors horizontal captureSuggestions draft={draft} formRef={form} prompt={snap.mainWorking ? <span className="spin fluo"><Icon name="star" /></span> : <Icon name="chevron" dir="right" />} />}
    </section>
  )
  // Escape the draggable home stack: its transform makes fixed descendants smaller than the viewport.
  return open ? createPortal(band, document.body) : band
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
  const { snap, expanded, setExpanded, push, now, colors, instant } = useApp()
  const tx = instant ? INSTANT : spring
  const mode = expanded === null ? 'normal' : expanded === project.id ? 'open' : 'mini'
  // Les « terminées » : ouvertes ou fermées à la main, pour la vue en cours (un changement de vue rend la règle par défaut).
  const [doneSet, setDoneSet] = useState<{ v: boolean; mode: string } | null>(null)
  const sessions = snap.sessions.filter((s) => !s.archived && s.projectId === project.id)
  // Une ligne ne change pas de place parce qu'une autre session écrit (le serveur les range par activité) : ce qui
  // travaille en tête, puis l'ordre déjà affiché, une nouvelle session en tête des siennes. Rien ne bouge sous le doigt.
  const shownRows = useRef<string[]>([])
  const active = stableOrder(sessions.filter((s) => s.status !== 'done'), (s) => s.id, sessionRank, (a, b) => b.openedAt - a.openedAt, shownRows.current, !settled)
  const rowKey = active.map((s) => s.id).join('|')
  useLayoutEffect(() => {
    shownRows.current = rowKey ? rowKey.split('|') : []
  }, [rowKey])
  const done = sessions.filter((s) => s.status === 'done')
  const att = active.filter((s) => s.status === 'needs_user')
  const cut = active.filter((s) => s.status === 'interrupted')
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
  // Un tap sur le nom : la bande reste sous le doigt pendant que les autres se replient ou se déplient autour
  // (keepInPlace) ; ce qui s'ouvre sous le bas de l'écran y est amené ; si elle a dû bouger malgré tout (haut du flux,
  // fil de weevboss qui se referme d'un coup), elle s'éclaire un instant.
  const sec = useRef<HTMLElement>(null)
  const head = useRef<HTMLDivElement>(null)
  const doneBox = useRef<HTMLDivElement>(null)
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
  const doneOpen = doneSet?.mode === mode ? doneSet.v : false
  const toggleDone = () => {
    setDoneSet({ v: !doneOpen, mode })
    // Les terminées s'ouvrent souvent sous le bas de l'écran : la dernière y est amenée, le dépliage fini.
    if (!doneOpen) window.setTimeout(() => reveal(doneBox.current?.lastElementChild, { block: 'nearest', flash: false }), 380)
  }

  const busy = active.some((s) => s.status === 'working')
  useSeen()
  const unread = sessions.some(isUnread)
  const summary = [
    active.length > cut.length ? activity(active.filter((s) => s.status !== 'interrupted')) : sessions.length && !cut.length ? t.nothingRunning : null,
    att.length ? t.yours(att.length) : null,
    convCount ? t.conversations(convCount) : null,
    // Sans activité connue (projet épinglé jamais lancé, horodatage 0) : rien, pas « il y a 20766 jours ».
    !active.length && project.lastActivityAt > 0 ? ago(now - project.lastActivityAt) : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <motion.section ref={sec} layout="position" transition={tx} className={`band ${busy ? 'busy' : ''} ${cut.length ? 'has-cut' : ''}`} style={color(colors[project.id] ?? 'p0')} aria-label={t.projectBand(project.name)} data-project={project.id}>
      <KeepSessionOrder order={rowKey} within={sec} />
      <motion.div ref={head} className="in head" initial={false} animate={{ minHeight: shown === 'mini' ? 50 : 64, paddingTop: shown === 'mini' ? 0 : 8 }} transition={tx}>
        <button className="head-name" onClick={toggle} aria-expanded={mode === 'open'} aria-controls={`more-${project.id}`}>
          <motion.span className="name" initial={false} animate={{ fontSize: NAME_SIZE[shown] }} transition={tx}>
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
            {cut.length > 0 && (
              <button className="ch alert-ch" aria-label={t.cutAria(cut.length)} onClick={() => push({ kind: 'session', id: cut[0].id })}>
                <span>
                  <G c="×" />
                  <sup>{cut.length}</sup>
                </span>
              </button>
            )}
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
              <button className="ch" aria-label={t.newSessionIn(project.name)} onClick={(e) => {
                if (snap.setup?.claude === false && tapHint('newSession', e.currentTarget, 'newSessionOff')) return void askSetup('claude')
                if (!tapHint('newSession', e.currentTarget)) push({ kind: 'new', projectId: project.id })
              }}>
                <Icon name="plus" />
              </button>
            ) : null}
          </div>
        )}
      </motion.div>

      <Collapse open={shown !== 'mini'} transition={tx}>
        <AnimatePresence initial={false}>
          {active.map((s) => (
            <RowSlot key={s.id}>
              <SessionRow session={s} />
            </RowSlot>
          ))}
        </AnimatePresence>
        {active.length === 0 && sessions.length > 0 && project.lastActivityAt > 0 && <div className="in meta empty">{t.idleSince(ago(now - project.lastActivityAt))}</div>}
        {sessions.length === 0 && mode === 'normal' && convs.slice(0, 3).map((c) => <ConvLine key={c.id} c={c} />)}
        {done.length > 0 && (
          <>
            <Line ch="✓" go={doneOpen ? '↑' : '↓'} onClick={toggleDone} label={t.done(done.length)}>
              <span className="meta">{t.done(done.length)}</span>
            </Line>
            <Collapse open={doneOpen}>
              <div ref={doneBox}>
                {done.slice(0, 6).map((s) => (
                  <SessionRow key={s.id} session={s} />
                ))}
              </div>
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
            <Line key={a.id} ch={a.runState === 'running' ? <AutoMark /> : <Icon name="cycle" />} meta={a.runState === 'running' ? t.running : a.lastEvent} onClick={() => push({ kind: 'auto', id: a.id })}>
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
  const nt = useT(NM)
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
      <UsageLine />
      {snap.sessions.some((s) => s.archived) && <Line ch="↓" onClick={() => push({ kind: 'archived' })}>{nt.archived}</Line>}
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
      <RelayPrefLine />
      <PrefLines />
      <Line ch="x" go={null} onClick={logout}>
        {t.logout}
      </Line>
      {snap.memoryCount !== undefined && (
        <Line ch="#" meta={t.memories(snap.memoryCount)} onClick={() => push({ kind: 'memory' })}>
          {t.memory}
        </Line>
      )}
    </section>
  )
}
