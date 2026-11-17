import { sourceAccessIssue, sourceForRepo, sourceForSession } from './source-access'
import { ThinkGate, LostFeaturesPage } from './lost-features'
import { ModelControlsPage } from './model-controls'
import { interceptModelControl } from '../model-controls'
import { FormatsPage } from './foryou-formats'
import { RemoteProgress } from './remote-progress'
import { OutboxStatus } from './outbox-status'
import { noticeKey, sessionNoticeKey } from '../../shared/notices.ts'
import { dismissNotice } from './notice-store'
import { Notice } from './notice'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionDetail, Tool } from '../../shared/api.ts'
import { api, type FileContent } from '../api'
import { useApp, type Page } from './app-context'
import { Composer, Line, Messages, StatusChar, type Attachment } from './bits'
import { SessionArchiveAction } from './session-archive'
import NM from '../i18n/notices'
import { SessionQuestion } from './session-question'
import { CutBand } from './cut-band'
import { ConversationPage, ConversationsPage, ImportPage } from './convs'
import { Preview, guessPreviewUrl, urlsInMessages, usePreviewState } from './preview'
import { effortLabel, modelLabel } from './settings'
import { ModelPicker } from './model-controls'
import { ReposPage } from './repos'
import { SoftwarePage, SoftwaresPage } from './softwares'
import { CalmConv, CalmGrid } from './calm'
import { markSeen } from './seen'
import { dropSeed, mergePending, peekSeed, seedPending, type Pending } from './pending'
import { FootError, Shell, swapPage } from './shell'
import { GoneBack, useGoneTitle } from './gone'
import { CodeFile } from './codeview'
import { FsFilePage, FsPage, InfraPage, UsagePage } from './infra'
import { RelayPage, SessionRelay } from './relay'
import { listFiles } from './repofiles'
import { useThreadAsk } from './askthread'
import { durLong, status, toolName } from './format'
import { useLang, useT } from '../i18n'
import { reveal, useFollow } from './follow'
import { FollowDown } from './followdown'
import M from '../i18n/pages'
import BM from '../i18n/bands'
import PM from '../i18n/plain-steps'
import { MemoryPage } from './memory'
import { RequestsPage } from './requests'
import { ProjectPage } from './project-screen'
import { ForYouPage, MediaPage } from './foryou'
import { AutoPage, AutoRunPage } from './auto-page'
import { WebPage } from './living-link'



export function PageView({ page }: { page: Page }) {
  switch (page.kind) {
    case 'think': return <ThinkGate />
    case 'lost-features': return <LostFeaturesPage />
    case 'models': return <ModelControlsPage id={page.id}/>
    case 'archived':
      return <ArchivedSessions />
    case 'session':
      return <SessionPage id={page.id} />
    case 'files':
      return <FilesPage projectId={page.projectId} repo={page.repo} dir={page.dir} />
    case 'file':
      return <FilePage projectId={page.projectId} repo={page.repo} path={page.path} line={page.line} />
    case 'project':
      return <ProjectPage projectId={page.projectId} />
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
    case 'requests':
      return <RequestsPage />
    case 'formats':
      return <FormatsPage />
    case 'foryou':
      return <ForYouPage who={page.who} />
    case 'media':
      return <MediaPage url={page.url} type={page.type} name={page.name} />
    case 'auto':
      return <AutoPage id={page.id} />
    case 'autorun':
      return <AutoRunPage id={page.id} at={page.at} />
    case 'webpage':
      return <WebPage path={page.path} title={page.title} pageKind={page.pageKind} />
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
      <div className="meta">{toolName(s.tool)} · {status[s.status].label}</div>
      <SessionArchiveAction session={s} />
    </div>)}
  </Shell>
}

function Missing() {
  const gone = useGoneTitle()
  return (
    <Shell slot="agent" kicker="weevils" title={gone}>
      <GoneBack />
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
// Session : le fil et ses bandes d'état.

function SessionPage({ id }: { id: string }) {
  const appLang = useLang()
  const { snap, now, replace, colors } = useApp()
  const t = useT(M)
  const tb = useT(BM)
  const tp = useT(PM)
  const gone = useGoneTitle()
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [missing, setMissing] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // Le premier message d'une session qu'on vient de lancer est déjà là (pending.ts : seedPending).
  const [pending, setPending] = useState<Pending[]>(() => peekSeed(id))
  useEffect(() => dropSeed(id), [id])
  const [preview, setPreview] = usePreviewState(id)
  const [showSettings, setShowSettings] = useState(false)
  /** Whether the header pill shows its phrase whole (not cut with « … » on a narrow screen). */


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
  }, [id, snap.version, replace, appLang])

  const s = snap.sessions.find((x) => x.id === id) ?? detail?.session
  // Ouverte : tout ce qu'elle a dit jusqu'ici est lu.
  useEffect(() => {
    if (s) markSeen(s.id, s.lastActivityAt)
  }, [s, s?.id, s?.lastActivityAt])
  const messages = useMemo(() => mergePending(detail?.messages ?? [], pending), [detail, pending])
  const body = useRef<HTMLDivElement>(null)
  const sp = snap.projects.find((p) => p.id === s?.projectId)
  const th = useThreadAsk(messages, { selectionOnly: true, title: s?.title ?? '', tool: s?.tool ?? 'claude', project: sp?.name, projectId: s?.projectId, repo: s?.repo ?? undefined, machine: s?.machineId })
  // La fin du fil : déjà là à l'ouverture, suivie pendant que la réponse s'écrit, sauf si on remonte relire (src/ui/follow.ts).
  // Un mot sélectionné (ou une question dictée) et sa réponse sous un message : le suivi attend, rien ne les pousse hors de l'écran.
  const last = messages.at(-1)
  const hold = th.hold
  const follow = useFollow(body, messages.length > 0, 80, `${messages.length}:${last?.id}:${last?.text.length}:${s?.status}:${s?.progress?.state}:${s?.progress?.completed}:${s?.progress?.label}:${s?.progress?.detail}`, hold)
  const suggestions = useMemo(() => urlsInMessages(messages, snap.config), [messages])
  // Ce qui arrive pendant qu'une sélection tient le fil est signalé (behind) et rejoint en glissant au relâché (useFollow).
  const toEnd = follow.toEnd


  // Introuvable : le même cadre (le conteneur suivi reste le même s'il apparaît ensuite).
  if (!s)
    return (
      <Shell slot="agent" kicker="weevils" title={missing && !pending.length ? gone : '…'} bodyRef={body}>
        {/* A session just launched (its first message is on its way) is not gone, only not listed yet. */}
        {missing && !pending.length && <GoneBack />}
      </Shell>
    )

  const project = snap.projects.find((p) => p.id === s.projectId)
  const sourceIssue = sourceAccessIssue(sourceForSession(snap.projects, s))
  const st = status[s.status]
  const previewUrl = preview.url ?? guessPreviewUrl(messages, s, project, snap.config)


  // Before the server takes it, the notice under the thread speaks (« sending… », « try again »); after, the bubble.
  const busy = (s.turnWorking ?? (s.status === 'working' && !s.background)) || s.queued > 0
  const pendingLabel = (pid: string) => (pending.find((x) => x.id === pid)?.accepted ? (busy ? tb.readsSoon : tb.received) : '')
  const send = async (text: string, files: Attachment[] = []) => {
    if(interceptModelControl(id,text,files.length))return
    if (sourceIssue) throw new Error(sourceIssue)
    setErr(null)
    const shown = files.length ? `${text ? `${text} ` : ''}(${t.photos(files.length)})` : text
    const tmp: Pending = { id: `pending-${Date.now()}`, role: 'user', text: shown, at: Date.now(), typed: text, after: detail?.messages.at(-1)?.id, known: (detail?.messages ?? []).filter((m) => m.role === 'user' || m.role === 'orchestrator').map((m) => m.id) }
    setPending((p) => [...p, tmp])
    toEnd()
    try {
      const r: { id: string; delivery?: { messageId?: string } } = files.length ? await api.attach(s.id, text, files) : await api.send(s.id, text)
      // The server has it: the bubble says « received », even while the agent is busy (r59).
      setPending((p) => p.map((x) => (x.id === tmp.id ? { ...x, accepted: true, ...(r.delivery?.messageId ? { messageId: r.delivery.messageId } : {}) } : x)))
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
      kicker={project?.name ?? t.sessionsKicker}
      title={s.title}
      scrollHeading
      sessionLayout
      headerControls={<button className="link inline" onClick={() => setShowSettings((v) => !v)} aria-label={t.changeModel} aria-pressed={showSettings} aria-controls="session-settings">
            {[modelLabel(s.settings?.model), effortLabel(s.settings?.effort)].filter(Boolean).join(' · ') || t.model}
          </button>}
      underHeader={showSettings && (
          <div id="session-settings">
          <ModelPicker key={s.id} id={s.id} onPicked={() => setShowSettings(false)} />
          <div className="in session-actions">
            <button className="link" onClick={() => setPreview({ open: !preview.open })} aria-pressed={!!preview.open}>
              {preview.open ? t.closeApp : t.seeApp}
            </button>
            {' · '}<SessionArchiveAction key={s.id} session={s} />
          </div>
        </div>
      )}
      meta={
          <>
          {/* One plain line: the state in words a non-developer reads, and for how long it has worked. */}
          <StatusChar s={s.status} /> {s.status === 'needs_user' ? tp.liveWaiting : s.status === 'idle' || s.status === 'done' ? tp.liveDone : st.label}
          {s.status === 'working' && s.workStartedAt != null && <> · {durLong(now - s.workStartedAt)}</>}
          {s.queued > 0 && <span className="strong"> · {t.queued(s.queued)}</span>}
        </>
      }
      dock={th.voice}
      float={<FollowDown show={follow.behind} urgent={s.status === 'needs_user'} body={body} toEnd={toEnd} />}
      bodyRef={body}
      side={preview.open ? <Preview session={s} project={project} url={previewUrl} suggestions={suggestions} onUrl={(url) => setPreview({ url })} onClose={() => setPreview({ open: false, full: false })} full={preview.full} onFull={(full) => setPreview({ full })} /> : undefined}
      foot={
        <>
          <FootError text={err} />
          {sourceIssue && <div className="in meta" role="status">{sourceIssue}</div>}
          <Composer
            draftKey={`session:${s.id}`}
            placeholder={sourceIssue ? '' : s.controllable ? (s.live ? t.writeTo(toolName(s.tool)) : t.resumeWith(toolName(s.tool))) : t.readOnly}
            label={t.composerLabel(s.title)}
            onSend={send}
            onAttach={send}
            voice
            disabled={!s.controllable || !!sourceIssue}
          />
        </>
      }
    >
      <div ref={th.ref} className="ask-thread session-thread">
        {/* Monté avec le fil chargé : la session s'ouvre posée sur son dernier message, sans tout dérouler. Avant, seulement
            s'il y a déjà une bulle (premier message d'une session lancée) ; remonté au chargement pour que le lot arrive sans
            se dérouler lui non plus. */}
        {(detail || missing || pending.length > 0) && (
          <Messages session plain key={detail || missing ? 'loaded' : 'early'} messages={messages} pendingLabel={pendingLabel} author={s.tool} working={s.turnWorking ?? (s.status === 'working' && !s.background)} after={th.after} />
        )}
      </div>

      <OutboxStatus scope={`/api/sessions/${encodeURIComponent(id)}/`} />

      {/* Les bandes d'état (question, travail, coupure) arrivent avec le fil : posées avant lui sur une page vide, elles
          seraient ensuite repoussées d'un coup vers le bas par les messages (ouverture depuis une notification). */}
      {(detail || missing) && (
        <>
        {s.progress && <RemoteProgress progress={s.progress} />}

        <SessionQuestion session={s} onError={setErr} />

        {/* No helpers row and no « working » row: the status line at the top says it, so the last message sent stays last. */}

        <SessionRelay session={s} onError={setErr} />

        <CutBand session={s} onError={setErr} />
        </>
      )}

    </Shell>
  )
}

// ---------------------------------------------------------------------------
// Explorateur de fichiers : un dossier par page, la liste du repo est gardée en cache.

/** Le nom d'une machine, seulement quand il y en a plusieurs à distinguer : jamais son id. */
const machineName = (machines: { id: string; name: string }[], id?: string) => (machines.length > 1 && id ? machines.find((m) => m.id === id)?.name : undefined)

/** Un dossier trop long s'affiche par tranches. */
const FILES_STEP = 500

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
  const [shown, setShown] = useState(FILES_STEP)
  useEffect(() => setShown(FILES_STEP), [theRepo, dir])
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
      <Shell slot={slot} kicker={project.name} title={t.folders}>
        {project.repos.map((r) => (
          <Line key={r} ch="/" meta={machineName(snap.machines, project.where[r])} onClick={() => push({ kind: 'files', projectId, repo: r })}>
            {r}
          </Line>
        ))}
      </Shell>
    )
  }

  return (
    <Shell
      slot={slot}
      kicker={dir ? (dir.split('/').at(-2) ?? theRepo) : project.name}
      title={dir ? dir.split('/').pop() : theRepo}
      meta={files ? t.files(files.length) : t.reading}
    >
      {err && <ErrorBand text={err} />}
      {entries?.folders.map(([name, count]) => (
        <Line key={name} ch="/" meta={t.files(count)} onClick={() => push({ kind: 'files', projectId, repo: theRepo, dir: dir ? `${dir}/${name}` : name })}>
          <span className="strong">{name}</span>
        </Line>
      ))}
      {entries?.leaves.slice(0, shown).map((name) => {
        const path = dir ? `${dir}/${name}` : name
        return (
          <Line key={name} ch="·" onClick={() => push({ kind: 'file', projectId, repo: theRepo, path })}>
            {name}
          </Line>
        )
      })}
      {entries && entries.leaves.length > shown && (
        <Line ch="+" go={null} onClick={() => setShown((n) => n + FILES_STEP)}>
          <span className="meta">{t.moreFiles(Math.min(FILES_STEP, entries.leaves.length - shown))}</span>
        </Line>
      )}
      {entries && entries.folders.length + entries.leaves.length === 0 && <div className="in meta empty">{t.emptyDir}</div>}
    </Shell>
  )
}

function FilePage({ projectId, repo, path, line }: { projectId: string; repo: string; path: string; line?: number }) {
  const { snap } = useApp()
  const machine = snap.projects.find((p) => p.id === projectId)?.where[repo] ?? snap.machines[0]?.id ?? ''
  const identity = `${machine}:${repo}:${path}`
  const currentIdentity = useRef(identity)
  currentIdentity.current = identity
  const [file, setFile] = useState<FileContent | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let off = false
    setFile(null)
    setErr(null)
    api.file(repo, path, machine)
      .then((f) => !off && setFile(f))
      .catch((e) => !off && setErr((e as Error).message))
    return () => {
      off = true
    }
  }, [repo, path, machine])
  return <CodeFile key={`${machine}:${repo}:${path}`} projectId={projectId} repo={repo} path={path} machine={machine} line={line} file={file} err={err} onSaved={saved => { if (currentIdentity.current === identity) setFile(saved) }} />
}

// ---------------------------------------------------------------------------

/** Les outils par leur nom, pas leur id. */
const TOOL_NAME: Record<Tool, string> = { claude: 'Claude', codex: 'Codex' }

function NewSessionPage({ projectId }: { projectId: string }) {
  const { snap, replace, colors } = useApp()
  const t = useT(M)
  const any = projectId === '__any'
  const [machine, setMachine] = useState(snap.machines[0]?.id ?? '')
  const [allRepos, setAllRepos] = useState<string[] | null>(null)
  const project = any
    ? { id: '__any', name: t.newSession, kind: 'repo' as const, repos: allRepos ?? [], where: Object.fromEntries((allRepos ?? []).map((r) => [r, machine])), lastActivityAt: 0 }
    : snap.projects.find((p) => p.id === projectId)
  const [tool, setTool] = useState<Tool>(snap.setup?.provider ?? 'claude')
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
  const sourceIssue = sourceAccessIssue(project.kind === 'installation' ? project : sourceForRepo(snap.projects, repo, any ? machine : repo ? project.where[repo] : undefined))
  const create = async (text: string) => {
    if (sourceIssue) { setErr(sourceIssue); throw new Error(sourceIssue) }
    if (created.current) return
    if (any && !repo) {
      setErr(t.pickRepoFirst)
      // Le choix qui manque est amené sous les yeux.
      reveal(repoLabel.current, { block: 'start' })
      throw new Error(t.pickRepoFirst)
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
      kicker={any ? 'weevils' : project.name}
      title={t.newSessionTitle}
      foot={
        <>
          <FootError text={err} />
          <Composer placeholder={sourceIssue ?? t.firstMessage} label={t.firstMessageLabel} onSend={create} disabled={!!sourceIssue} />
        </>
      }
    >
      {sourceIssue && <div className="in meta" role="status">{sourceIssue}</div>}
      <div className="in label">{t.tool}</div>
      {(['claude', 'codex'] as Tool[]).map((x) => (
        <Line key={x} className={tool === x ? 'invert' : ''} ch={tool === x ? '>' : ' '} go={null} onClick={() => setTool(x)} label={`${TOOL_NAME[x]}${tool === x ? t.chosen : ''}`}>
          {TOOL_NAME[x]}
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
            {t.project}
          </div>
          {any && !allRepos && <div className="in meta empty">…</div>}
          {project.repos.map((r) => (
            <Line key={r} className={repo === r ? 'invert' : ''} ch={repo === r ? '>' : '/'} go={null} meta={any ? undefined : machineName(snap.machines, project.where[r])} onClick={() => setRepo(r)}>
              {r}
            </Line>
          ))}
        </>
      )}
    </Shell>
  )
}
