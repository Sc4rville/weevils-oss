import { noticeKey } from '../../shared/notices.ts'
import { Notice } from './notice'
// The memory page (bottom of the machines band): what weevils remembers about the user. Browse, add, select to
// understand, edit, delete. Nothing else: no help text, no dialog.
//
// - « + » at the top: type, Enter keeps it.
// - Tap a memory: it opens in place, big; its text is editable (Enter or leaving the field saves, Esc cancels), its
//   origin (the weevil question, or « by hand ») and its date sit underneath, « forget » takes two taps.
// - A write refused by the server (a secret, an empty text…): its short reason shows a moment as an inverted band
//   right under the field (« + » or the open memory), then goes; the text typed in « + » stays to be fixed.
// - Select a word or a passage of an open memory: the same question bar as everywhere else (ask.tsx), answered with the
//   memory as context (server/explain.ts, kind memory). The weevboss logo at the bottom listens with the same context.

import { motion } from 'motion/react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MemoryItem } from '../../shared/api.ts'
import { api } from '../api'
import { useApp } from './app-context'
import { AskPanel, AskVoice, useAsk, type Ask } from './ask'
import { Collapse, spring } from './bits'
import { Shell } from './shell'
import { getLang, useT } from '../i18n'
import M from '../i18n/memory'
import './memory.css'

/** How long a refused write's reason stays on screen. */
const NOTE_MS = 3200

/** A refused write's reason, a moment, under the field it concerns. */
function Note({ text }: { text: string | null }) {
  return (
    <Collapse open={!!text}>
      <Notice eventId={noticeKey('error:memory', location.pathname, location.hash, text)} className="band invert" role="alert">
        <div className="in meta mem-note">! {text}</div>
      </Notice>
    </Collapse>
  )
}

/** A textarea that grows with its text (and never scrolls inside). */
function useAutosize(ref: React.RefObject<HTMLTextAreaElement | null>, value: string) {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [ref, value])
}

const sameText = (a: string, b: string) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim()

/** Enter (without Shift, outside an IME composition). */
const isEnter = (e: React.KeyboardEvent) => e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing

function when(at: number) {
  const d = new Date(at)
  const thisYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString(getLang(), thisYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' })
}

/** « + » : a new memory, typed in place. */
function AddLine({ onAdd }: { onAdd: (text: string) => Promise<void> }) {
  const t = useT(M)
  const [v, setV] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  useAutosize(ref, v)
  const save = async () => {
    const x = v.replace(/\s+/g, ' ').trim()
    if (!x) return
    setV('')
    try {
      await onAdd(x)
    } catch {
      setV(x)
    }
  }
  return (
    <div className="band tone composer mem-add">
      <div className="in">
        <span className="prompt" aria-hidden>
          +
        </span>
        <textarea
          ref={ref}
          rows={1}
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (isEnter(e)) {
              e.preventDefault()
              void save()
            } else if (e.key === 'Escape') {
              // Esc empties the field, and only that: the page stays (App closes it on Esc otherwise).
              e.stopPropagation()
              setV('')
              e.currentTarget.blur()
            }
          }}
          placeholder={t.add}
          aria-label={t.addLabel}
          enterKeyHint="done"
        />
      </div>
    </div>
  )
}

/** An open memory: its text in a field that saves itself, the selection reported for the question bar. */
function Editor({ m, onSave, onSelect, onClose }: { m: MemoryItem; onSave: (text: string) => Promise<void>; onSelect: (text: string) => void; onClose: () => void }) {
  const t = useT(M)
  const [draft, setDraft] = useState(m.text)
  const ref = useRef<HTMLTextAreaElement>(null)
  const editing = useRef(false)
  const cancel = useRef(false)
  useAutosize(ref, draft)
  // The selection in the field (double tap, long press, drag, mouse): native events, as the browser reports them.
  const report = useRef(onSelect)
  report.current = onSelect
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => {
      if (document.activeElement === el) report.current(el.value.slice(el.selectionStart, el.selectionEnd).trim())
    }
    el.addEventListener('select', read)
    document.addEventListener('selectionchange', read)
    return () => {
      el.removeEventListener('select', read)
      document.removeEventListener('selectionchange', read)
    }
  }, [])
  // Changed elsewhere (weevboss, a weevil's answer) while not being edited here: follow it.
  useEffect(() => {
    if (!editing.current) setDraft(m.text)
  }, [m.text])
  const commit = async () => {
    if (cancel.current || !draft.trim() || sameText(draft, m.text)) {
      cancel.current = false
      return setDraft(m.text)
    }
    try {
      await onSave(draft.replace(/\s+/g, ' ').trim())
    } catch {
      setDraft(m.text)
    }
  }
  return (
    <div className="in mem-edit">
      <button className="st mem-close" onClick={onClose} aria-label={t.close} aria-expanded>
        −
      </button>
      <textarea
        ref={ref}
        rows={1}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => (editing.current = true)}
        onBlur={() => {
          editing.current = false
          void commit()
        }}
        onKeyDown={(e) => {
          if (isEnter(e)) {
            e.preventDefault()
            e.currentTarget.blur()
          } else if (e.key === 'Escape') {
            // Esc cancels the edit, and only that: the page stays.
            e.stopPropagation()
            cancel.current = true
            e.currentTarget.blur()
          }
        }}
        aria-label={t.edit}
        enterKeyHint="done"
        spellCheck
      />
    </div>
  )
}

/** « forget » : a first tap arms it, a second one (within 3 s) forgets. */
function Forget({ onForget }: { onForget: () => void }) {
  const t = useT(M)
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const tm = setTimeout(() => setArmed(false), 3000)
    return () => clearTimeout(tm)
  }, [armed])
  return (
    <button className={armed ? 'mem-del on' : 'mem-del'} onClick={() => (armed ? onForget() : setArmed(true))}>
      {armed ? t.sure : t.forget}
    </button>
  )
}

function Item({ m, open, sel, a, note, onOpen, onClose, onSave, onSelect, onForget }: {
  m: MemoryItem
  open: boolean
  note: string | null
  sel: string
  a: Ask
  onOpen: () => void
  onClose: () => void
  onSave: (text: string) => Promise<void>
  onSelect: (text: string) => void
  onForget: () => void
}) {
  const t = useT(M)
  return (
    <motion.div layout="position" transition={spring} className={open ? 'band tone mem-item open' : 'mem-item'}>
      {open ? (
        <Editor m={m} onSave={onSave} onSelect={onSelect} onClose={onClose} />
      ) : (
        <button className="row mem-row" onClick={onOpen} aria-expanded={false}>
          <span className="in">
            <span className="st" aria-hidden>
              ·
            </span>
            <span className="mem-text">{m.text}</span>
          </span>
        </button>
      )}
      <Note text={open ? note : null} />
      <Collapse open={open}>
        {(sel || a.asking || a.answer) && (
          <div className="in">
            <AskPanel a={a} text={sel || null} usage={false} onHit={() => undefined} />
          </div>
        )}
        <div className="in mem-foot">
          <span className="meta mem-from">
            {m.source === 'answer' && m.q ? t.quote(m.q) : t.byHand} · {when(m.at)}
          </span>
          <Forget onForget={onForget} />
        </div>
      </Collapse>
    </motion.div>
  )
}

export function MemoryPage() {
  const t = useT(M)
  const { snap, colors } = useApp()
  const [items, setItems] = useState<MemoryItem[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [sel, setSel] = useState('')
  // A refused write: where (« add » or a memory id) and why, for a moment.
  const [note, setNote] = useState<{ at: string; text: string } | null>(null)
  useEffect(() => {
    if (!note) return
    const tm = setTimeout(() => setNote(null), NOTE_MS)
    return () => clearTimeout(tm)
  }, [note])
  const last = useRef(0)

  const load = useCallback(
    () =>
      api
        .memory()
        .then((r) => {
          last.current = Date.now()
          setItems(r.items)
          setErr(null)
        })
        .catch((e) => setErr((e as Error).message)),
    [],
  )
  useEffect(() => void load(), [snap.memoryCount, load])
  // An edit elsewhere (weevboss, a weevil's answer) leaves the count as is: re-read now and then while the page is open.
  useEffect(() => {
    if (Date.now() - last.current > 8000) void load()
  }, [snap.version, load])

  // Newest first, by when it was first remembered: an edit never makes the open memory jump.
  const list = items ? [...items].sort((x, y) => y.at - x.at) : null
  const item = list?.find((m) => m.id === open)

  const a = useAsk(() => ({
    kind: 'memory',
    repo: '',
    path: item?.id ?? '',
    selection: item ? sel : '',
    from: 0,
    to: 0,
    around: item ? item.text : (list ?? []).map((m) => `- ${m.text}`).join('\n'),
  }))
  // A new selection drops the previous answer; the same one (the field firing again) keeps it.
  const selRef = useRef('')
  const select = (text: string) => {
    if (text === selRef.current) return
    a.reset()
    selRef.current = text
    setSel(text)
  }
  const toggle = (id: string | null) => {
    a.reset()
    selRef.current = ''
    setSel('')
    setOpen(id)
  }
  // The open memory is gone (forgotten here or elsewhere): close it.
  useEffect(() => {
    if (open && items && !items.some((m) => m.id === open)) setOpen(null)
  }, [open, items])

  // A refused write (a secret, an empty text, the server gone…): its reason a moment, next to the field.
  const fail = (at: string) => (e: unknown) => {
    setNote({ at, text: (e as Error).message })
    throw e
  }
  const add = async (text: string) => {
    const r = await api.addMemory(text).catch(fail('add'))
    setItems((l) => [r.item, ...(l ?? []).filter((m) => m.id !== r.item.id)])
  }
  const save = (id: string) => async (text: string) => {
    const r = await api.editMemory(id, text).catch(fail(id))
    setItems((l) => l?.map((m) => (m.id === id ? r.item : m)) ?? null)
  }
  const forget = (id: string) => () =>
    void api
      .deleteMemory(id)
      .then(() => {
        setItems((l) => l?.filter((m) => m.id !== id) ?? null)
        toggle(null)
      })
      .catch((e) => setNote({ at: id, text: (e as Error).message }))

  return (
    <Shell slot={colors.__foot ?? 'p3'} kicker="weevils" title={t.title} meta={list ? (list.length ? t.count(list.length) : t.empty) : '…'} dock={<AskVoice a={a} />}>
      {err && (
        <Notice eventId={noticeKey('error:memory', location.pathname, location.hash, err)} className="band invert" role="alert">
          <div className="in meta" style={{ paddingBlock: 12 }}>
            ! {err}
          </div>
        </Notice>
      )}
      <AddLine onAdd={add} />
      <Note text={note?.at === 'add' ? note.text : null} />
      {!item && (a.asking || a.answer) && (
        <div className="band qa-band">
          <div className="in">
            <AskPanel a={a} text={null} usage={false} onHit={() => undefined} />
          </div>
        </div>
      )}
      {list?.map((m) => (
        <Item
          key={m.id}
          m={m}
          open={m.id === open}
          sel={m.id === open ? sel : ''}
          a={a}
          note={note?.at === m.id ? note.text : null}
          onOpen={() => toggle(m.id)}
          onClose={() => toggle(null)}
          onSave={save(m.id)}
          onSelect={select}
          onForget={forget(m.id)}
        />
      ))}
      {/* Room for the weevboss logo floating at the bottom: the last memory never ends up under it. */}
      <div style={{ height: 96 }} />
    </Shell>
  )
}
