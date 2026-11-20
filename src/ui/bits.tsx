import { sourceAccessIssue, sourceForSession } from './source-access'
import ToolM from '../i18n/codex-tools'
import { interceptModelControl } from '../model-controls'
import { withoutMachinePrefix } from '../../shared/machine-prefix.ts'
import { sessionNoticeKey } from '../../shared/notices.ts'
import { dismissNotice } from './notice-store'
import { AnimatePresence, motion, type Transition } from 'motion/react'
import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { api } from '../api'
import { useCaptureSuggestion } from './capture-suggestion'
import type { Author, Message, Session } from '../../shared/api.ts'
import { useApp } from './app-context'
import { chipLabel, chipLabels, type ChipId, dur, inline, isCommand, status, step, userText, userPhotos, userCaption } from './format'
import { blocks, spans, type ListItem } from './md'
import { copyText, useLongPress } from './copy'
import { markSeen } from './hints'
import { flash, reveal } from './follow'
import C from '../i18n/copy'
import { getLang, tr, useT } from '../i18n'
import M from '../i18n/bits'
import PM from '../i18n/plain-steps'
import { clusters, clusterLine, groupLine } from './plain-steps'
import D from '../i18n/devil'
import RM from '../i18n/relay'
import { isUnread, useSeen } from './seen'
import { AutoMark, G, Icon } from './icons'
import { LivingLink, livingLink } from './living-link'
import { autoOfSession } from './auto-model'

/** Ressort commun : léger dépassement, pour que les bandes aient de l'inertie. */
export const spring: Transition = { type: 'spring', stiffness: 420, damping: 32, mass: 0.9 }

/** Dépliage en hauteur : ce qui est en dessous est poussé en douceur. */
/** Sans animation : une bascule qui doit être immédiate. */
export const INSTANT: Transition = { duration: 0 }

export function Collapse({ open, children, id, transition = spring }: { open: boolean; children: ReactNode; id?: string; transition?: Transition }) {
  return (
    // La sortie reçoit la transition du rendu qui ferme (via custom) : un élément qui sort garde sinon ses anciennes props.
    <AnimatePresence initial={false} custom={transition}>
      {open && (
        <motion.div
          key="c"
          id={id}
          className="clip"
          custom={transition}
          variants={{ exit: (t: Transition) => ({ height: 0, opacity: 0, transition: t }) }}
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit="exit"
          transition={transition}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** Apparition d'un élément ajouté à une liste (nouvelle session, nouveau message). */
export function Appear({ children }: { children: ReactNode }) {
  return (
    <motion.div className="clip" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={spring}>
      {children}
    </motion.div>
  )
}

/** auto: the session runs for an automation; working, it shows AutoMark instead of the green star. */
export function StatusChar({ s, auto = false }: { s: Session['status']; auto?: boolean }) {
  if (auto && s === 'working') return <AutoMark />
  return (
    <span className={s === 'working' ? 'spin fluo' : s === 'interrupted' ? 'alert' : undefined}>
      <G c={status[s].ch} />
    </span>
  )
}

/** Long message de l'utilisateur : replié au-delà de quelques lignes, un geste pour tout lire. */
function Clamp({ text, full = false }: { text: string; full?: boolean }) {
  const t = useT(M)
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const long = !full && text.length > 420
  return (
    <>
      <div ref={box} className={`text ${long && !open ? 'clamp' : ''}`}>
        <Rich text={text} code={false} />
      </div>
      {long && (
        <button
          className="link small"
          onClick={() => {
            setOpen((v) => !v)
            // Déplié : la suite (ou, replié, le message) sous les yeux, du plus petit défilement.
            requestAnimationFrame(() => reveal(box.current, { block: 'nearest', flash: false }))
          }}
        >
          {open ? t.showLess : t.readAll}
        </button>
      )}
    </>
  )
}

/** Le logo officiel de l'outil (tracés Simple Icons, CC0), monochrome : currentColor, donc noir en clair et blanc en sombre, à la taille d'un glyphe. */
const LOGO: Record<string, string> = {
  claude: 'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z',
  codex: 'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z',
}

export function ToolIcon({ tool, size = 15 }: { tool: string; size?: number }) {
  const d = LOGO[tool]
  if (!d) return <span className="tool-svg">{tool.slice(0, 2)}</span>
  return (
    <svg className="tool-svg" width={size} height={size} viewBox="0 0 24 24" aria-hidden focusable="false">
      <path d={d} fill="currentColor" />
    </svg>
  )
}

export function SessionRow({ session }: { session: Session }) {
  const { push, now, snap } = useApp()
  const t = useT(M) // libellé d'état et durée suivent la langue
  const rt = useT(RM)
  useSeen()
  const unread = isUnread(session)
  const st = status[session.status]
  const waiting = session.status === 'needs_user'
  const ref = session.status === 'working' && session.workStartedAt ? session.workStartedAt : session.lastActivityAt
  // Un seul texte, en entier : la question qui t'attend, sinon l'activité en cours quand ça travaille, sinon le titre.
  const act = waiting && session.attention ? session.attention : session.status === 'working' ? session.now : undefined
  const text = session.title
  const cut = session.status === 'interrupted'
  const when = dur(now - (cut ? (session.interrupted?.at ?? session.lastActivityAt) : session.status === 'done' ? session.lastActivityAt : ref))
  const row = (
    <button
      className={`row ${waiting ? 'tone' : ''} ${cut ? 'cut' : ''} ${session.status === 'working' ? 'live' : ''} ${unread ? 'unread' : ''}`}
      onClick={() => push({ kind: 'session', id: session.id })}
      aria-label={t.rowAria(session.tool, session.title, st.label, act, session.background > 0 ? `${when}, ${t.background(session.background)}` : when)}
      title={act ? session.title : undefined}
    >
      <span className="in line" aria-hidden>
        <span className="st">
          <StatusChar s={session.status} auto={!!autoOfSession(snap, session.id)} />
        </span>
        <span className="tool-ic">
          <ToolIcon tool={session.tool} />
        </span>
        <span className="title wrap">
          <span className="session-name">{unread && <span className="dot" aria-hidden />}{text}</span>
          {/* Session Codex ouverte en relais d'une session Claude arrêtée par sa limite d'usage. */}
          {session.relayOf && (
            <span className="relay-sign" title={rt.signAria}>
              ⇄ {rt.sign}
            </span>
          )}
        </span>
        <span className="act">{when}</span>
      </span>
    </button>
  )
  return <div className="session-item">
    {waiting && session.ask ? <div className="cut-wrap ask-wrap">{row}<AskButton session={session} /></div>
      : cut ? <div className="cut-wrap">{row}<ResumeButton session={session} /></div> : row}
  </div>
}

/** L'action rapide d'une session qui attend : ouvrir son lien, lui coller le presse-papiers, ou lui répondre. */
export function AskButton({ session }: { session: Session }) {
  const { push } = useApp()
  const t = useT(M)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const ask = session.ask!
  const label = ask.kind === 'link' ? t.askLink : ask.kind === 'paste' ? t.askPaste : t.askReply
  const go = async () => {
    setErr(null)
    if (ask.kind === 'link' && ask.url) return void window.open(ask.url, '_blank', 'noopener')
    if (ask.kind !== 'paste') return push({ kind: 'session', id: session.id })
    setBusy(true)
    try {
      // Dans le geste : iOS propose « Coller », rien n'est lu sans l'accord de l'utilisateur.
      const text = (await navigator.clipboard.readText()).trim()
      if (!text) throw new Error(t.clipboardEmpty)
      if (interceptModelControl(session.id, text)) return
      const r = await api.send(session.id, text)
      dismissNotice(sessionNoticeKey(session))
      push({ kind: 'session', id: r.id })
    } catch (e) {
      // Presse-papiers refusé ou vide : la conversation s'ouvre, on y colle soi-même.
      setErr((e as Error).message)
      push({ kind: 'session', id: session.id })
    } finally {
      setBusy(false)
    }
  }
  return (
    <button className="resume ask" onClick={() => void go()} disabled={busy} aria-label={err ?? t.askAria(label, ask.text)} title={err ?? ask.text}>
      {label}
    </button>
  )
}

/** Relance une session coupée (--resume et un message qui la renvoie à son travail), puis ouvre son fil. */
export function ResumeButton({ session, onError, stay }: { session: Session; onError?: (e: string) => void; stay?: boolean }) {
  const { push, snap } = useApp()
  const sourceIssue = sourceAccessIssue(sourceForSession(snap.projects, session))
  const t = useT(M)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const go = async () => {
    if (sourceIssue || busy) return
    setBusy(true)
    setErr(null)
    onError?.('')
    try {
      const r = await api.resume(session.id)
      dismissNotice(sessionNoticeKey(session))
      if (!stay) push({ kind: 'session', id: r.id })
    } catch (e) {
      const m = (e as Error).message
      setErr(m)
      onError?.(m)
    } finally {
      setBusy(false)
    }
  }
  return (
    <button className="resume" onClick={() => void go()} disabled={busy || !!sourceIssue} aria-label={t.resumeAria(session.title)} title={err ?? sourceIssue ?? undefined}>
      {busy ? <span className="spin"><Icon name="star" /></span> : err ? <G c="!" /> : null} {t.resume}
    </button>
  )
}

/** Ligne pleine largeur : un caractère-icône, un texte, une flèche. */
export function Line({
  ch,
  children,
  meta,
  onClick,
  className = '',
  label,
  disabled,
  go = '→',
  value,
}: {
  ch?: ReactNode
  children: ReactNode
  meta?: ReactNode
  /** The current value, on the right of the label (« theme   light »): a setting read at a glance, never a sentence. */
  value?: ReactNode
  onClick?: () => void
  className?: string
  label?: string
  disabled?: boolean
  go?: string | null
}) {
  return (
    <button className={`row ${className}`} onClick={onClick} aria-label={label} disabled={disabled}>
      <span className="in">
        {ch != null && (
          <span className="st" aria-hidden>
            <G c={ch} />
          </span>
        )}
        <span className="stack-text">
          <span className="ellipsis">{children}</span>
          {meta && <span className="meta ellipsis">{meta}</span>}
        </span>
        {value != null && value !== '' && <span className="val">{value}</span>}
        {go && !disabled && (
          <span className="go" aria-hidden>
            <G c={go} />
          </span>
        )}
      </span>
    </button>
  )
}

export interface Attachment {
  name: string
  type: string
  /** Base64 sans préfixe, image déjà réduite. */
  data: string
}

/** Photo du téléphone réduite (côté long ≤ 1600 px, JPEG) : légère à envoyer, lisible par l'agent. */
const MAX_FILE = 32 * 1024 * 1024

/** Fichier envoyé tel quel (PDF, zip, doc…). */
async function raw(file: File): Promise<Attachment> {
  if (file.size > MAX_FILE) throw new Error(tr(M).tooBig(file.name))
  const buf = new Uint8Array(await file.arrayBuffer())
  let bin = ''
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
  return { name: file.name, type: file.type || 'application/octet-stream', data: btoa(bin) }
}

async function shrink(file: File): Promise<Attachment> {
  try {
    const bmp = await createImageBitmap(file)
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bmp.width * k)
    canvas.height = Math.round(bmp.height * k)
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height)
    const url = canvas.toDataURL('image/jpeg', 0.85)
    return { name: file.name.replace(/\.[^.]+$/, '') + '.jpg', type: 'image/jpeg', data: url.slice(url.indexOf(',') + 1) }
  } catch {
    // Format que le navigateur ne décode pas : on envoie tel quel.
    const buf = new Uint8Array(await file.arrayBuffer())
    let bin = ''
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
    return { name: file.name, type: file.type || 'image/jpeg', data: btoa(bin) }
  }
}

const blobToB64 = (b: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onerror = () => reject(new Error(tr(M).audioRead))
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.readAsDataURL(b)
  })

export function Composer({
  placeholder,
  label,
  onSend,
  onAttach,
  onFocus,
  prompt: _prompt,
  className = 'tone',
  disabled,
  voice = false,
  anyFile = false,
  draft,
  formRef,
  sayErrors = false,
  horizontal = false,
  captureSuggestions = false,
  draftKey,
}: {
  placeholder: string
  label: string
  onSend: (text: string) => void | Promise<void>
  /** Envoi avec des photos ; sans lui, pas de bouton photo. */
  onAttach?: (text: string, files: Attachment[]) => void | Promise<void>
  onFocus?: () => void
  prompt?: ReactNode
  className?: string
  disabled?: boolean
  /** Dictée : un appui pour enregistrer, un appui pour transcrire dans le champ. */
  voice?: boolean
  /** Toute pièce jointe (PDF, zip…), pas seulement des photos. */
  anyFile?: boolean
  /** Texte posé dans le champ de l'extérieur (dictée par le logo) ; n change à chaque nouveau texte. */
  draft?: { text: string; n: number; reset?: boolean }
  /** Pour envoyer depuis l'extérieur (troisième tap sur le logo). */
  formRef?: React.RefObject<HTMLFormElement | null>
  /** Un envoi refusé dit pourquoi sur la ligne au-dessus du champ (sinon l'appelant l'affiche lui-même). */
  sayErrors?: boolean
  /** Native one-line horizontal editor, isolated from page swipe gestures. */
  horizontal?: boolean
  /** Stable identity for a draft across title and locale changes. */
  draftKey?: string
  /** Offer pasted/authorized clipboard images before attaching them. */
  captureSuggestions?: boolean
}) {
  const t = useT(M)
  // Le texte en cours survit à un rechargement (mise à jour automatique de l'app, public/sw.js) : gardé dans l'onglet,
  // par champ (son libellé), effacé à l'envoi.
  const key = `weevils-draft:${draftKey ?? label}`
  const readDraft = (k: string) => {
    try {
      return sessionStorage.getItem(k) ?? ''
    } catch {
      return ''
    }
  }
  // Le brouillon appartient à une clé (id de session) : si la clé change alors que le composer reste monté, on recharge
  // le brouillon de la nouvelle conversation, jamais le texte de la précédente.
  const [draftState, setDraftState] = useState(() => ({ key, text: readDraft(key) }))
  if (draftState.key !== key) setDraftState({ key, text: readDraft(key) })
  const text = draftState.key === key ? draftState.text : readDraft(key)
  const keyRef = useRef(key)
  keyRef.current = key
  const setText = (v: string | ((cur: string) => string)) =>
    setDraftState((s) => (s.key === keyRef.current ? { key: s.key, text: typeof v === 'function' ? v(s.text) : v } : s))
  useEffect(() => {
    try {
      if (draftState.text) sessionStorage.setItem(draftState.key, draftState.text)
      else sessionStorage.removeItem(draftState.key)
    } catch {
      /* stockage indisponible */
    }
  }, [draftState])
  const field = useRef<HTMLInputElement | HTMLTextAreaElement>(null)
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const [files, setFiles] = useState<Attachment[]>([])
  const [rec, setRec] = useState<'off' | 'on' | 'wait'>('off')
  const [err, setErr] = useState<string | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const picker = useRef<HTMLInputElement>(null)
  const capture = useCaptureSuggestion(captureSuggestions && !!onAttach && !disabled)
  const canVoice = voice && typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
  useEffect(() => {
    if (draft?.reset) setText('')
    else if (draft?.text) setText((cur) => (cur.trim() ? `${cur.replace(/\s+$/, '')} ${draft.text}` : draft.text))
  }, [draft?.n])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const form = e.currentTarget
    // Use the live value: mobile IME may commit its final characters on blur.
    if (submitting.current || busy || disabled) return
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    const original = field.current?.value ?? text
    const typed = original.trim()
    if (!typed && !files.length) return
    submitting.current = true // synchronous: two submit events can precede a React render
    const sent = files
    const sentKey = key
    setText(original)
    setBusy(true)
    setErr(null)
    try {
      if (sent.length && onAttach) await onAttach(typed, sent)
      else await onSend(typed)
      // Keep the draft (including sessionStorage) until the server acknowledges it.
      // A new dictation arriving while we await the server must also survive.
      if (keyRef.current === sentKey) setText((current) => current === original ? '' : current)
      else {
        try {
          if (sessionStorage.getItem(sentKey) === original) sessionStorage.removeItem(sentKey)
        } catch { /* stockage indisponible */ }
      }
      setFiles((current) => current === sent ? [] : current)
    } catch (e) {
      if (sayErrors) setErr((e as Error).message || tr(M).sendFailed)
      flash(form)
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  const pick = async (list: FileList | readonly File[] | null) => {
    if (!list?.length) return
    setBusy(true)
    try {
      const got = await Promise.all([...list].slice(0, 6).map((f) => (anyFile && !f.type.startsWith('image/') ? raw(f) : shrink(f))))
      setFiles((f) => [...f, ...got].slice(0, 6))
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
      if (picker.current) picker.current.value = ''
    }
  }

  const toggleRec = async () => {
    if (rec === 'wait') return
    if (rec === 'on') {
      recorder.current?.stop()
      return
    }
    setErr(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find((t) => MediaRecorder.isTypeSupported(t))
      const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
      chunks.current = []
      r.ondataavailable = (ev) => ev.data.size && chunks.current.push(ev.data)
      r.onstop = async () => {
        stream.getTracks().forEach((tr) => tr.stop())
        setRec('wait')
        try {
          const blob = new Blob(chunks.current, { type: r.mimeType || type || 'audio/mp4' })
          // Too short or empty: not a failure, say nothing.
          if (blob.size < 800) return
          const { text: heard } = await api.transcribe(blob.type, await blobToB64(blob), getLang())
          if (heard) setText((cur) => (cur ? `${cur.replace(/\s+$/, '')} ${heard}` : heard))
        } catch (e) {
          // A failed dictation is said briefly, then fades: it never stays on screen.
          const m = (e as Error).message
          setErr(m)
          setTimeout(() => setErr((cur) => (cur === m ? null : cur)), 4000)
        } finally {
          setRec('off')
        }
      }
      r.start()
      recorder.current = r
      setRec('on')
    } catch (e) {
      setErr(/denied|permission|NotAllowed/i.test((e as Error).message + (e as Error).name) ? tr(M).micDenied : (e as Error).message)
      setRec('off')
    }
  }

  return (
    <form ref={formRef} className={`composer band ${className}`} aria-busy={busy} data-draft={!!text || !!files.length} onSubmit={submit}>
      {(files.length > 0 || err) && (
        <div className="in meta attach-line">
          {files.length > 0 && (
            <>
              <span className="strong">
                {t.attached(files.length, files.every((f) => f.type.startsWith('image/')))}
              </span>
              <button type="button" className="link small" onClick={() => setFiles([])}>
                {t.remove}
              </button>
            </>
          )}
          {err && <span>! {err}</span>}
        </div>
      )}
      <div className="in">
        {/* No « > » before the field: its width goes to the text. Only the sending star takes that spot. */}
        {busy && <span className="prompt" aria-hidden><span className="spin"><Icon name="star" /></span></span>}
        {horizontal ? (
          <textarea
            ref={(node) => { field.current = node }}
            className="horizontal-editor"
            rows={1}
            wrap="off"
            value={text.replace(/\r?\n/g, ' ')}
            onChange={(e) => setText(e.target.value.replace(/\r?\n/g, ' '))}
            onFocus={onFocus}
            onPaste={(e) => {
              if (!captureSuggestions || !onAttach || disabled) return
              const file = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'))
              if (file) { e.preventDefault(); capture.offer(file) }
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.keyCode === 229) return
              e.preventDefault()
              if (!e.shiftKey) e.currentTarget.form?.requestSubmit()
            }}
            onTouchStart={(e) => e.stopPropagation()}
            onTouchMove={(e) => e.stopPropagation()}
            onTouchEnd={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            placeholder={rec === 'on' ? t.listening : rec === 'wait' ? t.transcribing : placeholder}
            aria-label={label}
            enterKeyHint="send"
            autoComplete="off"
            disabled={disabled}
          />
        ) : (
          <input
            ref={(node) => { field.current = node }}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onFocus={onFocus}
            placeholder={rec === 'on' ? t.listening : rec === 'wait' ? t.transcribing : placeholder}
            aria-label={label}
            enterKeyHint="send"
            autoComplete="off"
            disabled={disabled}
          />
        )}
        {onAttach && !disabled && (
          <>
            <input ref={picker} type="file" accept={anyFile ? undefined : 'image/*'} multiple hidden onChange={(e) => void pick(e.target.files)} />
            {capture.candidate ? (
              <button type="button" className="tool-btn capture-offer" disabled={busy} aria-label={t.attachClipboardImage} onClick={() => {
                const file = capture.candidate?.file
                capture.clear()
                if (file) void pick([file])
              }}>
                <img src={capture.candidate.url} alt="" />
              </button>
            ) : (
              <button type="button" className="tool-btn" onClick={() => picker.current?.click()} aria-label={anyFile ? t.attachAny : t.attachPhoto}>
                <Icon name="plus" />
              </button>
            )}
          </>
        )}
        {canVoice && !disabled && (
          <button type="button" className={`tool-btn ${rec === 'on' ? 'rec' : ''}`} onClick={() => void toggleRec()} aria-label={rec === 'on' ? t.stopDictation : t.dictate} aria-pressed={rec === 'on'}>
            {rec === 'wait' ? <span className="spin"><Icon name="star" /></span> : <Icon name="mic" />}
          </button>
        )}
        <button className="send" type="submit" disabled={(!text.trim() && !files.length) || busy || disabled} aria-label={t.send}>
          <Icon name="arrow" />
        </button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Le fil : la vraie conversation, simplifiée. Toi, l'agent, et ce qu'il fait entre deux réponses.

/** An agent's reply with its structure kept, like a chat app: headings, bold, lists, quotes (with copy), tables that
 * scroll sideways on a phone, short code open with its copy button, long code folded behind « code · n lines ». */
export function Prose({ text }: { text: string }) {
  const parts = useMemo(() => blocks(text), [text])
  return (
    <div className="text md">
      {parts.map((b, i) =>
        b.kind === 'heading' ? (
          <p key={i} className={`md-h md-h${b.level}`}><Inline text={b.text} /></p>
        ) : b.kind === 'para' ? (
          <p key={i}><Inline text={b.text} /></p>
        ) : b.kind === 'list' ? (
          b.ordered ? (
            <ol key={i} start={b.start}>{b.items.map((it, j) => <Item key={j} item={it} />)}</ol>
          ) : (
            <ul key={i}>{b.items.map((it, j) => <Item key={j} item={it} />)}</ul>
          )
        ) : b.kind === 'quote' ? (
          <blockquote key={i}>
            <Inline text={b.text} />
            <CopyButton text={b.text} />
          </blockquote>
        ) : b.kind === 'table' ? (
          <div key={i} className="md-table">
            <table>
              <thead><tr>{b.head.map((c, j) => <th key={j}><Inline text={c} /></th>)}</tr></thead>
              <tbody>{b.rows.map((r, j) => <tr key={j}>{b.head.map((_, k) => <td key={k}><Inline text={r[k] ?? ''} /></td>)}</tr>)}</tbody>
            </table>
          </div>
        ) : b.kind === 'code' ? (
          b.body.split('\n').length <= SHORT_CODE ? (
            <div key={i} className="md-code">
              <pre className="code mono small">{b.body}</pre>
              <CopyButton text={b.body} />
            </div>
          ) : (
            <Snippet key={i} code={b.body} />
          )
        ) : (
          <hr key={i} />
        ),
      )}
    </div>
  )
}

/** Code this short reads at a glance: shown, not folded. */
const SHORT_CODE = 8

function Item({ item }: { item: ListItem }) {
  return (
    <li>
      <Inline text={item.text} />
      {item.sub.length > 0 && <ul>{item.sub.map((s, k) => <li key={k}><Inline text={s} /></li>)}</ul>}
    </li>
  )
}

/** One line of a reply: bold and italic around what Rich reads (links, `commands`, chips). */
function Inline({ text }: { text: string }) {
  const parts = useMemo(() => spans(text), [text])
  return (
    <>
      {parts.map((p, i) =>
        p.kind === 'strong' ? <strong key={i}><Rich text={p.s} /></strong> : p.kind === 'em' ? <em key={i}><Rich text={p.s} /></em> : <Rich key={i} text={p.s} />,
      )}
    </>
  )
}

function Snippet({ code }: { code: string }) {
  const t = useT(M)
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const n = code.split('\n').length
  const toggle = () => {
    // Le code s'ouvre vers le bas (le fil ne le repousse pas, src/ui/follow.ts) ; une fois déplié, on l'amène sous les
    // yeux s'il dépasse : son début d'abord quand il est plus grand que le fil.
    if (!open) window.setTimeout(() => reveal(box.current, { block: 'nearest', flash: false }), 400)
    setOpen((v) => !v)
  }
  return (
    <div ref={box} className="snippet">
      <div className="snippet-head">
        <button className="link" onClick={toggle} aria-expanded={open}>
          {t.code(n)}
        </button>
        <CopyButton text={code} />
      </div>
      <Collapse open={open}>
        <pre className="code mono small">{code}</pre>
      </Collapse>
    </div>
  )
}

/** Bouton copier discret : l'icône devient une coche un instant. */
export function CopyButton({ text }: { text: string }) {
  const t = useT(C)
  const [done, setDone] = useState(false)
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return (
    <button
      type="button"
      className={`copy ${done ? 'done' : ''}`}
      aria-label={done ? t.copied : t.copy}
      onClick={async (e) => {
        e.stopPropagation()
        if (await copyText(text)) {
          setDone(true)
          window.clearTimeout(timer.current)
          timer.current = window.setTimeout(() => setDone(false), 1200)
        }
      }}
    >
      <Icon name={done ? 'check' : 'copy'} />
    </button>
  )
}

/** Texte de message : les URL deviennent des liens (navigateur), les `commandes` ont leur bouton copier. */
/** Ce qu'une puce de branchement écrite dans un message devient à sa place : un bouton (fourni par le fil de weevboss),
 * sinon (null, ou hors de ce fil) son libellé, pour que la phrase reste lisible. */
export const ChipSlot = createContext<((b: ChipId) => ReactNode) | null>(null)

function InlineChip({ brick }: { brick: ChipId }) {
  const slot = useContext(ChipSlot)
  return slot?.(brick) ?? <span className="chip-label">{chipLabel(brick)}</span>
}

export function Rich({ text, code = true }: { text: string; code?: boolean }) {
  const parts = useMemo(() => inline(text, code), [text, code])
  return (
    <>
      {parts.map((p, i) =>
        p.kind === 'text' ? (
          p.s
        ) : p.kind === 'chip' ? (
          <InlineChip key={i} brick={p.brick} />
        ) : p.kind === 'url' && livingLink(p.href) ? (
          <LivingLink key={i} href={p.href} label={p.label} />
        ) : p.kind === 'url' ? (
          <a key={i} className="url" href={p.href} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
            {p.label}
          </a>
        ) : (
          <span key={i} className="cmd">
            {p.s}
            {isCommand(p.s) && <CopyButton text={p.s} />}
          </span>
        ),
      )}
    </>
  )
}

/** Une bulle : texte sélectionnable, appui long = tout le message copié (le nom devient « copié » un instant). */
function Bubble({ className, style, who, copy, mid, children }: { className: string; style?: React.CSSProperties; who: string; copy: string; mid?: string; children: ReactNode }) {
  const t = useT(C)
  const [copied, setCopied] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const press = useLongPress(async () => {
    const ok = await copyText(copy)
    if (ok) {
      markSeen('g-copy')
      setCopied(true)
      navigator.vibrate?.(12)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 1200)
    }
    return ok
  })
  const live = useRef(press)
  live.current = press
  // Écouteurs natifs : à la souris, glisser sur le texte sélectionne, donc le geste ne remonte pas au balayage de la page
  // (motion écoute nativement sur <main>) ; ce stopPropagation priverait aussi React de l'événement, d'où l'appui long ici.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const down = (e: globalThis.PointerEvent) => {
      if (e.pointerType === 'mouse') e.stopPropagation()
      live.current.onPointerDown(e)
    }
    const move = (e: globalThis.PointerEvent) => live.current.onPointerMove(e)
    const up = () => live.current.onPointerUp()
    const cancel = () => live.current.onPointerCancel()
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', cancel)
    return () => {
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', cancel)
    }
  }, [])
  return (
    <div ref={ref} className={`${className} ${copied ? 'copied' : ''}`} style={style} data-mid={mid}>
      <div className="in">
        {(copied || who) && <span className="who">{copied ? t.copied : who}</span>}
        {children}
      </div>
    </div>
  )
}

type Group = { kind: 'msg'; m: Message } | { kind: 'steps'; id: string; steps: Message[] }

/** Les actions consécutives de l'agent (lire, modifier, lancer…) forment un seul bloc replié. */
function group(messages: Message[]): Group[] {
  const out: Group[] = []
  for (const m of messages) {
    const last = out[out.length - 1]
    if (m.role === 'event') {
      if (last?.kind === 'steps') last.steps.push(m)
      else out.push({ kind: 'steps', id: m.id, steps: [m] })
    } else out.push({ kind: 'msg', m })
  }
  return out
}

/** The closed fold of project session threads: a plain line, the raw or long content behind a tap. */
function Fold({ head, className = '', label, children }: { head: ReactNode; className?: string; label?: string; children: ReactNode }) {
  return (
    <details className={`step-detail ${className}`}>
      <summary className="step-head" title={label}>
        <span className="text">{head}</span>
        
      </summary>
      <div className="step-content">{children}</div>
    </details>
  )
}

/** A brief from weevboss or another agent as shown: without the hidden ⟦weevils …⟧ context block (locale, steps) that rides on it. */
const briefText = (text: string) => userText(withoutMachinePrefix(text))

/** Session threads: one plain sentence per action; commands, paths and raw results only behind a tap. */
function PlainSteps({ steps, live }: { steps: Message[]; live: boolean }) {
  const mid = steps[0].id
  const listId = useId()
  const t = useT(M)
  const w = useT(PM)
  const [open, setOpen] = useState(false)
  const cs = useMemo(() => clusters(steps), [steps])
  const head = live ? clusterLine(cs[cs.length - 1], w) : groupLine(cs, w)
  return (
    <div className="msg band event plain" data-mid={mid}>
      <button type="button" className="in steps-head" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-controls={open ? listId : undefined}>
        <span className="text">
          {live ? <span className="spin fluo"><Icon name="star" /></span> : <Icon name="arrow" dir="right" />} <span key={head} className="fade-in">{head}</span>
        </span>
      </button>
      <Collapse open={open}>
        <div id={listId} className="in steps-list">
          {cs.map((c, ci) => (
            <Fold key={c.steps[0].id + ci} head={clusterLine(c, w)}>
                {c.steps.map((s) => (
                  <div key={s.id} className="step-raw">
                    <div className="meta">{w.rawTitle}</div>
                    {s.toolDetails?.commands.length ? <>{s.toolDetails.commands.map((command, i) => <pre key={i}>{command}</pre>)}</> : <pre>{s.text}</pre>}
                    {s.toolDetails?.commandsTruncated && <p className="meta">{t.commandTruncated}</p>}
                    {s.toolDetails?.output ? <><div className="meta">{t.recordedOutput}</div><pre>{s.toolDetails.output}</pre></> : <p className="meta">{w.unverified}</p>}
                    {s.toolDetails?.outputTruncated && <p className="meta">{t.outputTruncated}</p>}
                  </div>
                ))}
            </Fold>
          ))}
        </div>
      </Collapse>
    </div>
  )
}

function Steps({ steps, live, plain = false }: { steps: Message[]; live: boolean; plain?: boolean }) {
  if (plain) return <PlainSteps steps={steps} live={live} />
  return <RawSteps steps={steps} live={live} />
}

function RawSteps({ steps, live }: { steps: Message[]; live: boolean }) {
  const mid = steps[0].id
  const listId = useId()
  const t = useT(M)
  const [open, setOpen] = useState(false)
  const tools=useT(ToolM)
  const label = (message: Message) => {
    const category = message.toolDetails?.kinds?.length ? message.toolDetails.kinds.map(k => tools[k as keyof typeof tools] ?? step(message.text)).join(' · ') : step(message.text)
    const commands = message.toolDetails?.summaryCommands?.filter(Boolean).join(', ')
    return commands ? `${category} · ${commands}` : category
  }
  const last = label(steps[steps.length - 1])

  return (
    <div className="msg band event" data-mid={mid}>
      <button type="button" className="in steps-head" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-controls={open ? listId : undefined}>
        <span className="text">
          {live ? <span className="spin fluo"><Icon name="star" /></span> : <Icon name="arrow" dir="right" />} {t.steps(steps.length)} · <span key={last} className="fade-in">{last}</span>
        </span>
      </button>
      <Collapse open={open}>
        <div id={listId} className="in steps-list">
          {steps.map((s) => (
            <details key={s.id} className="step-detail">
              <summary className="step-head">
                <span className="text">{label(s)}</span>
                
              </summary>
              <div className="step-content">
                {!!s.toolDetails?.calls?.length && <>
                  <div className="meta">{t.recordedTools}</div>
                  <ul className="step-calls">{s.toolDetails.calls.map((call, i) => <li key={i}><code>{call.name}</code>{call.description && <p>{call.description}</p>}</li>)}</ul>
                </>}
                {s.toolDetails?.commands.length ? <><div className="meta">{t.recordedCommand}</div>{s.toolDetails.commands.map((command, i) => <pre key={i}>{command}</pre>)}</> : <p className="meta">{t.noRecordedCommand}</p>}
                {s.toolDetails?.commandsTruncated && <p className="meta">{t.commandTruncated}</p>}
                {s.toolDetails?.output ? <><div className="meta">{t.recordedOutput}</div><pre>{s.toolDetails.output}</pre></> : <p className="meta">{t.noRecordedOutput}</p>}
                {s.toolDetails?.outputTruncated && <p className="meta">{t.outputTruncated}</p>}
              </div>
            </details>
          ))}
        </div>
      </Collapse>
    </div>
  )
}

/** Provenance from the bridge, never inferred from the content of a human message. */
function Coordination({ folded, author, sourceThreadId, children }: { folded: boolean; author: string; sourceThreadId?: string; children: ReactNode }) {
  const t = useT(M)
  const { snap } = useApp()
  if (!folded) return children
  // A source without a known title is omitted: never a raw id.
  const source = sourceThreadId ? snap.sessions?.find(s => s.id === sourceThreadId)?.title?.trim() || null : null
  return <details className="session-coordination"><summary className="in">{source ? t.coordinationSource(author, source) : t.coordination(author)}</summary>{children}</details>
}

const WINDOW = 60

/** The request a session works on, pinned above its older messages: its first sentence on one line; a tap shows it all. */
function AskedLine({ text, who, tone, style }: { text: string; who: string; tone: string; style?: React.CSSProperties }) {
  const [open, setOpen] = useState(false)
  const first = text.split(/(?<=[.!?:])\s|\n/)[0].trim() || text
  return (
    <div className={`msg band session-asked ${tone}`} style={style}>
      <button type="button" className="in session-asked-line" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="who strong">{who}</span> <span className={open ? 'text' : 'text one-line'}>{open ? '' : first}</span>
      </button>
      {open && (
        <div className="in session-asked-full">
          <Rich text={text} code={false} />
        </div>
      )}
    </div>
  )
}

/** Auteur d'un message signé (weevboss par défaut) : nom affiché et couleur, d'après la config du serveur. */
export function useAuthors() {
  const { snap } = useApp()
  const list = snap.config.authors
  return useMemo(() => {
    const byId = new Map((list ?? []).map((a) => [a.id, a]))
    // Un auteur inconnu de la config (agent externe retiré, démo du pont e-mail) : une couleur stable de la palette.
    const tint = (id: string) => `var(--p${[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 16})`
    return (id?: string): Author => byId.get(id ?? 'weevboss') ?? { id: id ?? 'weevboss', name: id ?? 'weevboss', color: id && id !== 'weevboss' ? tint(id) : '' }
  }, [list])
}

/** Classe et style d'une bulle signée : le violet de weevboss, ou la couleur de l'agent externe. */
export const authorTone = (a: Author) => (a.color ? { className: 'tone orch ext', style: { '--who': a.color } as React.CSSProperties } : { className: 'tone orch', style: undefined })

/** after(id) : ce qui s'affiche sous un message (la barre de questions d'askthread.tsx), id = data-mid du message. */
/** pendingLabel : la mention des bulles envoyées pas encore arrivées dans le fil (ids « pending-… », src/ui/pending.ts). */
export function Messages({
  messages,
  author,
  working = false,
  after,
  chip,
  pendingLabel,
  session = false,
  plain = false,
}: {
  messages: Message[]
  author: string
  working?: boolean
  after?: (id: string) => ReactNode
  /** Une puce de branchement écrite dans le message id : son bouton, à sa place dans la phrase (null : son libellé). */
  chip?: (brick: ChipId, id: string) => ReactNode
  pendingLabel?: string | ((id: string) => string)
  /** Full session reading: continuous prose and optional technical coordination. */
  session?: boolean
  /** Project session thread: plain one-line actions, short intermediate chatter. Never the weevboss thread. */
  plain?: boolean
}) {
  const t = useT(M)
  const td = useT(D)
  const [all, setAll] = useState(false)
  // The window counts what is read (messages), never tool steps: 150 commands no longer push the request out of view.
  const said = useMemo(() => messages.flatMap((m, i) => (m.role === 'event' ? [] : [i])), [messages])
  const cut = all || said.length <= WINDOW ? 0 : said[said.length - WINDOW]

  // What the session was asked: the request that started it, and the latest one to it, always on top when the window
  // hides them (Scarville, 2026-11-17: « why is there no prompt »).
  const asked = (m: Message) => m.role === 'user' || m.role === 'orchestrator'
  const firstAsk = messages.findIndex(asked)
  const lastAsk = messages.length - 1 - [...messages].reverse().findIndex(asked)
  const pinnedAt = session && cut > 0 ? [...new Set([firstAsk, lastAsk])].filter((i) => i >= 0 && i < cut) : []
  const groups = useMemo(() => group(messages.slice(cut)), [messages, cut])
  const pinned = pinnedAt.map((i) => messages[i])
  const hidden = said.filter((i) => i < cut && !pinnedAt.includes(i)).length
  // Project threads: finished tool steps show nothing; a tap on the message they led to opens them (recorded actions
  // stay inspectable). Only the live one, at the bottom, says what is happening now.
  const [openSteps, setOpenSteps] = useState<Set<string>>(() => new Set())
  const stepsBefore = useMemo(() => {
    const out = new Map<string, Message[]>()
    if (!plain) return out
    groups.forEach((g, i) => {
      if (g.kind !== 'steps') return
      const next = groups.slice(i + 1).find((x) => x.kind === 'msg')
      const prev = groups.slice(0, i).reverse().find((x) => x.kind === 'msg')
      const host = next ?? prev
      if (host?.kind === 'msg') out.set(host.m.id, [...(out.get(host.m.id) ?? []), ...g.steps])
    })
    return out
  }, [groups, plain])
  const toggleSteps = (id: string, e: React.MouseEvent) => {
    if (!stepsBefore.has(id) || (e.target as HTMLElement).closest('a, button, summary, details[open] > *:not(summary)')) return
    setOpenSteps((v) => {
      const n = new Set(v)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }
  const authorOf = useAuthors()
  // An empty label says nothing (no dangling « · »).
  const pendingTag = (id: string) => {
    const label = !pendingLabel || !id.startsWith('pending-') ? '' : typeof pendingLabel === 'function' ? pendingLabel(id) : pendingLabel
    return label ? ` · ${label}` : ''
  }
  return (
    <AnimatePresence initial={false}>
      {pinned.map((m) => (
        <Appear key={`ask-${m.id}`}>
          <AskedLine text={m.role === 'user' ? userCaption(m.text) : briefText(m.text)} who={m.role === 'user' ? t.you : authorOf(m.author).name} tone={m.role === 'user' ? 'tone' : authorTone(authorOf(m.author)).className} style={m.role === 'orchestrator' ? authorTone(authorOf(m.author)).style : undefined} />
        </Appear>
      ))}
      {hidden > 0 && (
        <Line key="older" ch="↑" go={null} onClick={() => setAll(true)}>
          <span className="meta">{t.older(hidden)}</span>
        </Line>
      )}
      {groups.map((g, i) =>
        g.kind === 'steps' ? (
          <Appear key={g.id}>
            {(!plain || (working && i === groups.length - 1)) && <Steps steps={g.steps} live={working && i === groups.length - 1} plain={plain} />}
            {after?.(g.id)}
          </Appear>
        ) : (
          <Appear key={g.m.id}>
            {openSteps.has(g.m.id) && stepsBefore.get(g.m.id) && <Steps steps={stepsBefore.get(g.m.id)!} live={false} plain />}
            <div onClick={(e) => toggleSteps(g.m.id, e)}>
            <Coordination folded={session && g.m.role === 'orchestrator' && !!g.m.coordination && authorOf(g.m.author).id !== 'weevboss'} author={authorOf(g.m.author).name} sourceThreadId={g.m.sourceThreadId}>
            <Bubble
              className={`msg band ${session ? 'session-message' : ''} ${g.m.role === 'user' ? 'tone' : g.m.role === 'orchestrator' ? authorTone(authorOf(g.m.author)).className : ''} ${g.m.devil && g.m.role === 'assistant' ? 'devil' : ''}`}
              style={g.m.role === 'orchestrator' ? authorTone(authorOf(g.m.author)).style : undefined}
              who={`${g.m.role === 'user' ? t.you : g.m.role === 'orchestrator' ? authorOf(g.m.author).name : g.m.devil ? td.devil : session ? '' : author}${pendingTag(g.m.id)}`}
              copy={g.m.role === 'user' ? userText(g.m.text) : g.m.role === 'orchestrator' ? briefText(g.m.text) : chipLabels(withoutMachinePrefix(g.m.text))}
              mid={g.m.id}
            >
              {g.m.role === 'user' ? (
                <>
                  <Clamp text={userCaption(g.m.text)} full={session} />
                  {userPhotos(g.m.text).map((file) => (
                    <a key={file} className="user-photo" href={`/api/attachments?path=${encodeURIComponent(file)}`} target="_blank" rel="noopener noreferrer">
                      <img src={`/api/attachments?path=${encodeURIComponent(file)}`} alt={file.split('/').at(-1) ?? ''} loading="lazy" />
                    </a>
                  ))}
                </>
              ) : g.m.role === 'orchestrator' ? (
                <Clamp text={briefText(g.m.text)} full={session} />
              ) : (
                <ChipSlot.Provider value={chip ? (b) => chip(b, g.m.id) : null}>
                  <Prose text={withoutMachinePrefix(g.m.text)} />
                </ChipSlot.Provider>
              )}
            </Bubble>
            {after?.(g.m.id)}
            </Coordination>
            </div>
          </Appear>
        ),
      )}
    </AnimatePresence>
  )
}

/** L'agent travaille : une ligne vivante en bas du fil. */
/** mark: the sign of life in place of the green star (AutoMark for an automation). */
export function Working({ author, since, mark }: { author: string; since?: number | null; mark?: ReactNode }) {
  const { now } = useApp()
  const t = useT(M)
  return (
    <motion.div className="msg band working" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={spring}>
      <div className="in">
        <span className="who">
          {mark ?? <span className="spin fluo"><Icon name="star" /></span>} {t.working(author)}{since ? ` · ${dur(now - since)}` : ''}
          <span className="dots" aria-hidden>
            <i />
            <i />
            <i />
          </span>
        </span>
      </div>
    </motion.div>
  )
}
