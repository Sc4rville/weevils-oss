import { useEffect, useRef } from 'react'
import { api } from '../api'
import { intlLocale, useT } from '../i18n'
import M from '../i18n/infra'
import { useApp } from './app-context'
import './rate.css'

/** La valeur : les 2 dernières minutes, ramenées à la minute. */
const WINDOW = 120_000

/**
 * Le débit de tokens en direct, tout en haut à droite sous la barre d'état : juste le chiffre (tokens par minute,
 * toutes sessions et machines), qui défile en douceur vers la nouvelle mesure. Dessiné hors de React (rAF).
 */
export function TokenMeter() {
  const t = useT(M)
  const label = useRef(t.rateLabel)
  label.current = t.rateLabel
  const { push } = useApp()
  const root = useRef<HTMLButtonElement>(null)
  const num = useRef<HTMLSpanElement>(null)
  const target = useRef<number | null>(null)

  useEffect(() => {
    let stop = false
    let raf = 0
    let shown = 0
    let last = 0
    let text = ''
    const fmt = new Intl.NumberFormat(intlLocale(), { notation: 'compact', maximumSignificantDigits: 3 })
    const draw = (v: number) => {
      const s = v < 1 ? '0' : fmt.format(Math.round(v))
      if (s === text || !num.current) return
      num.current.textContent = text = s
      root.current?.classList.toggle('idle', s === '0')
      root.current?.setAttribute('aria-label', label.current(s))
    }
    // Le chiffre glisse vers la mesure (≈ 1,2 s), puis l'animation s'arrête jusqu'à la suivante.
    const frame = (now: number) => {
      raf = 0
      if (stop || target.current == null) return
      const dt = last ? Math.min(0.25, (now - last) / 1000) : 1
      last = now
      const goal = target.current
      shown += (goal - shown) * (1 - Math.exp(-dt * 2.5))
      if (Math.abs(goal - shown) < Math.max(1, goal * 0.003)) shown = goal
      draw(shown)
      if (shown !== goal) raf = requestAnimationFrame(frame)
      else last = 0
    }
    const load = () => {
      if (document.visibilityState !== 'visible') return
      void api
        .usageRate()
        .then((r) => {
          if (stop) return
          if (r.available === false) {
            target.current = null
            if (num.current) num.current.textContent = '—'
            root.current?.setAttribute('aria-label', label.current('—'))
            text = ''
            return
          }
          const per = Math.round(WINDOW / r.step)
          target.current = (r.buckets.slice(-per).reduce((a, b) => a + b, 0) * 60_000) / WINDOW
          if (!raf && !stop) raf = requestAnimationFrame(frame)
        })
        .catch(() => { target.current = null; text = ''; if (num.current) num.current.textContent = '—' })
    }
    load()
    const iv = setInterval(load, 5000)
    document.addEventListener('visibilitychange', load)
    return () => {
      stop = true
      if (raf) cancelAnimationFrame(raf)
      clearInterval(iv)
      document.removeEventListener('visibilitychange', load)
    }
  }, [])

  return (
    <button ref={root} className="token-meter idle" onClick={() => push({ kind: 'usage' })}>
      <span ref={num}>—</span>
    </button>
  )
}
