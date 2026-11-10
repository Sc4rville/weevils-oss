// @vitest-environment happy-dom
// Envoyer à weevboss (clavier, logo vocal, pièce jointe) n'ouvre jamais le plein écran : tout reste réduit,
// le message et la réponse s'affichent dans l'aperçu. Régressé deux fois : ce test le garde.
import { act } from 'react'
import { MotionGlobalConfig } from 'motion/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message, Snapshot } from '../../shared/api.ts'
import type { ForYouItem } from '../../shared/foryou.ts'
import type { Page } from './app-context'

const sent = vi.hoisted(() => ({ main: [] as string[], devil: [] as string[], attach: [] as string[], gate: null as Promise<void> | null, fail: '', foryou: 0, feed: [] as unknown[] }))

vi.mock('../api', () => ({
  api: {
    main: async (text: string) => {
      sent.main.push(text)
      if (sent.gate) await sent.gate
      if (sent.fail) throw new Error(sent.fail)
    },
    devil: async (text: string) => void sent.devil.push(text),
    mainAttach: async (text: string, files: { name: string }[]) => void sent.attach.push(`${text}|${files.map((f) => f.name).join(',')}`),
    usageRate: async () => ({ step: 15_000, end: Date.now(), buckets: [] }),
    // « Pour toi » : compté, pour vérifier que la bande ne l'appelle jamais sans flux côté serveur.
    foryou: async () => {
      sent.foryou++
      return { rev: 1, items: sent.feed, pulse: { working: 0, waiting: 0, delivered: 0, auto: 0 } }
    },
    foryouSeen: async () => ({ ok: true }),
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
const { resetForYou } = await import('./foryou-store')
const { tr } = await import('../i18n')
const { default: BM } = await import('../i18n/bands')

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
let pushed: Page[]

function render(s: Snapshot, open = false) {
  const ctx = {
    snap: s,
    now: Date.now(),
    offline: false,
    colors: {},
    push: (p: Page) => void pushed.push(p),
    replace: () => {},
    back: () => {},
    home: () => {},
    expanded: open ? 'agent' : null,
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
  const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>('form input:not([type=file]), form textarea')!
  await act(async () => {
    const proto = Object.getPrototypeOf(field)
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, text)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const submit = () => act(async () => void document.querySelector('form')!.requestSubmit())

// Des bulles apparaissent et partent (envoi en cours, réponse) : sans Web Animations, motion les joue en JS (happy-dom
// rejette celles qu'on annule).
const animate = Element.prototype.animate
beforeAll(() => void ((Element.prototype as { animate?: unknown }).animate = undefined))
afterAll(() => void (Element.prototype.animate = animate))

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  sent.main = []
  sent.devil = []
  sent.attach = []
  sent.gate = null
  sent.fail = ''
  sent.foryou = 0
  sent.feed = []
  expanded = []
  pushed = []
  localStorage.clear()
  resetForYou()
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
    const input = document.querySelector<HTMLInputElement>('input[type=file]')!
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
    expect(document.querySelector('.devil-on')).toBeNull()
    await type('dis un truc')
    await submit()
    await flush()
    expect(sent.main).toEqual(['dis un truc'])
    expect(sent.devil).toEqual([])
  })

  it('le réglage du devil mode s’applique tout de suite à la bande', async () => {
    render({ ...snap([]), devil: { enabled: true, working: false } })
    expect(document.querySelector('.devil-on')).toBeNull()
    act(() => setDevil(true))
    expect(document.querySelector('.devil-on')).not.toBeNull()
    act(() => setDevil(false))
    expect(document.querySelector('.devil-on')).toBeNull()
  })

  it('le message envoyé et la réponse apparaissent dans l’aperçu, bande réduite', async () => {
    render(snap([msg('u', 'user', 'fais le point', 1), msg('r', 'assistant', 'Tout tourne, deux sessions travaillent.', 2)]))
    const peek = document.querySelector('.peek')!
    expect(peek.textContent).toContain('fais le point')
    expect(peek.textContent).toContain('Tout tourne, deux sessions travaillent.')
    // Le fil est déjà rendu mais caché : l'ouvrir est immédiat.
    expect(document.querySelector<HTMLElement>('#agent-body')!.hidden).toBe(true)
    // Le tap simple, lui, ouvre la conversation.
    await act(async () => (peek as HTMLElement).click())
    expect(expanded).toEqual(['agent'])
  })
})

describe('fil de weevboss ouvert : il suit la réponse qui s’écrit', () => {
  // happy-dom ne calcule pas de mise en page : la hauteur du fil suit la longueur du dernier message.
  const fake = (el: HTMLElement, height: () => number) => {
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: height })
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 300 })
  }
  const devil = (text: string) => ({ ...msg('d', 'assistant', text, 2), devil: true })

  it('une réponse du diable en direct garde la fin visible', async () => {
    let s = { ...snap([msg('u', 'user', 'et toi ?', 1), devil('')]), devil: { enabled: true, working: true } }
    render(s, true)
    const chat = document.querySelector<HTMLElement>('.chat')!
    let h = 1000
    fake(chat, () => h)
    chat.scrollTop = 700
    for (const text of ['Moi', 'Moi je pense', 'Moi je pense que non, et voici pourquoi.']) {
      h += 200
      s = { ...s, main: [s.main[0], devil(text)] }
      render(s, true)
      expect(chat.scrollTop).toBe(h)
    }
  })

  it('notre propre défilement doux ne décroche pas le suivi (aperçu réduit)', async () => {
    let s = snap([msg('u', 'user', 'fais le point', 1)])
    render(s)
    const peek = document.querySelector<HTMLElement>('.peek')!
    let h = 800
    fake(peek, () => h)
    // Une position intermédiaire d'un défilement animé, loin du bas, sans geste : ce n'est pas l'utilisateur qui relit.
    peek.scrollTop = 100
    await act(async () => void peek.dispatchEvent(new Event('scroll')))
    h = 1100
    s = { ...s, main: [...s.main, msg('r', 'assistant', 'Tout tourne.', 2)] }
    render(s)
    expect(peek.scrollTop).toBe(1100)
  })

  it('pas quand on relit plus haut', async () => {
    let s = { ...snap([msg('u', 'user', 'et toi ?', 1), devil('')]), devil: { enabled: true, working: true } }
    render(s, true)
    await flush()
    const chat = document.querySelector<HTMLElement>('.chat')!
    fake(chat, () => 3000)
    // Un geste de l'utilisateur (le doigt remonte) : seul un geste décroche le suivi, pas un défilement du programme.
    await act(async () => void chat.dispatchEvent(new Event('touchstart')))
    chat.scrollTop = 200
    await act(async () => void chat.dispatchEvent(new Event('scroll')))
    await act(async () => void chat.dispatchEvent(new Event('touchend')))
    s = { ...s, main: [s.main[0], devil('Moi je pense')] }
    render(s, true)
    expect(chat.scrollTop).toBe(200)
  })
})

describe('le message envoyé se voit tout de suite', () => {
  // Ce qui part de l'aperçu part tout de suite (sans l'animation de sortie) : on lit l'état final.
  beforeAll(() => void (MotionGlobalConfig.skipAnimations = true))
  afterAll(() => void (MotionGlobalConfig.skipAnimations = false))
  it('une bulle « envoi… » dans l’aperçu dès le tap, remplacée par la vraie à son arrivée', async () => {
    let open = () => {}
    sent.gate = new Promise((r) => (open = r))
    const s = snap([msg('a', 'assistant', 'salut', 1)])
    render(s)
    await type('fais le point')
    await submit()
    const peek = document.querySelector('.peek')!
    expect(peek.textContent).toContain('fais le point')
    expect(peek.textContent).toContain(tr(BM).sending)
    // Claude Code l'a écrit dans son transcript : une seule bulle, la vraie.
    render({ ...s, main: [...s.main, msg('u', 'user', 'fais le point', 2)] })
    await act(async () => open())
    await flush()
    expect(peek.textContent).not.toContain(tr(BM).sending)
    expect(peek.textContent!.split('fais le point').length - 1).toBe(1)
  })

  it('un envoi refusé retire la bulle, rend le texte et dit pourquoi', async () => {
    sent.fail = 'weevboss est occupé'
    render(snap([msg('a', 'assistant', 'salut', 1)]))
    await type('fais le point')
    await submit()
    await flush()
    expect(document.querySelector('.peek')!.textContent).not.toContain('fais le point')
    expect(document.querySelector<HTMLTextAreaElement>('form textarea')!.value).toBe('fais le point')
    expect(document.querySelector('.attach-line')?.textContent).toContain('weevboss est occupé')
  })

  it('le dernier message de l’aperçu montre sa fin, pas son début coupé', () => {
    const long = `${'début '.repeat(80)}la toute fin de la réponse`
    render(snap([msg('a', 'assistant', long, 1)]))
    const last = document.querySelector('.peek-item.last')!
    expect(last.textContent).toContain('la toute fin de la réponse')
    expect(last.textContent!.length).toBeLessThan(long.length)
  })
})

describe('« weevboss · pour toi » dans la bande du haut', () => {
  const fy = (id: string, text: string, over: Partial<ForYouItem> = {}): ForYouItem => ({ id, kind: 'boss', tone: 'neutral', at: 1, who: 'weevboss', text, ...over })
  const withStream = (main: Message[], unseen = 0): Snapshot => ({ ...snap(main), foryou: { rev: 1, unseen } })
  const words = () => [...document.querySelectorAll<HTMLButtonElement>('.fyt-word')]
  const peekWrap = () => document.querySelector<HTMLElement>('.band.agent .peek-wrap')!
  const fyWrap = () => document.querySelector<HTMLElement>('.band.agent .fyt-wrap')!

  it('sans flux sur ce serveur : ni mots, ni aperçu, ni appel, même si l’appareil se souvient de « pour toi »', async () => {
    localStorage.setItem('weevils-top', 'foryou')
    render(snap([msg('a', 'assistant', 'salut', 1)]))
    await flush()
    expect(words()).toEqual([])
    expect(document.querySelector('.fyt-wrap')).toBeNull()
    expect(document.querySelector('.agent-top .devil-btn')).not.toBeNull()
    expect(sent.foryou).toBe(0)
    // L'aperçu du fil est là, comme avant.
    expect(peekWrap().hidden).toBe(false)
    expect(document.querySelector('.band.agent .peek-wrap:not([hidden]) .peek')!.textContent).toContain('salut')
  })

  it('avec un flux : les deux mots, weevboss actif par défaut, l’aperçu du fil inchangé', async () => {
    render(withStream([msg('a', 'assistant', 'salut', 1)]))
    await flush()
    expect(words().map((w) => w.textContent)).toEqual(['weevboss', tr(BM).forYou])
    expect(words().map((w) => w.getAttribute('aria-pressed'))).toEqual(['true', 'false'])
    // Entre la ligne du logo et l'aperçu, dans l'espace de la bande.
    const kids = [...document.querySelector('.agent-space')!.children].map((e) => e.className.split(' ')[0])
    expect(kids.indexOf('agent-nav')).toBeGreaterThan(kids.indexOf('agent-top'))
    expect(kids.indexOf('agent-nav')).toBeLessThan(kids.indexOf('peek-wrap'))
    expect(peekWrap().hidden).toBe(false)
    expect(fyWrap().hidden).toBe(true)
    expect(document.querySelector('.agent-nav .devil-btn')).not.toBeNull()
    expect(document.querySelector('.peek')!.textContent).toContain('salut')
  })

  it('« pour toi » montre l’aperçu du flux et cache celui du fil sans le démonter', async () => {
    sent.feed = [fy('p1', 'Deux sessions lancées ce matin.')]
    render(withStream([msg('a', 'assistant', 'salut', 1)]))
    await flush()
    const peek = document.querySelector('.peek')!
    await act(async () => words()[1].click())
    expect(words().map((w) => w.getAttribute('aria-pressed'))).toEqual(['false', 'true'])
    expect(peekWrap().hidden).toBe(true)
    expect(fyWrap().hidden).toBe(false)
    expect(fyWrap().textContent).toContain('Deux sessions lancées ce matin.')
    // Le même aperçu du fil, toujours monté, avec ses messages.
    expect(document.querySelector('.peek')).toBe(peek)
    expect(peek.textContent).toContain('salut')
    expect(document.querySelector('.band.agent .peek-wrap:not([hidden])')).toBeNull()
    expect(localStorage.getItem('weevils-top')).toBe('foryou')
    // Changer de mot n'ouvre rien.
    expect(expanded).toEqual([])
    expect(pushed).toEqual([])
    // Et retour.
    await act(async () => words()[0].click())
    expect(peekWrap().hidden).toBe(false)
    expect(fyWrap().hidden).toBe(true)
  })

  it('un tap sur l’aperçu de « pour toi » ouvre le flux en plein écran, pas le fil', async () => {
    localStorage.setItem('weevils-top', 'foryou')
    sent.feed = [fy('p1', 'Deux sessions lancées ce matin.')]
    render(withStream([]))
    await flush()
    await act(async () => document.querySelector<HTMLElement>('.fyt-peek')!.click())
    expect(pushed).toEqual([{ kind: 'foryou' }])
    expect(expanded).toEqual([])
    // Le mot déjà actif, touché de nouveau : pareil.
    await act(async () => words()[1].click())
    expect(pushed).toEqual([{ kind: 'foryou' }, { kind: 'foryou' }])
  })

  it('envoyer depuis « pour toi » n’ouvre pas la bande et ramène l’aperçu sur weevboss, où la bulle se voit', async () => {
    let open = () => {}
    sent.gate = new Promise((r) => (open = r))
    localStorage.setItem('weevils-top', 'foryou')
    render(withStream([msg('a', 'assistant', 'salut', 1)]))
    await flush()
    expect(peekWrap().hidden).toBe(true)
    await type('fais le point')
    await submit()
    expect(sent.main).toEqual(['fais le point'])
    expect(expanded).not.toContain('agent')
    expect(pushed).toEqual([])
    expect(peekWrap().hidden).toBe(false)
    expect(fyWrap().hidden).toBe(true)
    expect(words().map((w) => w.getAttribute('aria-pressed'))).toEqual(['true', 'false'])
    const shown = document.querySelector('.band.agent .peek-wrap:not([hidden]) .peek')!
    expect(shown.textContent).toContain('fais le point')
    expect(shown.textContent).toContain(tr(BM).sending)
    await act(async () => open())
    await flush()
    expect(expanded).not.toContain('agent')
  })

  it('au logo vocal et avec une pièce jointe depuis « pour toi » : pareil', async () => {
    localStorage.setItem('weevils-top', 'foryou')
    render(withStream([]))
    await flush()
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid=logo]')!.click())
    await flush()
    expect(sent.main).toEqual(['dicté au logo'])
    expect(peekWrap().hidden).toBe(false)
    await act(async () => words()[1].click())
    expect(peekWrap().hidden).toBe(true)
    const input = document.querySelector<HTMLInputElement>('input[type=file]')!
    await act(async () => {
      Object.defineProperty(input, 'files', { value: [new File(['x'], 'devis.pdf', { type: 'application/pdf' })], configurable: true })
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()
    await type('regarde ça')
    await submit()
    await flush()
    expect(sent.attach).toEqual(['regarde ça|devis.pdf'])
    expect(peekWrap().hidden).toBe(false)
    expect(expanded).not.toContain('agent')
  })

  it('fil ouvert : les mots restent, weevboss actif ; « pour toi » ouvre le flux et laisse le fil tel quel', async () => {
    localStorage.setItem('weevils-top', 'foryou')
    render(withStream([msg('a', 'assistant', 'salut', 1)]), true)
    await flush()
    expect(words().map((w) => w.getAttribute('aria-pressed'))).toEqual(['true', 'false'])
    expect(peekWrap().hidden).toBe(true)
    expect(fyWrap().hidden).toBe(true)
    expect(document.querySelector<HTMLElement>('#agent-body')!.hidden).toBe(false)
    await act(async () => words()[1].click())
    expect(pushed).toEqual([{ kind: 'foryou' }])
    // Ni refermé, ni changé de mot mémorisé.
    expect(expanded).toEqual([])
    expect(localStorage.getItem('weevils-top')).toBe('foryou')
    expect(document.querySelector('#agent-body .chat')).not.toBeNull()
  })

  it('un point sur « pour toi » quand il reste du non vu', async () => {
    sent.feed = [fy('p1', 'Du neuf.'), fy('p2', 'Déjà lu.', { seen: true })]
    render(withStream([], 1))
    await flush()
    expect(words()[1].querySelector('.fyt-dot')).not.toBeNull()
    expect(words()[0].querySelector('.fyt-dot')).toBeNull()
  })

  it('sans rien à voir : pas de point', async () => {
    render(withStream([], 0))
    await flush()
    expect(document.querySelector('.fyt-dot')).toBeNull()
  })
})

it('a new dictated user message releases a preview left in history-reading mode', async () => {
  const media = vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList)
  render(snap([msg('old', 'user', 'ancien message', 1), msg('reply', 'assistant', 'ancienne réponse', 2)]))
  const peek = document.querySelector<HTMLElement>('.peek')!
  Object.defineProperties(peek, { scrollHeight: { value: 2400, configurable: true }, clientHeight: { value: 180, configurable: true } })
  act(() => {
    peek.dispatchEvent(new Event('pointerdown'))
    peek.scrollTop = 0
    peek.dispatchEvent(new Event('scroll'))
    peek.dispatchEvent(new Event('pointerup'))
  })
  const transcript = `${'Long message dicté. '.repeat(180)}FIN DU MESSAGE`
  render(snap([msg('old', 'user', 'ancien message', 1), msg('reply', 'assistant', 'ancienne réponse', 2), msg('dictated', 'user', transcript, 3)]))
  await flush()
  expect(peek.scrollTop).toBe(2400)
  expect(peek.textContent).toContain('FIN DU MESSAGE')
  // The preview is compact, the full message remains intact in the thread.
  expect(document.querySelector('#agent-body')!.textContent).toContain('Long message dicté.')
  media.mockRestore()
})

it('a new reply while reading keeps the position and offers a way to the end', async () => {
  const media = vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList)
  render(snap([msg('old', 'user', 'ancien message', 1), msg('reply', 'assistant', 'ancienne réponse', 2)]))
  const peek = document.querySelector<HTMLElement>('.peek')!
  Object.defineProperties(peek, { scrollHeight: { value: 2400, configurable: true }, clientHeight: { value: 180, configurable: true } })
  act(() => {
    peek.dispatchEvent(new Event('pointerdown'))
    peek.scrollTop = 0
    peek.dispatchEvent(new Event('scroll'))
    peek.dispatchEvent(new Event('pointerup'))
  })
  render(snap([msg('old', 'user', 'ancien message', 1), msg('reply', 'assistant', 'ancienne réponse', 2), msg('new-reply', 'assistant', 'nouvelle réponse', 3)]))
  await flush()
  expect(peek.scrollTop).toBe(0)
  const toEnd = document.querySelector<HTMLButtonElement>('.peek-behind')!
  expect(toEnd).not.toBeNull()
  act(() => toEnd.click())
  expect(peek.scrollTop).toBe(2400)
  media.mockRestore()
})
