// Bulles « envoi en cours » d'une session : affichées sous le fil jusqu'à ce que le transcript montre le message.
import type { Message } from '../../shared/api.ts'
import { userText } from './format'

export interface Pending extends Message {
  /** Le texte tapé, sans les pièces jointes : l'agent reçoit « texte (photo : /chemin) », la bulle montre « texte (photo) ». */
  typed: string
  /** Dernier message réel connu à l'envoi : seuls ceux d'après peuvent être ce message (pas d'horloge à comparer). */
  after?: string
  /** User messages present before sending; stream updates may move the anchor after the new message. */
  known?: string[]
  /** Premier message d'une session neuve (seedPending) : aucun message plus ancien ne peut s'y tromper, donc pas
   * d'horloge comparée, et le serveur peut l'avoir précédé d'un contexte (conversation reprise) : il suffit qu'il y figure. */
  seed?: boolean
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

/** Sans repère dans le fil (pas encore chargé à l'envoi, session remplacée, premier message d'une session neuve) : seuls
 * les messages datés d'au plus 30 s avant l'envoi peuvent être celui-ci (marge pour l'horloge du téléphone). */
const SLACK_MS = 30_000

/** Merge provisional inputs with their transcript occurrences, including multiple queued inputs
 * combined by Codex. Already-known user messages cannot acknowledge a new send, even if an
 * assistant's timestamp moves the old anchor past that send while streaming. */
export function mergePending(real: Message[], pending: Pending[]): Message[] {
  const used = new Map<number, { start: number; end: number }[]>()
  const left = pending.filter((p) => {
    const typed = norm(p.typed)
    const from = p.after ? real.findIndex((m) => m.id === p.after) + 1 : 0
    for (let i = 0; i < real.length; i++) {
      const m = real[i]
      if ((m.role !== 'user' && m.role !== 'orchestrator') || (p.seed && m.role !== 'user') || (!p.known && i < from)) continue
      const body = norm(userText(m.text))
      if (p.known ? p.known.includes(m.id) : !p.seed && from === 0 && m.at < p.at - SLACK_MS) continue
      // Codex can combine several queued inputs into one transcript message.
      // Match complete input starts, consuming each occurrence once, rather than the whole message.
      const starts = [0]
      let offset = 0
      for (const line of userText(m.text).split(/\r?\n/).map(norm).filter(Boolean)) {
        if (offset) starts.push(offset)
        offset += line.length + 1
      }
      if (p.seed) starts.push(body.indexOf(typed))
      const ranges = used.get(i) ?? []
      const start = starts.find((at) => at >= 0 && body.startsWith(typed, at) && !ranges.some((r) => at < r.end && at + Math.max(1, typed.length) > r.start))
      if (start === undefined) continue
      used.set(i, [...ranges, { start, end: start + Math.max(1, typed.length) }])
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
