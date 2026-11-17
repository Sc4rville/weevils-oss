import { useEffect } from 'react'
import { useT } from '../i18n'
import M from '../i18n/gone'
import { useApp } from './app-context'

/** How long a missing page says so before it takes the reader back. */
export const GONE_MS = 2500

/** A page whose subject no longer exists: never a dead screen. A human line, then back where the reader came from
 * (or to the stream when there is nothing to go back to). */
export function GoneBack() {
  const t = useT(M)
  const { back, home } = useApp()
  useEffect(() => {
    let fallback: number | undefined
    const timer = window.setTimeout(() => {
      back()
      // Nothing to go back to (a link opened straight on the page): the stream. Unmounted by then if back() worked.
      fallback = window.setTimeout(home, 400)
    }, GONE_MS)
    return () => {
      window.clearTimeout(timer)
      window.clearTimeout(fallback)
    }
  }, [back, home])
  return (
    <div className="in gone" role="status">
      <p className="meta">{t.text}</p>
      <button type="button" className="link" onClick={() => { back(); window.setTimeout(home, 400) }}>{t.now}</button>
    </div>
  )
}

export function useGoneTitle() {
  return useT(M).title
}
