// Client de weevilsd : appels REST + flux temps réel (SSE). Aucune donnée fictive.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { AskResult, Brick, Device } from '../shared/setup.ts'
import type { Tour, TourId } from '../shared/tour.ts'
import { getLang, tr } from './i18n'
import M from './i18n/app'
import type { FsListing, InfraDetail, TokenRate, UsageInfo, UsageToday } from '../shared/infra.ts'
import type { ProgressFix, Software, SoftwareList } from '../shared/softwares.ts'
import type { ForYouFeed } from '../shared/foryou.ts'
import type { AutoDetail, AutoRunDetail, ConversationDetail, ExplainReply, ExplainRequest, ConversationSummary, GithubRepo, MemoryItem, Optimizer, OptimizerTalkReply, SessionDetail, Snapshot, SubagentDetail, Tool, WeevilQuestion, WeevilReply } from '../shared/api.ts'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

let onUnauthorized: (() => void) | null = null

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (res.status === 401 && !url.endsWith('/login')) onUnauthorized?.()
    throw new ApiError(res.status, (data as { error?: string }).error ?? res.statusText)
  }
  return data as T
}

const enc = encodeURIComponent
/** The app's language, for what the server writes for this reader (the stream's texts, its refusals), as GET /api/tips does. */
const inLang = () => `?lang=${getLang()}`

export interface FileContent {
  path: string
  size: number
  binary: boolean
  content: string
  truncated: boolean
}

export const api = {
  me: () => call<{ authed: boolean }>('GET', '/api/me'),
  login: (secret: string) => call<{ ok: true }>('POST', '/api/login', { secret }),
  logout: () => call<{ ok: true }>('POST', '/api/logout', {}),
  snapshot: () => call<Snapshot>('GET', '/api/snapshot'),
  session: (id: string) => call<SessionDetail>('GET', `/api/sessions/${enc(id)}`),
  /** Détail d'un sous-agent, d'une étape de workflow ou d'une commande d'arrière-plan (ses derniers pas). */
  subagent: (id: string, subId: string) => call<SubagentDetail>('GET', `/api/sessions/${enc(id)}/subagents/${enc(subId)}`),
  screen: (id: string) => call<{ screen: string | null }>('GET', `/api/sessions/${enc(id)}/screen`),
  archive: (id: string, archived: boolean) => call<{ ok: true }>('POST', `/api/sessions/${enc(id)}/archive`, { archived }),
  send: (id: string, text: string) => call<{ id: string }>('POST', `/api/sessions/${enc(id)}/send`, { text }),
  /** Session coupée en plein travail : relancée (--resume + message de reprise), ou laissée. */
  resume: (id: string) => call<{ id: string }>('POST', `/api/sessions/${enc(id)}/resume`, {}),
  dismiss: (id: string) => call<{ ok: true }>('POST', `/api/sessions/${enc(id)}/dismiss`, {}),
  /** Relais Codex pendant la limite de Claude : réglage, plan demandé pour une session, décision sur un plan (id « all » : tous). */
  relaySet: (o: { mode?: string; switchAt?: number; tz?: string }) => call<{ ok: true }>('POST', '/api/relay', o),
  relayRequest: (id: string) => call<{ ok: true }>('POST', `/api/sessions/${enc(id)}/relay`, {}),
  relayDecide: (id: string, action: 'go' | 'adjust' | 'wait', text?: string) => call<{ ok: true }>('POST', `/api/relay/plans/${enc(id)}`, { action, text }),
  attach: (id: string, text: string, files: { name: string; type: string; data: string }[]) => call<{ id: string }>('POST', `/api/sessions/${enc(id)}/attach`, { text, files }),
  transcribeInfo: () => call<{ enabled: boolean }>('GET', '/api/transcribe'),
  transcribe: (type: string, data: string, lang: string) => call<{ text: string }>('POST', '/api/transcribe', { type, data, lang }),
  key: (id: string, key: string) => call<{ ok: true }>('POST', `/api/sessions/${enc(id)}/key`, { key }),
  create: (body: { projectId: string; repo?: string; tool: Tool; text: string; machineId?: string }) => call<{ id: string }>('POST', '/api/sessions', body),
  main: (text: string) => call<{ id: string }>('POST', '/api/main', { text }),
  command: (id: string, command: string) => call<{ ok: true }>('POST', `/api/sessions/${enc(id)}/command`, { command }),
  mainCommand: (command: string) => call<{ ok: true }>('POST', '/api/main/command', { command }),
  githubRepos: (fresh = false) => call<{ repos: GithubRepo[] }>('GET', `/api/github/repos${fresh ? '?fresh' : ''}`),
  pinRepo: (repo: string, pinned: boolean) => call<{ ok: true }>('POST', '/api/github/pin', { repo, pinned }),
  newRepo: (name: string, description: string) => call<{ name: string }>('POST', '/api/github/repos', { name, description }),
  devil: (text: string) => call<{ id: string }>('POST', '/api/devil', { text }),
  setupWelcome: (device: Device) => call<{ ok: true }>('POST', '/api/setup/welcome', { device }),
  setupAsk: (brick: Brick, device: Device) => call<AskResult>('POST', '/api/setup/ask', { brick, device }),
  setupApply: (brick: Brick, values: Record<string, string>) => call<{ ok: true }>('POST', '/api/setup/apply', { brick, values }),
  /** Un secret demandé par un agent ([[setup:key:NOM]]) : la valeur part au serveur, rien ne revient. */
  setupKey: (name: string, value: string) => call<{ ok: true }>('POST', '/api/setup/key', { name, value }),
  setupDone: (brick: Brick) => call<{ ok: true }>('POST', '/api/setup/done', { brick }),
  tour: (mobile: boolean) => call<Tour>('GET', `/api/tour${mobile ? '?mobile=1' : ''}`),
  tourAct: (action: 'skip' | 'unskip' | 'done' | 'close' | 'open' | 'intro', id?: TourId) => call<Tour>('POST', '/api/tour', { action, id }),
  tourDemo: (id: TourId) => call<{ text?: string; audio?: string }>('POST', '/api/tour/demo', { id }),
  setupLink: () => call<{ link: string }>('GET', '/api/setup/link'),
  voiceChunk: (id: string, seq: number, type: string, data: string) => call<{ ok: true }>('POST', '/api/voice/chunk', { id, seq, type, data }),
  voiceFinish: (id: string, lang: string) => call<{ text: string }>('POST', '/api/voice/finish', { id, lang }),
  shortcut: (fresh: boolean) => call<{ token: string; url: string }>(fresh ? 'POST' : 'GET', '/api/voice/shortcut', fresh ? {} : undefined),
  voices: () => call<{ enabled: boolean; voices: { id: string; name: string; gender?: string }[]; current?: string }>('GET', '/api/voices'),
  setVoice: (id: string) => call<{ ok: true }>('POST', '/api/voices', { id }),
  mainAttach: (text: string, files: { name: string; type: string; data: string }[]) => call<{ id: string }>('POST', '/api/main/attach', { text, files }),
  memory: () => call<{ items: MemoryItem[] }>('GET', '/api/memory'),
  addMemory: (text: string) => call<{ item: MemoryItem }>('POST', '/api/memory', { text }),
  editMemory: (id: string, text: string) => call<{ item: MemoryItem }>('PUT', `/api/memory/${enc(id)}`, { text }),
  deleteMemory: (id: string) => call<{ ok: true }>('DELETE', `/api/memory/${enc(id)}`),
  weevil: () => call<{ question: WeevilQuestion | null }>('GET', '/api/weevil'),
  weevilMissed: (id: string) => call<{ ok: true }>('POST', `/api/weevil/${enc(id)}/missed`, {}),
  weevilAnswer: (id: string, text: string, history: { role: 'weevil' | 'user'; text: string }[]) => call<WeevilReply>('POST', `/api/weevil/${enc(id)}/answer`, { text, history }),
  /** « Pour toi » (shared/foryou.ts) : le flux, puis ce qu'on y fait. */
  foryou: () => call<ForYouFeed>('GET', `/api/foryou${inLang()}`),
  foryouSeen: (ids: string[]) => call<{ ok: true }>('POST', '/api/foryou/seen', { ids }),
  foryouDismiss: (id: string, eventId?: string) => call<{ ok: true }>('POST', `/api/foryou/${enc(id)}/dismiss`, { eventId }),
  foryouAct: (id: string, action: string, card?: string) => call<{ ok: true }>('POST', `/api/foryou/${enc(id)}/act${inLang()}`, { action, card }),
  foryouReply: (id: string, text: string) => call<{ ok: true }>('POST', `/api/foryou/${enc(id)}/reply${inLang()}`, { text }),
  foryouMore: (id: string) => call<{ text: string }>('POST', `/api/foryou/${enc(id)}/more${inLang()}`, {}),
  createOptimizer: () => call<{ item: Optimizer }>('POST', '/api/optimizers', {}),
  /** rev : la version à l'écran (le serveur refuse, 409, si la tâche a été réécrite depuis). */
  acceptOptimizer: (id: string, rev?: number) => call<{ ok: true }>('POST', `/api/optimizers/${enc(id)}/accept`, rev === undefined ? {} : { rev }),
  /** Une question sur une tâche (écrite ou dite) : la réponse, la tâche réécrite. tz : où se lisent les heures dites. */
  talkOptimizer: (id: string, text: string) => call<OptimizerTalkReply>('POST', `/api/optimizers/${enc(id)}/talk`, { text, tz: Intl.DateTimeFormat().resolvedOptions().timeZone }),
  refuseOptimizer: (id: string) => call<{ ok: true }>('POST', `/api/optimizers/${enc(id)}/refuse`, {}),
  toggleH24: (id: string) => call<{ ok: true }>('POST', `/api/h24/${enc(id)}/toggle`, {}),
  /** Une automatisation (tâche, timer, job) : ses passages, le plus récent en premier. */
  auto: (id: string) => call<AutoDetail>('GET', `/api/auto/${enc(id)}`),
  /** Ce qu'un passage (fini à `at`) a fait et produit. */
  autoRun: (id: string, at: number) => call<AutoRunDetail>('GET', `/api/auto/${enc(id)}/runs/${at}`),
  /** L'adresse d'une capture produite par une automatisation (pour <img src>). */
  autoBlob: (id: string, path: string) => `/api/auto/${enc(id)}/blob?path=${enc(path)}`,
  pauseOptimizer: (id: string, paused: boolean) => call<{ ok: boolean }>('POST', `/api/optimizers/${enc(id)}/pause`, { paused }),
  /** Maintenant, dès que la machine est libre. */
  runOptimizer: (id: string) => call<{ ok: boolean }>('POST', `/api/optimizers/${enc(id)}/run`, {}),
  conversations: (opts: { project?: string; q?: string }) => call<{ conversations: ConversationSummary[] }>('GET', `/api/conversations?${new URLSearchParams(opts)}`),
  conversation: (id: string) => call<ConversationDetail>('GET', `/api/conversations/${enc(id)}`),
  classify: (id: string, target: { projectId?: string }) => call<{ ok: true }>('POST', `/api/conversations/${enc(id)}/classify`, target),
  continueConv: (id: string, tool: Tool, text: string) => call<{ id: string }>('POST', `/api/conversations/${enc(id)}/continue`, { tool, text }),
  /** Envoi d'un export avec progression (XHR : fetch ne donne pas l'avancement de l'envoi). */
  importExport: (file: File, onProgress: (p: number) => void) =>
    new Promise<{ added: number; updated: number; total: number }>((resolve, reject) => {
      const x = new XMLHttpRequest()
      x.open('POST', '/api/import')
      x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total)
      x.onload = () => {
        let d: any = {}
        try {
          d = JSON.parse(x.responseText)
        } catch {
          /* réponse vide */
        }
        if (x.status < 300) resolve(d)
        else reject(new Error(d.error ?? tr(M).failed(x.status)))
      }
      x.onerror = () => reject(new Error(tr(M).uploadInterrupted))
      x.send(file)
    }),
  push: () => call<{ enabled: boolean; publicKey: string; devices: number }>('GET', '/api/push'),
  pushSubscribe: (sub: PushSubscriptionJSON) => call<{ ok: true; devices: number }>('POST', '/api/push/subscribe', sub),
  pushTest: () => call<{ ok: true }>('POST', '/api/push/test', {}),
  repos: (machine: string) => call<{ repos: string[] }>('GET', `/api/repos?machine=${enc(machine)}`),
  files: (repo: string, machine: string) => call<{ files: string[] }>('GET', `/api/repos/${enc(repo)}/files?machine=${enc(machine)}`),
  explain: (body: ExplainRequest) => call<ExplainReply>('POST', '/api/explain', body),
  infra: (machine: string) => call<InfraDetail>('GET', `/api/infra?machine=${enc(machine)}`),
  fs: (machine: string, path: string) => call<FsListing>('GET', `/api/fs?machine=${enc(machine)}&path=${enc(path)}`),
  fsFile: (machine: string, path: string) => call<FileContent>('GET', `/api/fs/file?machine=${enc(machine)}&path=${enc(path)}`),
  usage: () => call<UsageInfo>('GET', '/api/usage'),
  usageToday: () => call<UsageToday>('GET', '/api/usage/today'),
  usageRate: () => call<TokenRate>('GET', '/api/usage/rate'),
  file: (repo: string, path: string, machine: string) => call<FileContent>('GET', `/api/repos/${enc(repo)}/file?path=${enc(path)}&machine=${enc(machine)}`),
  softwares: () => call<SoftwareList>('GET', '/api/softwares'),
  software: (id: string) => call<Software>('GET', `/api/softwares/${enc(id)}`),
  openSoftware: (id: string) => call<Software>('POST', `/api/softwares/${enc(id)}/open`, {}),
  stopSoftware: (id: string) => call<Software>('POST', `/api/softwares/${enc(id)}/stop`, {}),
  fixProgress: (id: string, fix: ProgressFix) => call<Software>('POST', `/api/softwares/${enc(id)}/progress`, fix),
}

/** Capture d'écran d'un logiciel (la version dans l'adresse : une nouvelle capture n'est jamais masquée par le cache). */
export const softwareShot = (id: string, shot: number) => `/api/softwares/${enc(id)}/shot?v=${shot}`

/** Connexion + instantané tenu à jour par le flux SSE (le serveur annonce une version, on recharge). */
export function useLive() {
  const [authed, setAuthed] = useState<boolean | null>(null)
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [offline, setOffline] = useState(false)
  const loader = useRef<() => void>(() => undefined)

  useEffect(() => {
    onUnauthorized = () => setAuthed(false)
    // Lien de connexion « #k=<code> » (QR code) : on se connecte puis on efface le code de l'adresse.
    const m = /#k=([\w-]+)/.exec(location.hash)
    const start = m
      ? (history.replaceState(null, '', location.pathname), api.login(m[1]).then(() => ({ authed: true }), () => api.me()))
      : api.me()
    start.then((r) => setAuthed(r.authed)).catch(() => setOffline(true))
    return () => {
      onUnauthorized = null
    }
  }, [])

  useEffect(() => {
    if (!authed) return
    let stopped = false
    let inflight = false
    let wanted = 0
    let have = 0
    const load = async () => {
      if (inflight) return
      inflight = true
      try {
        const s = await api.snapshot()
        have = s.version
        // The greeting of an empty weevboss thread comes in the server's language: shown in the app's.
        s.main = s.main.map((m) => (m.id === 'hello' ? { ...m, text: tr(M).hello } : m))
        if (!stopped) {
          setSnap(s)
          setOffline(false)
        }
      } catch (e) {
        if (!(e instanceof ApiError)) setOffline(true)
      } finally {
        inflight = false
        if (wanted > have && !stopped) void load()
      }
    }
    loader.current = () => void load()
    void load()
    const es = new EventSource('/api/events')
    es.addEventListener('version', (e) => {
      wanted = Number((e as MessageEvent).data)
      if (wanted > have) void load()
    })
    es.onerror = () => setOffline(true)
    es.onopen = () => {
      setOffline(false)
      void load()
    }
    const onVisible = () => document.visibilityState === 'visible' && void load()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      stopped = true
      es.close()
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [authed])

  const refresh = useCallback(() => loader.current(), [])
  return { authed, setAuthed, snap, offline, refresh }
}
