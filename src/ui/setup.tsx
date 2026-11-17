import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import { flushSync } from 'react-dom'
import { FIELDS, isBrick, isSecretName, type ApplyResult, type Brick, type Device, type SetupField } from '../../shared/setup.ts'
import { api } from '../api'
import { ensurePush } from '../push'
import { tr, useT } from '../i18n'
import M from '../i18n/setup'
import { useApp } from './app-context'
import { copyText } from './copy'
import { Icon } from './icons'
import { flash, focusBoss, focusBossSoon } from './follow'
import { setTop } from './foryou-top'
import { Bring } from './bring'

// Accueil et branchements, côté app (contrat : shared/setup.ts, serveur : server/setup.ts).
// - useWelcome : au premier lancement, weevilsd écrit l'accueil de weevboss dans son fil, d'après l'état réel (une
//   brique à la fois, avec sa puce), et le fil s'ouvre pour qu'on le lise arriver. C'est tout l'onboarding.
// - SetupChips : les boutons sous un message de weevboss. Un tap lance le branchement : une action sur place
//   (notifications, adresse Siri), ou weevboss dit ce que ça apporte (et installe ce qui manque) puis le champ du bas
//   pose les questions. Jamais de commande à taper.
// - startSetup : la même chose depuis n'importe où (page machine, bulles, cartes) : le fil de weevboss s'ouvre en haut de
//   l'écran (focusBoss, src/ui/follow.ts), et sa réponse est mise en avant.
// - SetupComposer : le champ du bas pendant un parcours, une question à la fois ; les secrets sont masqués et partent
//   droit au serveur avec les autres réponses, à la fin. Jamais au modèle.

const standalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true

/** L'appareil d'où l'app est ouverte. */
export function device(): Device {
  const ua = navigator.userAgent
  const ios = /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1)
  const os: Device['os'] = ios ? 'ios' : /android/i.test(ua) ? 'android' : /mac os/i.test(ua) ? 'mac' : /windows/i.test(ua) ? 'windows' : /linux/i.test(ua) ? 'linux' : 'other'
  return { os, mobile: ios || /android|mobile/i.test(ua) || matchMedia('(pointer: coarse)').matches, standalone: standalone() }
}


// ---------------------------------------------------------------- le parcours en cours (champ du bas)

interface Flow {
  /** « key » : un secret demandé par un agent, nommé dans `key`. */
  brick: Brick | 'key'
  step: number
  values: Record<string, string>
  /** Un secret demandé par un agent ([[setup:key:NOM]]) : son nom ; une seule question, masquée. */
  key?: string
}
const KEY_FIELDS: SetupField[] = [{ name: 'value', secret: true }]
let flow: Flow | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
export const useFlow = () => useSyncExternalStore(subscribe, () => flow, () => null)
const setFlow = (f: Flow | null) => {
  flow = f
  emit()
}

/** Le logo de weevboss pendant un parcours : ce qu'il entend va dans le champ de la question, son 3e tap y répond
 * (le champ normal, démonté pendant le parcours, ne le recevrait pas). */
let flowInput: { add: (x: string) => void; send: () => void } | null = null
export const flowVoice = { add: (x: string) => flowInput?.add(x), send: () => flowInput?.send() }

/** Lance une brique : weevboss poste son explication (et fait ce qui se fait seul), puis, s'il le dit, le champ du bas
 * pose les questions. Rejette si le serveur ne répond pas. opened : le champ est déjà ouvert (openFlow, au tap). */
export async function startSetup(brick: Brick, opened = false, primary = false, again = false) {
  // Le fil de weevboss s'ouvre en haut de l'écran tout de suite (d'une page, du bas du flux) : sa réponse y arrive sous les yeux.
  focusBoss({ flash: false })
  // Claude Code: the official sign-in page opens from this very tap. The tab is opened now, inside the gesture (later,
  // phones block it), and sent to the page once weevilsd has started the login; the code field waits back here.
  const tab = brick === 'claude' || brick === 'account' ? openSignInTab() : null
  const r = await (primary && (brick === 'claude' || brick === 'codex') ? api.setupProvider(brick, device()) : api.setupAsk(brick, device(), again)).catch((e: unknown) => {
    tab?.close()
    if (opened && flow?.brick === brick && flow.step === 0) setFlow(null)
    throw e
  })
  if (tab) {
    if (r.open) tab.location.href = r.open
    else tab.close()
  }
  // La réponse (nouvelle, ou l'explication déjà là si on relance) est mise en avant, une fois ; une page ouverte entre-temps
  // n'est pas refermée : ce sera au retour.
  focusBossSoon({ mid: r.said })
  if (r.flow && FIELDS[brick]) {
    if (flow?.brick !== brick) setFlow({ brick, step: 0, values: {} })
  } else if (opened && flow?.brick === brick && flow.step === 0) setFlow(null)
}

function openSignInTab(): Window | null {
  try {
    return window.open('', '_blank')
  } catch {
    return null
  }
}

const composerInput = () => document.querySelector<HTMLInputElement>('.setup-form input')

/** Au tap, dans le geste même : le champ du bas s'ouvre et prend le focus tout de suite. Sur iPhone, le clavier ne
 * s'ouvre que pour un focus donné pendant le geste : ouvert après la réponse du serveur, le champ restait inerte et le
 * bouton semblait ne rien faire. Le serveur confirme ensuite (startSetup) ; s'il n'y a pas de questions, il se referme. */
function openFlow(brick: Brick): boolean {
  if (!FIELDS[brick]) return false
  if (flow?.brick !== brick) flushSync(() => setFlow({ brick, step: 0, values: {} }))
  composerInput()?.focus({ preventScroll: true })
  return true
}
/** Pareil, sans attendre ni signaler d'erreur (bulles, diablotin). */
export const askSetup = (brick: Brick) => void startSetup(brick).catch(() => undefined)

// ---------------------------------------------------------------- accueil

/** Premier lancement : weevboss accueille dans son fil, ouvert en haut de l'écran. Un appareil qui arrive après
 * (l'accueil déjà fait ailleurs) est simplement noté comme accueilli : bulles et astuces peuvent venir. */
export function useWelcome() {
  const { snap } = useApp()
  const welcomed = snap.setup?.welcomed
  const asked = useRef(false)
  useEffect(() => {
    if (welcomed === undefined || asked.current) return
    asked.current = true
    // Le fil s'ouvre sur l'accueil une fois écrit (une installation qui a déjà servi n'en a pas : rien ne s'ouvre).
    if (!welcomed) void api.setupWelcome(device()).then((r) => r.mid && focusBoss({ mid: r.mid }), () => (asked.current = false))
    try {
      localStorage.setItem('weevils-onboarded', '1')
    } catch {
      /* stockage indisponible */
    }
  }, [welcomed])
}

// ---------------------------------------------------------------- les boutons sous un message

export function PhoneLink() {
  const t = useT(M)
  const [link, setLink] = useState<string | null>(null)
  const [qr, setQr] = useState(true)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    void api.setupLink().then((r) => setLink(r.link), () => undefined)
  }, [])
  return (
    <div className="setup-qr">
      {qr && <img src="/api/setup/qr.svg" alt="" onError={() => setQr(false)} />}
      {!qr && <p className="meta">{t.noQr}</p>}
      {link && (
        <button
          type="button"
          className="setup-chip"
          onClick={async () => {
            if (await copyText(link)) setCopied(true)
          }}
        >
          <Icon name={copied ? 'check' : 'copy'} /> {copied ? t.copied : t.copyLink}
        </button>
      )}
    </div>
  )
}

/** Lance le branchement d'une brique, d'où qu'on le demande (puce sous un message, bulle, carte) : les questions du
 * champ du bas, une action sur place (notifications, adresse Siri), ou la marche à suivre postée par weevboss.
 * Renvoie une note à montrer en cas d'échec. */
export async function runBrick(brick: Brick, primary = false): Promise<{ ok: boolean; note?: string }> {
  try {
    if (brick === 'push') {
      if (!(await ensurePush({ ask: true, test: true }))) return { ok: false, note: tr(M).pushDenied }
      await api.setupDone('push')
    } else if (brick === 'shortcut') {
      const r = await api.shortcut(true)
      await copyText(`${location.origin}/api/voice/turn?k=${r.token}`)
      await api.setupDone('shortcut')
      if (r.url) location.href = r.url
    } else {
      // Le parcours de cette brique est déjà ouvert (second tap) : le champ reprend le focus, rien n'est reposté.
      if (flow?.brick === brick && !primary) composerInput()?.focus()
      else await startSetup(brick, openFlow(brick), primary)
    }
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

/** Le bouton d'une puce : sous un message, ou à sa place dans la phrase de weevboss (inline). */
export function Chip({ brick, inline = false }: { brick: Brick; inline?: boolean }) {
  const t = useT(M)
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  const [note, setNote] = useState<string | null>(null)
  const go = async () => {
    if (state === 'busy') return
    setNote(null)
    setState('busy')
    const r = await runBrick(brick)
    setNote(r.note ?? null)
    setState(r.ok ? 'done' : 'error')
  }
  return (
    <>
      <button type="button" className={`setup-chip ${inline ? 'inline' : ''} ${state}`} onClick={() => void go()} disabled={state === 'busy'}>
        {state === 'busy' ? <span className="spin"><Icon name="star" /></span> : state === 'done' ? <Icon name="check" /> : state === 'error' ? <Icon name="bang" /> : <Icon name="arrow" dir="right" />} {t[`chip_${brick}`]}
      </button>
      {note && <span className="meta setup-note">{note}</span>}
    </>
  )
}

/** [[setup:key:NOM]] : le champ masqué s'ouvre et prend le focus dans le geste même (clavier de l'iPhone). */
export function openKey(name: string) {
  if (!isSecretName(name)) return
  if (flow?.key !== name) flushSync(() => setFlow({ brick: 'key', step: 0, values: {}, key: name }))
  document.querySelector<HTMLInputElement>('.setup-form input')?.focus({ preventScroll: true })
}

/** Le bouton d'un secret demandé, à sa place dans la phrase de weevboss. */
export function KeyChip({ name }: { name: string }) {
  const t = useT(M)
  return (
    <button type="button" className="setup-chip inline" onClick={() => openKey(name)}>
      <Icon name="hash" /> {t.keyChip(name)}
    </button>
  )
}

/** Sous un message de weevboss : ses puces, en boutons (le QR de connexion s'affiche tel quel). */
export function SetupChips({ chips }: { chips: string[] }) {
  const list = chips.filter(isBrick)
  if (!list.length) return null
  return (
    <div className="setup-chips">
      {list.map((b) => (b === 'phone' ? <PhoneLink key={b} /> : b === 'history' ? <Bring key={b} /> : <Chip key={b} brick={b} />))}
    </div>
  )
}

// ---------------------------------------------------------------- le champ du bas pendant un parcours

const maskByCss = typeof CSS !== 'undefined' && CSS.supports?.('-webkit-text-security', 'disc')

export function SetupComposer() {
  const t = useT(M)
  const f = useFlow()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const field = useRef<HTMLInputElement>(null)
  const form = useRef<HTMLFormElement>(null)
  const fields = f ? (f.brick === 'key' ? KEY_FIELDS : (FIELDS[f.brick] ?? [])) : []
  const q = f ? fields[f.step] : undefined
  useEffect(() => {
    setText('')
    setErr(null)
    field.current?.focus({ preventScroll: true })
    // La réponse est prise : la question suivante s'éclaire un instant (sinon le libellé change sur place, sans signe).
    if (f && f.step > 0) flash(form.current)
  }, [f?.brick, f?.step, f?.key]) // eslint-disable-line react-hooks/exhaustive-deps
  // Une question à choix n'a pas de champ : la dictée y est ignorée (sinon le 3e tap enverrait un texte libre comme choix).
  const typed = useRef(false)
  // Un secret ne se dicte pas (l'audio partirait à la transcription).
  typed.current = !!q && q.kind !== 'choice' && !q.secret
  useEffect(() => {
    flowInput = {
      add: (x) => typed.current && setText((cur) => (cur.trim() ? `${cur.replace(/\s+$/, '')} ${x}` : x)),
      send: () => typed.current && form.current?.requestSubmit(),
    }
    return () => void (flowInput = null)
  }, [])
  // La réponse vide d'une question facultative a un sens (« vide : root », « vide : Tailscale ») : le bouton reste actif.
  if (!f || !q) return null
  const key = `${f.brick}_${q.name}` as const
  /** Une réponse : la question suivante, ou tout part au serveur (dernière question, ou un choix qui termine). */
  const answer = async (v: string) => {
    if ((!v && !q.optional) || busy) return
    const values = { ...f.values, [q.name]: v }
    // Répondu depuis « pour toi » : l'aperçu revient sur le fil de weevboss, où la suite s'affiche (comme à l'envoi d'un message).
    setTop('boss')
    if (f.step + 1 < fields.length && !q.stop?.includes(v)) return setFlow({ ...f, step: f.step + 1, values })
    setBusy(true)
    setErr(null)
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    try {
      const r = (f.brick === 'key' ? await api.setupKey(f.key ?? '', v) : await api.setupApply(f.brick, values)) as ApplyResult
      setFlow(null)
      // Le résultat (ou le même message, déjà là, d'un nouvel essai) est mis en avant dans le fil.
      focusBossSoon({ mid: r.said })
    } catch (e) {
      // Refusé (valeur, serveur injoignable) : on reste sur la question, la réponse dans le champ, et on dit pourquoi.
      setErr((e as Error).message || t.failed)
      flash(form.current)
    } finally {
      setBusy(false)
    }
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void answer(text.trim())
  }
  const label = f.key ? t.q_key(f.key) : t[`q_${key}` as `q_devil_url`]
  return (
    <form ref={form} className="composer band tone setup-form" onSubmit={submit} noValidate>
      <div className="in meta attach-line">
        <span className="strong">{label}</span>
        <span>
          {t.step(f.step + 1, fields.length)}
          {q.secret ? ` · ${t.secretNote}` : ''}
        </span>
        {err && <span>! {err}</span>}
      </div>
      {q.kind === 'choice' ? (
        <div className="in setup-choices" role="group" aria-label={label}>
          {(q.options ?? []).map((o) => (
            <button key={o} type="button" className="setup-chip" disabled={busy} onClick={() => void answer(o)}>
              {t[`o_${o}` as 'o_none']}
            </button>
          ))}
          <button type="button" className="tool-btn" onClick={() => setFlow(null)} aria-label={t.cancel}>
            <Icon name="close" />
          </button>
        </div>
      ) : (
      <div className="in">
        <span className="prompt" aria-hidden>
          {busy ? <span className="spin"><Icon name="star" /></span> : <Icon name={q.secret ? 'hash' : 'chevron'} dir="right" />}
        </span>
        <input
          ref={field}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={f.key ? t.p_key : t[`p_${key}` as `p_devil_url`]}
          aria-label={label}
          // Secret : masqué par le CSS plutôt que type=password là où c'est possible. Un champ mot de passe fait surgir le
          // gestionnaire de mots de passe d'iOS (« mot de passe fort » qui remplit le champ à ta place, trousseau) au
          // lieu du clavier, alors qu'on colle ici un mot de passe d'application ou un jeton, jamais à retenir.
          type={q.secret ? (maskByCss ? 'text' : 'password') : q.kind === 'email' ? 'email' : 'text'}
          className={q.secret && maskByCss ? 'masked' : undefined}
          inputMode={q.kind === 'email' ? 'email' : q.kind === 'url' ? 'url' : undefined}
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint={f.step + 1 < fields.length ? 'next' : 'send'}
        />
        <button type="button" className="tool-btn" onClick={() => setFlow(null)} aria-label={t.cancel}>
          <Icon name="close" />
        </button>
        <button className="send" type="submit" disabled={(!text.trim() && !q.optional) || busy} aria-label={t.next}>
          <Icon name="arrow" />
        </button>
      </div>
      )}
    </form>
  )
}
