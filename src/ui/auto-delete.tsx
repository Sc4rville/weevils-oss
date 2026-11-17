import { useRef, useState } from 'react'
import { api } from '../api'
import { useT } from '../i18n'
import M from '../i18n/h24'
import { useApp } from './app-context'
import { useTalk } from './auto-talk'

export function AutoDeleteAction({ id, title, onDeleted }: { id: string; title: string; onDeleted?: () => void }) {
  const t = useT(M)
  const { refresh } = useApp()
  const k = useTalk()
  const locked = useRef(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const remove = async () => {
    if (locked.current || !window.confirm(t.deleteConfirm(title))) return
    locked.current = true
    setBusy(true)
    setFailed(false)
    try {
      await api.deleteAutomation(id)
      k.forget(id)
      refresh()
      onDeleted?.()
    } catch {
      setFailed(true)
    } finally {
      locked.current = false
      setBusy(false)
    }
  }
  return <span className="auto-delete">
    <button type="button" className="auto-delete-button link" disabled={busy} onClick={() => void remove()}>{t.deleteAutomation}</button>
    {failed && <span role="alert">{t.deleteFailed}</span>}
  </span>
}
