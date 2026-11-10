import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { api } from '../api'
import { WeevbossLogo } from './logo'
import { Icon } from './icons'
import { getLang, tr, useLang, useT } from '../i18n'
import M from '../i18n/voice'
import { tapHint } from './hints'

/**
 * Le logo de weevboss est le bouton vocal, en trois taps qui s'enchaînent vite :
 * 1. enregistre ; 2. arrête et transcrit dans le champ ; 3. envoie.
 * Un tap pendant la transcription est retenu : le message part dès que le texte est là.
 */

type Phase = 'idle' | 'rec' | 'wait' | 'ready'

const blobToB64 = (b: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onerror = () => reject(new Error(tr(M).readAudio))
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.readAsDataURL(b)
  })

const MIME = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg']

/** Un tap-tap plus court que ça n'est pas une phrase : rien n'est envoyé (le serveur refait le contrôle, niveau sonore compris). */
const MIN_REC_MS = 600

// Un seul élément audio, déverrouillé par le premier tap (iOS refuse de jouer sans geste).
let player: HTMLAudioElement | null = null
const SILENCE = 'data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQxAADB8AhSmxhIIEVCSiJrDCQBTcu3UrAIwUdkRgQbFAZC1CQEwTJ9mjRvBA4UOLD8nKVOWfh+UlK3z/177OXrfOdKl7pyn3Xf//WreyTRUoAWgBgkOAGbZHBgG1OF6zM82DWbZaUmMBptgQhGjsyYqc9ae9XFz280948NMBWInljyzsNRFLPWdnZGWrddDsjK1unuSrVN9jJsK8KuQtQCtMBjCEtImISdNKJOopIpBFpNSMbIHCSRpRR5iakjTiyzLhchUUBwCgyKiweBv/7UsQbg8isVNoMPMjAAAA0gAAABEVFGmgqK////9bP/6XCykxBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'
export function unlockAudio() {
  if (player) return
  player = new Audio()
  player.src = SILENCE
  void player.play().catch(() => undefined)
  void loadCue()
}

// ---- Mesures d'un tour de parole (fin de parole, texte, envoi, accroche, réponse, début du son), envoyées au journal.
const marks: Record<string, number> = {}
const mark = (k: string) => (marks[k] = Date.now())
function reportMarks() {
  if (!marks.stop || !marks.play) return
  void fetch('/api/voice/marks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(marks), credentials: 'same-origin' }).catch(() => undefined)
  for (const k of Object.keys(marks)) delete marks[k]
}

/** Le son arrive en flux : l'élément audio commence à jouer au premier morceau, sans attendre le fichier entier. */
export async function say(text: string, onEnd: () => void, oral = false, voice?: string) {
  if (!player) return onEnd()
  const p = player
  try {
    const q = new URLSearchParams({ text: text.slice(0, 1500), oral: oral ? '1' : '0', ...(voice ? { voice } : {}) })
    p.src = `/api/speak/stream?${q}`
    p.onplaying = () => {
      mark('play')
      reportMarks()
      p.onplaying = null
    }
    p.onended = () => onEnd()
    p.onerror = () => onEnd()
    await p.play()
  } catch {
    onEnd()
  }
}

/** Accroche immédiate (« ok », « je regarde »), déjà générée avec la voix choisie, gardée en mémoire. */
let cueUrl: string | null = null
async function loadCue() {
  try {
    const r = await fetch('/api/voice/cue', { credentials: 'same-origin' })
    if (r.ok) {
      if (cueUrl) URL.revokeObjectURL(cueUrl)
      cueUrl = URL.createObjectURL(await r.blob())
    }
  } catch {
    /* pas d'accroche : tant pis */
  }
}
function playCue() {
  if (!player || !cueUrl) return
  player.src = cueUrl
  player.onplaying = () => mark('cue')
  player.onended = null
  void player.play().catch(() => undefined)
  void loadCue() // une autre accroche pour la prochaine fois
}
const hush = () => {
  if (player) {
    player.pause()
    player.onended = null
  }
}

/** Durée d'affichage d'un message d'état du logo, avant son fondu (0,35 s) : moins de 3 s en tout. */
const NOTE_MS = 2200

export function VoiceLogo({ onText, onSend, replyKey, replyText, working, take }: { onText: (t: string) => void; onSend: () => void; replyKey?: string; replyText?: string; working: boolean; take: () => string }) {
  const t = useT(M)
  const lang = useLang()
  // Langue changée : l'accroche gardée en mémoire est rechargée dans la nouvelle langue (le serveur suit l'app).
  const firstLang = useRef(true)
  useEffect(() => {
    if (firstLang.current) return void (firstLang.current = false)
    if (!player) return
    const timer = setTimeout(() => void loadCue(), 800)
    return () => clearTimeout(timer)
  }, [lang])
  const [speaking, setSpeaking] = useState(false)
  /** Le dernier message est parti à la voix : sa réponse sera lue. */
  const spoken = useRef(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [err, setErr] = useState<string | null>(null)
  // Les petits messages d'état du logo (« rien entendu »…) : une bulle de pensée, effacée en fondu (moins de 3 s en tout).
  useEffect(() => {
    if (!err) return
    const t = setTimeout(() => setErr(null), NOTE_MS)
    return () => clearTimeout(t)
  }, [err])
  const [reply, setReply] = useState(false)
  const rec = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const sendAfter = useRef(false)
  const lastReply = useRef(replyKey)
  // Jamais de voix pendant que l'utilisateur parle : une seule réponse en attente (la dernière), lue dès que le micro est coupé.
  const phaseRef = useRef<Phase>('idle')
  phaseRef.current = phase
  const micStopped = useRef(0)
  const pending = useRef<{ text: string; oral: boolean } | null>(null)
  const flushTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const flush = () => {
    clearTimeout(flushTimer.current)
    const p = pending.current
    if (!p) return
    // Seul un enregistrement en cours retient la voix ; une réponse unique est lue tout de suite.
    if (phaseRef.current === 'rec') {
      flushTimer.current = setTimeout(flush, 250)
      return
    }
    pending.current = null
    setSpeaking(true)
    setReply(true)
    void say(p.text, () => {
      setSpeaking(false)
      setReply(false)
    }, p.oral)
  }
  const queueSay = (text: string, oral: boolean) => {
    pending.current = { text, oral } // la plus récente remplace les précédentes : jamais de rafale
    flush()
  }

  // weevboss vient de répondre : une vague de couleur sur le logo.
  useEffect(() => {
    if (!replyKey || replyKey === lastReply.current) return
    lastReply.current = replyKey
    setReply(false)
    requestAnimationFrame(() => setReply(true))
    if (spoken.current && replyText) {
      spoken.current = false
      mark('reply')
      queueSay(replyText, false)
      return
    }
    const t = setTimeout(() => setReply(false), 1800)
    return () => clearTimeout(t)
  }, [replyKey])

  const start = async () => {
    setErr(null)
    sendAfter.current = false
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const type = MIME.find((t) => MediaRecorder.isTypeSupported(t))
      const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
      chunks.current = []
      // Chaque tranche part au serveur pendant que l'utilisateur parle : à l'arrêt, il ne reste presque rien à envoyer.
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
      const mime = r.mimeType || type || 'audio/mp4'
      let seq = 0
      let uploaded: Promise<unknown> = Promise.resolve()
      let uploadOk = true
      const recStart = Date.now()
      r.ondataavailable = (ev) => {
        if (!ev.data.size) return
        chunks.current.push(ev.data)
        const n = seq++
        const data = ev.data
        uploaded = uploaded.then(async () => {
          if (!uploadOk) return
          await api.voiceChunk(id, n, mime, await blobToB64(data)).catch(() => (uploadOk = false))
        })
      }
      r.onstop = async () => {
        stream.getTracks().forEach((tr) => tr.stop())
        try {
          const blob = new Blob(chunks.current, { type: mime })
          if (blob.size < 800 || Date.now() - recStart < MIN_REC_MS) throw new Error(tr(M).nothingHeard)
          await uploaded
          const { text } = uploadOk ? await api.voiceFinish(id, getLang()) : await api.transcribe(blob.type, await blobToB64(blob), getLang())
          mark('text')
          if (!text.trim()) throw new Error(tr(M).nothingHeard)
          onText(text.trim())
          if (sendAfter.current) {
            // Le troisième tap est arrivé pendant la transcription : on envoie dès que le champ est rempli.
            setTimeout(send, 30)
            setPhase('idle')
          } else setPhase('ready')
        } catch (e) {
          setErr((e as Error).message)
          setPhase('idle')
        }
      }
      // Petites tranches : l'arrêt est instantané, rien n'attend la fin d'un gros bloc.
      r.start(250)
      rec.current = r
      setPhase('rec')
    } catch (e) {
      setErr(/denied|permission|NotAllowed/i.test((e as Error).message + (e as Error).name) ? tr(M).micDenied : (e as Error).message)
      setPhase('idle')
    }
  }

  // Le message part à weevboss comme un message écrit ; sa vraie réponse sera résumée à l'oral puis lue.
  const send = () => {
    spoken.current = true
    mark('send')
    playCue()
    onSend()
    take()
  }
  const tap = (e: MouseEvent<HTMLButtonElement>) => {
    if (phase === 'idle' && !speaking && tapHint('voice', e.currentTarget)) return
    unlockAudio()
    // La voix se tait dès que l'utilisateur reprend la parole (le tap enchaîne sur l'enregistrement).
    if (speaking) {
      hush()
      setSpeaking(false)
      setReply(false)
      if (phase !== 'idle') return
    }
    if (phase === 'idle') void start()
    else if (phase === 'rec') {
      setPhase('wait')
      micStopped.current = Date.now()
      for (const k of Object.keys(marks)) delete marks[k]
      mark('stop')
      rec.current?.stop()
    } else if (phase === 'wait') sendAfter.current = true
    else {
      send()
      setPhase('idle')
    }
  }

  const label = phase === 'idle' ? t.dictate : phase === 'rec' ? t.stopAndTranscribe : phase === 'wait' ? t.sendWhenReady : t.send
  return (
    <div className="voice">
      <button className={`voice-logo ${phase} ${reply ? 'reply' : ''} ${working ? 'working' : ''} ${speaking ? 'speaking' : ''}`} onPointerDown={(e) => e.preventDefault()} onClick={tap} aria-label={label} aria-pressed={phase === 'rec'}>
        <WeevbossLogo className="voice-svg" />
      </button>
      <AnimatePresence>
        {err && (
          <motion.span
            key={err}
            className="voice-err"
            role="status"
            initial={{ opacity: 0, rotate: -8, y: 4 }}
            animate={{ opacity: 1, rotate: -8, y: 0 }}
            exit={{ opacity: 0, rotate: -8, y: -4 }}
            transition={{ duration: 0.35, ease: 'easeOut' }}
          >
            <span aria-hidden>! </span>
            {err}
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  )
}

/** Les voix de weevboss : un tap fait dire une phrase d'essai et garde la voix. */
export function VoicePicker({ userName }: { userName: string }) {
  const t = useT(M)
  const lang = useLang()
  const [list, setList] = useState<{ id: string; name: string }[] | null>(null)
  const [cur, setCur] = useState<string | undefined>()
  // Les voix proposées sont celles de la langue de l'app : relues quand elle change (le serveur suit l'app).
  const loaded = useRef(false)
  useEffect(() => {
    const load = () =>
      api
        .voices()
        .then((r) => {
          setList(r.voices)
          setCur(r.current)
        })
        .catch(() => setList([]))
    if (!loaded.current) {
      loaded.current = true
      void load()
      return
    }
    const timer = setTimeout(() => void load(), 800)
    return () => clearTimeout(timer)
  }, [lang])
  const [siri, setSiri] = useState<'idle' | 'copied' | 'error'>('idle')
  // Siri / bouton Action : un jeton personnel, l'adresse prête à coller dans le Raccourci (copiée), et le lien d'installation s'il existe.
  const siriLink = async () => {
    try {
      const r = await api.shortcut(true)
      const endpoint = `${location.origin}/api/voice/turn?k=${r.token}`
      await navigator.clipboard.writeText(endpoint).catch(() => undefined)
      setSiri('copied')
      if (r.url) location.href = r.url
    } catch {
      setSiri('error')
    }
  }
  const siriWord = (
    <button key="__siri" className={`word ${siri === 'copied' ? 'on' : ''}`} onClick={() => void siriLink()} aria-label="Siri">
      siri{siri === 'copied' ? <> <Icon name="check" /></> : siri === 'error' ? <> <Icon name="bang" /></> : null}
    </button>
  )
  if (!list?.length) return <div className="in words">{siriWord}</div>
  const pick = (id: string) => {
    unlockAudio()
    setCur(id)
    void api.setVoice(id).catch(() => undefined)
    void say(t.hello(userName), () => undefined, true, id)
  }
  return (
    <div className="in words" role="group" aria-label={t.voices}>
      {list.map((v) => (
        <button key={v.id} className={`word ${cur === v.id ? 'on' : ''}`} aria-pressed={cur === v.id} onClick={() => pick(v.id)}>
          {v.name}
        </button>
      ))}
      {siriWord}
    </div>
  )
}
