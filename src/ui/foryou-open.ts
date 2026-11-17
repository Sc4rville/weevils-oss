import { useCallback } from 'react'
import type { ForYouOpen } from '../../shared/foryou'
import { useApp } from './app-context'
import { focusBoss } from './follow'

/** Navigate to a server-confirmed existing destination; never create or dispatch work. */
export function useForYouOpen() {
  const { push, home, setH24Open } = useApp()
  return useCallback((target: ForYouOpen, projectId?: string) => {
    switch (target.page) {
      case 'session': push({ kind: 'session', id: target.id }); break
      case 'boss': focusBoss({ mid: target.mid, flash: !!target.mid }); break
      case 'auto': home(); setH24Open(true, target.id); break
      case 'usage': push({ kind: 'usage' }); break
      case 'machine': push({ kind: 'machine', projectId: projectId ?? '' }); break
    }
  }, [push, home, setH24Open])
}
