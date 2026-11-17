import { sessionNoticeKey } from '../../shared/notices.ts'
import { useState } from 'react'
import type { Session } from '../../shared/api.ts'
import { api } from '../api'
import { useT } from '../i18n'
import M from '../i18n/cut-band'
import { dismissNotice } from './notice-store'
import { Notice } from './notice'
import { ResumeButton } from './bits'
import { status } from './format'
import { startSetup } from './setup'

const TOOL_NAME: Record<Session['tool'], string> = { claude: 'Claude', codex: 'Codex' }

/** A session that stopped (crash, usage limit, signed out, service error): the plain reason, the tool's own words folded
 * away, and always a way on. Signed out, Resume alone would fail again: « sign in again » runs the in-app login in
 * weevboss's thread (a link, then a code to paste), and Resume stays for once it is done. Session page and focused
 * thread show the same band, so a stopped session never looks idle. */
export function CutBand({ session: s, onError }: { session: Session; onError: (text: string) => void }) {
  const t = useT(M)
  const [signing, setSigning] = useState(false)
  if (s.status !== 'interrupted') return null
  const signedOut = s.interrupted?.reason === 'auth'
  const signIn = async () => {
    if (signing) return
    setSigning(true)
    onError('')
    try {
      await startSetup(s.tool, false, false, true)
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setSigning(false)
    }
  }
  return (
    <Notice closable={false} eventId={sessionNoticeKey(s)} about={s.title} className="msg band cut-band">
      <div className="in">
        <span className="who">
          {status.interrupted.label}
          {s.interrupted ? ` · ${t.cutWhy(s.interrupted.reason)}` : ''}
        </span>
        {s.interrupted?.detail && (
          <details className="cut-detail">
            <summary className="meta">{t.cutDetail}</summary>
            <div className="text">{s.interrupted.detail}</div>
          </details>
        )}
        <div className="cut-actions">
          {signedOut && (
            <button className="resume sign-in" disabled={signing} onClick={() => void signIn()} aria-label={t.signInAria(TOOL_NAME[s.tool])}>
              {t.signInAgain}
            </button>
          )}
          <ResumeButton session={s} stay onError={onError} />
          <button className="link" onClick={() => void api.dismiss(s.id).then(() => dismissNotice(sessionNoticeKey(s))).catch((e) => onError((e as Error).message))}>
            {t.dismiss}
          </button>
        </div>
      </div>
    </Notice>
  )
}
