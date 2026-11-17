import { useState } from 'react'
import type { Session } from '../../shared/api.ts'
import { api } from '../api'
import { useT } from '../i18n'
import M from '../i18n/notices'
import { useApp } from './app-context'

/** Presentation only; the archive API never stops the agent. */
export function SessionArchiveAction({ session, onDone }: { session: Session; onDone?: () => void }) {
  const t = useT(M)
  const { refresh } = useApp()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [saved, setSaved] = useState<boolean | undefined>()
  const archived = saved ?? !!session.archived
  const toggle = async () => {
    setBusy(true)
    setErr('')
    try {
      await api.archive(session.id, !archived)
      setSaved(!archived)
      refresh()
      onDone?.()
    } catch (e) { setErr((e as Error).message) }
    finally { setBusy(false) }
  }
  return <>
    <button type="button" className="link session-archive-action" disabled={busy} onClick={() => void toggle()} aria-label={archived ? t.restoreAria(session.title) : t.archiveAria(session.title)}>{archived ? t.restore : t.archive}</button>
    {err && <span role="alert" className="meta">{err}</span>}
  </>
}

export function SessionMenu({ session }: { session: Session }) {
  const t = useT(M)
  return <details className="session-menu">
    <summary aria-label={t.actions(session.title)}>⋯</summary>
    <div className="in session-menu-body">
      <SessionArchiveAction session={session} />
      {session.status === 'working' && <div className="meta">{t.keepsWorking}</div>}
    </div>
  </details>
}
