import { forwardRef, useSyncExternalStore, type ComponentProps } from 'react'
import { useT } from '../i18n'
import M from '../i18n/notices'
import { Icon } from './icons'
import { dismissNotice, isNoticeDismissed, noticeVersion, subscribeNotices } from './notice-store'

export function useNotices() { return useSyncExternalStore(subscribeNotices, noticeVersion, noticeVersion) }
export function useNotice(id: string) {
  useNotices()
  return { hidden: isNoticeDismissed(id), dismiss: () => dismissNotice(id) }
}
export function NoticeClose({ onClose, about }: { onClose: () => void; about?: string }) {
  const t = useT(M)
  return <button type="button" className="notice-close" aria-label={about ? t.closeAbout(about.slice(0, 100)) : t.close} title={t.close} onKeyDown={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClose() }}><Icon name="close" /></button>
}
/** Closing changes presentation only. No session action is called here. */
export const Notice = forwardRef<HTMLDivElement, ComponentProps<'div'> & { eventId: string; about?: string; closable?: boolean }>(function Notice({ eventId, about, closable = true, children, className = '', ...props }, ref) {
  const { hidden, dismiss } = useNotice(eventId)
  if (hidden) return null
  return <div {...props} ref={ref} className={`${closable ? 'notice-shell' : ''} ${className}`}>{closable && <NoticeClose onClose={dismiss} about={about} />}{children}</div>
})
