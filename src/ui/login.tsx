import { noticeKey } from '../../shared/notices.ts'
import { Notice } from './notice'
import { useState, type FormEvent } from 'react'
import { api } from '../api'
import { Icon } from './icons'
import { useT } from '../i18n'
import M from '../i18n/login'

/** Connexion : un code d'accès (ou le lien QR « #k=… »). Une fois par appareil. */
export function Login({ onDone }: { onDone: () => void }) {
  const t = useT(M)
  const [code, setCode] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!code.trim() || busy) return
    setBusy(true)
    setErr(null)
    try {
      await api.login(code.trim())
      onDone()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className="stack">
      <section className="band agent" style={{ ['--c' as string]: 'var(--agent)', flex: 1 }}>
        <div className="in head">
          <span className="name">weevils</span>
        </div>
        <div className="in meta summary">{t.summary}</div>
        <form className="composer band tone" onSubmit={submit}>
          <div className="in">
            <span className="prompt" aria-hidden>
              {busy ? <span className="spin"><Icon name="star" /></span> : <Icon name="hash" />}
            </span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={t.code}
              aria-label={t.code}
              autoComplete="current-password"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <button className="send" type="submit" disabled={!code.trim() || busy} aria-label={t.signIn}>
              <Icon name="arrow" dir="right" />
            </button>
          </div>
        </form>
        {err && (
          <Notice eventId={noticeKey('error:login', location.pathname, location.hash, err)} className="band invert" role="alert">
            <div className="in meta" style={{ paddingBlock: 12 }}>
              ! {err}
            </div>
          </Notice>
        )}
      </section>
    </main>
  )
}
