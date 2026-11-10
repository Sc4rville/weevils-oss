// @vitest-environment happy-dom
// The two words of the top band and the preview of « pour toi »: nothing without a stream on the server, the choice is
// kept on the device, the preview shows the first items as strips and a tap opens the stream full screen.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Snapshot } from '../../shared/api.ts'
import type { ForYouFeed, ForYouItem } from '../../shared/foryou.ts'
import type { Page } from './app-context'

const net = vi.hoisted(() => ({ feed: null as unknown, calls: 0 }))

vi.mock('../api', () => ({
  api: {
    foryou: async () => {
      net.calls++
      return net.feed
    },
    foryouSeen: async () => ({ ok: true }),
    foryouDismiss: async () => ({ ok: true }),
    setupKey: async () => ({ ok: true, said: 'm1' }),
  },
}))

localStorage.setItem('weevils-language', 'fr')
const { ForYouPeek, TopWords, useTop, setTop, PEEK_ITEMS } = await import('./foryou-top')
const { resetForYou } = await import('./foryou-store')
const { Ctx } = await import('./app-context')
const { tr } = await import('../i18n')
const { default: BM } = await import('../i18n/bands')

const item = (id: string, over: Partial<ForYouItem> = {}): ForYouItem => ({ id, kind: 'boss', tone: 'neutral', at: 1, who: 'weevboss', text: `mot ${id}`, ...over })
const feedOf = (items: ForYouItem[], rev = 1): ForYouFeed => ({ rev, items, pulse: { working: 0, waiting: 0, delivered: 0, auto: 0 } })

const snap = (foryou?: Snapshot['foryou']): Snapshot => ({
  version: 1,
  now: Date.now(),
  machines: [],
  projects: [{ id: 'p', name: 'atelier', kind: 'repo', repos: [], where: {}, lastActivityAt: 0 } as unknown as Snapshot['projects'][number]],
  sessions: [],
  h24: [],
  conversations: [],
  conversationCounts: { total: 0, pending: 0, byProject: {} },
  classifier: { running: false, queued: 0 },
  main: [],
  mainWorking: false,
  mainHasScreen: false,
  mainQueued: 0,
  devil: { enabled: false, working: false },
  pinnedRepos: [],
  config: { userName: '', exposeDomain: '', publicHost: '', authors: [{ id: 'instinct', name: 'Instinct', color: '#ff8800' }] },
  ...(foryou ? { foryou } : {}),
})

let root: Root
let host: HTMLElement
let pushed: Page[]
let picked: string[]

function Words() {
  const [top] = useTop()
  return <TopWords active={top} onPick={(x) => void picked.push(x)} />
}

function render(s: Snapshot, node: React.ReactNode) {
  const ctx = {
    snap: s,
    now: Date.now(),
    offline: false,
    colors: { p: 'p4' },
    push: (p: Page) => void pushed.push(p),
    replace: () => {},
    back: () => {},
    home: () => {},
    expanded: null,
    setExpanded: () => {},
    h24Open: false,
    setH24Open: () => {},
    theme: 'light' as const,
    setTheme: () => {},
    refresh: () => {},
    logout: () => {},
  }
  act(() => root.render(<Ctx.Provider value={ctx}>{node}</Ctx.Provider>))
}

const flush = () => act(() => new Promise((r) => setTimeout(r, 20)))

// Strips come and go: without Web Animations, motion plays them in JS (happy-dom rejects the cancelled ones).
const { MotionGlobalConfig } = await import('motion/react')
const previousSkip = MotionGlobalConfig.skipAnimations
const animate = Element.prototype.animate
beforeAll(() => { (Element.prototype as { animate?: unknown }).animate = undefined; MotionGlobalConfig.skipAnimations = true })
afterAll(() => { Element.prototype.animate = animate; MotionGlobalConfig.skipAnimations = previousSkip })

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  localStorage.setItem('weevils-language', 'fr')
  resetForYou()
  net.feed = feedOf([])
  net.calls = 0
  pushed = []
  picked = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('les deux mots « weevboss · pour toi »', () => {
  it('sans flux sur ce serveur : aucun mot, aucun appel, et le choix reste weevboss', async () => {
    localStorage.setItem('weevils-top', 'foryou')
    let seen = ''
    const Probe = () => ((seen = useTop()[0]), null)
    render(snap(), <><Words /><Probe /></>)
    await flush()
    expect(host.querySelector('.fyt-words')).toBeNull()
    expect(seen).toBe('boss')
    expect(net.calls).toBe(0)
  })

  it('le mot actif est marqué, l’autre non ; un tap rend le mot touché', async () => {
    render(snap({ rev: 1, unseen: 0 }), <Words />)
    await flush()
    const [boss, fy] = [...host.querySelectorAll<HTMLButtonElement>('.fyt-word')]
    expect(boss.textContent).toBe('weevboss')
    expect(fy.textContent).toBe(tr(BM).forYou)
    expect(boss.getAttribute('aria-pressed')).toBe('true')
    expect(boss.classList.contains('on')).toBe(true)
    expect(fy.getAttribute('aria-pressed')).toBe('false')
    expect(fy.classList.contains('on')).toBe(false)
    await act(async () => fy.click())
    expect(picked).toEqual(['foryou'])
  })

  it('le choix est gardé sur l’appareil (weevils-top) et suivi tout de suite', async () => {
    render(snap({ rev: 1, unseen: 0 }), <Words />)
    await flush()
    act(() => setTop('foryou'))
    expect(localStorage.getItem('weevils-top')).toBe('foryou')
    expect(host.querySelectorAll('.fyt-word')[1].classList.contains('on')).toBe(true)
    act(() => setTop('boss'))
    expect(host.querySelectorAll('.fyt-word')[0].classList.contains('on')).toBe(true)
  })

  it('un point sur « pour toi » tant qu’il reste du non vu', async () => {
    net.feed = feedOf([item('a'), item('b', { seen: true })])
    render(snap({ rev: 1, unseen: 1 }), <Words />)
    await flush()
    const dot = host.querySelector('.fyt-word .fyt-dot')!
    expect(dot).not.toBeNull()
    expect(dot.getAttribute('aria-label')).toBe(tr(BM).forYouUnseen(1))
    expect(host.querySelectorAll('.fyt-word')[0].querySelector('.fyt-dot')).toBeNull()
    // Tout vu : le point part.
    net.feed = feedOf([item('a', { seen: true }), item('b', { seen: true })], 2)
    render(snap({ rev: 2, unseen: 0 }), <Words />)
    await flush()
    expect(host.querySelector('.fyt-dot')).toBeNull()
  })
})

describe('répondre à une question de branchement depuis « pour toi »', () => {
  it('l’aperçu revient sur le fil de weevboss, où la suite s’affiche', async () => {
    const { SetupComposer, openKey } = await import('./setup')
    setTop('foryou')
    render(snap({ rev: 1, unseen: 0 }), <><Words /><SetupComposer /></>)
    await act(async () => openKey('OPENAI_API_KEY'))
    const form = host.querySelector<HTMLFormElement>('form.setup-form')!
    const field = form.querySelector<HTMLInputElement>('input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!.call(field, 'sk-test')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(localStorage.getItem('weevils-top')).toBe('foryou')
    await act(async () => void form.requestSubmit())
    await flush()
    expect(localStorage.getItem('weevils-top')).toBe('boss')
    expect(host.querySelector('.fyt-word.on')!.textContent).toBe('weevboss')
  })
})

describe('l’aperçu de « pour toi »', () => {
  it('vide : une ligne discrète', async () => {
    render(snap({ rev: 1, unseen: 0 }), <ForYouPeek />)
    await flush()
    expect(host.querySelector('.fyt-empty')!.textContent).toBe(tr(BM).forYouEmpty)
    expect(host.querySelectorAll('.fyt-item').length).toBe(0)
  })

  it('les premiers items seulement, dans l’ordre du flux, chacun avec qui parle et une ligne', async () => {
    net.feed = feedOf([
      item('b1', { text: 'Trois   sessions\nlancées.' }),
      item('s1', { kind: 'session', tone: 'result', who: 'session', projectId: 'p', title: 'refonte', text: 'Les tests passent.' }),
      item('m1', { kind: 'mail', who: 'instinct', text: 'J’ai relu le devis.' }),
      ...Array.from({ length: 9 }, (_, i) => item(`x${i}`)),
    ])
    render(snap({ rev: 1, unseen: 12 }), <ForYouPeek />)
    await flush()
    const strips = [...host.querySelectorAll<HTMLElement>('.fyt-item')]
    expect(strips.length).toBe(PEEK_ITEMS)
    expect(strips[0].querySelector('.strong')!.textContent).toBe('weevboss')
    expect(strips[0].textContent).toContain('Trois sessions lancées.')
    // Une session parle au nom de son projet ; un auteur extérieur sous son nom.
    expect(strips[1].querySelector('.strong')!.textContent).toBe('atelier')
    expect(strips[1].textContent).toContain('Les tests passent.')
    expect(strips[2].querySelector('.strong')!.textContent).toBe('Instinct')
    // Chaque bande a sa couleur.
    for (const s of strips) expect(s.style.getPropertyValue('--c')).not.toBe('')
    // Le nom interne d'une catégorie ne s'affiche jamais.
    expect(host.textContent).not.toMatch(/\b(session|mail|boss|proposals|media)\b/)
  })

  it('un média montre une vignette (image : le fichier ; vidéo : un signe lecture), des propositions « + n »', async () => {
    net.feed = feedOf([
      item('i', { kind: 'media', who: 'session', projectId: 'p', text: 'le rendu', media: [{ id: 'm1', type: 'image', url: '/api/foryou/media/m1', name: 'rendu.png', bytes: 10 }] }),
      item('v', { kind: 'media', who: 'session', projectId: 'p', text: '', media: [{ id: 'm2', type: 'video', url: '/api/foryou/media/m2', name: 'clip.mp4', bytes: 10 }] }),
      item('p', {
        kind: 'proposals',
        who: 'weevils',
        text: '',
        cards: [
          { id: 'c1', title: 'Surveiller les tests', why: '', source: 'optimizer', kind: 'tests' },
          { id: 'c2', title: 'Explorer', why: '', source: 'optimizer', kind: 'explore' },
        ],
      }),
      item('a', { kind: 'alert', tone: 'alert', who: 'weevils', text: 'Une session t’attend.' }),
    ])
    render(snap({ rev: 1, unseen: 4 }), <ForYouPeek />)
    await flush()
    const [img, vid, prop, alert] = [...host.querySelectorAll<HTMLElement>('.fyt-item')]
    expect(img.querySelector<HTMLImageElement>('img.fyt-thumb')!.getAttribute('src')).toBe('/api/foryou/media/m1')
    expect(vid.querySelector('img')).toBeNull()
    expect(vid.querySelector('.fyt-thumb.fyt-play svg')).not.toBeNull()
    // Sans légende, le nom du fichier.
    expect(vid.textContent).toContain('clip.mp4')
    expect(prop.querySelector('.fyt-n')!.textContent!.trim()).toBe('+ 2')
    expect(prop.textContent).toContain('Surveiller les tests')
    expect(alert.classList.contains('fyt-alert')).toBe(true)
    expect(img.classList.contains('fyt-alert')).toBe(false)
  })

  it('each strip opens the stream; its independent close does not navigate', async () => {
    net.feed = feedOf([item('a', { kind: 'alert', live: true }), item('b')])
    render(snap({ rev: 1, unseen: 2 }), <ForYouPeek />)
    await flush()
    expect(host.querySelector('[data-fy="b"] .notice-close')).toBeNull()
    await act(async () => host.querySelector<HTMLButtonElement>('.fyt-open')!.click())
    expect(pushed).toEqual([{ kind: 'foryou' }])
    await act(async () => host.querySelector<HTMLButtonElement>('.notice-close')!.click())
    await flush()
    expect(pushed).toHaveLength(1)
    expect(host.querySelector('[data-fy="a"]')).toBeNull()
    expect(host.querySelector('[data-fy="b"]')).not.toBeNull()
    expect(host.querySelector('.fyt-peek')?.getAttribute('role')).toBe('region')
  })

  it('un nouvel item arrive en tête sans démonter ceux qui sont là', async () => {
    net.feed = feedOf([item('a'), item('b')])
    render(snap({ rev: 1, unseen: 2 }), <ForYouPeek />)
    await flush()
    const before = host.querySelector<HTMLElement>('.fyt-item')!
    net.feed = feedOf([item('n', { text: 'tout frais' }), item('a'), item('b')], 2)
    render(snap({ rev: 2, unseen: 3 }), <ForYouPeek />)
    await flush()
    const strips = [...host.querySelectorAll<HTMLElement>('.fyt-item')]
    expect(strips.map((s) => s.textContent)).toEqual([expect.stringContaining('tout frais'), expect.stringContaining('mot a'), expect.stringContaining('mot b')])
    expect(strips[1]).toBe(before)
  })

  it('un mot qui s’écoute porte quatre barres ; elles ne bougent que pendant sa lecture', async () => {
    const made: { paused: boolean }[] = []
    class FakeAudio {
      constructor() {
        made.push(this)
      }
      src = ''
      preload = ''
      currentTime = 0
      paused = true
      onplaying: (() => void) | null = null
      play() {
        this.paused = false
        return Promise.resolve()
      }
      pause() {
        this.paused = true
      }
    }
    vi.stubGlobal('Audio', FakeAudio)
    const { toggleVoice, resetVoice } = await import('./foryou-voice')
    net.feed = feedOf([item('a', { kind: 'boss', who: 'weevboss', text: 'trois choses en route', voice: 'nova' }), item('b', { kind: 'boss', who: 'weevboss', text: 'sans voix' })])
    render(snap({ rev: 1, unseen: 2 }), <ForYouPeek />)
    await flush()
    const strip = (id: string) => host.querySelector(`.fyt-item[data-fy="${id}"]`)!
    expect(strip('a').querySelector('.fyt-wave')).toBeTruthy()
    expect(strip('a').querySelector('.fyt-wave.on')).toBeNull()
    expect(strip('b').querySelector('.fyt-wave')).toBeNull()
    await act(async () => toggleVoice('a', 'trois choses en route', 'nova'))
    expect(strip('a').querySelector('.fyt-wave.on')!.getAttribute('aria-label')).toBe(tr(BM).forYouSpeaking)
    // Son item quitte le flux : la lecture s'arrête.
    net.feed = feedOf([item('b', { kind: 'boss', who: 'weevboss', text: 'sans voix' })], 2)
    render(snap({ rev: 2, unseen: 1 }), <ForYouPeek />)
    await flush()
    expect(made).toHaveLength(1)
    expect(made[0].paused).toBe(true)
    expect(strip('b').querySelector('.fyt-wave')).toBeNull()
    resetVoice()
    vi.unstubAllGlobals()
  })
})
