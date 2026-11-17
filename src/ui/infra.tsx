import { noticeKey } from '../../shared/notices.ts'
import { Notice } from './notice'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { DiskView, FsListing, InfraDetail, InfraPoint, Level, QuotaInfo, QuotaWindow, SpendSummary, UsageInfo, UsageToday } from '../../shared/infra.ts'
import { api, type FileContent } from '../api'
import { intlLocale, useT } from '../i18n'
import M from '../i18n/infra'
import { useApp } from './app-context'
import { Line, SessionRow } from './bits'
import { modelLabel } from './settings'
import { CodeFile } from './codeview'
import { ago, durLong } from './format'
import { Icon } from './icons'
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
        <span className="strong">{label}</span>
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
const dayName = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(intlLocale(), { weekday: 'short' })

// ---------------------------------------------------------------- où va le disque (mesures en lecture seule, toutes les 6 h)

/** « 14:30 », ou « mar. 14:30 » au-delà de 20 h d'écart. */
function stamp(t: number, now: number) {
  const d = new Date(t)
  const time = d.toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit' })
  return Math.abs(now - t) > 20 * 3600_000 ? `${d.toLocaleDateString(intlLocale(), { weekday: 'short' })} ${time}` : time
}

const SHOWN = 8

export function DiskSpace({ v, open }: { v: DiskView; open: (path: string) => void }) {
  const t = useT(M)
  const now = Date.now()
  const next = v.next ? stamp(v.next, now) : ''
  const share = (b: number) => (v.used ? Math.round((b / v.used) * 100) : 0)
  const shown = v.folders.slice(0, SHOWN)
  const smaller = v.folders.slice(SHOWN)
  const name = (f: DiskView['folders'][number]) =>
    f.kind === 'rest' ? t.diskRest(f.inside.length > 0) : f.kind === 'swap' ? t.diskSwap : f.kind === 'system' ? t.diskSystem(f.name) : f.name
  const inside = (f: DiskView['folders'][number]) =>
    f.kind === 'rest'
      ? f.inside.length
        ? t.diskDockerSays(f.inside.filter((i) => i.bytes >= 100 * 1024 ** 2).map((i) => `${t.diskDocker(i.name)} ${t.size(i.bytes)}${(i.reclaimable ?? 0) >= 1024 ** 3 ? ` (${t.diskFreeable(t.size(i.reclaimable!))})` : ''}`).join(' · '))
        : ''
      : f.inside.map((i) => `${i.name} ${t.size(i.bytes)}`).join(' · ')
  const where = (g: { name: string; parent?: string; kind?: string; loose?: boolean }) =>
    g.kind === 'rest' ? t.diskRest(v.folders.some((f) => f.kind === 'rest' && f.inside.length > 0)) : g.kind === 'swap' ? t.diskSwap : g.kind === 'system' ? t.diskSystem(g.name) : g.kind === 'loose' || g.loose ? t.diskLoose(g.name) : g.name
  return (
    <div className="disk-space">
      <div className="in label">{t.diskWhere}</div>
      {!v.at && <div className="in meta disk-note">{v.measuring ? t.diskMeasuring : t.diskFirst(next)}</div>}
      {shown.map((f) => {
        const body = (
          <>
            <div className="stat-h">
              <span className="strong ellipsis">{name(f)}</span>
              <span className="meta">{t.size(f.bytes)}</span>
            </div>
            <Gauge pct={share(f.bytes)} level="ok" />
            {inside(f) && <div className="meta disk-inside">{inside(f)}</div>}
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
      {smaller.length > 0 && <div className="in meta disk-note">{t.diskSmaller(smaller.length, t.size(smaller.reduce((a, f) => a + f.bytes, 0)))}</div>}
      {v.at && <div className="in meta disk-note">{v.measuring ? t.diskMeasuring : t.diskMeasured(stamp(v.at, now), next)}</div>}

      {v.at && <div className="in label">{t.diskGrowing}</div>}
      {v.at && !v.growth && <div className="in disk-later">{t.diskGrowthLater(next)}</div>}
      {v.growth && v.growth.items.length === 0 && <div className="in disk-later">{t.diskStable(stamp(v.growth.since, now))}</div>}
      {v.growth?.items.map((g) => (
        <Kv
          key={`${g.kind}:${g.parent ?? ''}:${g.name}`}
          k={[where(g), g.parent ? t.diskIn(g.parent) : ''].filter(Boolean).join(' · ')}
          v={t.diskPerDay(t.size(g.perDay))}
          onClick={g.path ? () => open(g.path!) : undefined}
        />
      ))}
      {v.growth && Math.abs(v.growth.perDay) >= 50 * 1024 ** 2 && (
        <div className="in meta disk-note">{t.diskWhole(v.growth.perDay > 0 ? t.diskPerDay(t.size(v.growth.perDay)) : `−${t.size(-v.growth.perDay)}`, stamp(v.growth.since, now))}</div>
      )}
      {!v.growth && v.recent.length > 0 && (
        <>
          <div className="in label">{t.diskRecent}</div>
          <div className="in meta disk-note">{t.diskRecentMeta}</div>
          {v.recent.map((r) => (
            <Kv key={`${r.parent ?? ''}/${r.name}`} k={[where(r), r.parent ? t.diskIn(r.parent) : ''].filter(Boolean).join(' · ')} v={t.size(r.bytes)} onClick={r.path ? () => open(r.path!) : undefined} />
          ))}
        </>
      )}
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
            <div className="in label">{t.machineLabel}</div>
            <Kv k={f.provider ? t.host : t.hardware} v={f.provider ?? f.hardware} />
            <Kv k={t.offer} v={offer?.plan ? `${offer.plan}${offer.price != null ? ` · ${t.perMonth(money(offer.price, offer.currency))}` : ''}` : null} onClick={offer?.url ? () => window.open(offer.url!, '_blank', 'noopener') : undefined} />
            <Kv k={t.cpu} v={`${t.cores(x.cores)}${f.cpuModel ? ` · ${f.cpuModel}` : ''}`} />
            <Kv k={t.mem} v={t.size(x.memTotal)} />
            <Kv k={t.disk} v={x.diskTotal ? t.size(x.diskTotal) : null} />
            <Kv k={t.system} v={f.os} />
            <Kv k={t.region} v={place} />
            <Kv k={t.network} v={f.network} />
            <Kv k={t.upSince} v={durLong(x.uptime)} />
            {x.weevboss && (
              <div className="in kv">
                <span className="v">{t.bossHere}</span>
              </div>
            )}

            <div className="in label">{t.loadLabel}</div>
            <Stat label={t.cpu} pct={x.cpu} level={levelOf1(x.cpu, 'cpu')} text={`${x.cpu} %`} />
            <Stat label={t.mem} pct={pct(x.memUsed, x.memTotal)} level={levelOf1(pct(x.memUsed, x.memTotal), 'mem')} text={t.of(t.size(x.memUsed), t.size(x.memTotal))} />
            {x.diskTotal > 0 && <Stat label={t.disk} pct={pct(x.diskUsed, x.diskTotal)} level={pct(x.diskUsed, x.diskTotal) >= 92 ? 'crit' : pct(x.diskUsed, x.diskTotal) >= 85 ? 'warn' : 'ok'} text={t.of(t.size(x.diskUsed), t.size(x.diskTotal))} />}

            {x.consumers.length > 0 && <div className="in label">{t.consumers}</div>}
            {x.consumers.map((c, i) => (
              <Line
                key={`${c.kind}:${c.label}:${i}`}
                ch={c.kind === 'session' ? '*' : c.kind === 'container' ? '#' : '·'}
                go={c.sessionId ? '→' : null}
                onClick={c.sessionId ? () => push({ kind: 'session', id: c.sessionId! }) : undefined}
                meta={[`${t.size(c.mem)} · ${c.cpu} % CPU`, ...c.parts].join(' · ')}
              >
                <span className="strong">{c.label}</span>
                {c.count > 1 ? ` ×${c.count}` : ''}
              </Line>
            ))}

            {x.day.length > 1 && <div className="in label">{t.today}</div>}
            {x.day.length > 1 && <DayChart points={x.day} episodes={x.episodes} />}
            {x.episodes.map((e) => (
              <div key={e.from} className="in row-static">
                <span className="st lv-text-crit" aria-hidden>
                  <Icon name="bang" />
                </span>
                <span className="stack-text">
                  <span className="strong">
                    {hhmm(e.from)}–{hhmm(e.to)}
                    {e.culprit ? ` · ${e.culprit}` : ''}
                  </span>
                  <span className="meta">{t.episode(e.cpu, e.mem)}</span>
                </span>
              </div>
            ))}

            {x.days.length > 1 && <div className="in label">{t.days(x.days.length)}</div>}
            {x.days.length > 1 &&
              x.days.map((y) => (
                <Kv key={y.day} k={dayName(y.day)} v={t.dayLine(y.cpu, y.cpuMax, y.mem, y.memMax)} />
              ))}

            {x.advice.length > 0 && <div className="in label">{t.advice}</div>}
            {x.advice.map((a) => (
              <div key={a} className="in advice">
                {a}
              </div>
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
  return (
    <>
      <div className="in label">
        {name}
        {q?.plan ? ` · ${planName(q.plan)}` : ''}
      </div>
      {!q && <div className="in meta empty">…</div>}
      {/* Never an empty section: no figures yet (an error, or an answer with no window) says so; old ones say their age. */}
      {q && !q.windows.length && <div className="in meta empty" role="status">{t.notYet}</div>}
      {q?.ok && q.windows.length > 0 && (q.stale || now - q.at > STALE_MS) && <div className="in meta stale">{t.lastKnown(ago(now - q.at))}</div>}
      {q?.windows.map((w) => (
        <div key={`${w.kind}${w.label ?? ''}`} className={`in stat ${w.kind === 'model' ? 'minor' : ''}`}>
          <div className="stat-h">
            <span className="strong">
              {label(w)} <span className={`lv-text-${quotaLevel(w.percent)}`}>{w.percent} %</span>
            </span>
            <span className="meta">{w.resetsAt ? t.resets(when(w.resetsAt, now)) : ''}</span>
          </div>
          <Gauge pct={w.percent} level={quotaLevel(w.percent)} className="big" />
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

/** L'entrée « abonnement » de la bande du bas : semaine et 5 h de Claude, Codex, et une barre pour le plus proche de la limite. */
export function UsageLine() {
  const t = useT(M)
  const { push } = useApp()
  const u = useQuotas()
  const cw = pick(u?.claude, 'week')
  const c5 = pick(u?.claude, 'session')
  const xw = pick(u?.codex, 'week') ?? pick(u?.codex, 'session')
  // One figure per tool: Claude's week (its 5 h window stays on the subscription page), Codex's nearest limit.
  const parts = [cw != null ? t.weekBrief('Claude', cw) : c5 != null ? t.toolPct('Claude', c5) : '', xw != null ? t.toolPct('Codex', xw) : ''].filter(Boolean)
  const top = Math.max(-1, ...[u?.claude, u?.codex].flatMap((q) => (q?.ok ? q.windows.filter((w) => w.kind !== 'model').map((w) => w.percent) : [])))
  return (
    <Line
      ch="%"
      className="usage-line"
      meta={
        u ? (
          <>
            {parts.join(' · ')}
            {top >= 0 && <Gauge pct={top} level={quotaLevel(top)} />}
          </>
        ) : (
          '…'
        )
      }
      onClick={() => push({ kind: 'usage' })}
    >
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
  if (!s?.burn) return null
  const usd = (n: number) => (n >= 100 ? Math.round(n).toString() : n.toFixed(1))
  const lines: string[] = []
  if (s.perPercent && s.pctPerHour && s.weekPercentNow != null) {
    const p = s.pctPerHour.fiveHours
    lines.push(p < 0.05 ? t.paceIdle : t.paceHour(p < 1 ? p.toFixed(2) : p.toFixed(1)))
    if (p >= 0.05) lines.push(s.limitAt ? t.limitAt(when(s.limitAt, now), durLong(s.limitAt - now)) : t.lastsWeek(when(s.week.end, now)))
    lines.push(t.estNow(Math.min(100, Math.round(s.weekPercentNow)), usd(s.week.cost)))
  } else lines.push(t.paceUncal(usd(s.burn.fiveHours)))
  return (
    <>
      <div className="in label">{t.pace}</div>
      {lines.map((l) => (
        <div key={l} className="in meta">
          {l}
        </div>
      ))}
    </>
  )
}

/** « claude-opus-5-5 » → « opus 5.5 » ; les autres noms tels quels. */
const modelName = (m: string) => modelLabel(m) ?? m

export function UsagePage() {
  const { snap, push, colors } = useApp()
  const t = useT(M)
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
  const byModel = useMemo(() => {
    const m = new Map<string, { weight: number }>()
    for (const r of today?.models ?? []) {
      const k = `${r.tool}:${modelName(r.model)}`
      const p = m.get(k) ?? { weight: 0 }
      p.weight += r.weight
      m.set(k, p)
    }
    return [...m].sort((a, b) => b[1].weight - a[1].weight)
  }, [today])
  const byProject = useMemo(() => {
    const m = new Map<string, { weight: number }>()
    for (const r of rows ?? []) {
      const p = m.get(r.projectId) ?? { weight: 0 }
      p.weight += r.weight
      m.set(r.projectId, p)
    }
    return [...m].sort((a, b) => b[1].weight - a[1].weight)
  }, [rows])
  const share = (w: number) => (total ? Math.round((w / total) * 100) : 0)
  const projectName = (id: string) => snap.projects.find((p) => p.id === id)?.name ?? id
  const known = new Set(snap.sessions.map((s) => s.id))
  return (
    <Shell slot="agent" kicker="weevils" title={t.usageTitle}>
      <div className="ipage">
        <Quota name="Claude" q={u?.claude} />
        <Pace />
        <Quota name="Codex" q={u?.codex} />

        {byModel.length > 0 && <div className="in label">{t.byModel}</div>}
        {byModel.map(([k, p]) => (
          <div key={k} className="in stat share">
            <div className="stat-h">
              <span className="strong">{k.slice(k.indexOf(':') + 1)}</span>
              <span className="meta">
                {t.share(share(p.weight))}
              </span>
            </div>
            <Gauge pct={share(p.weight)} level="ok" className="big" />
          </div>
        ))}

        <div className="in label">{t.byProject}</div>
        {!rows && <div className="in meta empty">{t.reading}</div>}
        {rows && !rows.length && <div className="in meta empty">{t.nobody}</div>}
        {byProject.map(([id, p]) => (
          <div key={id} className="in stat share" style={{ ['--bar' as string]: colors[id] ? `var(--${colors[id]})` : undefined }}>
            <div className="stat-h">
              <span className="strong">{projectName(id)}</span>
              <span className="meta">{t.share(share(p.weight))}</span>
            </div>
            <Gauge pct={share(p.weight)} level="ok" className="big" />
          </div>
        ))}

        {rows && rows.length > 0 && <div className="in label">{t.bySession}</div>}
        {rows?.slice(0, 40).map((r) => (
          <Line
            key={`${r.machine}:${r.id}`}
            ch="*"
            meta={`${projectName(r.projectId)} · ${t.share(share(r.weight))}`}
            go={known.has(r.id) ? '→' : null}
            onClick={known.has(r.id) ? () => push({ kind: 'session', id: r.id }) : undefined}
          >
            {snap.sessions.find((s) => s.id === r.id)?.title ?? r.title}
          </Line>
        ))}
      </div>
    </Shell>
  )
}
