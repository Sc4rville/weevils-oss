import { noticeKey } from '../../shared/notices.ts'
import { Notice } from './notice'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { DiskView, FsListing, InfraDetail, InfraPoint, Level, QuotaInfo, QuotaWindow, SpendSummary, UsageInfo, UsageToday } from '../../shared/infra.ts'
import { api, type FileContent } from '../api'
import { intlLocale, useT } from '../i18n'
import M from '../i18n/infra'
import RM from '../i18n/relay'
import { useApp } from './app-context'
import { Line, SessionRow } from './bits'
import { CodeFile } from './codeview'
import { ago, durLong } from './format'
import { Shell } from './shell'
import { askSetup } from './setup'
import './infra.css'

const quotaLevel = (p: number): Level => (p >= 90 ? 'crit' : p >= 75 ? 'warn' : 'ok')

/** « 16:00 », ou « jeu. 16:00 » au-delà de 20 h. */
function when(t: number | null, now: number) {
  if (!t) return ''
  const d = new Date(t)
  const time = d.toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit' })
  return t - now > 20 * 3600_000 ? `${d.toLocaleDateString(intlLocale(), { weekday: 'short' })} ${time}` : time
}

const levelOf1 = (v: number, k: 'cpu' | 'mem'): Level => (k === 'cpu' ? (v >= 90 ? 'crit' : v >= 70 ? 'warn' : 'ok') : v >= 92 ? 'crit' : v >= 80 ? 'warn' : 'ok')

/** Une jauge (pages machine et abonnement) : remplie de la couleur de l'encre, orange puis rouge près de la limite. */
function Gauge({ pct, level, className = '' }: { pct: number; level: Level; className?: string }) {
  return (
    <span className={`gauge ${className}`} aria-hidden>
      <span className={`lv-${level}`} style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
    </span>
  )
}

// ---------------------------------------------------------------- page machine (fusionnée avec l'ancienne page « @ »)

function Stat({ label, pct, level, text }: { label: string; pct: number | null; level: Level; text: string }) {
  return (
    <div className="in stat">
      <div className="stat-h">
        <span>{label}</span>
        <span className="meta">{text}</span>
      </div>
      {pct != null && <Gauge pct={pct} level={level} className="big" />}
    </div>
  )
}

/** La journée : la mémoire en aplat, le CPU en trait, les saturations en blocs rouges en bas, le pic marqué. */
function DayChart({ points, episodes }: { points: InfraPoint[]; episodes: InfraDetail['episodes'] }) {
  const t = useT(M)
  const W = 288
  const H = 64
  const d0 = new Date()
  d0.setHours(0, 0, 0, 0)
  const start = d0.getTime()
  const x = (at: number) => ((at - start) / 86400_000) * W
  const y = (v: number) => H - (Math.min(100, v) / 100) * (H - 4)
  if (!points.length) return <div className="in meta empty">{t.noMeasure}</div>
  const mem = `M${x(points[0].at)} ${H}` + points.map((p) => `L${x(p.at).toFixed(1)} ${y(p.mem).toFixed(1)}`).join('') + `L${x(points[points.length - 1].at + 300_000)} ${H}Z`
  const cpu = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.at).toFixed(1)} ${y(p.cpuMax).toFixed(1)}`).join('')
  const peak = points.reduce((a, b) => (b.cpuMax > a.cpuMax ? b : a))
  return (
    <div className="in chart">
      <svg viewBox={`0 0 ${W} ${H + 12}`} preserveAspectRatio="none" aria-hidden>
        <path d={mem} className="c-mem" />
        <path d={cpu} className="c-cpu" vectorEffect="non-scaling-stroke" />
        {episodes.map((e) => (
          <rect key={e.from} x={x(e.from)} y={H + 2} width={Math.max(2, x(e.to) - x(e.from))} height={6} className="lv-crit" />
        ))}
        <rect x={x(peak.at) - 2} y={y(peak.cpuMax) - 2} width={4} height={4} className="c-peak" />
      </svg>
      <div className="chart-h meta" aria-hidden>
        {[0, 6, 12, 18, 24].map((h) => (
          <span key={h}>{h}</span>
        ))}
      </div>
    </div>
  )
}

/** A local server by what it serves: the project folder's name (« mygame »), else the program (« caddy »); never the port. */
const serverName = (s: { name: string; dir?: string }) => (s.dir ? s.dir.replace(/\/+$/, '').split('/').pop() || s.name : s.name)

const hhmm = (t: number) => new Date(t).toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit' })

/** Une ligne « clé · valeur », la valeur en gras ; absente quand la valeur est inconnue. */
function Kv({ k, v, onClick }: { k: string; v: ReactNode; onClick?: () => void }) {
  if (v == null || v === '' || v === false) return null
  const body = (
    <>
      <span className="meta">{k}</span>
      <span className="v">{v}</span>
    </>
  )
  return onClick ? (
    <button className="in kv tap" onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className="in kv">{body}</div>
  )
}

const money = (n: number, cur: string | null) => `${Math.round(n * 100) / 100} ${cur ?? ''}`.trim()

// ---------------------------------------------------------------- où va le disque (mesures en lecture seule, toutes les 6 h)

const SHOWN = 8

/** Where the disk goes: the biggest folders, one row each (a tap opens it), then what grows by the day. Nothing
 *  before the first measurement: no note about when it will come. */
export function DiskSpace({ v, open }: { v: DiskView; open: (path: string) => void }) {
  const t = useT(M)
  if (!v.at) return null
  const share = (b: number) => (v.used ? Math.round((b / v.used) * 100) : 0)
  const name = (f: DiskView['folders'][number]) =>
    f.kind === 'rest' ? t.diskRest(f.inside.length > 0) : f.kind === 'swap' ? t.diskSwap : f.kind === 'system' ? t.diskSystem(f.name) : f.name
  const where = (g: { name: string; parent?: string; kind?: string; loose?: boolean }) =>
    g.kind === 'rest' ? t.diskRest(v.folders.some((f) => f.kind === 'rest' && f.inside.length > 0)) : g.kind === 'swap' ? t.diskSwap : g.kind === 'system' ? t.diskSystem(g.name) : g.kind === 'loose' || g.loose ? t.diskLoose(g.name) : g.name
  const growing = v.growth?.items ?? []
  return (
    <div className="disk-space">
      <div className="in label">{t.diskWhere}</div>
      {v.folders.slice(0, SHOWN).map((f) => {
        const body = (
          <>
            <div className="stat-h">
              <span className="ellipsis">{name(f)}</span>
              <span className="meta">{t.size(f.bytes)}</span>
            </div>
            <Gauge pct={share(f.bytes)} level="ok" />
          </>
        )
        return f.path ? (
          <button key={`${f.kind}:${f.name}`} className="in stat share disk-row" onClick={() => open(f.path!)}>
            {body}
          </button>
        ) : (
          <div key={`${f.kind}:${f.name}`} className="in stat share disk-row">
            {body}
          </div>
        )
      })}

      {growing.length > 0 && <div className="in label">{t.diskGrowing}</div>}
      {growing.map((g) => (
        <Kv key={`${g.kind}:${g.parent ?? ''}:${g.name}`} k={where(g)} v={t.diskPerDay(t.size(g.perDay))} onClick={g.path ? () => open(g.path!) : undefined} />
      ))}
    </div>
  )
}

export function InfraPage({ machine, projectId }: { machine?: string; projectId?: string }) {
  const { snap, push } = useApp()
  const t = useT(M)
  const fromProject = projectId ? snap.sessions.find((s) => s.projectId === projectId)?.machineId : undefined
  const [id, setId] = useState(machine ?? fromProject ?? snap.machines[0]?.id ?? '')
  const [d, setD] = useState<InfraDetail | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let off = false
    setErr(null)
    const load = () => api.infra(id).then((x) => !off && (setD(x), setErr(null))).catch((e) => !off && setErr((e as Error).message))
    void load()
    const tm = setInterval(load, 20_000)
    return () => {
      off = true
      clearInterval(tm)
    }
  }, [id])
  const m = snap.machines.find((x) => x.id === id)
  // Changement de machine : la fiche précédente reste affichée, en retrait, jusqu'à l'arrivée de la nouvelle (pas de
  // page vide puis tout d'un coup).
  const x = d
  const stale = !!d && d.id !== id
  const page = useRef<HTMLDivElement>(null)
  const f = x?.facts
  const sessions = snap.sessions.filter((s) => s.machineId === id && s.status !== 'done')
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0)
  const place = f ? [f.city, f.region !== f.city ? f.region : undefined, f.country].filter(Boolean).join(', ') : ''
  const offer = x?.offer
  // La première ligne sous le titre : qui l'héberge (ou quel matériel), l'offre, où.
  const headline = f && !stale ? [f.provider ?? f.hardware, offer?.plan, place].filter(Boolean).join(' · ') : ''
  // Une relecture (toutes les 20 s) qui échoue alors que la fiche est là : un mot dans l'en-tête, pas une bande en haut
  // de page, hors de vue si on a défilé.
  const failed = err && x && !stale ? `! ${t.notFresh}` : ''
  return (
    <Shell slot="agent" kicker="weevils" title={m?.name ?? id} meta={[headline || (m?.online === false ? t.offline : ''), failed].filter(Boolean).join(' · ') || undefined}>
      <div ref={page} className="ipage">
        {snap.machines.length > 1 && (
          <div className="in mx-tabs">
            {snap.machines.map((y) => (
              <button key={y.id} className={`mx-tab ${y.id === id ? 'on' : ''} ${y.online === false ? 'off' : ''}`} onClick={() => {
                  if (y.id === id) return
                  setId(y.id)
                  const sc = page.current?.closest('[data-scroll]')
                  if (sc && sc.scrollTop > 0) sc.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
                }}
                aria-pressed={y.id === id}>
                {y.name}
              </button>
            ))}
          </div>
        )}
        {err && (!x || stale) && (
          <Notice eventId={noticeKey('error:infra', location.pathname, location.hash, err)} className="band invert" role="alert">
            <div className="in meta" style={{ paddingBlock: 12 }}>
              {t.cantRead}
            </div>
          </Notice>
        )}
        {x && f && !(stale && err) && (
          <div className={`mx-detail ${stale ? 'stale' : ''}`} aria-busy={stale}>
            {/* What needs doing first (swap full, disk nearly full…), one bold row each. */}
            {x.advice.map((a) => (
              <div key={a} className="in advice">
                {a}
              </div>
            ))}
            {/* Each resource once: its use now, its size, a bar. The old « machine » block repeated the sizes. */}
            <Stat label={t.cpu} pct={x.cpu} level={levelOf1(x.cpu, 'cpu')} text={`${x.cpu} % · ${t.cores(x.cores)}`} />
            <Stat label={t.mem} pct={pct(x.memUsed, x.memTotal)} level={levelOf1(pct(x.memUsed, x.memTotal), 'mem')} text={t.of(t.size(x.memUsed), t.size(x.memTotal))} />
            {x.diskTotal > 0 && <Stat label={t.disk} pct={pct(x.diskUsed, x.diskTotal)} level={pct(x.diskUsed, x.diskTotal) >= 92 ? 'crit' : pct(x.diskUsed, x.diskTotal) >= 85 ? 'warn' : 'ok'} text={t.of(t.size(x.diskUsed), t.size(x.diskTotal))} />}
            <Kv k={f.provider ? t.host : t.hardware} v={f.provider ?? f.hardware} />
            <Kv k={t.offer} v={offer?.plan ? `${offer.plan}${offer.price != null ? ` · ${t.perMonth(money(offer.price, offer.currency))}` : ''}` : null} onClick={offer?.url ? () => window.open(offer.url!, '_blank', 'noopener') : undefined} />
            <Kv k={t.system} v={f.os?.replace(/\s*\([^)]*\)\s*$/, '')} />
            <Kv k={t.upSince} v={durLong(x.uptime)} />

            {x.consumers.length > 0 && <div className="in label">{t.consumers}</div>}
            {x.consumers.map((c, i) => (
              <Line
                key={`${c.kind}:${c.label}:${i}`}
                go={c.sessionId ? '→' : null}
                onClick={c.sessionId ? () => push({ kind: 'session', id: c.sessionId! }) : undefined}
                value={`${t.size(c.mem)} · ${c.cpu} %`}
              >
                {c.label}
                {c.count > 1 ? ` ×${c.count}` : ''}
              </Line>
            ))}

            {x.day.length > 1 && <div className="in label">{t.today}</div>}
            {x.day.length > 1 && <DayChart points={x.day} episodes={x.episodes} />}
            {x.episodes.map((e) => (
              <Kv key={e.from} k={`${hhmm(e.from)}–${hhmm(e.to)}`} v={e.culprit ?? t.episode(e.cpu, e.mem)} />
            ))}

            {x.diskView && !stale && <DiskSpace v={x.diskView} open={(p) => push({ kind: 'fs', machine: id, path: p })} />}
          </div>
        )}

        {sessions.length > 0 && <div className="in label">{t.sessions}</div>}
        {sessions.map((s) => (
          <SessionRow key={s.id} session={s} />
        ))}

        {x && !stale && x.servers.length > 0 && <div className="in label">{t.servers}</div>}
        {!stale && x?.servers.map((s) =>
          s.url ? (
            <Line key={s.port} ch="#" meta={s.url.replace(/^https:\/\//, '')} onClick={() => window.open(s.url, '_blank', 'noopener')} go="↑">
              <span className="strong">{serverName(s)}</span>
            </Line>
          ) : (
            <Line key={s.port} ch="#" go={s.dir ? '→' : null} onClick={s.dir ? () => push({ kind: 'fs', machine: id, path: s.dir! }) : undefined}>
              <span className="strong">{serverName(s)}</span>
            </Line>
          ),
        )}
        {/* Brancher une machine : weevboss pose les questions dans son fil (hébergeur, adresse, mot de passe), rien à taper d'autre. */}
        <Line ch="+" go="→" onClick={() => askSetup('machine')}>
          <span className="strong">{t.addLine}</span>
        </Line>
        <div style={{ height: 12 }} aria-hidden />
      </div>
    </Shell>
  )
}

// ---------------------------------------------------------------- tout le système de fichiers d'une machine

const parentOf = (p: string) => (p === '/' ? null : p.replace(/\/[^/]+\/?$/, '') || '/')
const join = (dir: string, name: string) => (dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`)
/** The folder's own name, never the full path: « /home/alex/projects » → « projects »; the root gives the machine name. */
const folderName = (dir: string, machine: string) => (dir === '/' ? machine : dir.replace(/\/+$/, '').split('/').pop() || machine)

export function FsPage({ machine, path }: { machine: string; path: string }) {
  const { snap, push } = useApp()
  const t = useT(M)
  const [l, setL] = useState<FsListing | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let off = false
    api
      .fs(machine, path)
      .then((x) => !off && setL(x))
      .catch((e) => !off && setErr((e as Error).message))
    return () => {
      off = true
    }
  }, [machine, path])
  const here = l?.path ?? path
  const parent = parentOf(here)
  const name = snap.machines.find((m) => m.id === machine)?.name ?? machine
  return (
    <Shell slot="agent" kicker={parent ? folderName(parent, name) : name} title={here === '/' ? '/' : `/${here.split('/').pop()}`} meta={l ? t.entries(l.entries.length) : t.reading}>
      <div className="ipage">
        {snap.machines.length > 1 && here === '/' && (
          <div className="in mx-tabs">
            {snap.machines.map((x) => (
              <button
                key={x.id}
                className={`mx-tab ${x.id === machine ? 'on' : ''} ${x.online === false ? 'off' : ''}`}
                onClick={() => x.id !== machine && push({ kind: 'fs', machine: x.id, path: '/' })}
                aria-pressed={x.id === machine}
              >
                {x.name}
              </button>
            ))}
          </div>
        )}
        {(err || l?.error) && (
          <Notice eventId={noticeKey('error:infra', location.pathname, location.hash, err ?? l?.error)} className="band invert" role="alert">
            <div className="in meta" style={{ paddingBlock: 12 }}>
              {t.cantOpen}
            </div>
          </Notice>
        )}
        {l && here === '/' && (
          <Line ch="/" onClick={() => push({ kind: 'fs', machine, path: l.home })}>
            <span className="strong">{t.homeFolder}</span>
          </Line>
        )}
        {l?.entries.map((e) =>
          e.dir ? (
            <Line key={e.name} ch="/" onClick={() => push({ kind: 'fs', machine, path: join(here, e.name) })}>
              <span className="strong">{e.name}/</span>
            </Line>
          ) : (
            <Line key={e.name} ch="·" meta={t.size(e.size)} onClick={() => push({ kind: 'fsfile', machine, path: join(here, e.name) })}>
              {e.name}
            </Line>
          ),
        )}
      </div>
    </Shell>
  )
}

/** Un fichier n'importe où : la vue fichier avec ses explications au tap. Dans un repo, il est ouvert comme un fichier du repo. */
export function FsFilePage({ machine, path }: { machine: string; path: string }) {
  const { snap } = useApp()
  const [file, setFile] = useState<FileContent | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let off = false
    api
      .fsFile(machine, path)
      .then((f) => !off && setFile(f))
      .catch((e) => !off && setErr((e as Error).message))
    return () => {
      off = true
    }
  }, [machine, path])
  const inRepo = /\/projects\/([\w.@+-]+)\/(.+)$/.exec(path)
  const project = inRepo ? snap.projects.find((p) => p.repos.includes(inRepo[1])) : undefined
  const dir = path.split('/').slice(0, -1).join('/') || '/'
  const name = snap.machines.find((m) => m.id === machine)?.name ?? machine
  return inRepo ? (
    <CodeFile projectId={project?.id ?? ''} repo={inRepo[1]} path={inRepo[2]} machine={machine} file={file} err={err} kicker={folderName(dir, name)} />
  ) : (
    <CodeFile projectId="" repo="" path={path} machine={machine} file={file} err={err} kicker={folderName(dir, name)} />
  )
}

// ---------------------------------------------------------------- abonnement

/** A plan as its product names it (« Max 20x », « Pro Lite »), never the raw lowercase id Codex reports (« prolite »). */
export function planName(plan: string): string {
  if (/[A-Z\s]/.test(plan)) return plan
  const known: Record<string, string> = { prolite: 'Pro Lite', plus: 'Plus', pro: 'Pro', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu', free: 'Free', go: 'Go' }
  return known[plan] ?? plan.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

function Quota({ name, q }: { name: string; q: QuotaInfo | undefined }) {
  const t = useT(M)
  const { now } = useApp()
  const label = (w: QuotaWindow) => (w.kind === 'session' ? t.session5h : w.kind === 'week' ? t.week : t.weekOf(w.label ?? ''))
  const old = q?.ok && q.windows.length > 0 && (q.stale || now - q.at > STALE_MS)
  // One heading row: the tool and its plan, and on its right what is missing (no figures yet) or how old they are.
  return (
    <>
      <div className="in label quota-head">
        <span>
          {name}
          {q?.plan ? ` · ${planName(q.plan)}` : ''}
        </span>
        <span className="meta" role={q && !q.windows.length ? 'status' : undefined}>
          {!q ? '…' : !q.windows.length ? t.notYet : old ? ago(now - q.at) : ''}
        </span>
      </div>
      {q?.windows.map((w) => (
        <div key={`${w.kind}${w.label ?? ''}`} className={`in stat ${w.kind === 'model' ? 'minor' : ''}`}>
          <div className="stat-h">
            <span>
              {label(w)} <span className={`strong lv-text-${quotaLevel(w.percent)}`}>{w.percent} %</span>
            </span>
            <span className="meta">{w.resetsAt ? t.resets(when(w.resetsAt, now)) : ''}</span>
          </div>
          <Gauge pct={w.percent} level={quotaLevel(w.percent)} />
        </div>
      ))}
    </>
  )
}

/** Figures older than this say their age. Never under 2 server periods: the server asks every 5 min but hands out the
 *  previous figures on the call that starts the new read, so with a poll a minute healthy figures reach about 7 min. */
const STALE_MS = 10 * 60_000
const USAGE_KEY = 'weevils-usage-v1'
const readUsage = (): UsageInfo | null => {
  try {
    const u = JSON.parse(localStorage.getItem(USAGE_KEY) ?? 'null')
    return u && typeof u === 'object' && u.claude && u.codex ? (u as UsageInfo) : null
  } catch {
    return null
  }
}
/** The last answer, kept on the phone too: the section opens on it at once, and keeps it while weevils restarts. */
let lastUsage: UsageInfo | null = readUsage()
/** Test hook: forget the phone's copy. */
export function forgetUsage() {
  lastUsage = null
  try {
    localStorage.removeItem(USAGE_KEY)
  } catch {
    /* unavailable storage */
  }
}
/** An answer without figures never replaces figures already known: they stay, marked old (with their age). */
const keep = (prev: QuotaInfo | undefined, next: QuotaInfo): QuotaInfo => (!next.windows.length && prev?.ok && prev.windows.length ? { ...prev, stale: true } : next)
function remember(next: UsageInfo): UsageInfo {
  const u = { ...next, claude: keep(lastUsage?.claude, next.claude), codex: keep(lastUsage?.codex, next.codex) }
  lastUsage = u
  try {
    localStorage.setItem(USAGE_KEY, JSON.stringify(u))
  } catch {
    /* unavailable storage: the memory copy still serves */
  }
  return u
}

/** Quotas Claude et Codex, relus toutes les minutes tant que la page est ouverte (le serveur ne demande qu'une fois
 *  toutes les 5 min). Une lecture ratée (weevils redémarre) réessaie 10 s plus tard ; les derniers chiffres restent. */
function useQuotas() {
  const [u, setU] = useState<UsageInfo | null>(lastUsage)
  useEffect(() => {
    let retry: ReturnType<typeof setTimeout> | undefined
    let off = false
    const load = () => {
      if (document.visibilityState !== 'visible') return
      clearTimeout(retry)
      void api
        .usage()
        .then((next) => !off && setU(remember(next)))
        .catch(() => {
          if (!off) retry = setTimeout(load, 10_000)
        })
    }
    load()
    const iv = setInterval(load, 60_000)
    document.addEventListener('visibilitychange', load)
    return () => {
      off = true
      clearTimeout(retry)
      clearInterval(iv)
      document.removeEventListener('visibilitychange', load)
    }
  }, [])
  return u
}

const pick = (q: QuotaInfo | undefined, kind: QuotaWindow['kind']) => (q?.ok ? q.windows.find((w) => w.kind === kind)?.percent : undefined)

/** The « subscriptions » row of Settings: one figure per tool, red near the limit (the page has the windows and resets). */
export function UsageLine() {
  const t = useT(M)
  const { push } = useApp()
  const u = useQuotas()
  const cw = pick(u?.claude, 'week') ?? pick(u?.claude, 'session')
  const xw = pick(u?.codex, 'week') ?? pick(u?.codex, 'session')
  const fig = (name: string, p: number | undefined) =>
    p == null ? null : (
      <span key={name} className={quotaLevel(p) === 'ok' ? '' : `lv-text-${quotaLevel(p)}`}>
        {name} {p}%
      </span>
    )
  const parts = [fig('Claude', cw), fig('Codex', xw)].filter(Boolean)
  return (
    <Line className="usage-line" value={u ? parts.flatMap((x, i) => (i ? [' · ', x] : [x])) : '…'} onClick={() => push({ kind: 'usage' })}>
      {t.usageTitle}
    </Line>
  )
}

/** Pace and forecast from the spend estimator (read-only). Hidden while the server has no such route (older weevilsd). */
function Pace() {
  const t = useT(M)
  const { now } = useApp()
  const [s, setS] = useState<SpendSummary | null>(null)
  useEffect(() => {
    let off = false
    const load = () => void Promise.resolve().then(() => api.usageSpend()).then((x) => !off && setS(x)).catch(() => {})
    load()
    const iv = setInterval(load, 60_000)
    return () => {
      off = true
      clearInterval(iv)
    }
  }, [])
  // One row, only when it says something: where this pace ends (the weekly limit, or the week holds). Idle, or not yet
  // calibrated against the weekly quota: nothing (a sentence about API prices told nobody anything).
  if (!s?.burn || !s.perPercent || !s.pctPerHour || s.weekPercentNow == null || s.pctPerHour.fiveHours < 0.05) return null
  return <Kv k={t.pace} v={s.limitAt ? t.paceLimit(when(s.limitAt, now)) : t.paceHolds} />
}

export function UsagePage() {
  const { snap, push, colors } = useApp()
  const t = useT(M)
  const rt = useT(RM)
  const u = useQuotas()
  const [today, setToday] = useState<UsageToday | null>(null)
  useEffect(() => {
    const load = () => void api.usageToday().then(setToday).catch(() => setToday((d) => d ?? { rows: [] }))
    load()
    const iv = setInterval(load, 60_000)
    return () => clearInterval(iv)
  }, [])
  const rows = today?.rows ?? null
  const total = rows?.reduce((s, r) => s + r.weight, 0) ?? 0
  const byProject = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of rows ?? []) m.set(r.projectId, (m.get(r.projectId) ?? 0) + r.weight)
    return [...m].sort((a, b) => b[1] - a[1])
  }, [rows])
  const share = (w: number) => (total ? Math.round((w / total) * 100) : 0)
  const projectName = (id: string) => snap.projects.find((p) => p.id === id)?.name ?? id
  // Each tool: its windows, then one row per setting that belongs to it (the Codex relay takes over at Claude's limit).
  return (
    <Shell slot="agent" kicker="weevils" title={t.usageTitle}>
      <div className="ipage">
        <Quota name="Claude" q={u?.claude} />
        <Pace />
        <Quota name="Codex" q={u?.codex} />
        {snap.relay && (
          <Line value={rt[`mode_${snap.relay.mode}`]} onClick={() => push({ kind: 'relay' })}>
            {rt.pref}
          </Line>
        )}

        {byProject.length > 0 && <div className="in label">{t.today}</div>}
        {byProject.map(([id, w]) => (
          <div key={id} className="in stat share" style={{ ['--bar' as string]: colors[id] ? `var(--${colors[id]})` : undefined }}>
            <div className="stat-h">
              <span>{projectName(id)}</span>
              <span className="meta">{t.share(share(w))}</span>
            </div>
            <Gauge pct={share(w)} level="ok" />
          </div>
        ))}
      </div>
    </Shell>
  )
}
