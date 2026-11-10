// Bulles « envoi en cours » d'une session : affichées sous le fil jusqu'à ce que le transcript montre le message.
import type { Message } from '../../shared/api.ts'

export interface Pending extends Message {
  /** Le texte tapé, sans les pièces jointes : l'agent reçoit « texte (photo : /chemin) », la bulle montre « texte (photo) ». */
  typed: string
  /** Dernier message réel connu à l'envoi : seuls ceux d'après peuvent être ce message (pas d'horloge à comparer). */
  after?: string
  /** Premier message d'une session neuve (seedPending) : aucun message plus ancien ne peut s'y tromper, donc pas
   * d'horloge comparée, et le serveur peut l'avoir précédé d'un contexte (conversation reprise) : il suffit qu'il y figure. */
  seed?: boolean
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

/** Sans repère dans le fil (pas encore chargé à l'envoi, session remplacée, premier message d'une session neuve) : seuls
 * les messages datés d'au plus 30 s avant l'envoi peuvent être celui-ci (marge pour l'horloge du téléphone). */
const SLACK_MS = 30_000

/**
 * Le fil, puis les bulles pas encore arrivées. Une bulle disparaît quand un message de l'utilisateur arrivé après
 * l'envoi commence par le texte tapé (retours à la ligne aplatis comme dans la pane) ; chaque message réel n'en
 * efface qu'une, et un message identique plus ancien (« ok » renvoyé) n'efface pas la nouvelle, même quand le dernier
 * message connu à l'envoi n'est plus dans le fil.
 */
export function mergePending(real: Message[], pending: Pending[]): Message[] {
  const used = new Set<number>()
  const left = pending.filter((p) => {
    const typed = norm(p.typed)
    const from = p.after ? real.findIndex((m) => m.id === p.after) + 1 : 0
    for (let i = from; i < real.length; i++) {
      const m = real[i]
      if (used.has(i) || (m.role !== 'user' && m.role !== 'orchestrator')) continue
      if (p.seed) {
        if (m.role !== 'user' || !norm(m.text).includes(typed)) continue
      } else {
        if (from === 0 && m.at < p.at - SLACK_MS) continue // un « ok » plus ancien n'efface pas la bulle
        if (!norm(m.text).startsWith(typed)) continue
      }
      used.add(i)
      return false
    }
    return true
  })
  return [...real, ...left]
}

/** Le premier message d'une session qu'on vient de lancer (nouvelle session, conversation reprise) : sa bulle est sous les
 * yeux dès l'ouverture de la session, sans attendre que le transcript soit écrit. */
const seeds = new Map<string, Pending>()
export function seedPending(id: string, text: string) {
  const at = Date.now()
  seeds.set(id, { id: `pending-${at}`, role: 'user', text, at, typed: text, seed: true })
}
/** Lu à l'ouverture (sans le retirer : un rendu peut être rejoué) ; dropSeed une fois la page montée. */
export const peekSeed = (id: string): Pending[] => {
  const p = seeds.get(id)
  return p ? [p] : []
}
export const dropSeed = (id: string) => void seeds.delete(id)
