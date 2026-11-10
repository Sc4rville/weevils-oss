import { noticeKey } from '../../shared/notices.ts'
import { Notice } from './notice'
import { useEffect, useRef, useState } from 'react'
import type { ExplainReply, ExplainRequest, Message, UsageHit } from '../../shared/api.ts'
import { api } from '../api'
import { useApp } from './app-context'
import { VoiceLogo } from './voice'
import { Icon } from './icons'
import { plain } from './format'
import { copyText } from './copy'
import { reveal } from './follow'
import { useT } from '../i18n'
import C from '../i18n/codeview'
import './ask.css'

/**
 * Questions sur une sélection, partout où l'on lit (fichier, fil de session, fil de weevboss) : la barre de mots
 * (explique, où c'est utilisé, demande…), la question écrite ou dictée, la réponse sur place, et le logo de weevboss
 * qui écoute avec le contexte de l'écran. L'hôte fournit la sélection et le contexte ; tout le reste vit ici.
 */

export type AskMode = ExplainRequest['mode']
/** Le contexte d'une question, sans le mode ni la question : construit par l'hôte au moment de demander. */
export type AskBase = Omit<ExplainRequest, 'mode' | 'question'>

interface Answer {
  id: number
  mode: AskMode
  loading: boolean
  reply?: ExplainReply
  err?: string
  /** Demande transmise au vrai weevboss : sa réponse est le premier message après cet instant. */
  since?: number
  voice?: boolean
}

export function useAsk(build: () => AskBase, opts: { onVoice?: () => void } = {}) {
  const { snap } = useApp()
  const [answer, setAnswer] = useState<Answer | null>(null)
  const [asking, setAsking] = useState(false)
  const [draft, setDraft] = useState('')
  const seq = useRef(0)
  const heard = useRef('')
  // Le logo vocal rappelle des fonctions gardées depuis le début de l'enregistrement : elles lisent l'hôte à jour ici.
  const live = useRef({ build, opts })
  live.current = { build, opts }

  const reset = () => {
    seq.current++
    setAnswer(null)
    setAsking(false)
    setDraft('')
  }
  const ask = async (mode: AskMode, question?: string, voice = false) => {
    const id = ++seq.current
    setAsking(false)
    setAnswer({ id, mode, loading: true, voice })
    try {
      const reply = await api.explain({ ...live.current.build(), mode, question })
      if (seq.current !== id) return
      setAnswer({ id, mode, loading: !!reply.forwarded, reply, since: reply.forwarded ? Date.now() - 2000 : undefined, voice })
    } catch (e) {
      if (seq.current === id) setAnswer({ id, mode, loading: false, err: (e as Error).message, voice })
    }
  }
  const submit = () => {
    const q = draft.trim()
    if (!q) return
    setDraft('')
    void ask('ask', q)
  }
  const open = () => {
    seq.current++
    setAnswer(null)
    setAsking(true)
  }
  /** Le logo a entendu : la question s'écrit sous la sélection (ou sous ce qui est affiché). */
  const voiceText = (x: string) => {
    heard.current = heard.current ? `${heard.current} ${x}` : x
    live.current.opts.onVoice?.()
    open()
    setDraft(heard.current)
  }
  const voiceSend = () => {
    const q = heard.current.trim()
    heard.current = ''
    if (!q) return
    setDraft('')
    void ask('ask', q, true)
  }

  // Une demande d'action est partie au vrai weevboss : sa réponse, dès qu'elle arrive dans son fil, s'affiche ici aussi.
  const forwarded: Message | undefined = answer?.since ? snap.main.find((m) => m.role === 'assistant' && m.at >= answer.since!) : undefined
  const shown = forwarded ? plain(forwarded.text) : answer?.reply?.text
  const waiting = answer ? (answer.reply?.forwarded ? !forwarded : answer.loading) : false
  const replyKey = answer?.voice ? (forwarded?.id ?? (answer.reply && !answer.reply.forwarded ? String(answer.id) : undefined)) : undefined
  return { answer, asking, setAsking, draft, setDraft, ask, submit, open, reset, voiceText, voiceSend, shown, waiting, replyKey }
}

export type Ask = ReturnType<typeof useAsk>

/** Le logo de weevboss en bas d'une page, sous le pouce : il écoute, sait ce qui est à l'écran, et lit sa réponse. */
export function AskVoice({ a }: { a: Ask }) {
  return (
    <div className="page-voice">
      <VoiceLogo take={() => ''} onText={a.voiceText} onSend={a.voiceSend} replyKey={a.replyKey} replyText={a.shown} working={a.waiting} />
    </div>
  )
}

/**
 * Sous la sélection : la barre de mots (si quelque chose est sélectionné), la question, la réponse.
 * `held` : un geste est en cours, la barre reste en place en retrait.
 */
export function AskPanel({
  a,
  text,
  held = false,
  usage = true,
  openFile,
  onHit,
  hitLabel = (h) => `${h.path}:${h.line}`,
}: {
  a: Ask
  /** Texte sélectionné ; null = rien de sélectionné (question dictée sur ce qui est affiché). */
  text: string | null
  held?: boolean
  /** « où c'est utilisé » n'a de sens qu'avec un repo. */
  usage?: boolean
  /** La sélection est un fichier du repo : « ouvre le fichier ». */
  openFile?: () => void
  onHit: (h: UsageHit) => void
  hitLabel?: (h: UsageHit) => string
}) {
  const c = useT(C)
  const [copied, setCopied] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const form = useRef<HTMLFormElement>(null)
  useEffect(() => setCopied(false), [text])
  const { answer } = a
  // Ce qui vient de s'ouvrir (barre, question, réponse) est amené sous les yeux d'un glissé court, au-dessus du logo
  // flottant (scroll-margin-bottom, ask.css). Une image plus tard : l'hôte a fini de recaler sa page (codeview, fil).
  // Plus haut que l'écran : son début en haut, pour lire la réponse depuis la première ligne.
  useEffect(() => {
    if (held) return
    const f = requestAnimationFrame(() => {
      const el = box.current
      if (!el) return
      const sc = el.closest('[data-scroll], .chat')
      const tall = el.getBoundingClientRect().height > (sc ? sc.clientHeight : window.innerHeight) - 80
      reveal(el, { block: tall ? 'start' : 'nearest', flash: false })
    })
    return () => cancelAnimationFrame(f)
  }, [held, text != null, a.asking, answer?.id, !!a.shown, !!answer?.err, answer?.reply?.hits?.length]) // eslint-disable-line react-hooks/exhaustive-deps
  // « demande » : le clavier s'ouvre et raccourcit la page ; une fois ouvert, le champ est ramené au-dessus.
  useEffect(() => {
    if (!a.asking) return
    input.current?.focus({ preventScroll: true })
    const vv = window.visualViewport
    const go = () => reveal(form.current, { block: 'nearest', flash: false })
    vv?.addEventListener('resize', go, { once: true })
    const tm = setTimeout(go, 350)
    return () => {
      vv?.removeEventListener('resize', go)
      clearTimeout(tm)
    }
  }, [a.asking])
  return (
    <div ref={box} className={held ? 'qa held' : 'qa'}>
      {text != null && (
        <div className="words qa-bar" role="group">
          {openFile && (
            <button className="word" onClick={openFile}>
              {c.openFile}
            </button>
          )}
          <button className={`word ${answer?.mode === 'explain' ? 'on' : ''}`} onClick={() => void a.ask('explain')}>
            {c.explain}
          </button>
          {usage && (
            <button className={`word ${answer?.mode === 'usage' ? 'on' : ''}`} onClick={() => void a.ask('usage')}>
              {c.usage}
            </button>
          )}
          <button className={`word ${a.asking || answer?.mode === 'ask' ? 'on' : ''}`} onClick={a.open}>
            {c.ask}
          </button>
          <button className={`word ${copied ? 'on' : ''}`} onClick={() => void copyText(text).then((ok) => ok && setCopied(true))}>
            {copied ? c.copied : c.copy}
          </button>
        </div>
      )}
      {a.asking && (
        <form
          ref={form}
          className="qa-ask"
          onSubmit={(e) => {
            e.preventDefault()
            a.submit()
          }}
        >
          <span className="strong" aria-hidden>
            <Icon name="chevron" dir="right" />
          </span>
          <input ref={input} value={a.draft} onChange={(e) => a.setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && a.setAsking(false)} aria-label={c.askLabel} enterKeyHint="send" />
        </form>
      )}
      {answer && (
        <div className="qa-answer" aria-live="polite">
          {a.waiting && !a.shown && (
            <span className="spin fluo">
              <Icon name="star" />
            </span>
          )}
          {answer.err && <Notice eventId={noticeKey("error:answer", answer.err)} className="strong" role="alert">! {answer.err}</Notice>}
          {a.shown && <p className="qa-text">{a.shown}</p>}
          {answer.reply?.hits && (
            <div className="qa-hits">
              {answer.reply.hits.length === 0 && <div className="meta">{c.nowhere}</div>}
              {answer.reply.hits.map((h, i) => (
                <button key={`${h.path}:${h.line}:${i}`} className="qa-hit" onClick={() => onHit(h)}>
                  <span className="strong">{hitLabel(h)}</span>
                  <span className="qa-snip">{h.text}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
