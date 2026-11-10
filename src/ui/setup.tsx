import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import { FIELDS, isBrick, type Brick, type Device } from '../../shared/setup.ts'
import { api } from '../api'
import { ensurePush } from '../push'
import { tr, useT } from '../i18n'
import M from '../i18n/setup'
import { useApp } from './app-context'
import { copyText } from './copy'
import { Icon } from './icons'

// Accueil et branchements, côté app (contrat : shared/setup.ts, serveur : server/setup.ts).
// - useWelcome : au premier lancement (intro terminée), weevilsd écrit l'accueil de weevboss dans son fil, adapté à
//   l'appareil, et le fil s'ouvre pour qu'on le lise arriver.
// - SetupChips : les boutons sous un message de weevboss. Un tap lance le branchement : une action sur place
//   (notifications, adresse Siri), ou weevboss dit ce que ça apporte (et installe ce qui manque) puis le champ du bas
//   pose les questions. Jamais de commande à taper.
// - startSetup : la même chose depuis n'importe où (page machine, bulles, cartes) : le fil de weevboss s'ouvre.
// - SetupComposer : le champ du bas pendant un parcours, une question à la fois ; les secrets sont masqués et partent
//   droit au serveur avec les autres réponses, à la fin. Jamais au modèle.

const read = (k: string) => {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}

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
  brick: Brick
  step: number
  values: Record<string, string>
}
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

/** Lance une brique : weevboss poste son explication (et fait ce qui se fait seul), puis, s'il le dit, le champ du bas
 * pose les questions. Rejette si le serveur ne répond pas. */
export async function startSetup(brick: Brick) {
  const r = await api.setupAsk(brick, device())
  if (r.flow && FIELDS[brick]) setFlow({ brick, step: 0, values: {} })
}
/** Pareil, sans attendre ni signaler d'erreur (bulles, diablotin). */
export const askSetup = (brick: Brick) => void startSetup(brick).catch(() => undefined)

// ---------------------------------------------------------------- accueil

/** Premier lancement : une fois l'intro fermée, l'appareil est noté (l'accueil, ce sont les premiers pas). */
export function useWelcome() {
  const { snap } = useApp()
  const pending = !!snap.setup && !snap.setup.welcomed
  const asked = useRef(false)
  useEffect(() => {
    if (!pending || asked.current) return
    const tick = () => {
      if (asked.current || read('weevils-onboarded') !== '1' || document.querySelector('.ob')) return
      asked.current = true
      // Le fil ne s'ouvre pas : les premiers pas (src/ui/tour.tsx) suivent la première demande sous la bande de weevboss.
      void api.setupWelcome(device()).catch(() => (asked.current = false))
    }
    tick()
    const id = window.setInterval(tick, 800)
    return () => window.clearInterval(id)
  }, [pending])
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

/** Lance le branchement d'une brique, d'où qu'on le demande (puce sous un message, premiers pas) : les questions du
 * champ du bas, une action sur place (notifications, adresse Siri), ou la marche à suivre postée par weevboss.
 * Renvoie une note à montrer en cas d'échec. */
export async function runBrick(brick: Brick): Promise<{ ok: boolean; note?: string }> {
  try {
    if (brick === 'push') {
      if (!(await ensurePush({ ask: true, test: true }))) return { ok: false, note: tr(M).pushDenied }
      await api.setupDone('push')
    } else if (brick === 'shortcut') {
      const r = await api.shortcut(true)
      await copyText(`${location.origin}/api/voice/turn?k=${r.token}`)
      await api.setupDone('shortcut')
      if (r.url) location.href = r.url
    } else await startSetup(brick)
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

function Chip({ brick }: { brick: Brick }) {
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
      <button type="button" className={`setup-chip ${state}`} onClick={() => void go()} disabled={state === 'busy'}>
        {state === 'busy' ? <span className="spin"><Icon name="star" /></span> : <Icon name={state === 'done' ? 'check' : state === 'error' ? 'bang' : 'arrow'} dir="right" />} {t[`chip_${brick}`]}
      </button>
      {note && <span className="meta setup-note">{note}</span>}
    </>
  )
}

/** Sous un message de weevboss : ses puces, en boutons (le QR de connexion s'affiche tel quel). */
export function SetupChips({ chips }: { chips: string[] }) {
  const list = chips.filter(isBrick)
  if (!list.length) return null
  return (
    <div className="setup-chips">
      {list.map((b) => (b === 'phone' ? <PhoneLink key={b} /> : <Chip key={b} brick={b} />))}
    </div>
  )
}

// ---------------------------------------------------------------- le champ du bas pendant un parcours

export function SetupComposer() {
  const t = useT(M)
  const f = useFlow()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const fields = f ? (FIELDS[f.brick] ?? []) : []
  const q = f ? fields[f.step] : undefined
  useEffect(() => {
    setText('')
    field.current?.focus({ preventScroll: true })
  }, [f?.brick, f?.step])
  // La réponse vide d'une question facultative a un sens (« vide : root », « vide : Tailscale ») : le bouton reste actif.
  if (!f || !q) return null
  const key = `${f.brick}_${q.name}` as const
  /** Une réponse : la question suivante, ou tout part au serveur (dernière question, ou un choix qui termine). */
  const answer = async (v: string) => {
    if ((!v && !q.optional) || busy) return
    const values = { ...f.values, [q.name]: v }
    if (f.step + 1 < fields.length && !q.stop?.includes(v)) return setFlow({ ...f, step: f.step + 1, values })
    setBusy(true)
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    try {
      await api.setupApply(f.brick, values)
    } finally {
      setBusy(false)
      setFlow(null)
    }
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void answer(text.trim())
  }
  const label = t[`q_${key}` as `q_devil_url`]
  return (
    <form className="composer band tone setup-form" onSubmit={submit} noValidate>
      <div className="in meta attach-line">
        <span className="strong">{label}</span>
        <span>
          {t.step(f.step + 1, fields.length)}
          {q.secret ? ` · ${t.secretNote}` : ''}
        </span>
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
          placeholder={t[`p_${key}` as `p_devil_url`]}
          aria-label={label}
          type={q.secret ? 'password' : q.kind === 'email' ? 'email' : 'text'}
          inputMode={q.kind === 'email' ? 'email' : q.kind === 'url' ? 'url' : undefined}
          autoComplete={q.secret ? 'new-password' : 'off'}
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
