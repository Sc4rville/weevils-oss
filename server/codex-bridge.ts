import type { AvailableModel, ModelControls, ModelSelection } from '../shared/model-controls.ts'
import MC from './i18n/model-controls.ts'
import { deliveryContext } from './outbox.ts'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import WebSocket from 'ws'
import { tr } from './i18n.ts'
import M from './i18n/codex-bridge.ts'

type Rpc = (method: string, params?: object) => Promise<any>
type Connect = <T>(socket: string, run: (rpc: Rpc) => Promise<T>) => Promise<T>
/** Connect only to the explicitly configured, already running daemon. Never spawn or resume. */
const connect: Connect = async (socket, run) => {
  const stat = fs.statSync(socket)
  if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw new Error(tr(M).unavailable)
  const ws = new WebSocket(`ws+unix://${socket}:/`)
  let seq = 0
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  const fail = () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(tr(M).uncertain)) }; pending.clear() }
  ws.on('error', fail); ws.on('close', fail)
  ws.on('message', data => {
    let m: any
    try { m = JSON.parse(data.toString()) } catch { return }
    const p = pending.get(m.id)
    if (!p) return // Never answer approvals or tool requests owned by another client.
    pending.delete(m.id); clearTimeout(p.timer)
    if (m.error) p.reject(new Error(tr(M).unavailable))
    else p.resolve(m.result)
  })
  const rpc: Rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(tr(M).uncertain)) }, 5000)
    pending.set(id, { resolve, reject, timer })
    ws.send(JSON.stringify({ id, method, params }), err => { if (err) { clearTimeout(timer); pending.delete(id); reject(new Error(tr(M).unavailable)) } })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(tr(M).unavailable)), 3000)
      ws.once('open', () => { clearTimeout(timer); resolve() })
      ws.once('error', () => { clearTimeout(timer); reject(new Error(tr(M).unavailable)) })
    })
    await rpc('initialize', { clientInfo: { name: 'weevils', version: '0.1.0' }, capabilities: { experimentalApi: true } })
    ws.send(JSON.stringify({ method: 'initialized' }))
    return await run(rpc)
  } finally { fail(); ws.terminate() }
}

export class CodexBridge {
  private loaded = new Set<string>()
  private activity = new Map<string, { type: 'active' | 'idle'; waiting: boolean; at: number }>()
  private queued = new Map<string,{count:number;at:number}>()
  queuedOf(id:string) {
    const q=this.queued.get(id)
    return this.can(id) && q && Date.now()-q.at<20_000 ? q.count : undefined
  }
  private names = new Map<string,string>()
  private nameReads = new Map<string,number>()
  private nameFile: string
  private knownThreads: () => string[]
  /** Explicit shared daemon metadata outranks generated topic titles. Retain last confirmed name offline. */
  nameOf(id:string) { return this.names.get(id) }
  private settings = new Map<string, { model?: string; effort?: string; at: number }>()
  settingsOf(id: string) {
    const s = this.settings.get(id)
    return this.can(id) && s && Date.now()-s.at < 20_000 ? { model: s.model, effort: s.effort } : undefined
  }
  private remember(id: string, thread: any) {
    this.rememberName(id, thread)
    this.settings.set(id, {model: typeof thread?.model === 'string' ? thread.model : undefined, effort: typeof thread?.reasoningEffort === 'string' ? thread.reasoningEffort : undefined, at: Date.now()})
  }
  private rememberName(id: string, thread: any) {
    if (!thread || !('name' in thread) || (thread.name !== null && typeof thread.name !== 'string')) return
    const name = thread.name?.trim() || undefined
    if (this.names.get(id) === name) return
    if (name) this.names.set(id, name); else this.names.delete(id)
    if (this.nameFile) {
      fs.mkdirSync(path.dirname(this.nameFile), {recursive:true,mode:0o700})
      const tmp = this.nameFile + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify([...this.names]), {mode:0o600})
      const fd=fs.openSync(tmp,'r');try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
      fs.renameSync(tmp,this.nameFile)
    }
  }
  private checked = 0
  private busy = false
  private socket: string
  private transport: Connect
  private changed: () => void
  constructor(socket = '', transport: Connect = connect, changed = () => {}, nameFile = '', knownThreads: () => string[] = () => []) {
    this.socket = socket; this.transport = transport; this.changed = changed; this.nameFile = nameFile; this.knownThreads = knownThreads
    if (nameFile) try {
      const saved = JSON.parse(fs.readFileSync(nameFile,'utf8'))
      if (Array.isArray(saved)) for (const entry of saved) if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string' && entry[1].trim()) this.names.set(entry[0],entry[1].trim())
    } catch { /* The daemon remains authoritative; a missing cache cannot create a name. */ }
  }
  can(id: string) { return !!this.socket && Date.now() - this.checked < 20_000 && this.loaded.has(id) }
  /** Read current capability at dispatch time; a stale poll must not reject a connected owner. */
  async reachable(id:string):Promise<boolean>{
    if(!this.socket)return false
    try{return await this.transport(this.socket,async rpc=>{this.loaded=await this.ids(rpc);this.checked=Date.now();this.changed();return this.loaded.has(id)})}catch{return false}
  }
  activityOf(id: string) {
    const state = this.activity.get(id)
    return this.can(id) && state && Date.now()-state.at < 20_000 ? state : undefined
  }
  private async ids(rpc: Rpc) {
    const ids = new Set<string>(); let cursor: string | undefined
    do {
      const page = await rpc('thread/loaded/list', cursor ? { cursor } : {})
      for (const id of page.data ?? []) if (typeof id === 'string') ids.add(id)
      cursor = page.nextCursor || undefined
    } while (cursor)
    return ids
  }
  /** Native durable queue survives both disconnects and weevils restarts. */
  private async drain(rpc: Rpc, id: string) {
    const state = await rpc('thread/read', { threadId: id, includeTurns: false })
    this.remember(id, state.thread)
    const status = state.thread?.status
    if (status?.type === 'active' || status?.type === 'idle') this.activity.set(id, { type: status.type, waiting: Array.isArray(status.activeFlags) && status.activeFlags.some((f: string) => f === 'waitingOnApproval' || f === 'waitingOnUserInput'), at: Date.now() })
    const queue = await rpc('thread/queue/list', { threadId: id })
    this.queued.set(id,{count:queue.data?.length??0,at:Date.now()})
    if (status?.type !== 'idle') return
    const first = queue.data?.[0]
    if (!first?.clientUserMessageId?.startsWith('weevils:')) return
    const remaining=Math.max(0,(queue.data?.length??1)-1)
    await rpc('thread/queue/start', { threadId: id, queuedSubmissionId: first.id })
    this.queued.set(id,{count:remaining,at:Date.now()})
  }
  async refresh() {
    if (!this.socket || this.busy) return
    this.busy = true
    try {
      await this.transport(this.socket, async rpc => {
        this.loaded = await this.ids(rpc); this.checked = Date.now(); this.changed()
        for (const id of this.loaded) {
          try { await this.drain(rpc, id) } catch { /* One busy or unloaded thread must not disable the other channels. */ }
        }
        // Stored/idle threads also own explicit names. Reading metadata never loads, resumes or queues a turn.
        const now = Date.now()
        const due = [...new Set(this.knownThreads())].filter(id => !this.loaded.has(id) && now - (this.nameReads.get(id) ?? 0) >= 60_000).slice(0,20)
        for (const id of due) {
          this.nameReads.set(id,now)
          try { const state=await rpc('thread/read',{threadId:id,includeTurns:false});this.rememberName(id,state.thread) } catch { /* Keep the last confirmed shared name offline. */ }
        }
        this.changed()
      })
    } catch { this.loaded.clear(); this.checked = 0; this.changed() }
    finally { this.busy = false }
  }
  private async catalog(rpc: Rpc): Promise<AvailableModel[]> {
    const models: AvailableModel[] = []; let cursor: string | undefined
    const seen = new Set<string>()
    do {
      const page = await rpc('model/list', { limit: 100, includeHidden: false, ...(cursor ? {cursor} : {}) })
      for (const m of page.data ?? []) {
        if (m.hidden || typeof m.model !== 'string' || typeof m.displayName !== 'string' || !Array.isArray(m.supportedReasoningEfforts)) continue
        models.push({id:m.model,label:m.displayName,efforts:m.supportedReasoningEfforts.map((e:any)=>e.reasoningEffort).filter((e:unknown)=>typeof e==='string'),defaultEffort:typeof m.defaultReasoningEffort==='string'?m.defaultReasoningEffort:undefined})
      }
      cursor=page.nextCursor || undefined
      if (cursor && seen.has(cursor)) throw new Error(tr(MC).unavailable)
      if (cursor) seen.add(cursor)
    } while (cursor)
    return models
  }
  async modelControls(id: string, selection?: ModelSelection): Promise<ModelControls> {
    if (!this.socket) throw new Error(tr(MC).unavailable)
    return this.transport(this.socket, async rpc => {
      if (!(await this.ids(rpc)).has(id)) throw new Error(tr(MC).unavailable)
      const models = await this.catalog(rpc)
      if (!models.length) throw new Error(tr(MC).unavailable)
      if (selection !== undefined) {
        if (!selection || typeof selection !== 'object' || Object.keys(selection).some(k=>!['model','effort'].includes(k)) || !models.some(m=>m.id===selection.model && m.efforts.includes(selection.effort))) throw new Error(tr(MC).invalid)
        // Future turns only: no resume, new thread, turn start, steer or interruption.
        await rpc('thread/settings/update', {threadId:id,model:selection.model,effort:selection.effort})
      }
      let state: any
      try { state=await rpc('thread/read',{threadId:id,includeTurns:false}) } catch(e) { if(selection)throw new Error(tr(MC).unconfirmed);throw e }
      if (selection && (state.thread?.model!==selection.model || state.thread?.reasoningEffort!==selection.effort)) throw new Error(tr(MC).unconfirmed)
      this.remember(id,state.thread)
      this.changed()
      return {threadId:id,tool:'codex',models,selected:{model:state.thread?.model??undefined,effort:state.thread?.reasoningEffort??undefined},active:state.thread?.status?.type==='active',appliesTo:'next-turn'}
    })
  }
  async send(id: string, text: string) {
    if (!this.socket) throw new Error(tr(M).unavailable)
    await this.transport(this.socket, async rpc => {
      if (!(await this.ids(rpc)).has(id)) throw new Error(tr(M).unavailable)
      const key = `weevils:${deliveryContext.getStore()?.messageId ?? crypto.randomUUID()}`
      const out = await rpc('thread/queue/add', { threadId: id, clientUserMessageId: key, input: [{ type: 'text', text, text_elements: [] }] })
      if (out.queuedSubmission?.clientUserMessageId !== key) throw new Error(tr(M).uncertain)
      // The queue acknowledgement is delivery. Failure to start must never trigger a resend.
      try { await this.drain(rpc, id) } catch { /* the next poll retries the same native queue entry */ }
    })
  }
}
