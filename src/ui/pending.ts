// Bulles « envoi en cours » d'une session : affichées sous le fil jusqu'à ce que le transcript montre le message.
import type { Message } from '../../shared/api.ts'

export interface Pending extends Message {
  /** Le texte tapé, sans les pièces jointes : l'agent reçoit « texte (photo : /chemin) », la bulle montre « texte (photo) ». */
  typed: string
  /** Dernier message réel connu à l'envoi : seuls ceux d'après peuvent être ce message (pas d'horloge à comparer). */
  after?: string
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

/**
 * Le fil, puis les bulles pas encore arrivées. Une bulle disparaît quand un message de l'utilisateur arrivé après
 * l'envoi commence par le texte tapé (retours à la ligne aplatis comme dans la pane) ; chaque message réel n'en
 * efface qu'une, et un message identique plus ancien (« ok » renvoyé) n'efface pas la nouvelle.
 */
export function mergePending(real: Message[], pending: Pending[]): Message[] {
  const used = new Set<number>()
  const left = pending.filter((p) => {
    const typed = norm(p.typed)
    for (let i = p.after ? real.findIndex((m) => m.id === p.after) + 1 : 0; i < real.length; i++) {
      const m = real[i]
      if (used.has(i) || (m.role !== 'user' && m.role !== 'orchestrator')) continue
      if (!norm(m.text).startsWith(typed)) continue
      used.add(i)
      return false
    }
    return true
  })
  return [...real, ...left]
}
