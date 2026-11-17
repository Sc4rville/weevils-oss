import { useEffect, useRef, useState } from 'react'
import { api, type FileContent } from '../api'
import { useT } from '../i18n'
import M from '../i18n/markdown-editor'
import './markdown-editor.css'

type Draft = { content: string; revision: string }
const memory = new Map<string, Draft>()
export const markdownDraftKey = (machine: string, repo: string, path: string) => `weevils-markdown:${JSON.stringify([machine, repo, path])}`
function retained(key: string): Draft | undefined {
  if (memory.has(key)) return memory.get(key)
  try {
    const value = JSON.parse(sessionStorage.getItem(key) || 'null')
    if (typeof value?.content === 'string' && typeof value?.revision === 'string') return value
  } catch { /* Storage can be unavailable; retain this tab's memory. */ }
}

export function MarkdownEditor({ file, machine, repo, path, onSaved, onEditing }: {
  file: FileContent; machine: string; repo: string; path: string; onSaved: (file: FileContent) => void; onEditing: (editing: boolean) => void
}) {
  const t = useT(M)
  const key = markdownDraftKey(machine, repo, path)
  const [draft, setDraft] = useState<Draft>(() => retained(key) ?? { content: file.content, revision: file.revision! })
  const [open, setOpen] = useState(() => !!retained(key))
  const [busy, setBusy] = useState(false)
  const inflight = useRef(false)
  const [error, setError] = useState('')
  const [storageError, setStorageError] = useState(false)
  const [saved, setSaved] = useState(false)
  const [latest, setLatest] = useState<FileContent | null>(null)
  useEffect(() => { onEditing(open) }, [open, onEditing])
  const dirty = draft.content !== file.content
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (dirty || busy) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [dirty, busy])
  const keep = (next: Draft) => {
    setDraft(next); setSaved(false); memory.set(key, next)
    try { sessionStorage.setItem(key, JSON.stringify(next)); setStorageError(false) } catch { setStorageError(true) }
  }
  const save = async (revision = draft.revision) => {
    if (inflight.current) return
    inflight.current = true; setBusy(true); setError(''); setSaved(false)
    const frozen = { ...draft, revision }
    // Persist even an unchanged draft before dispatch, including the exact base revision.
    keep(frozen)
    try {
      const result = await api.saveFile(repo, path, machine, frozen.content, revision)
      if (!result.revision || result.content !== frozen.content) throw new Error(t.failed)
      memory.delete(key)
      try { sessionStorage.removeItem(key) } catch { /* Server-confirmed result remains visible. */ }
      setDraft({ content: result.content, revision: result.revision }); setLatest(null); setSaved(true)
      onSaved(result)
    } catch (e) { setError((e as Error).message || t.failed) }
    finally { inflight.current = false; setBusy(false) }
  }
  const compare = async () => {
    try { setLatest(await api.file(repo, path, machine)) } catch (e) { setError((e as Error).message) }
  }
  return <section className="in markdown-editor" data-draft={dirty ? 'true' : undefined} aria-busy={busy}>
    <div className="markdown-tools">
      {!open ? <button type="button" onClick={() => setOpen(true)}>{t.edit}</button> : <>
        <button type="button" disabled={busy || !dirty} onClick={() => void save()}>{busy ? t.saving : t.save}</button>
        <button type="button" disabled={busy} onClick={() => setOpen(false)}>{t.close}</button>
      </>}
      <span className="meta" role="status">{saved ? t.saved : dirty && !storageError ? t.draft : ''}</span>
    </div>
    {storageError && <p role="alert">{t.storage}</p>}
    {open && <textarea aria-label={t.text} value={draft.content} disabled={busy} spellCheck={false} onChange={e => {
      const value = e.target.value
      keep({ ...draft, content: file.content.includes('\r\n') ? value.replace(/\r?\n/g, '\r\n') : value })
    }} />}
    {error && <div role="alert"><p>{error}</p><button type="button" disabled={busy} onClick={() => void compare()}>{t.compare}</button></div>}
    {latest && <details open><summary>{t.latest}</summary><pre>{latest.content}</pre>
      {latest.editable && latest.revision && <button type="button" disabled={busy} onClick={() => void save(latest.revision)}>{t.replace}</button>}
    </details>}
  </section>
}
