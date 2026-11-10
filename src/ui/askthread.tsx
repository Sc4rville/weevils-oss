import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { Message } from '../../shared/api.ts'
import { useApp } from './app-context'
import { AskPanel, AskVoice, useAsk, type Ask } from './ask'
import { wordAt } from './codesel'
import { EDGE } from './codeview'
import { anchorRow, flatText, offsetOf, pathAt, pathOrWord, rangeOf, wordUnder } from './textpick'
import { listFiles, matchFile, parsePath } from './repofiles'
import { step, userText } from './format'
import { markSeen } from './hints'

/**
 * Un fil de conversation qu'on interroge (session ou weevboss) : chaque mot d'un message, d'une ligne d'outil ou d'un
 * bloc de code ouvert répond au tap ; un glissé horizontal prend plusieurs mots du même message ; un chemin se prend
 * en entier et peut s'ouvrir. La barre et la réponse s'affichent sous le message (ask.tsx). L'appui long copie
 * toujours le message entier (Bubble, bits.tsx) : un appui de plus de ~0,45 s n'est jamais un tap ici.
 */

export interface ThreadInfo {
  title: string
  /** claude, codex, weevboss… */
  tool: string
  project?: string
  projectId?: string
  repo?: string
  machine?: string
}

/** Une sélection dans un message : son id (data-mid) et les caractères [s, e) de son texte à plat. */
interface TSel {
  mid: string
  s: number
  e: number
}

const LONG = 450
const HL = 'wv-ask'

type Highlights = { set: (k: string, v: unknown) => void; delete: (k: string) => void }
const highlights = (): { reg: Highlights; H: new (...r: Range[]) => unknown } | null => {
  const reg = (globalThis.CSS as unknown as { highlights?: Highlights })?.highlights
  const H = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight
  return reg && H ? { reg, H } : null
}

const who = (m: Message, tool: string, me: string) => (m.role === 'user' ? me : m.role === 'assistant' ? tool : m.role === 'event' ? '→' : (m.author ?? 'weevboss'))
const body = (m: Message) => (m.role === 'user' ? userText(m.text) : m.role === 'event' ? step(m.text) : m.text)
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export function useThreadAsk(messages: Message[], info: ThreadInfo) {
  const { snap, push } = useApp()
  const box = useRef<HTMLDivElement | null>(null)
  const [sel, setSel] = useState<TSel | null>(null)
  const [selText, setSelText] = useState('')
  const [dragging, setDragging] = useState(false)
  /** Message sous lequel s'ouvre une question dictée sans sélection. */
  const [spot, setSpot] = useState<string | null>(null)
  const frozen = useRef<string | null>(null)

  /** Les messages à l'écran (ids), du haut vers le bas. */
  const visibleIds = () => {
    const el = box.current
    const sc = el?.closest('[data-scroll]') ?? el?.closest('.chat') ?? el
    if (!el || !sc) return []
    const { top, bottom } = sc.getBoundingClientRect()
    return [...el.querySelectorAll<HTMLElement>('[data-mid]')].filter((n) => {
      const r = n.getBoundingClientRect()
      return r.bottom > top && r.top < bottom
    }).map((n) => n.dataset.mid!)
  }
  /** Le message sous lequel ouvrir une question dictée : le dernier vu en entier (pas celui que coupe le bas de l'écran,
   * ni celui caché sous le logo ou la saisie) ; sinon le dernier visible. */
  const spotId = () => {
    const el = box.current
    const sc = el?.closest('[data-scroll]') ?? el?.closest('.chat') ?? el
    if (!el || !sc) return null
    const { top, bottom } = sc.getBoundingClientRect()
    const whole = [...el.querySelectorAll<HTMLElement>('[data-mid]')].filter((n) => {
      const r = n.getBoundingClientRect()
      return r.bottom > top && r.bottom <= bottom - 72
    })
    return whole.at(-1)?.dataset.mid ?? visibleIds().at(-1) ?? null
  }

  const a: Ask = useAsk(
    () => {
      const ids = sel ? [sel.mid] : spot ? [spot] : visibleIds()
      const first = Math.max(0, messages.findIndex((m) => m.id === ids[0]))
      const last = Math.max(first, messages.findIndex((m) => m.id === ids[ids.length - 1]))
      const from = Math.max(0, first - 4)
      const to = Math.min(messages.length - 1, last + 3)
      const lines: string[] = []
      for (let i = from; i <= to; i++) lines.push(`[${who(messages[i], info.tool, snap.config.userName || 'user')}] ${clip(body(messages[i]), i >= first && i <= last ? 3000 : 900)}`)
      return { kind: 'conv', repo: info.repo ?? '', path: '', machine: info.machine, title: info.title, tool: info.tool, project: info.project, selection: sel ? selText : '', from: 0, to: 0, around: lines.join('\n\n') }
    },
    { onVoice: () => !sel && !spot && setSpot(spotId()) },
  )
  const live = useRef({ a, sel })
  live.current = { a, sel }

  /** Au lâcher, le message touché reste à sa place à l'écran pendant que la barre change de message (recalé après le rendu). */
  const settle = useRef<(() => void) | null>(null)
  const keepRow = useCallback((row: Element | null) => {
    const fix = anchorRow(row)
    settle.current = fix
    requestAnimationFrame(() => settle.current === fix && (settle.current = null))
  }, [])
  useLayoutEffect(() => {
    const fix = settle.current
    settle.current = null
    fix?.()
  })

  const choose = useCallback((next: TSel | null, text = '') => {
    live.current.a.reset()
    setSpot(null)
    setSel(next)
    setSelText(text)
    if (next) markSeen('g-ask')
  }, [])

  // ---- Gestes. Capture : la bulle arrête la souris pour son propre usage, on doit tout voir avant elle.
  const attach = useCallback(
    (el: HTMLDivElement | null) => {
      const prev = box.current as (HTMLDivElement & { __off?: () => void }) | null
      prev?.__off?.()
      box.current = el
      if (!el) return
      type G = { id: number; x: number; y: number; t: number; root: HTMLElement | null; flat: string; col: number; word: [number, number] | null; mode: 'pending' | 'words' | 'off'; mouse: boolean }
      let g: G | null = null
      const down = (e: PointerEvent) => {
        if (e.button !== 0 || !e.isPrimary) return
        g = null
        const target = e.target as Element
        if (target.closest('a, button, input, textarea, .qa') || e.clientX < EDGE) return
        const root = target.closest<HTMLElement>('[data-mid]')
        const base = { id: e.pointerId, x: e.clientX, y: e.clientY, t: Date.now(), mode: 'pending' as const, mouse: e.pointerType === 'mouse' }
        if (!root || !el.contains(root)) return void (g = { ...base, root: null, flat: '', col: 0, word: null })
        const flat = flatText(root)
        const u = wordUnder(root, flat, e.clientX, e.clientY, pathOrWord)
        g = { ...base, root, flat, col: u?.col ?? 0, word: u?.word ?? null }
      }
      // Phase de bulle : un geste qui part d'un mot est à nous, la page ne part ni en arrière ni vers les repos.
      const claim = (e: PointerEvent) => {
        if (g && g.id === e.pointerId && g.word && !g.mouse) e.stopPropagation()
      }
      const move = (e: PointerEvent) => {
        if (!g || e.pointerId !== g.id || g.mode === 'off' || !g.root) return
        const dx = e.clientX - g.x
        const dy = e.clientY - g.y
        if (g.mode === 'pending') {
          if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return
          // À la souris, glisser garde la sélection native du navigateur (reprise au lâcher) ; au doigt, l'horizontal est à nous.
          if (g.mouse || !g.word || Math.abs(dy) > Math.abs(dx)) return void (g.mode = 'off')
          // Pas de capture du pointeur : au doigt, les mouvements restent sur la bulle, qui annule ainsi son appui long.
          g.mode = 'words'
          frozen.current = live.current.sel?.mid ?? null
          setDragging(true)
        }
        const at = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-mid]')
        const anchor = wordAt(g.flat, g.col) ?? g.word!
        let s = anchor[0]
        let end = anchor[1]
        if (at === g.root) {
          const u = wordUnder(g.root, g.flat, e.clientX, e.clientY)
          const k = u?.col ?? g.col
          const f = wordAt(g.flat, k) ?? wordAt(g.flat, k - 1) ?? [k, k]
          if (f[0] < s) s = f[0]
          else end = Math.max(end, f[1])
        } else {
          // Hors du message : la sélection va jusqu'à son début ou sa fin.
          const r = g.root.getBoundingClientRect()
          if (e.clientY > r.bottom) end = g.flat.length
          else if (e.clientY < r.top) s = 0
        }
        setSel({ mid: g.root.dataset.mid!, s, e: end })
        markSeen('g-ask')
        setSelText(g.flat.slice(s, end).trim())
      }
      const up = (e: PointerEvent) => {
        if (!g || e.pointerId !== g.id) return
        const was = g
        g = null
        setDragging(false)
        keepRow(was.root)
        if (was.mode === 'words') {
          live.current.a.reset()
          setSpot(null)
          return
        }
        // Souris : une sélection native dans un seul message devient la nôtre.
        const ns = window.getSelection()
        if (was.mouse && ns && !ns.isCollapsed && ns.rangeCount) {
          const r = ns.getRangeAt(0)
          const root = (r.commonAncestorContainer instanceof Element ? r.commonAncestorContainer : r.commonAncestorContainer.parentElement)?.closest<HTMLElement>('[data-mid]')
          if (root && el.contains(root)) {
            const s = offsetOf(root, r.startContainer, r.startOffset)
            const end = offsetOf(root, r.endContainer, r.endOffset)
            if (s != null && end != null && end > s) {
              const flat = flatText(root)
              ns.removeAllRanges()
              return choose({ mid: root.dataset.mid!, s, e: end }, flat.slice(s, end).trim())
            }
          }
        }
        if (was.mode !== 'pending' || Date.now() - was.t > LONG) return // appui long : la bulle a copié le message
        const cur = live.current.sel
        const w = was.word
        if (!was.root || !w || (cur && cur.mid === was.root.dataset.mid && cur.s === w[0] && cur.e === w[1])) return choose(null)
        choose({ mid: was.root.dataset.mid!, s: w[0], e: w[1] }, was.flat.slice(w[0], w[1]))
      }
      const cancel = (e: PointerEvent) => {
        if (g && e.pointerId === g.id) {
          g = null
          setDragging(false)
        }
      }
      el.addEventListener('pointerdown', down, true)
      el.addEventListener('pointerdown', claim)
      el.addEventListener('pointermove', move, true)
      el.addEventListener('pointerup', up, true)
      el.addEventListener('pointercancel', cancel, true)
      ;(el as HTMLDivElement & { __off?: () => void }).__off = () => {
        el.removeEventListener('pointerdown', down, true)
        el.removeEventListener('pointerdown', claim)
        el.removeEventListener('pointermove', move, true)
        el.removeEventListener('pointerup', up, true)
        el.removeEventListener('pointercancel', cancel, true)
      }
    },
    [choose, keepRow],
  )

  // ---- Surlignage (CSS Custom Highlight API) : rien ne change dans le rendu des messages.
  useLayoutEffect(() => {
    const h = highlights()
    if (!h) return
    const root = sel && box.current?.querySelector(`[data-mid="${CSS.escape(sel.mid)}"]`)
    const r = root && rangeOf(root, sel.s, sel.e)
    if (r) h.reg.set(HL, new h.H(r))
    else h.reg.delete(HL)
  })
  useEffect(() => () => highlights()?.reg.delete(HL), [])
  // Le message a disparu du fil (fenêtre glissante : retiré de `messages`, ou sorti des messages affichés, Messages
  // n'en montre que les derniers) : la sélection tombe ; une réponse affichée reste, sous le premier message encore
  // affiché (sinon elle disparaîtrait avec lui, et `hold` resterait vrai sans rien à l'écran).
  useEffect(() => {
    if (!sel && !spot) return
    const ids = new Set(messages.map((m) => m.id))
    const root = box.current
    const shown = root ? [...root.querySelectorAll<HTMLElement>('[data-mid]')].map((n) => n.dataset.mid!).filter((id) => ids.has(id)) : [...ids]
    const gone = (id: string) => !shown.includes(id)
    const keep = live.current.a.answer ? (shown[0] ?? null) : null
    if (sel && gone(sel.mid)) {
      setSel(null)
      setSelText('')
      setSpot(keep)
    } else if (!sel && spot && gone(spot)) setSpot(keep)
  }, [messages, sel, spot])

  // ---- « ouvre le fichier » : la sélection est un chemin d'un repo connu, et le fichier existe.
  const [file, setFile] = useState<{ projectId: string; repo: string; path: string; line?: number } | null>(null)
  useEffect(() => {
    setFile(null)
    const t = selText
    if (!t || pathAt(t, 0)?.[1] !== t.length) return
    const p = parsePath(t, info.repo)
    if (!p) return
    const project = snap.projects.find((x) => x.repos.includes(p.repo))
    const machine = project?.where[p.repo] ?? (p.repo === info.repo ? info.machine : undefined) ?? snap.machines[0]?.id ?? ''
    let off = false
    listFiles(p.repo, machine)
      .then((files) => {
        const path = matchFile(files, p.rel)
        if (!off && path) setFile({ projectId: project?.id ?? info.projectId ?? p.repo, repo: p.repo, path, line: p.line })
      })
      .catch(() => undefined)
    return () => {
      off = true
    }
  }, [selText, info.repo, info.machine, info.projectId, snap.projects, snap.machines])

  const anchor = dragging ? frozen.current : (sel?.mid ?? spot)
  const after = (id: string): ReactNode =>
    id === anchor ? (
      <div className="band qa-band">
        <div className="in">
          <AskPanel
            a={a}
            text={sel ? selText : null}
            held={dragging}
            usage={!!info.repo}
            openFile={file ? () => push({ kind: 'file', ...file }) : undefined}
            onHit={(h) => info.repo && push({ kind: 'file', projectId: info.projectId ?? info.repo, repo: info.repo, path: h.path, line: h.line })}
          />
        </div>
      </div>
    ) : null

  return {
    ref: attach,
    after,
    a,
    voice: <AskVoice a={a} />,
    selected: !!sel,
    /** Une barre ou une réponse ouverte sous un message : le fil ne doit pas la pousser hors de l'écran (useFollow `hold`). */
    hold: !!sel || dragging || (!!spot && (a.asking || !!a.answer)),
  }
}
