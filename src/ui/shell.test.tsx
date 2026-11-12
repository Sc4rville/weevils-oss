// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MotionGlobalConfig } from 'motion/react'
import { expect, it, vi } from 'vitest'
vi.mock('./app-context', async (original) => ({ ...await original<typeof import('./app-context')>(), useApp: () => ({ back: vi.fn(), theme: 'light' }) }))
import { Shell } from './shell'
MotionGlobalConfig.skipAnimations = true
it('keeps back navigation fixed while session title, metadata and all messages share the scroll container', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<Shell slot="agent" kicker="sample-project" title="SampleProject — création du monde" meta="Long session context" scrollHeading foot={<input aria-label="message" />}><p>First complete message</p><p>Last complete message</p></Shell>))
    expect(host.querySelector('.page-head .back')).not.toBeNull()
    expect(host.querySelector('.page-head h1')).toBeNull()
    expect(host.querySelector('.page-body h1')?.textContent).toBe('SampleProject — création du monde')
    expect(host.querySelector('.page-body')?.textContent).toContain('First complete message')
    expect(host.querySelector('.page-body')?.textContent).toContain('Last complete message')
    expect(host.querySelector('.page-foot input')).not.toBeNull()
  } finally { await act(async () => root.unmount()); host.remove() }
})
