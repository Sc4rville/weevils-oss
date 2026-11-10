// Copier dans le presse-papiers, et l'appui long qui copie un message entier.
import { useRef } from 'react'

/** Les champs utiles d'un pointeur, communs à l'événement natif et à celui de React. */
type Ptr = { clientX: number; clientY: number; isPrimary: boolean; pointerType: string; button: number; target: EventTarget | null }

/** Presse-papiers moderne, sinon l'ancienne méthode (champ caché + execCommand) qu'iOS accepte encore pendant un geste. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px'
      document.body.appendChild(ta)
      ta.select()
      ta.setSelectionRange(0, text.length)
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}

/**
 * Appui long (~0,5 s, sans bouger) sur un message : `onLong` est appelé. Les liens et boutons gardent leur geste.
 * Une copie hors geste peut être refusée (iOS) : `onLong` renvoie false et on retente au relâchement, qui compte comme geste.
 */
export function useLongPress(onLong: () => Promise<boolean>, ms = 480) {
  const st = useRef<{ x: number; y: number; timer: number; pending: boolean; fired: boolean } | null>(null)
  const clear = () => {
    if (st.current) window.clearTimeout(st.current.timer)
  }
  return {
    onPointerDown: (e: Ptr) => {
      if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return
      if ((e.target as HTMLElement).closest('a, button, input, textarea')) return
      clear()
      const s = { x: e.clientX, y: e.clientY, timer: 0, pending: false, fired: false }
      s.timer = window.setTimeout(() => {
        s.fired = true
        void onLong().then((ok) => {
          if (!ok) s.pending = true
        })
      }, ms)
      st.current = s
    },
    onPointerMove: (e: Ptr) => {
      const s = st.current
      if (s && !s.fired && Math.hypot(e.clientX - s.x, e.clientY - s.y) > 10) {
        clear()
        st.current = null
      }
    },
    onPointerUp: () => {
      const s = st.current
      clear()
      st.current = null
      if (s?.pending) void onLong()
    },
    onPointerCancel: () => {
      // iOS annule le pointeur quand il prend la main (défilement, sélection) : avant l'appui long, on abandonne.
      const s = st.current
      if (s && !s.fired) {
        clear()
        st.current = null
      }
    },
  }
}
