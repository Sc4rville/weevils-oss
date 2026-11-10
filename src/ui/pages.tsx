import { noticeKey, sessionNoticeKey } from '../../shared/notices.ts'
import { dismissNotice } from './notice-store'
import { Notice } from './notice'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionDetail, Tool } from '../../shared/api.ts'
import { api, type FileContent } from '../api'
import { useApp, type Page } from './app-context'
import { Collapse, Composer, Line, Messages, ResumeButton, StatusChar, Working, type Attachment } from './bits'
import { Background } from './subagents'
import { SessionArchiveAction } from './session-archive'
import NM from '../i18n/notices'
import { SessionQuestion } from './session-question'
import { ConversationPage, ConversationsPage, ImportPage } from './convs'
import { Preview, guessPreviewUrl, urlsInMessages, usePreviewState } from './preview'
import { Settings, effortLabel, modelLabel } from './settings'
import { ReposPage } from './repos'
import { SoftwarePage, SoftwaresPage } from './softwares'
import { CalmConv, CalmGrid } from './calm'
import { markSeen } from './seen'
import { dropSeed, mergePending, peekSeed, seedPending, type Pending } from './pending'
import { FootError, Shell, swapPage } from './shell'
import { CodeFile } from './codeview'
import { FsFilePage, FsPage, InfraPage, UsagePage } from './infra'
import { RelayPage, SessionRelay } from './relay'
import { listFiles } from './repofiles'
import { useThreadAsk } from './askthread'
import { ago, durLong, status } from './format'
import { useT } from '../i18n'
import { reveal, useFollow } from './follow'
import { FollowDown } from './followdown'
import M from '../i18n/pages'
import { MemoryPage } from './memory'
import { ForYouPage, MediaPage } from './foryou'
import { AutoPage, AutoRunPage } from './auto-page'

export function PageView({ page }: { page: Page }) {
  switch (page.kind) {
    case 'archived':
      return <ArchivedSessions />
    case 'session':
      return <SessionPage id={page.id} />
    case 'files':
      return <FilesPage projectId={page.projectId} repo={page.repo} dir={page.dir} />
    case 'file':
      return <FilePage projectId={page.projectId} repo={page.repo} path={page.path} line={page.line} />
    case 'machine':
      return <InfraPage projectId={page.projectId || undefined} />
    case 'fs':
      return <FsPage machine={page.machine} path={page.path} />
    case 'fsfile':
      return <FsFilePage machine={page.machine} path={page.path} />
    case 'usage':
      return <UsagePage />
    case 'relay':
      return <RelayPage />
    case 'new':
      return <NewSessionPage projectId={page.projectId} />
    case 'conversations':
      return <ConversationsPage projectId={page.projectId} />
    case 'conversation':
      return <ConversationPage id={page.id} />
    case 'import':
      return <ImportPage />
    case 'repos':
      return <ReposPage />
    case 'softwares':
      return <SoftwaresPage />
    case 'software':
      return <SoftwarePage id={page.id} />
    case 'calm':
      return <CalmGrid />
    case 'calmconv':
      return <CalmConv id={page.id} />
    case 'memory':
      return <MemoryPage />
    case 'foryou':
      return <ForYouPage who={page.who} />
    case 'media':
      return <MediaPage url={page.url} type={page.type} name={page.name} />
    case 'auto':
      return <AutoPage id={page.id} />
    case 'autorun':
      return <AutoRunPage id={page.id} at={page.at} />
  }
}

function ArchivedSessions() {
  const { snap, push } = useApp()
  const t = useT(NM)
  const list = snap.sessions.filter((s) => s.archived)
  return <Shell slot="agent" kicker="weevils" title={t.archived}>
    {!list.length && <div className="in meta empty">{t.empty}</div>}
    {list.map((s) => <div key={s.id} className="in archive-entry">
      <button type="button" className="link" onClick={() => push({ kind: 'session', id: s.id })}>{s.title}</button>
      <div className="meta">{s.tool} · {status[s.status].label}</div>
      <SessionArchiveAction session={s} />
    </div>)}
  </Shell>
}

function Missing({ text }: { text?: string }) {
  const t = useT(M)
  return (
    <Shell slot="agent" kicker="weevils" title={t.notFound}>
      <div className="in meta empty">{text ?? t.notFound}</div>
    </Shell>
  )
}

function ErrorBand({ text }: { text: string }) {
  return (
    <Notice eventId={noticeKey("page-error", location.pathname, text)} className="band invert" role="alert">
      <div className="in meta" style={{ paddingBlock: 12 }}>
        ! {text}
      </div>
    </Notice>
  )
}

// ---------------------------------------------------------------------------
// Session : le fil, l'écran du terminal, les touches.

function SessionPage({ id }: { id: string }) {
  const { snap, now, replace, colors } = useApp()
  const t = useT(M)
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [missing, setMissing] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // Le premier message d'une session qu'on vient de lancer est déjà là (pending.ts : seedPending).
  const [pending, setPending] = useState<Pending[]>(() => peekSeed(id))
  useEffect(() => dropSeed(id), [id])
  const [screenText, setScreenText] = useState<string | null>(null)
  const [showScreen, setShowScreen] = useState<boolean | null>(null)
  const [preview, setPreview] = usePreviewState(id)
  const [showSettings, setShowSettings] = useState(false)
  const screenBand = useRef<HTMLDivElement>(null)
  /** L'écran du terminal ouvert par une commande (/model, /approvals) : il est amené sous les yeux et mis en avant. */
  const screenAsked = useRef(false)

  // Le détail suit chaque nouvelle version annoncée par le serveur.
  useEffect(() => {
    let off = false
    api
      .session(id)
      .then((d) => {
        if (off) return
        setDetail(d)
        setMissing(false)
        if (d.session.id !== id) replace({ kind: 'session', id: d.session.id })
      })
      .catch(() => !off && setMissing(true))
    return () => {
      off = true
    }
  }, [id, snap.version, replace])

  const s = snap.sessions.find((x) => x.id === id) ?? detail?.session
  // Ouverte : tout ce qu'elle a dit jusqu'ici est lu.
  useEffect(() => {
    if (s) markSeen(s.id, s.lastActivityAt)
  }, [s, s?.id, s?.lastActivityAt])
  // L'écran brut du terminal est un secours : jamais ouvert tout seul.
  const screenOpen = showScreen ?? false

  // Écran du terminal : rafraîchi tant qu'il est affiché.
  useEffect(() => {
    if (!s?.hasScreen || !screenOpen) return
    let off = false
    const tick = () =>
      api
        .screen(id)
        .then((r) => !off && setScreenText(r.screen))
        .catch(() => undefined)
    tick()
    const t = setInterval(tick, 1500)
    return () => {
      off = true
      clearInterval(t)
    }
  }, [id, s?.hasScreen, screenOpen])

  const messages = useMemo(() => mergePending(detail?.messages ?? [], pending), [detail, pending])
  const body = useRef<HTMLDivElement>(null)
  const sp = snap.projects.find((p) => p.id === s?.projectId)
  const th = useThreadAsk(messages, { title: s?.title ?? '', tool: s?.tool ?? 'claude', project: sp?.name, projectId: s?.projectId, repo: s?.repo ?? undefined, machine: s?.machineId })
  // La fin du fil : déjà là à l'ouverture, suivie pendant que la réponse s'écrit, sauf si on remonte relire (src/ui/follow.ts).
  // Un mot sélectionné (ou une question dictée) et sa réponse sous un message : le suivi attend, rien ne les pousse hors de l'écran.
  const last = messages.at(-1)
  const hold = th.hold
  const follow = useFollow(body, messages.length > 0, 80, `${messages.length}:${last?.id}:${last?.text.length}:${s?.status}`, hold)
  const suggestions = useMemo(() => urlsInMessages(messages, snap.config), [messages])
  // Ce qui arrive pendant qu'une sélection tient le fil est signalé (behind) et rejoint en glissant au relâché (useFollow).
  const toEnd = follow.toEnd

  // Réglages ouverts (en bas du fil) : amenés sous les yeux une fois dépliés, même si on relisait plus haut.
  useEffect(() => {
    if (!showSettings) return
    const t = window.setTimeout(() => reveal(document.getElementById('session-settings'), { block: 'nearest' }), 380)
    return () => window.clearTimeout(t)
  }, [showSettings])
  // L'écran du terminal déplié : il s'ouvre vers le bas, on l'amène sous les yeux (mis en avant s'il vient d'une commande).
  useEffect(() => {
    if (!screenOpen) return
    const lit = screenAsked.current
    screenAsked.current = false
    const t = window.setTimeout(() => reveal(screenBand.current, { block: 'nearest', flash: lit }), 380)
    return () => window.clearTimeout(t)
  }, [screenOpen])

  // Introuvable : le même cadre (le conteneur suivi reste le même s'il apparaît ensuite).
  if (!s)
    return (
      <Shell slot="agent" kicker="weevils" title={missing ? t.notFound : '…'} bodyRef={body}>
        {missing && <div className="in meta empty">{t.notFound}</div>}
      </Shell>
    )

  const project = snap.projects.find((p) => p.id === s.projectId)
  const st = status[s.status]
  const previewUrl = preview.url ?? guessPreviewUrl(messages, s, project, snap.config)

  const send = async (text: string, files: Attachment[] = []) => {
    setErr(null)
    const shown = files.length ? `${text ? `${text} ` : ''}(${t.photos(files.length)})` : text
    const tmp: Pending = { id: `pending-${Date.now()}`, role: 'user', text: shown, at: Date.now(), typed: text, after: detail?.messages.at(-1)?.id }
    setPending((p) => [...p, tmp])
    toEnd()
    try {
      const r = files.length ? await api.attach(s.id, text, files) : await api.send(s.id, text)
      if (s.status === 'needs_user' || s.status === 'interrupted') dismissNotice(sessionNoticeKey(s))
      if (r.id !== id) replace({ kind: 'session', id: r.id })
    } catch (e) {
      setPending((p) => p.filter((x) => x.id !== tmp.id))
      setErr((e as Error).message)
      throw e
    }
  }

  return (
    <Shell
      slot={colors[s.projectId] ?? 'agent'}
      kicker={project?.name ?? s.projectId}
      title={s.title}
      meta={
        <>
          {s.now && (
            <>
              <span className="strong">{s.now}</span>
              <br />
            </>
          )}
          {s.tool}{' '}
          <button className="link inline" onClick={() => setShowSettings(true)} aria-label={t.changeModel} aria-controls="session-settings">
            {[modelLabel(s.settings?.model), effortLabel(s.settings?.effort)].filter(Boolean).join(' · ') || t.model}
          </button>
          {' '}· <StatusChar s={s.status} /> {st.label}
          {s.background > 0 && <span className="strong"> · {t.background(s.background)}</span>}
          {s.queued > 0 && <span className="strong"> · {t.queued(s.queued)}</span>}
          {s.status === 'working' && s.workStartedAt != null ? <>{t.since(durLong(now - s.workStartedAt))}</> : <> · {ago(now - s.lastActivityAt)}</>}
          {' · '}
          {s.machineId}
          {' · '}
          <button className="link" onClick={() => setPreview({ open: !preview.open })} aria-pressed={!!preview.open}>
            {preview.open ? t.closeBrowser : t.browser}
          </button>
          {' · '}
          <button className="link" onClick={() => setShowSettings((v) => !v)} aria-pressed={showSettings} aria-controls="session-settings">
            {t.settings}
          </button>
          {' · '}<SessionArchiveAction key={s.id} session={s} />
        </>
      }
      dock={th.voice}
      float={<FollowDown show={follow.behind} urgent={s.status === 'needs_user'} body={body} toEnd={toEnd} />}
      bodyRef={body}
      side={preview.open ? <Preview url={previewUrl} suggestions={suggestions} onUrl={(url) => setPreview({ url })} onClose={() => setPreview({ open: false, full: false })} full={preview.full} onFull={(full) => setPreview({ full })} /> : undefined}
      foot={
        <>
          <FootError text={err} />
          <Composer
            placeholder={s.controllable ? (s.live ? t.writeTo(s.tool) : t.resumeWith(s.tool)) : t.readOnly}
            label={t.composerLabel(s.title)}
            onSend={send}
            onAttach={send}
            voice
            disabled={!s.controllable}
          />
        </>
      }
    >
      <div ref={th.ref} className="ask-thread">
        {/* Monté avec le fil chargé : la session s'ouvre posée sur son dernier message, sans tout dérouler. Avant, seulement
            s'il y a déjà une bulle (premier message d'une session lancée) ; remonté au chargement pour que le lot arrive sans
            se dérouler lui non plus. */}
        {(detail || missing || pending.length > 0) && (
          <Messages key={detail || missing ? 'loaded' : 'early'} messages={messages} author={s.tool} working={s.status === 'working'} after={th.after} />
        )}
      </div>

      {/* Les bandes d'état (question, travail, coupure) arrivent avec le fil : posées avant lui sur une page vide, elles
          seraient ensuite repoussées d'un coup vers le bas par les messages (ouverture depuis une notification). */}
      {(detail || missing) && (
        <>
        <Background session={s} />

        <SessionQuestion session={s} onError={setErr} />

        {s.status === 'working' && <Working author={s.tool} since={s.workStartedAt} />}

        <SessionRelay session={s} onError={setErr} />

        {s.status === 'interrupted' && (
          <Notice closable={false} eventId={sessionNoticeKey(s)} about={s.title} className="msg band cut-band">
            <div className="in">
              <span className="who">
                × {st.label}
                {s.interrupted ? ` · ${t.cutWhy(s.interrupted.reason)}` : ''}
              </span>
              {s.interrupted?.detail && <div className="text">{s.interrupted.detail}</div>}
              <div className="cut-actions">
                <ResumeButton session={s} stay onError={setErr} />
                <button className="link" onClick={() => void api.dismiss(s.id).then(() => dismissNotice(sessionNoticeKey(s))).catch((e) => setErr((e as Error).message))}>
                  {t.dismiss}
                </button>
              </div>
            </div>
          </Notice>
        )}
        </>
      )}

      <Collapse open={showSettings} id="session-settings">
        <div className="band tone">
          <Settings
            id={s.id}
            tool={s.tool}
            settings={s.settings}
            canCommand={s.hasScreen}
            run={(c) => api.command(s.id, c)}
            onPicker={() => {
              screenAsked.current = true
              setShowScreen(true)
            }}
          />
        </div>
      </Collapse>

      {s.hasScreen && (
        <div ref={screenBand} className="band tone">
          <Line ch=">_" go={screenOpen ? '−' : '+'} onClick={() => setShowScreen(!screenOpen)} label={screenOpen ? t.hideScreen : t.showScreen}>
            <span className="meta">{t.terminalScreen}</span>
          </Line>
          <Collapse open={screenOpen}>
            <pre className="screen">{screenText ?? t.readingScreen}</pre>
            <div style={{ height: 10 }} />
          </Collapse>
        </div>
      )}
    </Shell>
  )
}

// ---------------------------------------------------------------------------
// Explorateur de fichiers : un dossier par page, la liste du repo est gardée en cache.

const fileContents = new Map<string, Promise<FileContent>>()
const readFile = (repo: string, path: string, machine: string) => {
  const k = `${machine}:${repo}\u0000${path}`
  if (!fileContents.has(k)) fileContents.set(k, api.file(repo, path, machine).catch((e) => (fileContents.delete(k), Promise.reject(e))))
  return fileContents.get(k)!
}
/** Préchargement discret (à l'ouverture d'une bande) : l'explorateur s'ouvre ensuite sans attente. */
export const prefetchRepo = (repo: string, machine: string) => void listFiles(repo, machine).catch(() => undefined)

function FilesPage({ projectId, repo, dir = '' }: { projectId: string; repo?: string; dir?: string }) {
  const { snap, push, colors } = useApp()
  const t = useT(M)
  const project = snap.projects.find((p) => p.id === projectId) ?? (repo ? { id: projectId, name: repo, kind: 'repo' as const, repos: [repo], where: {}, lastActivityAt: 0 } : undefined)
  const theRepo = repo ?? (project?.repos.length === 1 ? project.repos[0] : undefined)
  const machine = (theRepo && project?.where[theRepo]) || (snap.machines[0]?.id ?? '')
  const [files, setFiles] = useState<string[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    if (!theRepo) return
    let off = false
    listFiles(theRepo, machine)
      .then((f) => !off && setFiles(f))
      .catch((e) => !off && setErr((e as Error).message))
    return () => {
      off = true
    }
  }, [theRepo, machine])

  const entries = useMemo(() => {
    if (!files) return null
    const prefix = dir ? `${dir}/` : ''
    const folders = new Map<string, number>()
    const leaves: string[] = []
    for (const f of files) {
      if (!f.startsWith(prefix)) continue
      const rest = f.slice(prefix.length)
      const slash = rest.indexOf('/')
      if (slash >= 0) folders.set(rest.slice(0, slash), (folders.get(rest.slice(0, slash)) ?? 0) + 1)
      else leaves.push(rest)
    }
    return { folders: [...folders].sort((a, b) => a[0].localeCompare(b[0])), leaves: leaves.sort((a, b) => a.localeCompare(b)) }
  }, [files, dir])

  if (!project) return <Missing />
  const slot = colors[projectId] ?? 'agent'

  if (!theRepo) {
    return (
      <Shell slot={slot} kicker={project.name} title="/ repos" meta={t.repos(project.repos.length)}>
        {project.repos.map((r) => (
          <Line key={r} ch="/" meta={project.where[r]} onClick={() => push({ kind: 'files', projectId, repo: r })}>
            {r}
          </Line>
        ))}
      </Shell>
    )
  }

  return (
    <Shell
      slot={slot}
      kicker={dir ? `${theRepo}/${dir.split('/').slice(0, -1).join('/')}` : project.name}
      title={dir ? `/${dir.split('/').pop()}` : `/ ${theRepo}`}
      meta={`${machine} · ${files ? t.files(files.length) : t.readingRepo}`}
    >
      {err && <ErrorBand text={err} />}
      {entries?.folders.map(([name, count]) => (
        <Line key={name} ch="/" meta={t.files(count)} onClick={() => push({ kind: 'files', projectId, repo: theRepo, dir: dir ? `${dir}/${name}` : name })}>
          <span className="strong">{name}/</span>
        </Line>
      ))}
      {entries?.leaves.slice(0, 500).map((name) => {
        const path = dir ? `${dir}/${name}` : name
        return (
          <Line key={name} ch="·" onClick={() => push({ kind: 'file', projectId, repo: theRepo, path })}>
            {name}
          </Line>
        )
      })}
      {entries && entries.leaves.length > 500 && <div className="in meta empty">{t.moreFiles(entries.leaves.length - 500)}</div>}
      {entries && entries.folders.length + entries.leaves.length === 0 && <div className="in meta empty">{t.emptyDir}</div>}
    </Shell>
  )
}

function FilePage({ projectId, repo, path, line }: { projectId: string; repo: string; path: string; line?: number }) {
  const { snap } = useApp()
  const machine = snap.projects.find((p) => p.id === projectId)?.where[repo] ?? snap.machines[0]?.id ?? ''
  const [file, setFile] = useState<FileContent | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let off = false
    readFile(repo, path, machine)
      .then((f) => !off && setFile(f))
      .catch((e) => !off && setErr((e as Error).message))
    return () => {
      off = true
    }
  }, [repo, path, machine])
  return <CodeFile projectId={projectId} repo={repo} path={path} machine={machine} line={line} file={file} err={err} />
}

// ---------------------------------------------------------------------------

function NewSessionPage({ projectId }: { projectId: string }) {
  const { snap, replace, colors } = useApp()
  const t = useT(M)
  const any = projectId === '__any'
  const [machine, setMachine] = useState(snap.machines[0]?.id ?? '')
  const [allRepos, setAllRepos] = useState<string[] | null>(null)
  const project = any
    ? { id: '__any', name: t.newSession, kind: 'repo' as const, repos: allRepos ?? [], where: Object.fromEntries((allRepos ?? []).map((r) => [r, machine])), lastActivityAt: 0 }
    : snap.projects.find((p) => p.id === projectId)
  const [tool, setTool] = useState<Tool>('claude')
  const [repo, setRepo] = useState<string | undefined>(any ? undefined : project?.repos[0])
  const [err, setErr] = useState<string | null>(null)
  const created = useRef(false)
  const repoLabel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!any) return
    setAllRepos(null)
    api
      .repos(machine)
      .then((r) => setAllRepos(r.repos))
      .catch((e) => setErr((e as Error).message))
  }, [any, machine])
  if (!project) return <Missing />
  const create = async (text: string) => {
    if (created.current) return
    if (any && !repo) {
      setErr(t.pickRepoFirst)
      // Le choix qui manque est amené sous les yeux.
      reveal(repoLabel.current, { block: 'start' })
      throw new Error('repo')
    }
    created.current = true
    setErr(null)
    try {
      const r = await api.create({ projectId: any ? (repo ?? '') : projectId, repo, tool, text, machineId: repo ? project.where[repo] : undefined })
      seedPending(r.id, text)
      swapPage()
      replace({ kind: 'session', id: r.id })
    } catch (e) {
      created.current = false
      setErr((e as Error).message)
      throw e
    }
  }
  return (
    <Shell
      slot={colors[projectId] ?? 'agent'}
      kicker={project.name}
      title={t.newSessionTitle}
      foot={
        <>
          <FootError text={err} />
          <Composer placeholder={t.firstMessage} label={t.firstMessageLabel} onSend={create} />
        </>
      }
    >
      <div className="in label">{t.tool}</div>
      {(['claude', 'codex'] as Tool[]).map((x) => (
        <Line key={x} className={tool === x ? 'invert' : ''} ch={tool === x ? '>' : ' '} go={null} onClick={() => setTool(x)} label={`${x}${tool === x ? t.chosen : ''}`}>
          {x}
        </Line>
      ))}
      {any && snap.machines.length > 1 && (
        <>
          <div className="in label">{t.machine}</div>
          {snap.machines.map((m) => (
            <Line
              key={m.id}
              className={machine === m.id ? 'invert' : ''}
              ch={machine === m.id ? '>' : '@'}
              go={null}
              disabled={m.online === false}
              meta={m.online === false ? t.offline : undefined}
              onClick={() => {
                setMachine(m.id)
                setRepo(undefined)
              }}
            >
              {m.name}
            </Line>
          ))}
        </>
      )}
      {(project.repos.length > 1 || any) && (
        <>
          <div ref={repoLabel} className="in label">
            {t.repo}
          </div>
          {any && !allRepos && <div className="in meta empty">…</div>}
          {project.repos.map((r) => (
            <Line key={r} className={repo === r ? 'invert' : ''} ch={repo === r ? '>' : '/'} go={null} meta={any ? undefined : project.where[r]} onClick={() => setRepo(r)}>
              {r}
            </Line>
          ))}
        </>
      )}
    </Shell>
  )
}
