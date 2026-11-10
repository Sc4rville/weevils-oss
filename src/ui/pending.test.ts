import { describe, expect, it } from 'vitest'
import type { Message } from '../../shared/api.ts'
import { mergePending, type Pending } from './pending'

const msg = (id: string, text: string, role: Message['role'] = 'user'): Message => ({ id, role, text, at: 0 })
const pend = (typed: string, after?: string, shown = typed): Pending => ({ id: `pending-${typed}-${after}`, role: 'user', text: shown, at: 0, typed, after })
const texts = (list: Message[]) => list.map((m) => m.text)

describe('mergePending', () => {
  const before = [msg('a', 'earlier'), msg('b', 'sure', 'assistant')]

  it('pas encore arrivé : la bulle reste sous le fil', () => {
    expect(texts(mergePending(before, [pend('hello', 'b')]))).toEqual(['earlier', 'sure', 'hello'])
  })

  it('arrivé : la bulle disparaît', () => {
    expect(texts(mergePending([...before, msg('c', 'hello')], [pend('hello', 'b')]))).toEqual(['earlier', 'sure', 'hello'])
  })

  it('retours à la ligne aplatis par la pane : reconnu quand même', () => {
    expect(texts(mergePending([...before, msg('c', 'line one line two')], [pend('line one\n  line two ', 'b')]))).toEqual(['earlier', 'sure', 'line one line two'])
  })

  it('envoi avec photo : l’agent reçoit le chemin, la bulle « (photo) » disparaît quand même', () => {
    const real = [...before, msg('c', 'hey (photo: /home/u/.local/share/weevils/inbox/2026-11-09-a.jpg)')]
    expect(texts(mergePending(real, [pend('hey', 'b', 'hey (photo)')]))).toEqual(texts(real))
  })

  it('photo seule (rien de tapé) : effacée par le premier message arrivé après', () => {
    const real = [...before, msg('c', 'Look at this photo. (photo: /x/inbox/2026-11-09-a.jpg)')]
    expect(texts(mergePending(real, [pend('', 'b', '(photo)')]))).toEqual(texts(real))
  })

  it('un message identique plus ancien n’efface pas la nouvelle bulle (« ok » renvoyé)', () => {
    const real = [msg('a', 'ok'), msg('b', 'done', 'assistant')]
    expect(texts(mergePending(real, [pend('ok', 'b')]))).toEqual(['ok', 'done', 'ok'])
  })

  it('deux envois identiques : chaque message arrivé n’efface qu’une bulle', () => {
    const p = [pend('ok', 'b'), { ...pend('ok', 'b'), id: 'pending-2' }]
    expect(texts(mergePending([...before, msg('c', 'ok')], p))).toEqual(['earlier', 'sure', 'ok', 'ok'])
    expect(texts(mergePending([...before, msg('c', 'ok'), msg('d', 'ok')], p))).toEqual(['earlier', 'sure', 'ok', 'ok'])
  })

  it('une réponse de l’agent qui reprend le texte ne compte pas', () => {
    expect(texts(mergePending([...before, msg('c', 'hello to you too', 'assistant')], [pend('hello', 'b')]))).toEqual(['earlier', 'sure', 'hello to you too', 'hello'])
  })

  it('fil pas encore chargé à l’envoi, ou dernier message connu sorti du fil : tout le fil compte', () => {
    expect(texts(mergePending([msg('c', 'hello')], [pend('hello')]))).toEqual(['hello'])
    expect(texts(mergePending([msg('c', 'hello')], [pend('hello', 'trimmed')]))).toEqual(['hello'])
  })

  it('sans repère dans le fil : un message identique bien plus ancien n’efface pas la bulle (reprise, photo seule)', () => {
    const at = 1_000_000_000
    const old = { ...msg('a', 'ok'), at: at - 10 * 60_000 }
    expect(texts(mergePending([old], [{ ...pend('ok', 'gone'), at }]))).toEqual(['ok', 'ok'])
    expect(texts(mergePending([old], [{ ...pend('', undefined, '(photo)'), at }]))).toEqual(['ok', '(photo)'])
    expect(texts(mergePending([old, { ...msg('b', 'ok'), at: at + 2000 }], [{ ...pend('ok', 'gone'), at }]))).toEqual(['ok', 'ok'])
  })
})

it('reconciles an acknowledged prompt wrapped in injected metadata without a duplicate bubble', () => {
  const real = [msg('new', '⟦weevils — what weevils remembers: context⟧\nhello')]
  expect(mergePending(real, [pend('hello')])).toEqual(real)
})

it('acknowledges a new user message even when a streaming assistant anchor moves after it', () => {
  const prior = msg('old-user', 'same question')
  const answer = msg('streaming', 'answer', 'assistant')
  const pending = { ...pend('same question', 'streaming'), known: ['old-user'], at: 100000 }
  expect(mergePending([prior, answer], [pending])).toHaveLength(3)
  const arrived = { ...msg('new-user', 'same question'), at: 100100 }
  expect(mergePending([prior, arrived, answer], [pending])).toEqual([prior, arrived, answer])
})

it('reconciles multiple queued prompts combined in one transcript message, including repeated inputs', () => {
  const real = [msg('combined', 'first\n⟦weevils context⟧\nyes\nyes')]
  const pending = [pend('first'), pend('yes'), { ...pend('yes'), id: 'second-yes' }]
  expect(mergePending(real, pending)).toEqual(real)
  expect(mergePending([msg('combined', 'first\nyes')], pending)).toHaveLength(2)
})
