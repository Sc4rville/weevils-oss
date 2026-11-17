import { MarkdownEditor } from './markdown-editor'
import { noticeKey } from '../../shared/notices.ts'
import { Notice } from './notice'
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FileContent } from '../api'
import { useApp } from './app-context'
import { Shell } from './shell'
import { AskPanel, AskVoice, useAsk } from './ask'
import { around, lineRange, selText, spanLines, spanWords, wordAt, type Sel } from './codesel'
import { anchorRow, caretAt, rangeOf } from './textpick'
import { reveal } from './follow'
import { useT } from '../i18n'
import M from '../i18n/pages'
import './codeview.css'

/**
 * Vue d'un fichier qu'on interroge : chaque mot répond au tap (surligné dans la couleur du projet), un glissé prend
 * plusieurs mots, la marge des numéros prend des lignes entières. Sous la sélection, la barre de ask.tsx : explique,
 * où c'est utilisé, demande. Les réponses arrivent sur place, d'un modèle rapide qui connaît la page.
 * Le logo de weevboss, en haut, écoute aussi : la question dictée porte sur la sélection, ou sur ce qui est affiché.
 */

/** Bord gauche réservé au geste retour (glisser vers la droite depuis le bord). */
export const EDGE = 22

/** Le point (x, y) dans le fichier : ligne, colonne, mot sous le doigt, ou la marge des numéros. */
function hit(box: HTMLElement, lines: string[], x: number, y: number): { line: number; col: number; gutter: boolean; word: [number, number] | null } | null {
  const el = document.elementFromPoint(x, y)
  const row = el?.closest<HTMLElement>('[data-l]')
  if (!row || !box.contains(row)) return null
  const line = Number(row.dataset.l)
  if (el?.closest('[data-g]')) return { line, col: 0, gutter: true, word: null }
  const ct = row.querySelector('.ct')
  const c = caretAt(x, y)
  if (!ct || !c || !ct.contains(c.node)) return { line, col: (lines[line] ?? '').length, gutter: false, word: null }
  const pre = document.createRange()
  pre.setStart(ct, 0)
  pre.setEnd(c.node, c.offset)
  const col = pre.toString().length
  // Le curseur tombe entre deux caractères : le mot retenu est celui qui est vraiment sous le doigt.
  for (const k of [col, col - 1]) {
    const w = wordAt(lines[line] ?? '', k)
    const r = w && rangeOf(ct, w[0], w[1])
    if (!w || !r) continue
    for (const rect of r.getClientRects()) if (x >= rect.left - 3 && x <= rect.right + 3 && y >= rect.top - 2 && y <= rect.bottom + 2) return { line, col: k, gutter: false, word: w }
  }
  return { line, col, gutter: false, word: null }
}

const CodeLine = memo(function CodeLine({ n, text, s, e, whole, flash }: { n: number; text: string; s: number; e: number; whole: boolean; flash: boolean }) {
  const on = e > s
  return (
    <div className={`cl${whole ? ' whole' : ''}${flash ? ' flash' : ''}`} data-l={n}>
      <span className="cg" data-g aria-hidden>
        {n + 1}
      </span>
      <span className="ct">
        {on ? (
          <>
            {text.slice(0, s)}
            <mark>{text.slice(s, e)}</mark>
            {text.slice(e)}
          </>
        ) : (
          text || ' '
        )}
      </span>
    </div>
  )
})

export function CodeFile({ projectId, repo, path, machine, line, file, err, kicker, onSaved }: { projectId: string; repo: string; path: string; machine: string; line?: number; file: FileContent | null; err: string | null; kicker?: string; onSaved?: (file: FileContent) => void }) {
  const { colors, push } = useApp()
  const t = useT(M)
  const [editing, setEditing] = useState(false)
  const prose = /\.(md|markdown|txt)$/i.test(path)
  const lines = useMemo(() => (file && !file.binary ? file.content.replace(/\n$/, '').split('\n') : []), [file])
  const box = useRef<HTMLDivElement>(null)
  const [sel, setSel] = useState<Sel | null>(null)
  const [dragging, setDragging] = useState(false)
  /** Ligne sous laquelle s'ouvre la question quand rien n'est sélectionné (logo vocal). */
  const [spot, setSpot] = useState<number | null>(null)
  const [flash, setFlash] = useState<number | null>(null)

  /** Lignes affichées à l'écran (0-based), pour une question sans sélection. */
  const visible = (): [number, number] => {
    const el = box.current
    const sc = el?.closest('[data-scroll]')
    if (!el || !sc || !lines.length) return [0, Math.min(lines.length - 1, 30)]
    const { top, bottom } = sc.getBoundingClientRect()
    const rows = el.querySelectorAll<HTMLElement>('[data-l]')
    const find = (y: number) => {
      let lo = 0
      let hi = rows.length - 1
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (rows[mid].getBoundingClientRect().bottom < y) lo = mid + 1
        else hi = mid
      }
      return lo
    }
    return [find(top + 8), find(bottom - 8)]
  }

  // ---- Questions : le contexte est lu au moment de demander (sélection, ou ce qui est affiché).
  const a = useAsk(
    () => {
      const [from, to] = sel ? [sel.start.line, sel.end.line] : spot != null ? [spot, spot] : visible()
      return { kind: 'file', repo, path, machine, selection: sel ? selText(lines, sel) : '', from: from + 1, to: to + 1, around: around(lines, from, to) }
    },
    { onVoice: () => !sel && spot == null && setSpot(visible()[0]) },
  )
  const live = useRef(a)
  live.current = a

  // ---- Gestes : tap = un mot ; glissé horizontal = des mots ; marge = des lignes ; glissé vertical = défilement.
  const selRef = useRef(sel)
  selRef.current = sel
  const spotRef = useRef(spot)
  spotRef.current = spot
  /** Pendant un geste, la barre reste où elle était : rien ne bouge sous le doigt. Elle rejoint la sélection au lâcher. */
  const frozen = useRef<number | null>(null)
  /** Au lâcher, la ligne touchée reste à sa place à l'écran pendant que la barre change de ligne (recalé après le rendu). */
  const settle = useRef<(() => void) | null>(null)
  useLayoutEffect(() => {
    const fix = settle.current
    settle.current = null
    fix?.()
  })
  useEffect(() => {
    const el = box.current
    if (!el) return
    let g: { id: number; x: number; y: number; at: NonNullable<ReturnType<typeof hit>>; mode: 'pending' | 'words' | 'lines' | 'off' } | null = null
    const hold = () => {
      frozen.current = selRef.current ? selRef.current.end.line : spotRef.current
      setDragging(true)
    }
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || (e.target as Element).closest('.qa')) return
      if (e.clientX < EDGE) return // le geste retour garde le bord
      const h = hit(el, lines, e.clientX, e.clientY)
      if (!h) return
      // Sur un mot ou dans la marge, le geste est à nous : la page ne part pas en arrière.
      if (h.word || h.gutter) e.stopPropagation()
      g = { id: e.pointerId, x: e.clientX, y: e.clientY, at: h, mode: h.gutter ? 'lines' : 'pending' }
      if (h.gutter) {
        el.setPointerCapture(e.pointerId)
        hold()
        setSel(spanLines(lines, h.line, h.line))
      }
    }
    const move = (e: PointerEvent) => {
      if (!g || e.pointerId !== g.id || g.mode === 'off') return
      const dx = e.clientX - g.x
      const dy = e.clientY - g.y
      if (g.mode === 'pending') {
        const mouse = e.pointerType === 'mouse'
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8 && !(mouse && Math.hypot(dx, dy) > 4)) return
        // Au doigt, un départ vertical fait défiler ; un départ horizontal sur un mot sélectionne.
        if (!g.at.word || (!mouse && Math.abs(dy) > Math.abs(dx))) {
          g.mode = 'off'
          return
        }
        g.mode = 'words'
        el.setPointerCapture(e.pointerId)
        hold()
      }
      e.stopPropagation()
      const h = hit(el, lines, e.clientX, e.clientY)
      if (!h) return
      if (g.mode === 'lines') setSel(spanLines(lines, g.at.line, h.line))
      else setSel(spanWords(lines, { line: g.at.line, col: g.at.col }, { line: h.line, col: h.col }))
    }
    const up = (e: PointerEvent) => {
      if (!g || e.pointerId !== g.id) return
      const was = g
      g = null
      setDragging(false)
      if (was.mode === 'off') return
      const fix = anchorRow(el.querySelector(`[data-l="${was.at.line}"]`))
      settle.current = fix
      requestAnimationFrame(() => settle.current === fix && (settle.current = null))
      live.current.reset()
      setSpot(null)
      if (was.mode !== 'pending') return
      // Tap : le mot sous le doigt, ou rien (tap à côté = tout ferme).
      const w = was.at.word
      const cur = selRef.current
      if (w && !(cur && !cur.lines && cur.start.line === was.at.line && cur.end.line === was.at.line && cur.start.col === w[0] && cur.end.col === w[1])) {
        setSel({ start: { line: was.at.line, col: w[0] }, end: { line: was.at.line, col: w[1] } })
      } else setSel(null)
    }
    const cancel = (e: PointerEvent) => {
      if (g && e.pointerId === g.id) {
        g = null
        setDragging(false)
      }
    }
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', cancel)
    return () => {
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', cancel)
    }
  }, [lines, editing])

  // ---- Arrivée depuis « où c'est utilisé » : la ligne visée, au centre, un éclair de couleur. À l'ouverture la page
  // arrive déjà sur la ligne (sans défilement) ; dans le même fichier, un glissé doux montre dans quel sens on va.
  const goLine = useCallback((n: number, smooth = false) => {
    const row = box.current?.querySelector<HTMLElement>(`[data-l="${n}"]`)
    if (!row) return
    if (smooth) reveal(row, { block: 'center', flash: false })
    else row.scrollIntoView({ block: 'center' })
    setFlash(null)
    requestAnimationFrame(() => setFlash(n))
  }, [])
  useLayoutEffect(() => {
    if (line && lines.length) goLine(Math.min(line, lines.length) - 1)
  }, [line, lines.length, goLine])

  const anchor = dragging ? frozen.current : sel ? sel.end.line : spot
  const panel =
    anchor != null ? (
      <AskPanel
        a={a}
        text={sel ? selText(lines, sel) : null}
        held={dragging}
        onHit={(h) => (h.path === path ? goLine(h.line - 1, true) : push({ kind: 'file', projectId, repo, path: h.path, line: h.line }))}
        hitLabel={(h) => `${h.path === path ? '' : h.path}:${h.line}`}
      />
    ) : null

  return (
    <Shell
      slot={colors[projectId] ?? 'agent'}
      kicker={kicker ?? (path.split('/').at(-2) || repo)}
      title={path.split('/').pop()}
      meta={file ? (file.truncated ? t.truncated : undefined) : t.reading}
      dock={file && !file.binary && !editing ? <AskVoice a={a} /> : undefined}
    >
      {err && (
        <Notice eventId={noticeKey('error:codeview', location.pathname, location.hash, err)} className="band invert" role="alert">
          <div className="in meta" style={{ paddingBlock: 12 }}>
            ! {err}
          </div>
        </Notice>
      )}
      {file?.editable && file.revision && onSaved && <MarkdownEditor key={`${machine}:${repo}:${path}`} file={file} machine={machine} repo={repo} path={path} onSaved={onSaved} onEditing={setEditing} />}
      {file?.binary && <div className="in meta empty">{t.binary}</div>}
      {file && !file.binary && !editing && (
        <div ref={box} className={`in code lines ${prose ? '' : 'mono'}`} style={{ ['--gw' as string]: `${String(lines.length).length}ch` }}>
          {lines.map((text, i) => {
            const r = lineRange(sel, i, text.length)
            return (
              <Fragment key={i}>
                <CodeLine n={i} text={text} s={r ? r[0] : 0} e={r ? r[1] : 0} whole={!!sel?.lines && !!r} flash={flash === i} />
                {i === anchor && panel}
              </Fragment>
            )
          })}
        </div>
      )}
    </Shell>
  )
}

