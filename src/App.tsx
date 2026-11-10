import { trackViewport } from './ui/viewport'
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import { Component, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { api, useLive } from './api'
import { Ctx, THEME_COLOR, colorSlots, isTheme, isSettled, setSettledNow, stableOrder, type AppCtx, type Page, type Theme } from './ui/app-context'
import { AgentBand, FootBand, ProjectBand } from './ui/bands'
import { spring } from './ui/bits'
import { H24Rail } from './ui/h24'
import { TalkProvider } from './ui/auto-talk'
import { Login } from './ui/login'
import { TourBand, TourIntro } from './ui/tour'
import { RelayBand } from './ui/relay'
import { Tips } from './ui/tips'
import { WeevilQuestions } from './ui/weevil'
import { HintBubble, loadHints } from './ui/hints'
import { GestureCoach } from './ui/coach'
import { PageView } from './ui/pages'
import { usePinch } from './ui/calm'
import { adoptUnknown } from './ui/seen'
import { useDevil } from './ui/devil'
import { FOCUS_BOSS, flash, flashBossMessage, focusBoss, keepInPlace, reveal, takeBossOnReturn, toTop, when, type FocusBoss } from './ui/follow'
import { ensurePush } from './push'
import { useT } from './i18n'
import M from './i18n/app'

const THEME_KEY = 'weevils-theme'

/** D'où une page a été ouverte : l'élément touché, sa bande, sa place à l'écran (pour l'y retrouver au retour). */
interface Opener {
  el: HTMLElement | null
  key?: string
  top: number
}

/**
 * Juste avant que l'ordre des bandes change dans le DOM (getSnapshotBeforeUpdate : avant toute mutation), la bande sous
 * les yeux est retenue à sa place pendant que les autres glissent autour (keepInPlace) ; corrigé une première fois avant
 * l'affichage (componentDidUpdate).
 */
class KeepOrder extends Component<{ order: string; active: boolean }> {
  pin: (() => void) | null = null
  until = 0
  getSnapshotBeforeUpdate(prev: { order: string }) {
    if (prev.order && prev.order !== this.props.order && this.props.active && window.scrollY > 0 && Date.now() > this.until) {
      const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 3)?.closest('[data-project]')
      if (el) {
        this.pin = keepInPlace(el)
        this.until = Date.now() + 650
      }
    }
    return null
  }
  componentDidUpdate() {
    this.pin?.()
    this.pin = null
  }
  render() {
    return null
  }
}

const smooth = (): ScrollBehavior => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth')

function initialTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY)
    if (isTheme(t)) return t
  } catch {
    /* stockage indisponible */
  }
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export default function App() {
  const live = useLive()
  const t = useT(M)
  const devil = useDevil(!!live.snap?.devil?.enabled)
  const [theme, setThemeState] = useState<Theme>(initialTheme)
  const [now, setNow] = useState(() => Date.now())
  const [expanded, setExpanded] = useState<string | null>(null)
  const [h24Open, setH24Open] = useState(false)
  const [h24Focus, setH24Focus] = useState<string | null>(null)
  const [stack, setStack] = useState<Page[]>([])
  const stackRef = useRef<Page[]>([])
  const openers = useRef<(Opener | undefined)[]>([])
  /** Le dernier élément touché : sur iPhone, un bouton touché ne prend pas le focus (activeElement reste <body>). */
  const lastTap = useRef<{ el: HTMLElement | null; at: number }>({ el: null, at: 0 })
  /** À faire une fois toutes les pages refermées (focusBoss depuis une page). */
  const afterPop = useRef<(() => void) | null>(null)

  // Horloge commune à toutes les durées affichées.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    if (live.snap) setNow(Date.now())
    if (live.snap) adoptUnknown(live.snap.sessions)
  }, [live.snap])
  // Autorisation déjà donnée : l'appareil se ré-abonne à chaque lancement (clé changée, serveur réinstallé…).
  useEffect(() => {
    if (live.authed) void ensurePush().catch(() => undefined)
    if (live.authed) void loadHints()
  }, [live.authed])

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t)
    try {
      localStorage.setItem(THEME_KEY, t)
    } catch {
      /* ignoré */
    }
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme])
  }, [theme])

  // Hauteur visible réelle et zone sûre de la barre d'état, même clavier iPhone ouvert.
  useEffect(trackViewport, [])

  useEffect(() => {
    // Le doigt (touch*) et le pointeur suivis à part : pointercancel arrive dès qu'un glissé devient un défilement, le doigt
    // encore posé ; seul touchend dit qu'il est levé.
    const held = { pointer: false, touch: false }
    const touching = () => held.pointer || held.touch
    let still = true
    let timer = 0
    const set = (v: boolean) => {
      if (still === v) return
      still = v
      setSettledNow(v)
    }
    const later = () => {
      clearTimeout(timer)
      timer = window.setTimeout(() => !touching() && set(true), 1200)
    }
    const down = (e: Event) => {
      held[e.type === 'touchstart' ? 'touch' : 'pointer'] = true
      clearTimeout(timer)
      set(false)
      if (e.type === 'pointerdown') lastTap.current = { el: (e.target as Element | null)?.closest?.<HTMLElement>('button, [role="button"], a') ?? null, at: Date.now() }
    }
    const up = (e: Event) => {
      if (e.type.startsWith('touch')) held.touch = ((e as TouchEvent).touches?.length ?? 0) > 0
      else held.pointer = false
      if (!touching()) later()
    }
    const moving = () => {
      set(false)
      if (!touching()) later()
    }
    const opts = { capture: true, passive: true }
    const downs = ['pointerdown', 'touchstart'] as const
    const ups = ['pointerup', 'pointercancel', 'touchend', 'touchcancel'] as const
    for (const n of downs) window.addEventListener(n, down, opts)
    for (const n of ups) window.addEventListener(n, up, opts)
    // Le défilement du flux seul (pas celui des fils qui suivent leur réponse) ; la molette, d'où qu'elle vienne.
    window.addEventListener('scroll', moving, { passive: true })
    window.addEventListener('wheel', moving, opts)
    return () => {
      clearTimeout(timer)
      for (const n of downs) window.removeEventListener(n, down, opts)
      for (const n of ups) window.removeEventListener(n, up, opts)
      window.removeEventListener('scroll', moving)
      window.removeEventListener('wheel', moving, opts)
    }
  }, [])

  // ---- Navigation par pages, branchée sur l'historique (bouton retour du navigateur).
  const setPages = useCallback((next: Page[]) => {
    stackRef.current = next
    setStack(next)
    document.body.style.overflow = next.length ? 'hidden' : ''
  }, [])

  const push = useCallback(
    (p: Page) => {
      const a = document.activeElement
      const tap = Date.now() - lastTap.current.at < 1500 ? lastTap.current.el : null
      const el = tap ?? (a && a !== document.body ? (a as HTMLElement) : null)
      openers.current[stackRef.current.length] = { el, key: el?.closest<HTMLElement>('[data-project]')?.dataset.project, top: el?.getBoundingClientRect().top ?? 0 }
      const next = [...stackRef.current, p]
      setPages(next)
      history.pushState({ w: next.length }, '')
    },
    [setPages],
  )

  const replace = useCallback(
    (p: Page) => {
      const next = [...stackRef.current.slice(0, -1), p]
      setPages(next)
      history.replaceState({ w: next.length }, '')
    },
    [setPages],
  )

  const back = useCallback(() => {
    if (stackRef.current.length) history.back()
  }, [])
  const home = useCallback(() => {
    if (stackRef.current.length) history.go(-stackRef.current.length)
  }, [])

  useEffect(() => {
    history.replaceState({ w: 0 }, '')
    // Le navigateur ne remet pas le flux là où il croit : le retour (ci-dessous) et focusBoss s'en chargent.
    history.scrollRestoration = 'manual'
    const onPop = (e: PopStateEvent) => {
      const w = (e.state as { w?: number } | null)?.w ?? 0
      if (w >= stackRef.current.length) return
      const o = openers.current[w]
      // Rendu tout de suite : le flux est à jour avant que la page sortante le découvre.
      flushSync(() => setPages(stackRef.current.slice(0, w)))
      const then = w === 0 ? afterPop.current : null
      afterPop.current = null
      // Une réponse de weevboss arrivée pendant que la page le cachait : elle passe avant l'élément d'où l'on venait.
      const boss = w === 0 ? takeBossOnReturn() : null
      // Le flux est à nouveau celui qu'on voit : les bords libres (le rail) comptent dès maintenant, pas à la fin de la sortie.
      if (w === 0) delete document.documentElement.dataset.page
      if (then)
        return void requestAnimationFrame(() => {
          then()
          if (boss && boss.flash !== false) flashBossMessage(boss.mid)
        })
      if (boss) return void requestAnimationFrame(() => focusBoss(boss))
      if (!o) return
      // Retour au flux : la ligne d'où l'on venait a pu bouger (sa bande remontée, les lignes réordonnées). Elle est remise
      // à la même place à l'écran pendant que la page la recouvre encore (rien de visible), puis amenée sous les yeux et
      // mise en avant si elle a bougé. Disparue : sa bande la remplace.
      const band = o.key ? document.querySelector<HTMLElement>(`[data-project="${CSS.escape(o.key)}"] .head`) : null
      const el = o.el?.isConnected ? o.el : band
      if (!el) return
      // Dans un fil qui suit sa fin (celui de weevboss, le corps d'une page) : il a défilé de lui-même pendant l'absence ;
      // le ramener en arrière jusqu'à l'ancien bouton se battrait avec son suivi (useFollow) et la fenêtre n'y est pour
      // rien. Le focus seul, comme avant.
      if (el.closest('.chat, [data-scroll]')) return void setTimeout(() => el.focus?.({ preventScroll: true }), 60)
      let moved = el !== o.el
      if (w === 0 && !moved) {
        const d = el.getBoundingClientRect().top - o.top
        if (Math.abs(d) > 8) {
          window.scrollBy(0, d)
          moved = true
        }
      }
      if (el === o.el) setTimeout(() => el.focus?.({ preventScroll: true }), 60)
      setTimeout(() => reveal(el, { block: 'nearest', flash: moved }), 300)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [setPages])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (stackRef.current.length) back()
      else if (h24Open) setH24Open(false)
      else {
        // La bande ouverte se referme sans glisser sous les yeux (celles du dessus se redéplient).
        if (expanded && expanded !== 'agent') keepInPlace(document.querySelector(`[data-project="${CSS.escape(expanded)}"]`))
        setExpanded(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [back, h24Open, expanded])

  // Ouvrir le fil de weevboss (l'aperçu touché, une démo) avec le flux un peu défilé : il remonte d'abord en douceur,
  // puis le fil s'ouvre en haut de l'écran (le chemin de focusBoss, sans mise en avant).
  const expand = useCallback((id: string | null) => {
    if (id === 'agent' && window.scrollY > 4 && !stackRef.current.length) focusBoss({ flash: false })
    else setExpanded(id)
  }, [])
  const openH24 = useCallback((open: boolean, focus?: string) => {
    setH24Focus(open ? (focus ?? null) : null)
    setH24Open(open)
  }, [])

  // Un parcours (branchement) ou une action qui répond dans le fil de weevboss, lancé d'où que ce soit (une page, le bas
  // du flux) : les pages se referment, le flux remonte en douceur jusqu'en haut, puis le fil s'ouvre (ouvrir d'abord
  // replierait les bandes et ferait sauter l'écran) et sa réponse est mise en avant (src/ui/follow.ts).
  useEffect(() => {
    const on = (e: Event) => {
      const o = (e as CustomEvent<FocusBoss>).detail ?? {}
      const open = () => {
        const go = () => {
          setExpanded('agent')
          if (o.flash !== false) flashBossMessage(o.mid)
        }
        if (window.scrollY < 4) return go()
        toTop()
        when(() => window.scrollY < 4, go, 900)
      }
      if (stackRef.current.length) {
        // Déjà en route vers l'accueil (deux appels coup sur coup) : on remplace seulement ce qui suivra.
        const going = !!afterPop.current
        afterPop.current = open
        if (!going) history.go(-stackRef.current.length)
      } else open()
    }
    window.addEventListener(FOCUS_BOSS, on)
    return () => window.removeEventListener(FOCUS_BOSS, on)
  }, [])

  // Notification touchée : « /#s=<id> » au lancement, ou message du service worker si l'app est déjà ouverte.
  const ready = !!live.snap
  useEffect(() => {
    if (!ready) return
    const open = (url: string) => {
      // « /#relay » : la vue des plans de reprise Codex (notification du relais).
      if (/#relay\b/.test(url)) {
        history.replaceState(history.state, '', location.pathname)
        if (stackRef.current.at(-1)?.kind !== 'relay') push({ kind: 'relay' })
        return
      }
      const m = /#s=([^&]+)/.exec(url)
      if (!m) return
      history.replaceState(history.state, '', location.pathname)
      const id = decodeURIComponent(m[1])
      const top = stackRef.current.at(-1)
      if (top?.kind !== 'session' || top.id !== id) return push({ kind: 'session', id })
      // Déjà ouverte : pas de seconde copie par-dessus ; le fil redescend en douceur et son dernier message est mis en avant.
      const pages = document.querySelectorAll<HTMLElement>('.page')
      const page = pages[pages.length - 1]
      const body = page?.querySelector<HTMLElement>('.page-body[data-scroll]')
      body?.scrollTo({ top: body.scrollHeight, behavior: smooth() })
      setTimeout(() => flash(Array.from(page?.querySelectorAll('[data-mid]') ?? []).at(-1)), 400)
    }
    open(location.hash)
    const onMsg = (e: MessageEvent) => e.data?.type === 'open' && open(String(e.data.url))
    navigator.serviceWorker?.addEventListener('message', onMsg)
    return () => navigator.serviceWorker?.removeEventListener('message', onMsg)
  }, [ready, push])

  const logout = useCallback(() => {
    void api.logout().finally(() => live.setAuthed(false))
  }, [live])

  // Couleurs stables (ordre alphabétique des projets), quel que soit l'ordre d'affichage.
  const projectIds = live.snap?.projects.map((p) => p.id).sort().join('|') ?? ''
  const colors = useMemo(() => colorSlots(projectIds ? projectIds.split('|') : []), [projectIds])
  // Ordre vivant : ce qui t'attend, puis ce qui travaille, puis ce qui est ouvert, puis le reste. Dans un même rang, l'ordre
  // affiché tient (l'activité seule ne fait pas permuter deux bandes) ; seul un nouveau projet se place par activité. Rien
  // ne bouge sous le doigt ni pendant un défilement : l'ordre en attente s'applique ensuite (src/ui/app-context.tsx).
  const shownOrder = useRef<string[]>([])
  const ordered = useMemo(() => {
    const snap = live.snap
    if (!snap) return []
    const rank = (id: string) => {
      const ss = snap.sessions.filter((s) => !s.archived && s.projectId === id)
      if (ss.some((s) => s.status === 'needs_user' || s.status === 'interrupted')) return 0
      if (ss.some((s) => s.status === 'working')) return 1
      if (ss.some((s) => s.status === 'idle')) return 2
      return 3
    }
    return stableOrder(snap.projects, (p) => p.id, (p) => rank(p.id), (a, b) => b.lastActivityAt - a.lastActivityAt, shownOrder.current, !isSettled())
  }, [live.snap])
  const orderKey = ordered.map((p) => p.id).join('|')
  useLayoutEffect(() => {
    shownOrder.current = orderKey ? orderKey.split('|') : []
  }, [orderKey])

  const pinchMain = usePinch(() => push({ kind: 'calm' }))

  // (Avant tout return : les hooks.) Ouvrir ou fermer la bande weevboss : tout bascule d'un coup, sans ressort ni état intermédiaire.
  const prevExpanded = useRef(expanded)
  const instant = prevExpanded.current !== expanded && (prevExpanded.current === 'agent' || expanded === 'agent')
  useEffect(() => {
    prevExpanded.current = expanded
  }, [expanded])

  if (live.authed === false) return <Login onDone={() => live.setAuthed(true)} />
  if (!live.snap) {
    return (
      <main className="stack">
        <section className="band agent" style={{ ['--c' as string]: 'var(--agent)', flex: 1 }}>
          <div className="in head">
            <span className="name">weevils</span>
          </div>
          <div className="in meta summary">{live.offline ? t.offline : t.connecting}</div>
        </section>
      </main>
    )
  }

  const ctx: AppCtx = {
    snap: live.snap,
    now,
    offline: live.offline,
    colors,
    push,
    replace,
    back,
    home,
    expanded,
    instant,
    setExpanded: expand,
    h24Open,
    setH24Open: openH24,
    h24Focus,
    theme,
    setTheme,
    refresh: live.refresh,
    logout,
  }

  return (
    <Ctx.Provider value={ctx}>
      <MotionConfig reducedMotion="user" transition={spring}>
        <div className="status-cover" aria-hidden style={devil ? ({ ['--status-c' as string]: 'var(--devil)' }) : undefined} />
        <motion.main
          {...pinchMain}
          className="stack"
          aria-hidden={stack.length > 0 || undefined}
          inert={stack.length > 0}
          drag="x"
          dragDirectionLock
          dragConstraints={{ left: 0, right: 0 }}
          dragElastic={{ left: 0.18, right: 0 }}
          dragSnapToOrigin
          onDragEnd={(_, info) => {
            if (info.offset.x < -90 || info.velocity.x < -600) push({ kind: 'repos' })
          }}
        >
          <KeepOrder order={orderKey} active={stack.length === 0} />
          <AgentBand />
          <TourBand />
          <RelayBand />
          {ordered.map((p) => (
            <ProjectBand key={p.id} project={p} />
          ))}
          <FootBand />
        </motion.main>
        {/* One negotiation state for the drawer and the automation pages: a question in flight, a rewritten task, a ✓
            given on one shows on the other. */}
        <TalkProvider>
          <div inert={stack.length > 0}>
            <H24Rail />
          </div>
          <AnimatePresence>
            {stack.map((p, i) => (
              <PageView key={`${i}:${p.kind}:${p.kind === 'files' ? `${p.repo}/${p.dir}` : p.kind === 'software' || p.kind === 'auto' ? p.id : p.kind === 'autorun' ? `${p.id}@${p.at}` : p.kind === 'media' ? p.url : ''}`} page={p} />
            ))}
          </AnimatePresence>
        </TalkProvider>
        <Tips paused={stack.length > 0} />
        <WeevilQuestions paused={stack.length > 0} />
        <TourIntro />
        <HintBubble />
        <GestureCoach />
      </MotionConfig>
    </Ctx.Provider>
  )
}
