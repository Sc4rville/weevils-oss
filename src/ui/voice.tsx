import { withoutMachinePrefix } from '../../shared/machine-prefix.ts'
import { noticeKey } from '../../shared/notices.ts'
import { Notice, useNotice } from './notice'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { api } from '../api'
import { recordedChunks, saveRecording, saveVoiceChunk, splitVoiceChunk, voiceRecordings, volatileVoiceRecordings, type VoiceRecording } from '../voice-recordings'
import { WeevbossLogo } from './logo'
import { Icon } from './icons'
import { localeHeaders, getLang, tr, useLang, useT } from '../i18n'
import M from '../i18n/voice'
import { markSeen, tapHint } from './hints'
import { askSetup } from './setup'
import { useApp } from './app-context'
import { ITEM_SAYS, LOGO_SAYS } from './foryou-voice'
import LM from '../i18n/live'
import { LiveLine, armLive, disarmLive, startLive, stopLive, useLive } from './live'

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

/** Rien à transcrire (trop court, silence) : pas une panne, le logo n'en dit rien. */
class Quiet extends Error {}
const quiet = () => new Quiet(tr(M).nothingHeard)

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
  void fetch('/api/voice/marks', { method: 'POST', headers: { ...localeHeaders(), 'content-type': 'application/json' }, body: JSON.stringify(marks), credentials: 'same-origin' }).catch(() => undefined)
  for (const k of Object.keys(marks)) delete marks[k]
}

/** Le logo va parler : les messages vocaux de « pour toi » (src/ui/foryou-voice.ts, leur propre élément audio) se taisent. */
const announce = () => window.dispatchEvent(new Event(LOGO_SAYS))

/** Un message vocal de « pour toi » démarre : le logo se tait, et sa lecture en cours se termine proprement (son état suit). */
function quietLogo() {
  if (!player || player.paused) return
  player.pause()
  const end = player.onended
  player.onended = null
  end?.call(player, new Event('ended'))
}
if (typeof window !== 'undefined') window.addEventListener(ITEM_SAYS, quietLogo)

/** Le son arrive en flux : l'élément audio commence à jouer au premier morceau, sans attendre le fichier entier. */
export async function say(text: string, onEnd: () => void, oral = false, voice?: string) {
  if (!player) return onEnd()
  const p = player
  announce()
  try {
    const q = new URLSearchParams({ text: text.slice(0, 1500), oral: oral ? '1' : '0', lang: getLang(), ...(voice ? { voice } : {}) })
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
  const requestedLang = getLang()
  try {
    const r = await fetch('/api/voice/cue', { credentials: 'same-origin', headers: localeHeaders() })
    if (r.ok) {
      const blob = await r.blob()
      if (requestedLang !== getLang()) return
      if (cueUrl) URL.revokeObjectURL(cueUrl)
      cueUrl = URL.createObjectURL(blob)
    }
  } catch {
    /* pas d'accroche : tant pis */
  }
}
function playCue() {
  if (!player || !cueUrl) return
  announce()
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

/** Logos qui écoutent, transcrivent ou parlent. */
const busyLogos = new Set<object>()
export const voiceBusy = () => busyLogos.size > 0

/** Hold the logo this long for a live conversation (src/ui/live.tsx). */
const HOLD_MS = 550

/** Durée d'affichage d'un message d'état du logo, avant son fondu (0,35 s) : moins de 3 s en tout. */
const NOTE_MS = 2200

export function VoiceLogo({ onText, onSend, replyKey, replyText, working, take, recordingScope }: { recordingScope?: string; onText: (t: string) => void; onSend: () => void; replyKey?: string; replyText?: string; working: boolean; take: () => string }) {
  const t = useT(M)
  const tl = useT(LM)
  const lang = useLang()
  const liveNow = useLive()
  const hold = useRef<{ timer?: ReturnType<typeof setTimeout>; fired: boolean }>({ fired: false })
  const snapshot = useApp().snap
  const snapSetup = snapshot.setup
  // IndexedDB is already isolated by app origin. A late machine snapshot must not move an active recording.
  const scope = recordingScope ?? `page:${location.pathname}${location.hash}`
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const [saved, setSaved] = useState<VoiceRecording[]>([])
  const currentRecording = useRef<VoiceRecording | null>(null)
  const memory = useRef(new Map<string, Blob[]>())
  const tried = useRef(new Set<string>())
  const refreshSaved = async () => {
    const rows = await voiceRecordings(scope).catch(() => [])
    const ram = [...volatileVoiceRecordings.values()].map(value => value.recording).filter(item => item.scope === scope)
    if (alive.current && scopeRef.current === scope) setSaved([...ram, ...rows.filter(item => !ram.some(r => r.id === item.id))])
  }
  useEffect(() => {
    setSaved([])
    void refreshSaved()
    return () => { if (rec.current?.state === 'recording') rec.current.stop() }
  }, [scope])
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
  const [arming, setArming] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // Les petits messages d'état du logo (« rien entendu »…) : une bulle de pensée, effacée en fondu (moins de 3 s en tout).
  useEffect(() => {
    // Toujours effacé, même lié à un enregistrement : une note ne reste jamais collée au logo.
    if (!err) return
    const t = setTimeout(() => setErr(null), NOTE_MS)
    return () => clearTimeout(t)
  }, [err])
  const busyKey = useRef({})
  useEffect(() => {
    const k = busyKey.current
    // « ready » (dictée transcrite, en attente d'un tap pour l'envoyer) n'écoute ni ne parle : souvent envoyée autrement.
    if (phase === 'rec' || phase === 'wait' || speaking || liveNow) busyLogos.add(k)
    else busyLogos.delete(k)
    return () => void busyLogos.delete(k)
  }, [phase, speaking, !!liveNow])
  const [reply, setReply] = useState(false)
  const rec = useRef<MediaRecorder | null>(null)
  const starting = useRef(false)
  useEffect(() => {
    if (phase !== 'rec' && phase !== 'wait') return
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', protect)
    return () => window.removeEventListener('beforeunload', protect)
  }, [phase])
  // Démonté en pleine écoute (feuille fermée) : le micro se coupe et plus rien ne part au serveur.
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      const r = rec.current
      if (!r || r.state === 'inactive') return
      // Keep the final dataavailable callback: it journals the last chunk even after unmount.
      r.stop()
      r.stream.getTracks().forEach((tr) => tr.stop())
    }
  }, [])
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
    void say(withoutMachinePrefix(p.text), () => {
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

  // Recovery never sends a message. Even a completed transcript requires an explicit insertion.
  const recover = async (item: VoiceRecording) => {
    if (phase === 'rec' || phase === 'wait') return
    setErr(null)
    setPhase('wait')
    currentRecording.current = item
    try {
      let text = item.text
      if (!text) {
        const parts = memory.current.get(item.id) ?? volatileVoiceRecordings.get(item.id)?.parts ?? await recordedChunks(item)
        if (!parts.length) throw quiet()
        for (let n = 0; n < parts.length; n++) {
          await saveVoiceChunk(item, n, parts[n])
          await api.voiceChunk(item.id, n, item.type, await blobToB64(parts[n]))
        }
        text = (await api.voiceFinish(item.id, item.lang, parts.length)).text.trim()
        if (!text) throw quiet()
        item = { ...item, text }
        await saveRecording(item)
      }
      if (!alive.current || scopeRef.current !== item.scope) return
      // Do not silently replace or send the current draft.
      onText(text)
      await saveRecording({ ...item, insertedAt: Date.now() })
      if (!volatileVoiceRecordings.get(item.id)?.recording.text) {
        volatileVoiceRecordings.delete(item.id)
        memory.current.delete(item.id)
      }
      setPhase('ready')
    } catch {
      // Background retry of an earlier page's recording: silent. The audio stays in the journal; nothing was asked just now.
      if (alive.current) setPhase('idle')
    } finally { void refreshSaved() }
  }
  // No visible list: a dictation that stopped but was never transcribed (or never reached the draft) is recovered by itself,
  // once per recording, in the conversation it belongs to. An interrupted one stays in the journal. Never sends.
  useEffect(() => {
    if (phase === 'rec' || phase === 'wait') return
    const next = saved.find(item => item.count > 0 && item.stoppedAt && !item.insertedAt && !tried.current.has(item.id))
    if (!next) return
    tried.current.add(next.id)
    void recover(next)
  }, [saved, phase])
  const start = async () => {
    if (starting.current) return
    starting.current = true
    setArming(true)
    setErr(null)
    sendAfter.current = false
    let stream: MediaStream | undefined
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (!alive.current) return void stream.getTracks().forEach((tr) => tr.stop())
      const type = MIME.find((t) => MediaRecorder.isTypeSupported(t))
      const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
      const mime = r.mimeType || type || 'audio/mp4'
      let item: VoiceRecording = { id, scope, type: mime, lang: getLang(), startedAt: Date.now(), count: 0 }
      // Refuse to start unprotected recording if this browser cannot retain audio.
      try { await saveRecording(item) } catch { throw new Error(tr(M).storageUnavailable) }
      if (!alive.current || scopeRef.current !== scope) return void stream.getTracks().forEach((tr) => tr.stop())
      currentRecording.current = item
      tried.current.add(item.id) // this session reports its own failure; automatic recovery is for what an earlier page left behind
      const parts: Blob[] = []
      memory.current.set(id, parts)
      let stored: Promise<void> = Promise.resolve()
      let uploaded: Promise<unknown> = Promise.resolve()
      let uploadError: unknown
      let storageError: unknown
      const tracks = stream
      r.ondataavailable = (ev) => {
        for (const data of splitVoiceChunk(ev.data)) {
          const n = parts.length
          parts.push(data)
          item = { ...item, count: parts.length }
          const snapshot = item
          stored = stored.then(() => saveVoiceChunk(snapshot, n, data)).catch(e => {
            storageError = e
            // RAM remains available for export; stop before more unprotected speech is recorded.
            if (r.state !== 'inactive') r.stop()
          })
          uploaded = uploaded.then(async () => {
            if (uploadError) return
            try { await api.voiceChunk(id, n, mime, await blobToB64(data)) } catch (e) { uploadError = e }
          })
        }
      }
      r.onerror = () => {
        uploadError = new Error(tr(M).recordingInterrupted)
        if (r.state !== 'inactive') r.stop()
      }
      r.onstop = async () => {
        if (alive.current && scopeRef.current === scope) setPhase('wait')
        tracks.getTracks().forEach((tr) => tr.stop())
        item = { ...item, stoppedAt: Date.now() }
        try {
          await stored
          try { await saveRecording(item) } catch (e) { storageError = e; throw e }
          if (storageError) throw new Error(tr(M).storageInterrupted)
          if (!alive.current || scopeRef.current !== scope) return
          const blob = new Blob(parts, { type: mime })
          if (blob.size < 800 || item.stoppedAt! - item.startedAt < MIN_REC_MS) throw quiet()
          await uploaded
          if (uploadError) throw uploadError
          const text = (await api.voiceFinish(id, item.lang, parts.length)).text.trim()
          if (!text) throw quiet()
          item = { ...item, text }
          await saveRecording(item)
          mark('text')
          if (!alive.current || scopeRef.current !== scope) return
          onText(text)
          await saveRecording({ ...item, insertedAt: Date.now() })
          if (sendAfter.current) {
            setTimeout(() => { if (alive.current && scopeRef.current === scope) send() }, 30)
            setPhase('idle')
          } else setPhase('ready')
        } catch (e) {
          if (alive.current && scopeRef.current === scope) {
            if (storageError || !(e instanceof Quiet)) setErr(storageError ? tr(M).storageInterrupted : (e as Error).message)
            setPhase('idle')
            // Include RAM-only recording if browser persistence failed mid-recording.
            setSaved(rows => [item, ...rows.filter(row => row.id !== id)])
          }
        } finally {
          if (storageError) volatileVoiceRecordings.set(id, { recording: item, parts })
          else memory.current.delete(id)
          void refreshSaved()
        }
      }
      r.start(250)
      rec.current = r
      setPhase('rec')
    } catch (e) {
      stream?.getTracks().forEach((tr) => tr.stop())
      setErr(/denied|permission|NotAllowed/i.test((e as Error).message + (e as Error).name) ? tr(M).micDenied : (e as Error).message)
      setPhase('idle')
    } finally { starting.current = false; if (alive.current) setArming(false) }
  }

  // Le message part à weevboss comme un message écrit ; sa vraie réponse sera résumée à l'oral puis lue.
  const send = () => {
    spoken.current = true
    mark('send')
    playCue()
    onSend()
    take()
  }
  // Hold: a live conversation (Gemini as the voice, weevboss doing the work). The audio wakes inside the gesture.
  const pressStart = () => {
    hold.current.fired = false
    if (phase !== 'idle' || liveNow) return
    armLive()
    hold.current.timer = setTimeout(() => {
      hold.current.fired = true
      hush()
      setSpeaking(false)
      setErr(null)
      navigator.vibrate?.(12)
      markSeen('g-live')
      startLive()
    }, HOLD_MS)
  }
  const pressEnd = () => {
    clearTimeout(hold.current.timer)
    if (!hold.current.fired) disarmLive()
  }
  const tap = (e: MouseEvent<HTMLButtonElement>) => {
    if (hold.current.fired) return void (hold.current.fired = false)
    // While live, a tap ends it.
    if (liveNow) return stopLive()
    // Première fois : la bulle. Sans dictée ni voix branchées, elle renvoie vers weevboss, qui explique comment.
    const off = snapSetup?.voice === false && snapSetup.dictation === false
    if (phase === 'idle' && !speaking && tapHint('voice', e.currentTarget, off ? 'voiceOff' : undefined)) return void (off && askSetup('voice'))
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

  const errorId = noticeKey('error:voice', currentRecording.current?.id, err)
  const { hidden: errorHidden } = useNotice(errorId)
  const label = liveNow ? tl.stop : phase === 'idle' ? t.dictate : phase === 'rec' ? t.stopAndTranscribe : phase === 'wait' ? t.sendWhenReady : t.send
  return (
    <div className="voice" data-voice-busy={arming || phase === 'rec' || phase === 'wait' || !!err && !!currentRecording.current}>
      <button
        className={`voice-logo ${liveNow ? `live live-${liveNow.state}` : phase} ${reply && !liveNow ? 'reply' : ''} ${working ? 'working' : ''} ${speaking ? 'speaking' : ''}`}
        onPointerDown={(e) => { e.preventDefault(); pressStart() }}
        onPointerUp={pressEnd}
        onPointerLeave={pressEnd}
        onPointerCancel={pressEnd}
        onContextMenu={(e) => e.preventDefault()}
        onClick={tap}
        aria-label={label}
        aria-pressed={phase === 'rec' || !!liveNow}
      >
        <WeevbossLogo className="voice-svg" recording={phase === 'rec'} />
      </button>
      <LiveLine />
      <AnimatePresence>
        {err && !errorHidden && (
          <motion.div
            key={err}
            className="voice-err"
            role="status"
            initial={{ opacity: 0, rotate: -8, y: 4 }}
            animate={{ opacity: 1, rotate: -8, y: 0 }}
            exit={{ opacity: 0, rotate: -8, y: -4 }}
            transition={{ duration: 0.35, ease: 'easeOut' }}
          >
            <Notice eventId={errorId} className="voice-error-notice" role="status"><span aria-hidden>! </span>{err}</Notice>
          </motion.div>
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
  useEffect(() => {
    let live = true
    void api.voices().then(r => {
      if (live) { setList(r.voices); setCur(r.current) }
    }).catch(() => { if (live) setList([]) })
    return () => { live = false }
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
    <button key="__siri" className={`word ${siri === 'copied' ? 'on' : ''}`} onClick={() => void siriLink()}>
      {t.siri}{siri === 'copied' ? <> <Icon name="check" /></> : siri === 'error' ? <> <Icon name="bang" /></> : null}
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
