// @vitest-environment happy-dom
// Envoyer à weevboss (clavier, logo vocal, pièce jointe) n'ouvre jamais le plein écran : tout reste réduit,
// le message et la réponse s'affichent dans l'aperçu. Régressé deux fois : ce test le garde.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message, Snapshot } from '../../shared/api.ts'

const sent = vi.hoisted(() => ({ main: [] as string[], devil: [] as string[], attach: [] as string[] }))

vi.mock('../api', () => ({
  api: {
    main: async (text: string) => void sent.main.push(text),
    devil: async (text: string) => void sent.devil.push(text),
    mainAttach: async (text: string, files: { name: string }[]) => void sent.attach.push(`${text}|${files.map((f) => f.name).join(',')}`),
  },
}))
vi.mock('../push', () => ({ ensurePush: async () => {} }))
// Le logo vocal : on ne simule pas le micro, seulement ce qu'il fait au bout du compte (texte entendu, puis envoi).
vi.mock('./voice', () => ({
  VoiceLogo: ({ onText, onSend }: { onText: (t: string) => void; onSend: () => void }) => (
    <button
      data-testid="logo"
      onClick={() => {
        onText('dicté au logo')
        setTimeout(onSend, 0)
      }}
    />
  ),
}))

const { AgentBand } = await import('./bands')
const { Ctx } = await import('./app-context')
const { setDevil } = await import('./devil')

const msg = (id: string, role: Message['role'], text: string, at: number): Message => ({ id, role, text, at })

const snap = (main: Message[], working = false): Snapshot => ({
  version: 1,
  now: Date.now(),
  machines: [],
  projects: [],
  sessions: [],
  h24: [],
  conversations: [],
  conversationCounts: { total: 0, pending: 0, byProject: {} },
  classifier: { running: false, queued: 0 },
  main,
  mainWorking: working,
  mainHasScreen: false,
  mainQueued: 0,
  devil: { enabled: false, working: false },
  pinnedRepos: [],
  config: { userName: '', exposeDomain: '', publicHost: '' },
})

let root: Root
let host: HTMLElement
let expanded: (string | null)[]

function render(s: Snapshot) {
  const ctx = {
    snap: s,
    now: Date.now(),
    offline: false,
    colors: {},
    push: () => {},
    replace: () => {},
    back: () => {},
    home: () => {},
    expanded: null,
    setExpanded: (id: string | null) => void expanded.push(id),
    h24Open: false,
    setH24Open: () => {},
    theme: 'light' as const,
    setTheme: () => {},
    refresh: () => {},
    logout: () => {},
  }
  act(() =>
    root.render(
      <Ctx.Provider value={ctx}>
        <AgentBand />
      </Ctx.Provider>,
    ),
  )
}

const flush = () => act(() => new Promise((r) => setTimeout(r, 20)))

const type = async (text: string) => {
  const field = host.querySelector<HTMLInputElement | HTMLTextAreaElement>('form input:not([type=file]), form textarea')!
  await act(async () => {
    const proto = Object.getPrototypeOf(field)
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, text)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const submit = () => act(async () => void host.querySelector('form')!.requestSubmit())

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  sent.main = []
  sent.devil = []
  sent.attach = []
  expanded = []
  localStorage.clear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('bande de weevboss : envoyer ne l’ouvre jamais en plein écran', () => {
  it('au clavier', async () => {
    render(snap([msg('a', 'assistant', 'salut', 1)]))
    await type('fais le point')
    await submit()
    await flush()
    expect(sent.main).toEqual(['fais le point'])
    expect(expanded).not.toContain('agent')
  })

  it('au logo vocal', async () => {
    render(snap([]))
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid=logo]')!.click())
    await flush()
    expect(sent.main).toEqual(['dicté au logo'])
    expect(expanded).not.toContain('agent')
  })

  it('avec une pièce jointe', async () => {
    render(snap([]))
    const input = host.querySelector<HTMLInputElement>('input[type=file]')!
    const file = new File(['%PDF-1.4'], 'devis.pdf', { type: 'application/pdf' })
    await act(async () => {
      Object.defineProperty(input, 'files', { value: [file], configurable: true })
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()
    await type('regarde ça')
    await submit()
    await flush()
    expect(sent.attach).toEqual(['regarde ça|devis.pdf'])
    expect(expanded).not.toContain('agent')
  })

  it('en devil mode', async () => {
    localStorage.setItem('weevils-devil', '1')
    render({ ...snap([]), devil: { enabled: true, working: false } })
    await type('dis un truc')
    await submit()
    await flush()
    expect(sent.devil).toEqual(['dis un truc'])
    expect(expanded).not.toContain('agent')
  })

  it('devil mode resté allumé sur l’appareil, mais plus de modèle branché : weevboss reçoit', async () => {
    localStorage.setItem('weevils-devil', '1')
    render(snap([]))
    expect(host.querySelector('.devil-on')).toBeNull()
    await type('dis un truc')
    await submit()
    await flush()
    expect(sent.main).toEqual(['dis un truc'])
    expect(sent.devil).toEqual([])
  })

  it('le réglage du devil mode s’applique tout de suite à la bande', async () => {
    render({ ...snap([]), devil: { enabled: true, working: false } })
    expect(host.querySelector('.devil-on')).toBeNull()
    act(() => setDevil(true))
    expect(host.querySelector('.devil-on')).not.toBeNull()
    act(() => setDevil(false))
    expect(host.querySelector('.devil-on')).toBeNull()
  })

  it('le message envoyé et la réponse apparaissent dans l’aperçu, bande réduite', async () => {
    render(snap([msg('u', 'user', 'fais le point', 1), msg('r', 'assistant', 'Tout tourne, deux sessions travaillent.', 2)]))
    const peek = host.querySelector('.peek')!
    expect(peek.textContent).toContain('fais le point')
    expect(peek.textContent).toContain('Tout tourne, deux sessions travaillent.')
    // Le fil est déjà rendu mais caché : l'ouvrir est immédiat.
    expect(host.querySelector<HTMLElement>('#agent-body')!.hidden).toBe(true)
    // Le tap simple, lui, ouvre la conversation.
    await act(async () => (peek as HTMLElement).click())
    expect(expanded).toEqual(['agent'])
  })
})
