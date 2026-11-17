import { noticeKey } from '../../shared/notices.ts'
import { Notice } from './notice'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { FsListing, InfraDetail, Level, QuotaInfo, QuotaWindow, SpendSummary, UsageInfo, UsageToday } from '../../shared/infra.ts'
import { api, type FileContent } from '../api'
import { intlLocale, useT } from '../i18n'
import M from '../i18n/infra'
import RM from '../i18n/relay'
import { useApp } from './app-context'
import { Collapse, Line } from './bits'
import { focusBossSoon } from './follow'
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

/** Une jauge (pages machine et abonnement) : remplie de la couleur de l'encre, orange puis rouge près de la limite. */
function Gauge({ pct, level, className = '' }: { pct: number; level: Level; className?: string }) {
  return (
    <span className={`gauge ${className}`} aria-hidden>
      <span className={`lv-${level}`} style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
    </span>
  )
}

// ---------------------------------------------------------------- page machines

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


/** The machines page (Yann, 2026-11-17: « machines c le bordel… fais un truc clean »): one line per machine, its name
 *  and online / offline; a tap opens the few things that matter (a warning, memory, disk, up for, the host) and
 *  « remove », which weevboss does in its thread, as it added it. One « add a machine » at the bottom. */
export function InfraPage({ machine, projectId }: { machine?: string; projectId?: string }) {
  const { snap } = useApp()
  const t = useT(M)
  const fromProject = projectId ? snap.sessions.find((s) => s.projectId === projectId)?.machineId : undefined
  const [open, setOpen] = useState<string | null>(machine ?? fromProject ?? null)
  return (
    <Shell slot="agent" kicker="weevils" title={t.machinesTitle}>
      <div className="ipage">
        {snap.machines.map((m) => (
          <div key={m.id} className={`mx-item ${open === m.id ? 'open' : ''}`}>
            <Line ch="@" go={null} value={m.online === false ? t.offline : t.online} className={m.online === false ? 'off' : ''} onClick={() => setOpen(open === m.id ? null : m.id)}>
              {m.online === false ? m.name : <span className="strong">{m.name}</span>}
            </Line>
            <Collapse open={open === m.id}>{open === m.id && <MachineDetail id={m.id} name={m.name} />}</Collapse>
          </div>
        ))}
        {/* Weevboss asks the questions in its thread (host, address, password): nothing else to type here. */}
        <Line ch="+" onClick={() => askSetup('machine')}>
          {t.addLine}
        </Line>
        <div style={{ height: 12 }} aria-hidden />
      </div>
    </Shell>
  )
}

function MachineDetail({ id, name }: { id: string; name: string }) {
  const t = useT(M)
  const [d, setD] = useState<InfraDetail | null>(null)
  const [err, setErr] = useState(false)
  const [armed, setArmed] = useState(false)
  const [asked, setAsked] = useState(false)
  useEffect(() => {
    let off = false
    const load = () => api.infra(id).then((x) => !off && (setD(x), setErr(false))).catch(() => !off && setErr(true))
    void load()
    const tm = setInterval(load, 20_000)
    return () => {
      off = true
      clearInterval(tm)
    }
  }, [id])
  useEffect(() => {
    if (!armed) return
    const tm = setTimeout(() => setArmed(false), 3000)
    return () => clearTimeout(tm)
  }, [armed])
  const remove = () => {
    if (!armed) return setArmed(true)
    setArmed(false)
    setAsked(true)
    void api.main(t.removeAsk(name)).then(() => focusBossSoon({})).catch(() => setAsked(false))
  }
  // An unreachable machine (offline, gone) is the one most often removed: its remove line stays, under one plain note.
  const removeLine = (d ? !d.weevboss : err) && (
    <Line ch="x" go={null} className={armed ? 'on' : ''} disabled={asked} onClick={remove}>
      {asked ? t.removeAsked : armed ? t.removeSure : t.remove}
    </Line>
  )
  if (!d)
    return (
      <div className="mx-detail">
        <div className="in meta mx-note" role={err ? 'alert' : undefined}>{err ? t.cantRead : '…'}</div>
        {removeLine}
      </div>
    )
  return (
    <div className="mx-detail">
      {d.advice.map((a) => (
        <div key={a} className="in advice">
          {a}
        </div>
      ))}
      <Kv k={t.mem} v={t.of(t.size(d.memUsed), t.size(d.memTotal))} />
      <Kv k={t.disk} v={d.diskTotal ? t.of(t.size(d.diskUsed), t.size(d.diskTotal)) : null} />
      <Kv k={t.upSince} v={durLong(d.uptime)} />
      <Kv k={t.host} v={d.facts?.provider} />
      {/* The machine weevboss runs on is this weevils itself: it cannot remove itself. */}
      {removeLine}
    </div>
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
    <Line ch="%" className="usage-line" value={u ? parts.flatMap((x, i) => (i ? [' · ', x] : [x])) : '…'} onClick={() => push({ kind: 'usage' })}>
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
