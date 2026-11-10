import { noticeKey } from '../../shared/notices.ts'
import { Notice } from './notice'
// Conversations ChatGPT / Claude.ai : liste, lecture, rangement, import, « continuer ici ».

import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import type { ConversationDetail, ConversationSummary, Tool } from '../../shared/api.ts'
import { api } from '../api'
import { intlLocale, tr, useT } from '../i18n'
import M from '../i18n/convs'
import { useApp } from './app-context'
import { Collapse, Composer, Line, Messages } from './bits'
import { ago } from './format'
import { seedPending } from './pending'
import { FootError, Shell, swapPage } from './shell'
import { Icon } from './icons'

const SOURCE = { chatgpt: 'chatgpt', claude: 'claude.ai' } as const

export function statusLabel(c: ConversationSummary, name: (id: string) => string) {
  const t = tr(M)
  switch (c.status) {
    case 'auto':
      return t.filedBy(name(c.projectId!))
    case 'accepted':
    case 'corrected':
      return t.filed(name(c.projectId!))
    case 'pending':
      return c.suggestedProjectId ? t.toFileSuggest(name(c.suggestedProjectId)) : t.toFile
    case 'none':
      return t.unfiled
    default:
      return t.filingPending
  }
}

export function useProjectName() {
  const { snap } = useApp()
  return (id: string) => snap.projects.find((p) => p.id === id)?.name ?? id.replace(/^cat-/, '')
}

export function ConvLine({ c }: { c: ConversationSummary }) {
  useT(M) // re-rendu au changement de langue (statusLabel lit le catalogue à l'appel)
  const { push, now } = useApp()
  const name = useProjectName()
  return (
    <Line ch='"' meta={`${SOURCE[c.source]} · ${ago(now - c.updatedAt)} · ${statusLabel(c, name)}`} onClick={() => push({ kind: 'conversation', id: c.id })}>
      {c.title}
    </Line>
  )
}

/** Choisir où ranger : un des projets. */
export function Chooser({ c, onDone }: { c: ConversationSummary; onDone: () => void }) {
  const t = useT(M)
  const { snap, refresh } = useApp()
  const [err, setErr] = useState<string | null>(null)
  const go = async (target: { projectId?: string }) => {
    try {
      await api.classify(c.id, target)
      refresh()
      onDone()
    } catch (e) {
      setErr((e as Error).message)
    }
  }
  return (
    <div className="band tone">
      {err && <Notice eventId={noticeKey("error:conversations", location.pathname, err)} className="in meta" role="alert">! {err}</Notice>}
      {snap.projects
        .filter((p) => p.id !== c.projectId && p.id !== 'divers' && p.id !== 'general')
        .map((p) => (
          <Line key={p.id} ch="→" go={null} meta={p.kind === 'invented' ? t.category : undefined} onClick={() => void go({ projectId: p.id })}>
            {p.name}
          </Line>
        ))}
    </div>
  )
}

export function ConversationsPage({ projectId }: { projectId?: string }) {
  const t = useT(M)
  const { snap, colors } = useApp()
  const [list, setList] = useState<ConversationSummary[] | null>(null)
  const [q, setQ] = useState('')
  const project = projectId ? snap.projects.find((p) => p.id === projectId) : undefined

  useEffect(() => {
    let off = false
    const timer = setTimeout(
      () =>
        api
          .conversations(q.trim() ? { q: q.trim() } : projectId ? { project: projectId } : {})
          .then((r) => !off && setList(r.conversations))
          .catch(() => !off && setList([])),
      q ? 250 : 0,
    )
    return () => {
      off = true
      clearTimeout(timer)
    }
  }, [q, projectId, snap.version])

  return (
    <Shell
      slot={projectId ? (colors[projectId] ?? 'agent') : 'agent'}
      kicker={project?.name ?? 'weevils'}
      title={t.title}
      meta={list ? t.count(list.length) : t.reading}
    >
      <div className="band tone composer">
        <div className="in">
          <span className="prompt" aria-hidden>
            ?
          </span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t.search} aria-label={t.searchLabel} />
        </div>
      </div>
      {list?.map((c) => <ConvLine key={c.id} c={c} />)}
      {list && list.length === 0 && (
        <div className="in meta empty">{q ? t.nothingFound : snap.conversationCounts.total ? t.noneHere : t.noneYet}</div>
      )}
    </Shell>
  )
}

export function ConversationPage({ id }: { id: string }) {
  const t = useT(M)
  const { colors, replace, refresh } = useApp()
  const name = useProjectName()
  const [d, setD] = useState<ConversationDetail | null>(null)
  const [missing, setMissing] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const [tool, setTool] = useState<Tool>('claude')
  const [err, setErr] = useState<string | null>(null)
  const { snap } = useApp()

  useEffect(() => {
    let off = false
    api
      .conversation(id)
      .then((r) => !off && setD(r))
      .catch(() => !off && setMissing(true))
    return () => {
      off = true
    }
  }, [id, snap.version])

  if (!d) return <Shell slot="agent" kicker={t.conversations} title={missing ? t.notFound : '…'}>{null}</Shell>
  const c = d.conversation

  const accept = async () => {
    setErr(null)
    try {
      await api.classify(c.id, { projectId: c.suggestedProjectId })
      refresh()
    } catch (e) {
      setErr((e as Error).message)
    }
  }
  const cont = async (text: string) => {
    setErr(null)
    try {
      const r = await api.continueConv(c.id, tool, text)
      seedPending(r.id, text)
      swapPage()
      replace({ kind: 'session', id: r.id })
    } catch (e) {
      setErr((e as Error).message)
      throw e
    }
  }

  return (
    <Shell
      slot={c.projectId ? (colors[c.projectId] ?? 'agent') : 'agent'}
      kicker={c.projectId ? name(c.projectId) : t.toFile}
      title={c.title}
      meta={`${SOURCE[c.source]} · ${t.messages(c.messageCount)} · ${new Date(c.updatedAt).toLocaleDateString(intlLocale(), { day: 'numeric', month: 'long', year: 'numeric' })}`}
      foot={
        <>
          <FootError text={err} />
          <Composer placeholder={t.continueWithTool(tool)} label={t.continueLabel} onSend={cont} />
        </>
      }
    >
      <div className={`band ${c.status === 'pending' ? 'invert' : 'tone'}`}>
        <div className="in" style={{ paddingBlock: 12 }}>
          <div className="strong">{statusLabel(c, name)}</div>
          {c.reason && <div className="meta">{c.reason}</div>}
          <div className="inline-actions">
            {c.status === 'pending' && c.suggestedProjectId && (
              <button className="link" onClick={() => void accept()}>
                {t.fileIn(name(c.suggestedProjectId))}
              </button>
            )}
            <button className="link" onClick={() => setChoosing((v) => !v)} aria-expanded={choosing}>
              {c.projectId ? t.change : t.elsewhere}
            </button>
          </div>
        </div>
      </div>
      <Collapse open={choosing}>
        <Chooser c={c} onDone={() => setChoosing(false)} />
      </Collapse>
      <Messages messages={d.messages} author={SOURCE[c.source]} />
      <div className="band tone">
        <div className="in label">{t.continueWith}</div>
        {(['claude', 'codex'] as Tool[]).map((x) => (
          <Line key={x} className={tool === x ? 'invert' : ''} ch={tool === x ? '>' : ' '} go={null} onClick={() => setTool(x)}>
            {x}
          </Line>
        ))}
      </div>
    </Shell>
  )
}

export function ImportPage() {
  const t = useT(M)
  const { snap, refresh } = useApp()
  const [progress, setProgress] = useState<number | null>(null)
  const [result, setResult] = useState<{ total: number; added: number; updated: number } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setErr(null)
    setResult(null)
    setProgress(0)
    try {
      const r = await api.importExport(file, setProgress)
      setResult({ total: r.total, added: r.added, updated: r.updated })
      refresh()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setProgress(null)
      if (input.current) input.current.value = ''
    }
  }

  const cl = snap.classifier
  return (
    <Shell slot="agent" kicker="weevils" title={t.importTitle} meta={t.importedCount(snap.conversationCounts.total)}>
      <label className="row band invert" style={{ display: 'block', cursor: 'pointer' }}>
        <span className="in">
          <span className="st" aria-hidden>
            {progress != null ? <span className="spin"><Icon name="star" /></span> : <Icon name="arrow" />}
          </span>
          <span className="stack-text">
            <span className="strong">{progress != null ? t.uploading(Math.round(progress * 100)) : t.pickFile}</span>
            <span className="meta">{t.formats}</span>
          </span>
        </span>
        <input ref={input} type="file" accept=".zip,.json,application/zip,application/json" onChange={(e) => void onFile(e)} style={{ position: 'absolute', opacity: 0, width: 1, height: 1 }} />
      </label>
      {result && <div className="in meta strong" style={{ paddingBlock: 12 }}>
          <Icon name="check" /> {t.imported(result.total, result.added, result.updated)}
        </div>}
      {err && <Notice eventId={noticeKey("error:import", err)} className="in meta strong" style={{ paddingBlock: 12 }} role="alert">! {err}</Notice>}
      <div className="in meta" style={{ paddingBlock: 10 }}>
        {cl.running ? t.filing(cl.queued) : cl.lastError ? t.filingFailed(cl.lastError) : snap.conversationCounts.pending ? t.toFileByYou(snap.conversationCounts.pending) : t.allFiled}
      </div>
    </Shell>
  )
}
