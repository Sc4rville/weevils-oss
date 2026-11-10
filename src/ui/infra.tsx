import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { FsListing, InfraDetail, InfraPoint, Level, QuotaInfo, QuotaWindow, UsageInfo, UsageRow } from '../../shared/infra.ts'
import { api, type FileContent } from '../api'
import { intlLocale, useT } from '../i18n'
import M from '../i18n/infra'
import { useApp } from './app-context'
import { Line, SessionRow } from './bits'
import { CodeFile } from './codeview'
import { durLong } from './format'
import { Icon } from './icons'
import { Shell } from './shell'
import { copyText } from './copy'
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

export function InfraPage({ machine, projectId }: { machine?: string; projectId?: string }) {
  const { snap, push } = useApp()
  const t = useT(M)
  const fromProject = projectId ? snap.sessions.find((s) => s.projectId === projectId)?.machineId : undefined
  const [id, setId] = useState(machine ?? fromProject ?? snap.machines[0]?.id ?? '')
  const [d, setD] = useState<InfraDetail | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
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
  const x = d?.id === id ? d : null
  const f = x?.facts
  const sessions = snap.sessions.filter((s) => s.machineId === id && s.status !== 'done')
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0)
  const copy = (cmd: string) => void copyText(cmd).then((ok) => ok && (setCopied(cmd), setTimeout(() => setCopied(null), 1500)))
  const place = f ? [f.city, f.region !== f.city ? f.region : undefined, f.country].filter(Boolean).join(', ') : ''
  const direct = f?.ip && f.publicIp && f.sshPort ? `ssh ${f.sshPort !== 22 ? `-p ${f.sshPort} ` : ''}${f.user}@${f.ip}` : ''
  const offer = x?.offer
  // La première ligne sous le titre : qui l'héberge (ou quel matériel), l'offre, où.
  const headline = f ? [f.provider ?? f.hardware, offer?.plan, place].filter(Boolean).join(' · ') : ''
  return (
    <Shell slot="agent" kicker="weevils" title={m?.name ?? id} meta={headline || (m?.online === false ? t.offline : undefined)}>
      <div className="ipage">
        {snap.machines.length > 1 && (
          <div className="in mx-tabs">
            {snap.machines.map((y) => (
              <button key={y.id} className={`mx-tab ${y.id === id ? 'on' : ''} ${y.online === false ? 'off' : ''}`} onClick={() => setId(y.id)} aria-pressed={y.id === id}>
                {y.name}
              </button>
            ))}
          </div>
        )}
        {err && (
          <div className="band invert" role="alert">
            <div className="in meta" style={{ paddingBlock: 12 }}>
              ! {err}
            </div>
          </div>
        )}
        {x && f && (
          <>
            <div className="in label">{t.machineLabel}</div>
            <Kv k={f.provider ? t.host : t.hardware} v={f.provider ?? f.hardware} />
            <Kv k={t.offer} v={offer?.plan ? `${offer.plan}${offer.price != null ? ` · ${t.perMonth(money(offer.price, offer.currency))}` : ''}` : null} onClick={offer?.url ? () => window.open(offer.url!, '_blank', 'noopener') : undefined} />
            <Kv k={t.cpu} v={`${t.cores(x.cores)}${f.cpuModel ? ` · ${f.cpuModel}` : ''}`} />
            <Kv k={t.mem} v={t.size(x.memTotal)} />
            <Kv k={t.disk} v={x.diskTotal ? t.size(x.diskTotal) : null} />
            <Kv k={t.system} v={[f.os, f.arch, f.virt].filter(Boolean).join(' · ')} />
            <Kv k={t.region} v={place} />
            <Kv k={t.network} v={f.network} />
            <Kv k={t.upSince} v={durLong(x.uptime)} />
            <Kv k="weevboss" v={x.weevboss ? t.here : null} />

            {(x.reach.length > 0 || direct || f.rdns) && <div className="in label">{t.connect}</div>}
            {x.reach.map((r) => (
              <Kv key={`${r.from}:${r.alias}`} k={t.from(r.from)} v={copied === `ssh ${r.alias}` ? t.copied : `ssh ${r.alias}`} onClick={() => copy(`ssh ${r.alias}`)} />
            ))}
            <Kv k={f.ip ?? ''} v={direct ? (copied === direct ? t.copied : direct) : null} onClick={() => copy(direct)} />
            <Kv k={t.rdns} v={f.rdns} />

            <div className="in label">{t.loadLabel}</div>
            <Stat label={t.cpu} pct={x.cpu} level={levelOf1(x.cpu, 'cpu')} text={`${x.cpu} % · ${t.load(...x.load)}`} />
            <Stat label={t.mem} pct={pct(x.memUsed, x.memTotal)} level={levelOf1(pct(x.memUsed, x.memTotal), 'mem')} text={t.of(t.size(x.memUsed), t.size(x.memTotal))} />
            {x.swapTotal > 0 && <Stat label={t.swap} pct={pct(x.swapUsed, x.swapTotal)} level={pct(x.swapUsed, x.swapTotal) > 50 ? 'warn' : 'ok'} text={t.of(t.size(x.swapUsed), t.size(x.swapTotal))} />}
            {x.diskTotal > 0 && <Stat label={t.disk} pct={pct(x.diskUsed, x.diskTotal)} level={pct(x.diskUsed, x.diskTotal) >= 92 ? 'crit' : pct(x.diskUsed, x.diskTotal) >= 85 ? 'warn' : 'ok'} text={t.of(t.size(x.diskUsed), t.size(x.diskTotal))} />}

            {x.consumers.length > 0 && <div className="in label">{t.consumers}</div>}
            {x.consumers.map((c, i) => (
              <Line
                key={`${c.kind}:${c.label}:${i}`}
                ch={c.kind === 'session' ? '*' : c.kind === 'container' ? '#' : '>_'}
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
          </>
        )}

        {/* L'abonnement (quotas Claude et Codex, ce qui consomme) : sur la machine principale, celle qui sert l'app. */}
        {id === snap.machines[0]?.id && (
          <>
            <div className="in label">{t.usageTitle}</div>
            <Line ch="%" meta={t.usageMeta} onClick={() => push({ kind: 'usage' })}>
              {t.usageLine}
            </Line>
          </>
        )}

        {sessions.length > 0 && <div className="in label">{t.sessions}</div>}
        {sessions.map((s) => (
          <SessionRow key={s.id} session={s} />
        ))}

        {x && x.servers.length > 0 && <div className="in label">{t.servers}</div>}
        {x?.servers.map((s) =>
          s.url ? (
            <Line key={s.port} ch="#" meta={s.url.replace(/^https:\/\//, '')} onClick={() => window.open(s.url, '_blank', 'noopener')} go="↑">
              <span className="strong">{s.port}</span> {s.name} {s.dir}
            </Line>
          ) : (
            <Line key={s.port} ch="#" go={s.dir ? '→' : null} onClick={s.dir ? () => push({ kind: 'fs', machine: id, path: s.dir! }) : undefined}>
              <span className="strong">{s.port}</span> {s.name} {s.dir}
            </Line>
          ),
        )}
        <div style={{ height: 12 }} aria-hidden />
      </div>
    </Shell>
  )
}

// ---------------------------------------------------------------- tout le système de fichiers d'une machine

const parentOf = (p: string) => (p === '/' ? null : p.replace(/\/[^/]+\/?$/, '') || '/')
const join = (dir: string, name: string) => (dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`)

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
    <Shell slot="agent" kicker={parent ? `${name}:${parent}` : name} title={here === '/' ? '/' : `/${here.split('/').pop()}`} meta={l ? `${name} · ${t.entries(l.entries.length)}` : t.reading}>
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
          <div className="band invert" role="alert">
            <div className="in meta" style={{ paddingBlock: 12 }}>
              ! {err ?? l?.error}
            </div>
          </div>
        )}
        {l && here === '/' && (
          <Line ch="/" meta={l.home} onClick={() => push({ kind: 'fs', machine, path: l.home })}>
            <span className="strong">~</span>
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
    <CodeFile projectId={project?.id ?? ''} repo={inRepo[1]} path={inRepo[2]} machine={machine} file={file} err={err} kicker={`${name}:${dir}`} />
  ) : (
    <CodeFile projectId="" repo="" path={path} machine={machine} file={file} err={err} kicker={`${name}:${dir}`} />
  )
}

// ---------------------------------------------------------------- abonnement

function Quota({ name, q }: { name: string; q: QuotaInfo | undefined }) {
  const t = useT(M)
  const { now } = useApp()
  const label = (w: QuotaWindow) => (w.kind === 'session' ? t.session5h : w.kind === 'week' ? t.week : t.weekOf(w.label ?? ''))
  return (
    <>
      <div className="in label">
        {name}
        {q?.plan ? ` · ${q.plan}` : ''}
      </div>
      {!q && <div className="in meta empty">…</div>}
      {q && !q.ok && <div className="in meta empty">! {q.error ?? t.unavailable}</div>}
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

export function UsagePage() {
  const { snap, push, colors } = useApp()
  const t = useT(M)
  const [u, setU] = useState<UsageInfo | null>(null)
  const [rows, setRows] = useState<UsageRow[] | null>(null)
  useEffect(() => {
    void api
      .usage()
      .then(setU)
      .catch(() => undefined)
    void api
      .usageToday()
      .then((r) => setRows(r.rows))
      .catch(() => setRows([]))
  }, [])
  const total = rows?.reduce((s, r) => s + r.weight, 0) ?? 0
  const byProject = useMemo(() => {
    const m = new Map<string, { weight: number; tokens: number }>()
    for (const r of rows ?? []) {
      const p = m.get(r.projectId) ?? { weight: 0, tokens: 0 }
      p.weight += r.weight
      p.tokens += r.tokens
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
        <Quota name="Codex" q={u?.codex} />

        <div className="in label">{t.byProject}</div>
        {!rows && <div className="in meta empty">{t.reading}</div>}
        {rows && !rows.length && <div className="in meta empty">{t.nobody}</div>}
        {byProject.map(([id, p]) => (
          <div key={id} className="in stat share" style={{ ['--bar' as string]: colors[id] ? `var(--${colors[id]})` : undefined }}>
            <div className="stat-h">
              <span className="strong">{projectName(id)}</span>
              <span className="meta">{t.share(share(p.weight), p.tokens)}</span>
            </div>
            <Gauge pct={share(p.weight)} level="ok" className="big" />
          </div>
        ))}

        {rows && rows.length > 0 && <div className="in label">{t.bySession}</div>}
        {rows?.slice(0, 40).map((r) => (
          <Line
            key={`${r.machine}:${r.id}`}
            ch={r.tool === 'codex' ? '>_' : '*'}
            meta={`${projectName(r.projectId)} · ${r.tool} · ${r.machine} · ${t.share(share(r.weight), r.tokens)}`}
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
