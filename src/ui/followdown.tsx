// « Du nouveau en bas » : l'utilisateur relit plus haut dans un fil et quelque chose arrive en dessous (réponse, question,
// coupure). Un bouton flotte au-dessus de la saisie ; un tap redescend en douceur et met en avant ce qui est arrivé.
import { AnimatePresence, motion } from 'motion/react'
import type { RefObject } from 'react'
import { useT } from '../i18n'
import M from '../i18n/pages'
import { flash } from './follow'
import { Icon } from './icons'

/** Ce qu'on met en avant en arrivant en bas : la question qui attend, sinon le dernier message du fil. */
export function lastBand(body: HTMLElement | null): Element | null {
  if (!body) return null
  return body.querySelector('.msg.ask') ?? Array.from(body.querySelectorAll('.msg:not(.working)')).at(-1) ?? null
}

/**
 * `show` : du nouveau est arrivé sous l'écran (useFollow().behind). `urgent` : la session attend l'utilisateur (« ! »).
 * `toEnd` : useFollow().toEnd.
 */
export function FollowDown({ show, urgent, body, toEnd }: { show: boolean; urgent?: boolean; body: RefObject<HTMLElement | null>; toEnd: () => void }) {
  const t = useT(M)
  const go = () => {
    toEnd()
    // Une fois le glissé posé : « c'est ici ».
    window.setTimeout(() => flash(lastBand(body.current)), 520)
  }
  return (
    <AnimatePresence>
      {show && (
        <motion.button
          key="down"
          type="button"
          className={urgent ? 'follow-down urgent' : 'follow-down'}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 10 }}
          onClick={go}
          aria-label={urgent ? t.waitsBelow : t.newBelow}
        >
          {urgent ? <span aria-hidden>!</span> : <Icon name="arrow" dir="down" />}
        </motion.button>
      )}
    </AnimatePresence>
  )
}
