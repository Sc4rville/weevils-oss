import { beforeEach, expect, it, vi } from 'vitest'
import type { SetupState } from './setup.ts'

// L'accueil de weevboss (server/setup.ts, greeting) : bonjour, puis une seule brique, d'après l'état réel. Il n'y a plus
// de premiers pas dans l'app : c'est tout l'onboarding, la suite weevboss la mène lui-même (weevils setup).
const auth = vi.hoisted(() => ({ ready: false, tool: 'claude' as 'claude' | 'codex' }))
vi.mock('./provider.ts', () => ({
  preferredTool: () => auth.tool,
  providerStatus: () => ({ installed: true, logged: auth.ready }),
  providerReady: () => auth.ready,
  codexLogged: () => false,
}))
process.env.WEEVILS_LANG = 'en'
const { greeting } = await import('./setup.ts')

const state = (o: { devices?: number; github?: boolean; projects?: number } = {}) =>
  ({ phone: { devices: o.devices ?? 1, push: 0 }, github: { logged: o.github ?? false }, projects: o.projects ?? 0 }) as unknown as SetupState
const desktop = { os: 'linux', mobile: false, standalone: false } as const
const phone = { os: 'ios', mobile: true, standalone: true } as const
const both = { claude: true, codex: true }

beforeEach(() => {
  auth.ready = false
  auth.tool = 'claude'
})

it('no agent signed in: hello, then only the sign-in chip of the chosen agent', () => {
  const g = greeting(state(), desktop, both)
  expect(g.brick).toBe('claude')
  expect(g.text).toMatch(/^Hi.*I’m weevboss\./)
  expect(g.text.match(/\[\[setup:/g)).toHaveLength(1)
  expect(g.text).toContain('[[setup:claude]]')
  auth.tool = 'codex'
  expect(greeting(state(), desktop, both).brick).toBe('codex')
  auth.tool = 'claude'
  expect(greeting(state(), desktop, { claude: false, codex: true }).brick).toBe('codex')
})

it('agent ready, opened on a computer with no phone yet: the phone, and the real project count', () => {
  auth.ready = true
  const g = greeting(state({ projects: 12 }), desktop, both)
  expect(g.brick).toBe('phone')
  expect(g.text).toContain('your 12 projects')
  expect(g.text).toContain('[[setup:phone]]')
})

it('opened on the phone: GitHub next, then nothing left to offer', () => {
  auth.ready = true
  expect(greeting(state(), phone, both).brick).toBe('github')
  const done = greeting(state({ github: true }), phone, both)
  expect(done.brick).toBeUndefined()
  expect(done.text).not.toContain('[[setup:')
  expect(done.text).not.toContain('projects')
})
