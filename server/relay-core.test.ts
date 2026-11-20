import AgentMessages from './i18n/agent-messages.ts'
import MachineProse from './i18n/machine-prose.ts'
// Relais Codex vu de weevilsd (server/core.ts) : weevboss qui répond par Codex pendant la limite de Claude (même dossier,
// AGENTS.md, contexte caché), le fil qui mêle les deux, le retour sur Claude avec ce que Codex a dit, les sessions liées
// (« relais ») et l'annonce de coupure laissée au relais. tmux est simulé.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session, Tool } from '../shared/api.ts'

// weevboss tourne sur cette machine (les tests ont un WEEVILS_MACHINE, qui le coupe par défaut).
vi.hoisted(() => { process.env.WEEVILS_ORCHESTRATOR = '1'; process.env.WEEVILS_BOSS_TURNS = '0' }) // the pane-based conversation mode (turn mode: boss-view.test.ts)
const mux = vi.hoisted(() => ({
  sendText: vi.fn(async (_name: string, _text: string) => {}),
  sendKey: vi.fn(async (_name: string, _key: string) => {}),
  capture: vi.fn(async (_name: string) => ''),
  spawnWv: vi.fn(async (..._args: unknown[]) => {}),
  killWv: vi.fn(async (_name: string) => {}),
  listWv: vi.fn(async () => [] as unknown[]),
  setOpt: vi.fn(async (..._args: unknown[]) => {}),
}))
vi.mock('./mux.ts', async (orig) => ({ ...(await orig<typeof import('./mux.ts')>()), ...mux }))
vi.mock('./voicepipe.ts', () => ({ keepWarm() {}, warmCues() {} }))
vi.mock('./fast.ts', () => ({ setCartesiaVoice() {} }))
vi.mock('./titles.ts', async (orig) => ({ ...(await orig<typeof import('./titles.ts')>()), llmTitles: async () => [] }))

const { Weevils, joinContext } = await import('./core.ts')
const { DATA_DIR, HOME, ORCH_DIR, INBOX_DIR } = await import('./config.ts')
const { setLang, withLang } = await import('./i18n.ts')
const { projectCodexFlags } = await import('./agent-launch.ts')
type Transcript = import('./transcripts.ts').Transcript

const NOW = Date.parse('2026-11-10T14:00:00Z')
const MIN = 60_000
const cwd = path.join(HOME, 'projects', 'demo')
fs.mkdirSync(cwd, { recursive: true })

let w: InstanceType<typeof Weevils>
const transcript = (over: Partial<Transcript> = {}): Transcript => {
  const id = over.id ?? 's1'
  return { id, tool: 'claude', file: `/nowhere/${id}.jsonl`, cwd, openedAt: NOW - 20 * MIN, lastActivityAt: NOW - MIN, workStartedAt: null, phase: 'idle', firstPrompt: 'refais le panier', messages: [{ id: `${id}-m0`, role: 'user', text: 'refais le panier', at: NOW - 20 * MIN }], subagents: [], offset: 0, partial: '', queued: [], ...over } as Transcript
}
const add = (t: Transcript) => (w.store.byFile.set(t.file, t), t)
const one = (id: string): Session | undefined => w.sessions(Date.now()).find((s) => s.id === id)

/** Le relais, réduit à ce que weevilsd lui demande. */
function fakeRelay(over: Record<string, unknown> = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r: any = {
    on: true,
    boss: undefined as { pane?: string; sessionId?: string; since: number } | undefined,
    back: undefined as number | undefined,
    bossOn: () => r.on,
    setBoss: (b: typeof r.boss) => void (r.boss = b),
    episode: () => (r.on ? { kind: 'limit', since: NOW - MIN, until: Date.parse('2026-11-10T17:00:00Z'), tz: 'Europe/Paris' } : undefined),
    takeBossBack: () => {
      const b = r.back
      r.back = undefined
      return b
    },
    relayOf: (..._ids: (string | undefined)[]) => undefined as string | undefined,
    relayedBy: (_id: string) => undefined as string | undefined,
    covers: (_s: Session) => false,
    view: () => ({ mode: 'ask', codex: true, switchAt: 97, plans: [] }),
    ...over,
  }
  return r
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
  for (const f of Object.values(mux)) f.mockReset()
  mux.capture.mockResolvedValue('')
  mux.listWv.mockResolvedValue([])
  fs.rmSync(path.join(DATA_DIR, 'state.json'), { force: true })
  fs.rmSync(path.join(HOME, '.claude.json'), { force: true })
  setLang('fr', true)
  w = new Weevils()
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllTimers()
  vi.useRealTimers()
})

it('keeps a message before transport when both providers are unavailable, without a duplicate writer', async () => {
  w.relay = fakeRelay({ executionTool: () => null, retryAt: () => NOW + MIN }) as never
  await expect(w.sendMain('preserve this request and attachment context')).rejects.toMatchObject({ status: 429, retryAt: NOW + MIN })
  expect(mux.spawnWv).not.toHaveBeenCalled()
  expect(mux.sendText).not.toHaveBeenCalled()
  expect(mux.killWv).not.toHaveBeenCalled()
})

it('defers attachments before saving any copies while quota is blocked, for main and session entrypoints', async () => {
  w.relay = fakeRelay({ executionTool: () => null, providerReady: () => false, retryAt: () => NOW + MIN, requestReturn: () => {} }) as never
  const t = add(transcript({ id: 'blocked-codex', tool: 'codex' }))
  ;(w as any).codexBridge = { can: () => true, activityOf: () => ({ type: 'idle', waiting: false, at: NOW }) }
  const files = [{ name: 'quota-attachment.png', type: 'image/png', data: Buffer.from('fixture').toString('base64') }]
  const names = () => [INBOX_DIR, path.join(DATA_DIR, 'inbox')].flatMap(d => fs.existsSync(d) ? fs.readdirSync(d).map(f => path.join(d, f)) : []).sort()
  const before = names()
  for (let n = 0; n < 3; n++) {
    await expect(w.attachMain('keep this screenshot', files)).rejects.toMatchObject({ status: 429 })
    await expect(w.attach(t.id, 'keep this screenshot', files)).rejects.toMatchObject({ status: 429 })
  }
  expect(names()).toEqual(before)
  expect(files[0].data).toBe(Buffer.from('fixture').toString('base64'))
  expect(mux.spawnWv).not.toHaveBeenCalled()
})

it('waits for the real Codex turn to finish before returning main to Claude, preserving its pane', async () => {
  vi.stubEnv('WEEVILS_PROVIDER', 'codex')
  const r = fakeRelay({ executionTool: () => 'claude', retryAt: () => NOW + MIN })
  w.relay = r as never
  const cx = add(transcript({ id: 'cx-return', tool: 'codex', cwd: ORCH_DIR, phase: 'working', messages: [{ id: 'context', role: 'assistant', text: 'The existing GPU job is still running; monitor it.', at: NOW }] }))
  ;(w as any).directCodexBoss = { sessionId: cx.id, since: NOW - MIN }
  await expect(w.sendMain('continue monitoring')).rejects.toMatchObject({ status: 429 })
  expect(mux.spawnWv).not.toHaveBeenCalled()
  cx.phase = 'idle'
  await w.sendMain('continue monitoring')
  expect(mux.spawnWv).toHaveBeenCalledOnce()
  const command = (mux.spawnWv.mock.calls[0] as unknown[])[4] as string[]
  expect(command[0]).toBe('claude')
  expect(command.at(-1)).toContain('GPU job is still running')
  expect(mux.killWv).not.toHaveBeenCalled()
  expect(process.env.WEEVILS_PROVIDER).toBe('codex')
  const claudeId = w.orchestratorId!
  const claude = add(transcript({ id: claudeId, cwd: ORCH_DIR, phase: 'working', lastActivityAt: NOW + MIN, messages: [{ id: 'claude-progress', role: 'assistant', text: 'Monitored the existing pod without restarting it.', at: NOW + MIN }] }))
  ;(w as any).codexBridge = { activityOf: () => ({ type: 'idle', waiting: false, at: NOW + MIN }), settingsOf: () => undefined }
  expect(w.bossConversation()).toBe(claudeId)
  expect(w.snapshot().mainWorking).toBe(true)
  // When the preferred provider returns, reuse its existing owner with the other provider's progress attached.
  claude.phase = 'idle'; r.executionTool = () => 'codex'
  const send = vi.fn(async () => {})
  ;(w as any).codexBridge = { can: () => true, send }
  // Credentials are irrelevant to this already loaded, explicitly mocked owner.
  const auth = path.join(HOME, '.codex', 'auth.json'); fs.mkdirSync(path.dirname(auth), { recursive: true }); fs.writeFileSync(auth, JSON.stringify({ tokens: { access_token: 'fixture' } }))
  const bin = path.join(HOME, 'fixture-bin'); fs.mkdirSync(bin, { recursive: true }); fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexit 1\n', { mode: 0o700 }); vi.stubEnv('PATH', bin)
  await w.sendMain('next status')
  expect(send).toHaveBeenCalledOnce()
  const sent = (send.mock.calls[0] as unknown[])[1] as string
  expect(sent).toMatch(/^next status ⟦weevils — /)
  expect(sent).toContain('Monitored the existing pod without restarting it.')
  expect(mux.spawnWv).toHaveBeenCalledOnce()
})

describe('weevboss pendant la limite de Claude', () => {
  it('K1 répond par Codex : même dossier, AGENTS.md = ses consignes, contexte caché (fil récent, heure de retour) ; jamais claude', async () => {
    const r = fakeRelay()
    w.relay = r as never
    w.orchestratorId = 'boss'
    add(transcript({ id: 'boss', cwd: ORCH_DIR, messages: [{ id: 'b1', role: 'user', text: 'lance les tests du panier', at: NOW - 30 * MIN }, { id: 'b2', role: 'assistant', text: 'c’est lancé dans demo', at: NOW - 29 * MIN }] }))
    const res = await w.sendMain('où en sont mes sessions ?')
    expect(mux.spawnWv).toHaveBeenCalledTimes(1)
    const [name, dir, tool, title, command] = mux.spawnWv.mock.calls[0] as [string, string, Tool, string, string[]]
    expect([dir, tool, title]).toEqual([ORCH_DIR, 'codex', 'weevboss'])
    expect(command[0]).toBe('codex')
    // Agents ask for permission by default (WEEVILS_SAFE unset): no bypass flag.
    expect(command.join(' ')).not.toContain('--dangerously')
    expect(command.at(-1)).toMatch(/^où en sont mes sessions \? ⟦weevils — tu es weevboss, sur Codex pendant que Claude est indisponible \(limite d'usage atteinte jusqu'à 18 h\)/)
    expect(command.at(-1)).toContain('user: lance les tests du panier | you: c’est lancé dans demo')
    expect(command.join(' ')).not.toContain('claude')
    // weevboss keeps its own voice: never the project sessions' plain-voice rule.
    expect(command.join(' ')).not.toContain('developer_instructions')
    expect(res).toEqual({ id: name })
    expect(r.boss).toMatchObject({ pane: name })
    // Les consignes de l'orchestrateur, identiques pour les deux outils.
    expect(fs.readFileSync(path.join(ORCH_DIR, 'AGENTS.md'), 'utf8')).toBe(fs.readFileSync(path.join(ORCH_DIR, 'CLAUDE.md'), 'utf8'))
    expect(fs.readFileSync(path.join(ORCH_DIR, 'AGENTS.md'), 'utf8').length).toBeGreaterThan(200)
  })

  it('K2 le fil mêle Claude et Codex, sans le contexte caché ; au retour, Claude reçoit ce que Codex a dit et la pane de Codex reste intacte', async () => {
    const r = fakeRelay()
    w.relay = r as never
    w.orchestratorId = 'boss'
    add(transcript({ id: 'boss', cwd: ORCH_DIR, messages: [{ id: 'b1', role: 'user', text: 'bonjour', at: NOW - 30 * MIN }, { id: 'b2', role: 'assistant', text: 'salut', at: NOW - 29 * MIN }] }))
    add(transcript({ id: 'cx', tool: 'codex', cwd: ORCH_DIR, openedAt: NOW - 5 * MIN, messages: [{ id: 'c0', role: 'user', text: ' ⟦weevils — le dernier message est resté sans réponse⟧', at: NOW - 5 * MIN }, { id: 'c1', role: 'user', text: 'où en est demo ? ⟦weevils — tu es weevboss, sur Codex⟧', at: NOW - 4 * MIN }, { id: 'c2', role: 'assistant', text: 'demo : deux sessions arrêtées, plans prêts', at: NOW - 3 * MIN }] }))
    r.boss = { pane: 'wv-orchestrateur-abc', sessionId: 'cx', since: NOW - 5 * MIN }
    w.panes = [{ name: 'wv-orchestrateur-abc', tool: 'codex', sessionId: 'cx', title: 'weevboss', cwd: ORCH_DIR, createdAt: NOW - 5 * MIN }]
    expect(w.snapshot().main.map((m) => `${m.role}: ${m.text}`)).toEqual(['user: bonjour', 'assistant: salut', 'user: où en est demo ?', 'assistant: demo : deux sessions arrêtées, plans prêts'])
    expect(w.snapshot().mainHasScreen).toBe(true)
    // Ni la pane de weevboss sur Codex ni son transcript ne sont des sessions de projet.
    expect(w.sessions(NOW).map((s) => s.id)).toEqual([])
    // Claude revient.
    r.on = false
    r.back = NOW - 5 * MIN
    await w.sendMain('merci')
    expect(mux.killWv).not.toHaveBeenCalled()
    const command = (mux.spawnWv.mock.calls.at(-1) as unknown[])[4] as string[]
    expect(command.slice(0, 3)).toEqual(['claude', '--resume', 'boss'])
    expect(command.at(-1)).toMatch(/^merci ⟦weevils — /)
    expect(command.at(-1)).toContain('Codex a répondu à ta place')
    expect(command.at(-1)).toContain('user: où en est demo ? | codex: demo : deux sessions arrêtées, plans prêts')
    // Dit une fois.
    mux.spawnWv.mockClear()
    w.panes = []
    await w.sendMain('encore')
    expect(((mux.spawnWv.mock.calls.at(-1) as unknown[])[4] as string[]).at(-1)).toBe('encore')
  })

  it('K3 un seul bloc de contexte caché par message', () => {
    expect(joinContext('', '')).toBe('')
    expect(joinContext('', 'a')).toBe(' ⟦weevils — a⟧')
    expect(joinContext(' ⟦weevils — a⟧', 'b ⟧ c')).toBe(' ⟦weevils — a — b ] c⟧')
  })
})

describe('sessions liées par le relais', () => {
  it('K4 la session Codex porte le signe « relais » et le titre de la session Claude ; la coupure est annoncée par le relais seul', async () => {
    const r = fakeRelay({
      relayOf: (...ids: (string | undefined)[]) => (ids.includes('cx1') || ids.includes('wv-demo-xyz') ? 's1' : undefined),
      relayedBy: (id: string) => (id === 's1' ? 'cx1' : undefined),
      covers: (s: Session) => s.id === 's1',
    })
    w.relay = r as never
    add(transcript({ stopError: { at: NOW - MIN, reason: 'quota', text: "You've hit your session limit · resets 6pm" } }))
    add(transcript({ id: 'cx1', tool: 'codex', firstPrompt: '[from:weevboss] Tu prends le relais', messages: [{ id: 'x', role: 'orchestrator', text: 'Tu prends le relais', at: NOW - MIN }] }))
    const claudePane = { name: 'wv-demo-cl', tool: 'claude' as Tool, sessionId: 's1', title: 't', cwd, createdAt: NOW - 20 * MIN }
    w.panes = [claudePane, { name: 'wv-demo-xyz', tool: 'codex', sessionId: 'cx1', title: 't', cwd, createdAt: NOW - MIN }]
    expect(one('cx1')).toMatchObject({ relayOf: 's1', title: one('s1')!.title })
    expect(one('s1')).toMatchObject({ relayedBy: 'cx1', status: 'interrupted' })
    // Une pane Codex pas encore reliée à son transcript : déjà marquée.
    w.panes = [claudePane, { name: 'wv-demo-xyz', tool: 'codex', title: 't', cwd, createdAt: NOW - 1000 }]
    expect(w.sessions(NOW).find((s) => s.id === 'wv-demo-xyz')).toMatchObject({ relayOf: 's1' })
    const say = vi.fn()
    w.setup = { say, flags: () => undefined, messages: () => [] } as never
    ;(w as any).announceCuts()
    expect(say).not.toHaveBeenCalled()
    r.covers = () => false
    ;(w as any).announced.clear()
    ;(w as any).announceCuts()
    expect(say).toHaveBeenCalledTimes(1)
  })

  it('K5 le relais ouvre une session Codex dans le dossier exact de la session (pas la racine du repo)', async () => {
    const host = w.relayHost()
    const sub = path.join(cwd, 'packages', 'cart')
    fs.mkdirSync(sub, { recursive: true })
    const id = await host.openCodex(sub, 'refonte', '[from:weevboss] Tu prends le relais')
    expect(mux.spawnWv.mock.calls[0].slice(1, 5)).toEqual([sub, 'codex', 'refonte', ['codex', ...projectCodexFlags(), '[from:weevboss] Tu prends le relais']])
    expect(id).toBe(mux.spawnWv.mock.calls[0][0])
    expect(host.resolve(id)).toBe(id)
  })
})

it('keeps agent coordination out of main while retaining briefs in their recipient session', () => {
 w.orchestratorId = 'boss'
 const boss = add(transcript({id:'boss',cwd:ORCH_DIR,messages:[
  {id:'user',role:'user',text:'montre les directives',at:NOW-3000},
  {id:'bridge-return',role:'orchestrator',author:'codex',text:'rapport interne',at:NOW-2000},
  {id:'answer',role:'assistant',text:'voici le résultat utile',at:NOW-1000},
 ]}))
 const target = add(transcript({id:'target',tool:'codex',messages:[
  {id:'brief',role:'orchestrator',author:'weevboss',text:'corrige les titres',at:NOW-2000},
  {id:'response',role:'assistant',text:'je vérifie les titres',at:NOW-1000},
 ]}))
 expect(w.snapshot().main.map(m=>m.id)).toEqual(['user','answer'])
 expect(target.messages.map(m=>[m.id,m.role,m.author])).toEqual([
  ['brief','orchestrator','weevboss'],['response','assistant',undefined],
 ])
 expect(boss.messages.some(m=>m.id==='bridge-return')).toBe(true)
})

it('explicit Codex choice starts a real boss without a quota episode and retains its registration', async () => {
 vi.stubEnv('WEEVILS_PROVIDER','codex')
 const bin=path.join(HOME,'.local','bin');fs.mkdirSync(bin,{recursive:true});fs.writeFileSync(path.join(bin,'codex'),'#!/bin/sh\nexit 0\n',{mode:0o700})
 const auth=path.join(HOME,'.codex','auth.json');fs.mkdirSync(path.dirname(auth),{recursive:true});fs.writeFileSync(auth,JSON.stringify({tokens:{access_token:'fixture'}}))
 try {
  await w.sendMain('bonjour Codex')
  expect(mux.spawnWv).toHaveBeenCalledTimes(1)
  const [name,dir,tool,,command]=mux.spawnWv.mock.calls[0] as [string,string,Tool,string,string[]]
  expect([dir,tool,command[0]]).toEqual([ORCH_DIR,'codex','codex'])
  expect(command.at(-1)).not.toContain('limite')
  const persisted=JSON.parse(fs.readFileSync(path.join(DATA_DIR,'state.json'),'utf8'))
  expect(persisted.directCodexBoss.pane).toBe(name)
  const second=new Weevils()
  second.panes=[{name,tool:'codex',sessionId:'direct',cwd:ORCH_DIR,title:'weevboss',createdAt:NOW}]
  const t=transcript({id:'direct',tool:'codex',cwd:ORCH_DIR})
  second.store.byFile.set(t.file,t)
  mux.sendText.mockImplementation(async()=>{t.messages.push({id:'new',role:'user',text:'encore',at:Date.now()})})
  const sent=second.sendMain('encore');await vi.advanceTimersByTimeAsync(15000);await sent
  expect(mux.spawnWv).toHaveBeenCalledTimes(1)
 } finally {vi.unstubAllEnvs()}
})
it('uses one existing daemon writer even when several terminal clients show the same boss thread', async () => {
 const r = fakeRelay({boss:{pane:'wv-orchestrateur-a',sessionId:'cx',since:NOW-MIN}})
 w.relay = r as never
 add(transcript({id:'cx',tool:'codex',cwd:ORCH_DIR,originator:'codex-tui',delegationSources:new Map([['brief','boss']])}))
 w.panes = ['a','b'].map(suffix=>({name:`wv-orchestrateur-${suffix}`,tool:'codex',sessionId:'cx',title:'weevboss',cwd:ORCH_DIR,createdAt:NOW-MIN}))
 const send = vi.fn(async () => {})
 ;(w as any).codexBridge = {can:(id:string)=>id==='cx',send}
 expect(w.bossConversation()).toBe('cx')
 await Promise.all([w.sendMain('premier'),w.sendMain('second')])
 expect(send.mock.calls.map((c:any)=>c[0])).toEqual(['cx','cx'])
 expect(mux.sendText).not.toHaveBeenCalled()
 expect(mux.spawnWv).not.toHaveBeenCalled()
 expect(mux.killWv).not.toHaveBeenCalled()
})
it('does not spawn a competing boss client when an existing bridge thread is temporarily disconnected', async () => {
 w.relay = fakeRelay({boss:{sessionId:'cx',since:NOW-MIN}}) as never
 add(transcript({id:'cx',tool:'codex',cwd:ORCH_DIR,originator:'codex-tui',delegationSources:new Map([['brief','boss']])}))
 ;(w as any).codexBridge = {can:()=>false}
 await expect(w.sendMain('réponse')).rejects.toThrow()
 expect(mux.spawnWv).not.toHaveBeenCalled()
})

it('keeps the persisted owner when a terminal name now points at another thread', async () => {
 const r = fakeRelay({boss:{pane:'wv-orchestrateur-old',sessionId:'owner',since:NOW-MIN}})
 w.relay = r as never
 add(transcript({id:'owner',tool:'codex',cwd:ORCH_DIR}))
 w.panes = [{name:'wv-orchestrateur-old',tool:'codex',sessionId:'unrelated',title:'other',cwd:ORCH_DIR,createdAt:NOW}]
 const send = vi.fn(async () => {})
 ;(w as any).codexBridge = {can:(id:string)=>id==='owner',send}
 expect(w.bossConversation()).toBe('owner')
 await w.sendMain('continue ici')
 expect((send.mock.calls[0] as unknown[])[0]).toBe('owner')
 expect(r.boss.sessionId).toBe('owner')
 expect(mux.spawnWv).not.toHaveBeenCalled()
 expect(mux.sendText).not.toHaveBeenCalled()
})

it('carries the explicit app locale into a session without treating French chat as its preference',async()=>{
 const t=add(transcript({id:'locale-target',tool:'codex',firstPrompt:undefined,messages:[{id:'e0',role:'event',text:'session started',at:NOW-MIN}]}))
 const delivered:string[]=[]
 ;(w as any).codexBridge={can:()=>true,activityOf:()=>({type:'idle',waiting:false,at:Date.now()}),send:async(_id:string,text:string)=>{delivered.push(text)}}
 await withLang('en',()=>w.send(t.id,'Bonjour, corrige cette image.'))
 expect(delivered[0]).toContain('Bonjour, corrige cette image.')
 expect(delivered[0]).toContain('Explicit app locale: English (en)')
 expect(delivered[0]).toContain('Chat replies may follow')
 expect(delivered[0]).toMatch(/⟦weevils[^⟧]+⟧$/)
 // First brief only: once the session has a message, and never on a slash command.
 t.messages.push({id:'u1',role:'user',text:delivered[0],at:Date.now()})
 await withLang('en',()=>w.send(t.id,'Encore une chose.'))
 await withLang('en',()=>w.send(t.id,'/compact'))
 expect(delivered.slice(1)).toEqual(['Encore une chose.','/compact'])
})

it('a device locale cannot rewrite the shared orchestrator template in another language',()=>{
 setLang('en',true)
 withLang('fr',()=> (w as any).prepareOrchestrator())
 const template=fs.readFileSync(path.join(import.meta.dirname,'orchestrator.en.md'),'utf8').split('{{user}}')[0]
 expect(fs.readFileSync(path.join(ORCH_DIR,'AGENTS.md'),'utf8').startsWith(template)).toBe(true)
 setLang('fr',true)
})

it('intercepts bare model controls at normal session send and command entrypoints without typing into a pane', async()=>{
 add(transcript({id:'model-target',tool:'codex'}))
 mux.sendText.mockClear();mux.sendKey.mockClear()
 expect(await w.send('model-target','/model')).toMatchObject({control:'model'})
 expect(await w.command('model-target','/effort')).toMatchObject({control:'model'})
 expect(mux.sendText).not.toHaveBeenCalled()
 expect(mux.sendKey).not.toHaveBeenCalled()
})

it('ships the same product contract to both agents in a fresh profile without importing private memory',()=>{
 fs.rmSync(ORCH_DIR,{recursive:true,force:true})
 const privateDir=path.join(HOME,'.claude','projects','private','memory')
 fs.mkdirSync(privateDir,{recursive:true});fs.writeFileSync(path.join(privateDir,'MEMORY.md'),'PRIVATE_MEMORY_SENTINEL')
 for(const language of ['en','fr'] as const){
  setLang(language,true)
  ;(w as any).prepareOrchestrator()
  const claude=fs.readFileSync(path.join(ORCH_DIR,'CLAUDE.md'),'utf8')
  const codex=fs.readFileSync(path.join(ORCH_DIR,'AGENTS.md'),'utf8')
  expect(codex).toBe(claude)
  expect(codex).toContain(MachineProse[language].rule)
  expect(codex).toContain(AgentMessages[language].rule)
  expect(codex).toContain(AgentMessages[language].automation)
  expect(codex).not.toContain('{{machineProse}}')
  expect(codex).toContain(language==='en'?'Shared product contract':'Contrat produit partagé')
  expect(codex).not.toContain('PRIVATE_MEMORY_SENTINEL')
  expect(codex).not.toMatch(/Yann|scarville\.tech/)
 }
 expect(mux.spawnWv).not.toHaveBeenCalled()
})

it('rechecks a stale boss capability before refusing a real loaded owner, preserving one writer',async()=>{
 w.relay=fakeRelay({boss:{sessionId:'cx',since:NOW-MIN}}) as never
 add(transcript({id:'cx',tool:'codex',cwd:ORCH_DIR,originator:'codex-tui',delegationSources:new Map([['brief','boss']])}))
 const send=vi.fn(async(_id:string,_text:string)=>{}),reachable=vi.fn(async()=>true)
 ;(w as any).codexBridge={can:()=>false,reachable,send}
 await w.sendMain('existing pending request')
 expect(reachable).toHaveBeenCalledWith('cx');expect(send).toHaveBeenCalledOnce()
 expect(send.mock.calls[0][0]).toBe('cx')
 expect(mux.spawnWv).not.toHaveBeenCalled();expect(mux.sendText).not.toHaveBeenCalled()
})
it('never falls back to a pane or another writer after a daemon send became uncertain',async()=>{
 w.relay=fakeRelay({boss:{pane:'wv-owner',sessionId:'cx',since:NOW-MIN}}) as never
 add(transcript({id:'cx',tool:'codex',cwd:ORCH_DIR,originator:'codex-tui'}))
 w.panes=[{name:'wv-owner',tool:'codex',sessionId:'cx',title:'weevboss',cwd:ORCH_DIR,createdAt:NOW-MIN}]
 ;(w as any).codexBridge={can:()=>false,reachable:async()=>true,send:async()=>{throw new Error('uncertain')}}
 await expect(w.sendMain('same request')).rejects.toThrow('uncertain')
 expect(mux.spawnWv).not.toHaveBeenCalled();expect(mux.sendText).not.toHaveBeenCalled()
})
