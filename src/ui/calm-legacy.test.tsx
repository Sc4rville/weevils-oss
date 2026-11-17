// @vitest-environment happy-dom
import { StrictMode, act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
const back = vi.hoisted(() => vi.fn())
vi.mock('./app-context', () => ({ useApp: () => ({ back }) }))
import { CalmGrid } from './calm'
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
it('returns once from a legacy overview entry without rendering a fullscreen page or session grid', async () => {
 const host = document.createElement('div'), root = createRoot(host)
 document.body.append(host)
 await act(async () => root.render(<StrictMode><CalmGrid /></StrictMode>))
 expect(back).toHaveBeenCalledTimes(1)
 expect(host.childElementCount).toBe(0)
 await act(async () => root.unmount()); host.remove()
})
