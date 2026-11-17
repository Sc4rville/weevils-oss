import { noticeKey } from '../../shared/notices.ts'
import { Notice } from './notice'
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'
import type { Phase, Progress, Software } from '../../shared/softwares.ts'
import { api, ApiError, softwareShot } from '../api'
import { useT } from '../i18n'
import M from '../i18n/softwares'
import { useApp } from './app-context'
import { Shell } from './shell'
import { Icon } from './icons'
import './softwares.css'
import { PreviewChat } from './preview-chat'
import { GoneBack, useGoneTitle } from './gone'

// « Mes logiciels » : tout ce que l'utilisateur construit ou fait tourner, un rectangle de couleur par logiciel (même
// grille que les repos). Dedans, son interface (capture) ou, sans capture, une phrase simple (jamais de sortie brute) ;
// en bas, la barre d'avancement en trois phases. Un tap l'ouvre et le lance (le serveur fait le reste).

/** Couleur par place (attribuée à la première vue, puis gardée) : le même pas que la grille des repos (deux voisins n'ont jamais une teinte proche). */
const tint = (i: number) => ({ '--c': `var(--p${(i * 7) % 16})` }) as CSSProperties

/** Dernier état connu de chaque logiciel : sa page s'affiche tout de suite, avant la première réponse. */
const known = new Map<string, Software>()
/** Le lancement demandé au tap a échoué : sa page le dit à la place d'un écran muet. */
const openFailed = new Map<string, string>()

// ---------------------------------------------------------------------------
// Fonctions pures (testées dans softwares.test.ts).

/** Remplissage (0 à 100) du segment k (1 à 3) : plein avant la phase, au pourcentage dans la phase, vide après. */
export function segFill(k: number, phase: Phase, percent: number): number {
  if (k < phase) return 100
  if (k > phase) return 0
  return Math.max(0, Math.min(100, percent))
}

/** Un tap à x sur une barre de largeur width : la phase du segment touché, la position dans le segment arrondie à 5. */
export function tapToFix(x: number, width: number): { phase: Phase; percent: number } {
  const f = width > 0 ? Math.max(0, Math.min(1, x / width)) : 0
  const seg = Math.min(2, Math.floor(f * 3))
  const percent = Math.max(0, Math.min(100, Math.round(((f * 3 - seg) * 100) / 5) * 5))
  return { phase: (seg + 1) as Phase, percent }
}

/** Position sur toute la barre (0 à 300) : pour le clavier, qui avance de 5 en 5 d'une phase à l'autre. */
export const linear = (p: Pick<Progress, 'phase' | 'percent'>) => (p.phase - 1) * 100 + Math.max(0, Math.min(100, p.percent))
export function fromLinear(v: number): { phase: Phase; percent: number } {
  const x = Math.max(0, Math.min(300, Math.round(v)))
  const phase = Math.min(3, Math.floor(x / 100) + 1) as Phase
  return { phase, percent: x - (phase - 1) * 100 }
}

const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p

/** Ordre stable tant que la page est ouverte : ceux déjà vus gardent leur place (avec leurs données fraîches), les nouveaux
 *  arrivent au bout, les disparus s'en vont. Première liste (prev null) : l'ordre du serveur. Un tap ne tombe pas à côté. */
export function keepOrder<T extends { id: string }>(prev: readonly T[] | null, next: readonly T[]): T[] {
  if (!prev) return [...next]
  const byId = new Map(next.map((x) => [x.id, x]))
  const kept = prev.flatMap((x) => {
    const n = byId.get(x.id)
    return n ? [n] : []
  })
  const had = new Set(prev.map((x) => x.id))
  return [...kept, ...next.filter((x) => !had.has(x.id))]
}

/** Même origine que l'appli : jamais dans un cadre (la tuile weevils afficherait l'appli dans elle-même, scripts et origine
 *  compris). Sauf les pages statiques que weevils sert lui-même sous /api/site/ : en bac à sable (CSP sans allow-same-origin),
 *  elles n'ont pas l'origine de l'appli. */
export function sameOrigin(url: string, origin: string): boolean {
  try {
    const u = new URL(url, origin)
    return u.origin === origin && !u.pathname.startsWith('/api/site/')
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Petits morceaux.

/** Tourne : un carré plein vert fluo ; démarre : le même qui clignote ; en échec : un « ! » d'encre. Aucun mot. */
function RunMark({ run }: { run: Software['run'] }) {
  if (run === 'running' || run === 'starting') return <span className={`sw-run ${run === 'starting' ? 'blink' : ''}`} aria-hidden />
  if (run === 'failed')
    return (
      <span className="sw-run fail" aria-hidden>
        <Icon name="bang" />
      </span>
    )
  return null
}

/** Trois segments d'encre, une couleur fixe par phase (la même partout) : pleins avant, au pourcentage dans la phase, vides après. */
function Segments({ progress }: { progress: Pick<Progress, 'phase' | 'percent'> }) {
  return (
    <>
      {([1, 2, 3] as const).map((k) => (
        <span key={k} className={`sw-seg ph${k}`}>
          <span style={{ width: `${segFill(k, progress.phase, progress.percent)}%` }} />
        </span>
      ))}
    </>
  )
}

export function PhaseBar({ progress }: { progress: Progress }) {
  const t = useT(M)
  return (
    <span className="sw-phase" role="img" aria-label={t.progress(progress.phase, progress.percent)}>
      <Segments progress={progress} />
      {progress.source === 'user' && <span className="sw-mark" aria-hidden />}
    </span>
  )
}

/** La grande barre de la page d'un logiciel : un tap la règle là où il tombe, un appui long revient à l'estimation. */
function PhaseFix({ progress, onFix, onReset }: { progress: Progress; onFix: (p: { phase: Phase; percent: number }) => void; onReset: () => void }) {
  const t = useT(M)
  const timer = useRef<number | undefined>(undefined)
  const long = useRef(false)
  /** Point de départ de l'appui ; moved : le doigt (ou la souris) a glissé, ni appui long ni correction. */
  const start = useRef<{ x: number; y: number } | null>(null)
  const moved = useRef(false)
  const cancel = () => window.clearTimeout(timer.current)
  useEffect(() => cancel, [])
  const down = (e: PointerEvent<HTMLDivElement>) => {
    long.current = false
    moved.current = false
    start.current = { x: e.clientX, y: e.clientY }
    cancel()
    timer.current = window.setTimeout(() => {
      long.current = true
      onReset()
    }, 650)
  }
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const s0 = start.current
    if (!s0 || moved.current) return
    if (Math.hypot(e.clientX - s0.x, e.clientY - s0.y) > 8) {
      moved.current = true
      cancel()
    }
  }
  const click = (e: MouseEvent<HTMLDivElement>) => {
    cancel()
    start.current = null
    // Appui long déjà traité ; glissé ; clic au clavier (detail 0) : pas de position, les flèches s'en chargent.
    if (long.current || moved.current || e.detail === 0) return
    const r = e.currentTarget.getBoundingClientRect()
    onFix(tapToFix(e.clientX - r.left, r.width))
  }
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 5 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -5 : 0
    if (!d) return
    e.preventDefault()
    onFix(fromLinear(linear(progress) + d))
  }
  return (
    <div className="sw-fix">
      <div
        className="sw-phase big"
        role="slider"
        tabIndex={0}
        aria-valuemin={0}
        aria-valuemax={300}
        aria-valuenow={linear(progress)}
        aria-valuetext={t.progress(progress.phase, progress.percent)}
        aria-label={t.progress(progress.phase, progress.percent)}
        aria-description={t.fix}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={cancel}
        onPointerLeave={cancel}
        onPointerCancel={cancel}
        onContextMenu={(e) => e.preventDefault()}
        onClick={click}
        onKeyDown={key}
      >
        <Segments progress={progress} />
      </div>
      {progress.source === 'user' && <button className="sw-mark" aria-label={t.corrected} onClick={onReset} />}
    </div>
  )
}

function ErrorBand({ text }: { text: string }) {
  return (
    <Notice eventId={noticeKey('error:softwares', location.pathname, location.hash, text)} className="band invert" role="alert">
      <div className="in meta" style={{ paddingBlock: 12 }}>
        ! {text}
      </div>
    </Notice>
  )
}

// ---------------------------------------------------------------------------
// La grille.

export function Tile({ sw, slot, onOpen }: { sw: Software; slot: number; onOpen: () => void }) {
  const t = useT(M)
  const ref = useRef<HTMLButtonElement>(null)
  /** La capture qui n'a pas pu se charger : la suivante (autre horodatage) retente. */
  const [broken, setBroken] = useState<number | null>(null)
  const shot = sw.shot != null && broken !== sw.shot
  return (
    <button ref={ref} className="sw" style={tint(slot)} aria-label={`${sw.name}, ${t.progress(sw.progress.phase, sw.progress.percent)}`} onClick={onOpen}>
      <span className={`sw-view ${shot ? 'has-shot' : 'no-shot'}`}>
        {shot ? (
          <img src={softwareShot(sw.id, sw.shot!)} alt="" loading="lazy" decoding="async" onError={() => setBroken(sw.shot!)} />
        ) : (
          <span className="sw-empty">{sw.kind === 'web' ? t.noPreview : t.noVisualInterface}</span>
        )}
        {shot && <RunMark run={sw.run} />}
      </span>
      <span className="sw-name">{sw.name}</span>
      {sw.blurb && <span className="sw-blurb">{sw.blurb}</span>}
      <span className="sw-state">{t[sw.run]}</span>
      <span className="sw-progress-label">{t.phaseName(sw.progress.phase)}</span>
      <PhaseBar progress={sw.progress} />
    </button>
  )
}

/** La page des logiciels est-elle celle du dessus (sinon, inutile de relire la liste) ? */
const onTop = () => !![...document.querySelectorAll('.page')].at(-1)?.querySelector('.sw-grid')

export function SoftwaresPage() {
  const t = useT(M)
  const { push } = useApp()
  const [list, setList] = useState<Software[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  /** L'ordre affiché, et la place de couleur de chaque logiciel (donnée à la première vue, gardée tant que la page vit). */
  const order = useRef<Software[] | null>(null)
  const slots = useRef(new Map<string, number>())
  useEffect(() => {
    let off = false
    let first = true
    const load = () => {
      if (!first && (document.hidden || !onTop())) return
      first = false
      api
        .softwares()
        .then((r) => {
          if (off) return
          for (const s of r.softwares) known.set(s.id, s)
          const next = keepOrder(order.current, r.softwares)
          order.current = next
          for (const s of next) if (!slots.current.has(s.id)) slots.current.set(s.id, slots.current.size)
          setList(next)
          setErr(null)
        })
        .catch((e) => !off && setErr((e as Error).message))
    }
    load()
    const id = window.setInterval(load, 10_000)
    return () => {
      off = true
      window.clearInterval(id)
    }
  }, [])

  // Ouvrir, c'est lancer : la page suit le démarrage (le serveur répond tout de suite, run = starting).
  const open = (sw: Software) => {
    openFailed.delete(sw.id)
    push({ kind: 'software', id: sw.id })
    api
      .openSoftware(sw.id)
      .then((s) => known.set(s.id, s))
      .catch((e) => openFailed.set(sw.id, (e as Error).message))
  }

  return (
    <Shell slot="agent" kicker="weevils" title={t.title} meta={list ? t.count(list.length) : '…'}>
      {err && <ErrorBand text={err} />}
      <div className="sw-grid">
        {list?.map((sw) => (
          <Tile key={sw.id} sw={sw} slot={slots.current.get(sw.id) ?? 0} onOpen={() => open(sw)} />
        ))}
      </div>
    </Shell>
  )
}

// ---------------------------------------------------------------------------
// La page d'un logiciel : son interface en direct, ou son état et sa sortie en direct.

export function SoftwarePage({ id }: { id: string }) {
  const previewFrame = useRef<HTMLIFrameElement>(null)
  const t = useT(M)
  const gone = useGoneTitle()
  const { snap, colors } = useApp()
  const [sw, setSw] = useState<Software | null>(() => known.get(id) ?? null)
  const [missing, setMissing] = useState(false)
  const [brokenShot, setBrokenShot] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)
  /** Corrections en vol : la relecture ne remet pas l'ancienne barre sous le doigt. */
  const fixing = useRef(0)
  /** Numéro de la dernière correction envoyée : seule sa réponse s'applique (taps rapides, flèche maintenue). */
  const fixSeq = useRef(0)

  useEffect(() => {
    let off = false
    /** Relectures qui se chevauchent : une réponse plus ancienne que celle déjà appliquée est jetée. */
    let sent = 0
    let applied = 0
    const tick = () => {
      const failed = openFailed.get(id)
      if (failed) {
        openFailed.delete(id)
        setErr(failed)
      }
      if (document.hidden) return
      const mine = ++sent
      const fixAt = fixSeq.current
      api
        .software(id)
        .then((s) => {
          if (off || mine < applied) return
          applied = mine
          known.set(s.id, s)
          setMissing(false)
          // Une correction en vol, ou partie depuis la demande : la barre reste celle du doigt.
          const keep = fixing.current > 0 || fixSeq.current !== fixAt
          setSw((prev) => (keep && prev ? { ...s, progress: prev.progress } : s))
        })
        .catch((e) => {
          if (off) return
          if (e instanceof ApiError && e.status === 404) setMissing(true)
        })
    }
    tick()
    const timer = window.setInterval(tick, 1500)
    return () => {
      off = true
      window.clearInterval(timer)
    }
  }, [id])

  if (!sw) {
    return (
      <Shell slot="agent" kicker={t.kicker} title={missing ? gone : '…'}>
        {err && <ErrorBand text={err} />}
        {missing && <GoneBack />}
      </Shell>
    )
  }

  // La couleur du projet quand le logiciel en est un ; sinon celle de weevils.
  const names = new Set([sw.repo, ...sw.repos].filter(Boolean).map(base))
  const project = snap.projects.find((p) => p.repos.some((r) => names.has(r)))
  const slot = (project && colors[project.id]) || 'agent'

  const send = async (fix: { phase?: Phase; percent?: number; reset?: boolean }) => {
    setErr(null)
    fixing.current++
    const mine = ++fixSeq.current
    if (!fix.reset && fix.phase) setSw((s) => (s ? { ...s, progress: { ...s.progress, phase: fix.phase!, percent: fix.percent ?? 0, source: 'user', at: Date.now() } } : s))
    try {
      const s = await api.fixProgress(id, fix)
      // Une correction plus récente est partie entre-temps : sa réponse (ou son état optimiste) fait foi.
      if (mine !== fixSeq.current) return
      known.set(s.id, s)
      setSw(s)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      fixing.current--
    }
  }
  const stop = async () => {
    setErr(null)
    try {
      const s = await api.stopSoftware(id)
      known.set(s.id, s)
      setSw(s)
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const live = sw.run === 'running' || sw.run === 'starting'
  // Seul ce que weevils a lancé lui-même s'arrête d'ici : pas ce qu'un service ou un conteneur fait tourner en permanence.
  const canStop = live && !!sw.owned
  const frame = !!sw.url && !!sw.embeddable && sw.run !== 'starting' && !sameOrigin(sw.url, location.origin)
  const meta = [t[sw.run], sw.blurb].filter(Boolean).join(' · ')

  return (
    <Shell slot={slot} kicker={t.kicker} title={sw.name} meta={meta}
      foot={sw.url ? <PreviewChat key={sw.id} viewerId={`software:${sw.id}`} projectId={project?.id} repo={sw.repo ? base(sw.repo) : undefined} frame={previewFrame} /> : undefined}>
      {err && <ErrorBand text={err} />}
      <div className="band tone">
        <div className="in sw-tools">
          <PhaseFix progress={sw.progress} onFix={(p) => void send(p)} onReset={() => void send({ reset: true })} />
          {sw.url && (
            <a className="key" href={sw.url} target="_blank" rel="noreferrer" aria-label={t.openTab}>
              <Icon name="external" />
            </a>
          )}
          {canStop && (
            <button className="key" aria-label={t.stop} onClick={() => void stop()}>
              <Icon name="pause" />
            </button>
          )}
        </div>
        {sw.progress.reason && <div className="in meta sw-reason">{sw.progress.reason}</div>}
      </div>
      {frame && (
        <div className="sw-frame">
          <iframe
            ref={previewFrame}
            key={sw.url}
            src={sw.url}
            title={t.frame}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            allow="clipboard-write; fullscreen"
            referrerPolicy="no-referrer"
          />
        </div>
      )}
      {!frame && sw.url && sw.run !== 'starting' && sw.shot != null && brokenShot !== sw.shot && (
        <a className="sw-shot" href={sw.url} target="_blank" rel="noreferrer" aria-label={t.openTab}>
          <img src={softwareShot(sw.id, sw.shot)} alt={t.shot(sw.name)} onError={() => setBrokenShot(sw.shot!)} />
        </a>
      )}
      {!frame && (sw.shot == null || brokenShot === sw.shot) && <div className="in sw-empty-detail">{sw.kind === 'web' ? t.noPreview : t.noVisualInterface}</div>}
    </Shell>
  )
}
