// Cycle de vie d'une session : statut (working / needs_user / idle / done), session en démarrage, lancement et
// reprise (argv passé à tmux), fermeture, ménage des panes inactives, liaison des panes Codex, relecture du registre
// tmux et notifications push aux changements d'état. tmux est simulé ; les minuteries sont factices.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session, Subagent, Tool } from '../shared/api.ts'

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
// The question judge (Haiku) is replaced: a candidate question is confirmed as is, after a tick.
vi.mock('./asks-judge.ts', () => ({ judgeAsk: async (i: { said: string }) => i.said }))
/** Lets the (mocked) question judge answer: the first read asks it, the next one shows its verdict. */
const judged = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}
vi.mock('./titles.ts', async (orig) => ({ ...(await orig<typeof import('./titles.ts')>()), llmTitles: async () => [] }))

const { Weevils } = await import('./core.ts')
const { DATA_DIR, HOME } = await import('./config.ts')
const { tr } = await import('./i18n.ts')
const CO = (await import('./i18n/core.ts')).default
const P = (await import('./i18n/push.ts')).default
const TipsM = (await import('./i18n/tips.ts')).default
const { projectClaude, projectCodexFlags } = await import('./agent-launch.ts')
type Transcript = import('./transcripts.ts').Transcript

const NOW = Date.parse('2026-11-09T12:00:00Z')
const MIN = 60_000
const PANE = 'wv-demo-abc123'
const cwd = path.join(HOME, 'projects', 'demo')
fs.mkdirSync(cwd, { recursive: true })
const ALIVE = process.pid
const DEAD = spawnSync('true').pid
/** A project session's commands: the bare one plus the plain-voice rule (server/agent-launch.ts). */
const CLAUDE = projectClaude()
const CODEX = projectCodexFlags()
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

let w: InstanceType<typeof Weevils>

function transcript(over: Partial<Transcript> = {}): Transcript {
  const id = over.id ?? 's1'
  return {
    id,
    tool: 'claude',
    file: `/nowhere/${id}.jsonl`,
    cwd,
    openedAt: NOW - 2 * MIN,
    lastActivityAt: NOW - MIN,
    workStartedAt: null,
    phase: 'idle',
    firstPrompt: 'earlier',
    messages: [{ id: `${id}-m0`, role: 'user', text: 'earlier', at: NOW - MIN }],
    subagents: [],
    offset: 0,
    partial: '',
    queued: [],
    ...over,
  }
}
const add = (t: Transcript) => (w.store.byFile.set(t.file, t), t)
const pane = (over: Partial<(typeof w.panes)[number]> = {}) => ({ name: PANE, tool: 'claude' as Tool, sessionId: 's1', title: 't', cwd, createdAt: NOW - MIN, ...over })
/** Statut vu par l'app : relu à chaque appel (sessions() ne passe pas par le snapshot mémorisé). */
const one = (id = 's1'): Session | undefined => w.sessions(Date.now()).find((s) => s.id === id)

beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
  for (const f of Object.values(mux)) f.mockReset()
  mux.capture.mockResolvedValue('')
  mux.listWv.mockResolvedValue([])
  // Rien ne passe d'un test à l'autre par state.json (hooks, titres) ni ~/.claude.json.
  fs.rmSync(path.join(DATA_DIR, 'state.json'), { force: true })
  w = new Weevils()
  fs.rmSync(path.join(HOME, '.claude.json'), { force: true })
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('statut', () => {
  it('L1 pane lancée sans transcript : « démarrage… », puis terminée après 30 min ; un dialogue → à toi', () => {
    w.panes = [pane({ sessionId: 'p1', createdAt: NOW - 10_000 })]
    expect(one('p1')).toMatchObject({ status: 'working', lastMessage: tr(CO).starting, controllable: true, live: true, hasScreen: true, origin: 'weevils' })
    w.panes = [pane({ sessionId: undefined, createdAt: NOW - 31 * MIN })]
    expect(one(PANE)).toMatchObject({ status: 'done', lastMessage: undefined })
    w.panes = [pane({ sessionId: 'p1', screenAttention: 'Do you want to proceed?' })]
    expect(one('p1')).toMatchObject({ status: 'needs_user', attention: 'Do you want to proceed?' })
  })

  it('L2 hooks reçus : UserPromptSubmit → working ; Stop → idle ; permission → needs_user ; « waiting for your input » → pas needs_user', () => {
    add(transcript())
    w.panes = [pane()]
    w.hooks.set('s1', { event: 'SessionStart', at: NOW - MIN, pid: ALIVE })
    // Sans pidHeader, le pid connu est gardé.
    w.hook({ session_id: 's1', hook_event_name: 'UserPromptSubmit' })
    expect(w.hooks.get('s1')).toMatchObject({ event: 'UserPromptSubmit', at: NOW, pid: ALIVE })
    expect(one()).toMatchObject({ status: 'working', workStartedAt: NOW - MIN })
    w.hook({ session_id: 's1', hook_event_name: 'Stop' })
    expect(one()?.status).toBe('idle')
    w.hook({ session_id: 's1', hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' })
    expect(one()).toMatchObject({ status: 'needs_user', attention: 'Claude needs your permission to use Bash' })
    w.hook({ session_id: 's1', hook_event_name: 'Notification', message: 'Claude is waiting for your input' })
    expect(one()?.status).toBe('idle')
  })

  it('L2b un hook plus vieux que la dernière activité ne compte plus', () => {
    add(transcript({ phase: 'working', lastActivityAt: NOW - MIN }))
    w.panes = [pane()]
    w.hooks.set('s1', { event: 'Stop', at: NOW - 5 * MIN, pid: ALIVE })
    expect(one()?.status).toBe('working')
  })

  it('L3 SessionEnd → terminée', () => {
    add(transcript())
    w.panes = [pane()]
    w.hooks.set('s1', { event: 'SessionEnd', at: NOW, pid: ALIVE })
    expect(one()?.status).toBe('done')
  })

  it('L4 pane inactive depuis plus de 30 min → terminée ; l’orchestrateur n’est pas une session de projet', () => {
    add(transcript({ lastActivityAt: NOW - 31 * MIN }))
    w.panes = [pane()]
    expect(one()).toMatchObject({ status: 'done', live: true, controllable: true })
    const orch = path.join(DATA_DIR, 'orchestrateur')
    add(transcript({ id: 'boss', cwd: orch }))
    w.panes.push(pane({ name: 'wv-orchestrateur-000000', sessionId: 'boss', cwd: orch }))
    w.panes.push(pane({ name: 'wv-orchestrateur-111111', sessionId: undefined, cwd: orch }))
    expect(w.sessions(NOW).map((s) => s.id)).toEqual(['s1'])
  })

  it('L4b a conversation brought from another computer (server/bring.ts): listed from its arrival, finished, ready to resume', () => {
    add(transcript({ lastActivityAt: NOW - 40 * 24 * 60 * MIN }))
    expect(one()).toBeUndefined()
    w.store.broughtAt = (id) => (id === 's1' ? NOW - MIN : undefined)
    expect(one()).toMatchObject({ status: 'done', live: false, controllable: true, lastActivityAt: NOW - 40 * 24 * 60 * MIN })
    w.store.broughtAt = undefined
  })

  it('L5 ouverte dans un terminal que weevils ne pilote pas (processus vivant, pas de pane) : cachée', () => {
    add(transcript())
    w.hooks.set('s1', { event: 'Stop', at: NOW, pid: ALIVE })
    expect(one()).toBeUndefined()
    // Son processus est mort : terminée, visible, reprenable.
    w.hooks.set('s1', { event: 'Stop', at: NOW, pid: DEAD })
    expect(one()).toMatchObject({ status: 'done', live: false, controllable: true })
  })

  it('L6 sans hook : la phase lue dans le transcript, bornée dans le temps ; plus de processus en plein tour → coupée', () => {
    const t = add(transcript({ phase: 'working', lastActivityAt: NOW - 5 * MIN }))
    w.panes = [pane()]
    expect(one()?.status).toBe('working')
    t.lastActivityAt = NOW - 11 * MIN
    expect(one()?.status).toBe('idle')
    w.panes = []
    t.lastActivityAt = NOW - 31 * MIN
    expect(one()).toMatchObject({ status: 'interrupted', live: false, interrupted: { at: NOW - 31 * MIN, reason: 'died' } })
    t.phase = 'idle'
    expect(one()).toMatchObject({ status: 'done', live: false })
    expect(one()?.interrupted).toBeUndefined()
  })

  it('L7 la file d’attente ne compte que pendant le travail', () => {
    const t = add(transcript({ phase: 'working', queued: [{ key: 'next', at: NOW }] }))
    w.panes = [pane()]
    expect(one()?.queued).toBe(1)
    t.phase = 'idle'
    expect(one()?.queued).toBe(0)
  })
})

describe('lancement et reprise', () => {
  it('L8 claude : identifiant choisi d’avance (--session-id), dossier marqué de confiance', async () => {
    const r = await w.create({ projectId: 'demo', tool: 'claude', text: 'fix x' })
    expect(r.id).toMatch(UUID)
    expect(mux.spawnWv).toHaveBeenCalledTimes(1)
    const [name, dir, tool, title, command, sessionId] = mux.spawnWv.mock.calls[0]
    expect(name).toMatch(/^wv-demo-[0-9a-f]{6}$/)
    expect([dir, tool, title, command, sessionId]).toEqual([cwd, 'claude', 'fix x', [...CLAUDE, '--session-id', r.id, 'fix x'], r.id])
    const trusted = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8'))
    expect(trusted.projects[cwd].hasTrustDialogAccepted).toBe(true)
    // La pane apparaît aussitôt, en démarrage.
    expect(one(r.id)).toMatchObject({ status: 'working', lastMessage: tr(CO).starting })
  })

  it('L8b codex : l’id est le nom de la pane ; texte vide → « nouvelle session », sans argument', async () => {
    const r = await w.create({ projectId: 'demo', tool: 'codex', text: '  ' })
    const [name, , tool, title, command, sessionId] = mux.spawnWv.mock.calls[0]
    expect(r.id).toBe(name)
    expect([tool, title, command, sessionId]).toEqual(['codex', tr(CO).newSession, ['codex', ...CODEX], undefined])
  })

  it('L8c signé par weevboss ; dossier absent → erreur, rien lancé', async () => {
    await w.create({ projectId: 'demo', tool: 'claude', text: 'fix x', from: 'weevboss' })
    expect((mux.spawnWv.mock.calls[0][4] as string[]).at(-1)).toBe('[from:weevboss] fix x')
    mux.spawnWv.mockClear()
    await expect(w.create({ projectId: 'ghost', repo: 'ghost', tool: 'claude', text: 'x' })).rejects.toThrow(tr(CO).dirNotFound(path.join(HOME, 'projects', 'ghost')))
    expect(mux.spawnWv).not.toHaveBeenCalled()
  })

  it('L9 écrire à une session sans processus la reprend (--resume), dans son dossier ou dans HOME s’il a disparu', async () => {
    const t = add(transcript({ lastActivityAt: NOW - 40 * MIN }))
    expect(one()?.status).toBe('done')
    expect(await w.send('s1', 'again')).toEqual({ id: 's1' })
    expect(mux.spawnWv.mock.calls[0].slice(1)).toEqual([cwd, 'claude', 'earlier', [...CLAUDE, '--resume', 's1', 'again'], 's1'])
    expect(mux.sendText).not.toHaveBeenCalled()

    w = new Weevils()
    mux.spawnWv.mockClear()
    add({ ...t, tool: 'codex', cwd: path.join(HOME, 'gone') })
    await w.send('s1', 'again')
    expect(mux.spawnWv.mock.calls[0].slice(1)).toEqual([HOME, 'codex', 'earlier', ['codex', 'resume', ...CODEX, 's1', 'again'], 's1'])
  })

  it('L9b la pane relancée remplace la reprise : le message suivant est tapé dedans', async () => {
    add(transcript({ lastActivityAt: NOW - 40 * MIN }))
    await w.send('s1', 'again')
    expect(w.panes).toHaveLength(1)
    expect(w.panes[0]).toMatchObject({ sessionId: 's1', cwd })
    expect(one()?.hasScreen).toBe(true)
  })
})

describe('fermeture et ménage', () => {
  it('L10 fermer : la pane est tuée, la session devient terminée', async () => {
    add(transcript())
    w.panes = [pane()]
    w.hooks.set('s1', { event: 'Stop', at: NOW, pid: DEAD })
    expect(one()?.status).toBe('idle')
    expect(await w.close('s1')).toEqual({ ok: true })
    expect(mux.killWv.mock.calls).toEqual([[PANE]])
    expect(w.panes).toEqual([])
    expect(one()).toMatchObject({ status: 'done', hasScreen: false })
  })

  it('L10b l’orchestrateur, une session sans pane : refusé ; une autre machine : relayé', async () => {
    w.panes = [pane({ name: 'wv-orchestrateur-000000', sessionId: 'boss', cwd: path.join(DATA_DIR, 'orchestrateur') })]
    await expect(w.close('boss')).rejects.toThrow(tr(TipsM).notClosable)
    await expect(w.close('s1')).rejects.toThrow(tr(TipsM).notClosable)
    expect(mux.killWv).not.toHaveBeenCalled()
    const call = vi.fn(async () => ({ ok: true }))
    w.remotes = [{ has: (id: string) => id === 'r1', call } as any]
    await w.close('r1')
    expect(call).toHaveBeenCalledWith('POST', '/api/sessions/r1/close', {})
  })

  it('L11 ménage : une pane sans activité depuis plus de 2 h est fermée, pas une récente ni l’orchestrateur', async () => {
    add(transcript({ lastActivityAt: NOW - 121 * MIN }))
    add(transcript({ id: 's2', phase: 'working', lastActivityAt: NOW - 5 * MIN }))
    w.panes = [
      pane({ createdAt: NOW - 130 * MIN }),
      pane({ name: 'wv-demo-222222', sessionId: 's2', createdAt: NOW - 130 * MIN }),
      pane({ name: 'wv-orchestrateur-000000', sessionId: undefined, cwd: path.join(DATA_DIR, 'orchestrateur'), createdAt: NOW - 600 * MIN }),
    ]
    await (w as any).reapPanes()
    expect(mux.killWv.mock.calls).toEqual([[PANE]])
  })

  it('L11b un hook récent compte comme de l’activité', async () => {
    add(transcript({ lastActivityAt: NOW - 121 * MIN }))
    w.panes = [pane({ createdAt: NOW - 130 * MIN })]
    w.hooks.set('s1', { event: 'PostToolUse', at: NOW - 10 * MIN })
    await (w as any).reapPanes()
    expect(mux.killWv).not.toHaveBeenCalled()
  })
})

describe('registre tmux', () => {
  it('L12 deux panes codex dans le même dossier : chacune reliée à son transcript, la plus ancienne d’abord', () => {
    w.panes = [pane({ name: 'wv-demo-aaaaaa', tool: 'codex', sessionId: undefined, createdAt: NOW - 60_000 }), pane({ name: 'wv-demo-bbbbbb', tool: 'codex', sessionId: undefined, createdAt: NOW - 50_000 })]
    add(transcript({ id: 'c2', tool: 'codex', openedAt: NOW - 45_000 }))
    add(transcript({ id: 'c1', tool: 'codex', openedAt: NOW - 55_000 }))
    // Trop ancien (ouvert avant la pane) et d'un autre dossier : jamais reliés.
    add(transcript({ id: 'old', tool: 'codex', openedAt: NOW - 10 * MIN }))
    add(transcript({ id: 'else', tool: 'codex', cwd: HOME, openedAt: NOW - 40_000 }))
    ;(w as any).linkCodexPanes()
    expect(w.panes.map((p) => p.sessionId)).toEqual(['c1', 'c2'])
    expect(mux.setOpt.mock.calls).toEqual([
      ['wv-demo-aaaaaa', '@wv_session_id', 'c1'],
      ['wv-demo-bbbbbb', '@wv_session_id', 'c2'],
    ])
    expect(w.detail('wv-demo-aaaaaa')?.session.id).toBe('c1')
  })

  it('L13 relecture : id gardé si tmux ne l’a pas encore, dialogue lu à l’écran, pane disparue retirée', async () => {
    w.panes = [pane(), pane({ name: 'wv-gone-000000', sessionId: 'gone' })]
    mux.listWv.mockResolvedValue([pane({ sessionId: undefined })])
    mux.capture.mockResolvedValue(['  Do you want to make this edit?', '  ❯ 1. Yes', '    2. No', '  Esc to cancel · Enter to confirm'].join('\n'))
    await (w as any).watchPanes()
    expect(w.panes).toHaveLength(1)
    expect(w.panes[0]).toMatchObject({ name: PANE, sessionId: 's1', screenAttention: 'Do you want to make this edit?' })
    mux.capture.mockResolvedValue('› ')
    await (w as any).watchPanes()
    expect(w.panes[0].screenAttention).toBeUndefined()
  })
})

describe('notifications', () => {
  const send = vi.fn(async (_p: unknown) => {})
  const settle = () => vi.advanceTimersByTimeAsync(250)
  beforeEach(() => {
    send.mockClear()
    w.push = { enabled: true, send } as any
    add(transcript())
    w.panes = [pane()]
    w.hooks.set('s1', { event: 'Stop', at: NOW - MIN, pid: ALIVE })
  })

  it('premier relevé muet ; « à toi » une fois ; pas deux fois en moins d’une minute', async () => {
    w.bump()
    await settle()
    expect(send).not.toHaveBeenCalled()
    w.hook({ session_id: 's1', hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' })
    await settle()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ title: `${tr(P).waitingTitle('demo')} · earlier`, category: 'question', body: 'Claude needs your permission to use Bash', url: '/#s=s1', tag: 's1' }))
    w.hook({ session_id: 's1', hook_event_name: 'Stop' })
    await settle()
    w.hook({ session_id: 's1', hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' })
    await settle()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('travail de plus de 15 s terminé : « a fini », avec la dernière réponse', async () => {
    const t = w.store.get('s1')!
    w.hook({ session_id: 's1', hook_event_name: 'UserPromptSubmit' })
    await settle()
    expect(one()?.status).toBe('working')
    await vi.advanceTimersByTimeAsync(20_000)
    t.messages.push({ id: 'a1', role: 'assistant', text: 'All three buttons are in.', at: Date.now() })
    t.lastActivityAt = Date.now()
    w.hook({ session_id: 's1', hook_event_name: 'Stop' })
    await settle()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ title: `${tr(P).doneTitle('demo')} · earlier`, category: 'result', body: 'All three buttons are in.' }))
  })

  it('un tour qui finit sur une question : notification « à toi » avec la question, même si des sous-agents tournent', async () => {
    w.bump()
    await settle()
    const t = w.store.get('s1')!
    w.hook({ session_id: 's1', hook_event_name: 'UserPromptSubmit' })
    await settle()
    t.messages.push({ id: 'q', role: 'assistant', text: 'Le pod est prêt. Ouvre ce lien pour valider la facturation : https://www.runpod.io/console/billing', at: Date.now() })
    t.subagents = [{ id: 'b1', kind: 'agent', label: 'search', activity: 'WebSearch', status: 'working', startedAt: Date.now() }]
    t.lastActivityAt = Date.now()
    w.hook({ session_id: 's1', hook_event_name: 'Stop' })
    await settle()
    await settle()
    expect(one()).toMatchObject({ status: 'needs_user', ask: { kind: 'link', url: 'https://www.runpod.io/console/billing' } })
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ title: `${tr(P).waitingTitle('demo')} · earlier`, category: 'question', body: 'Ouvre ce lien pour valider la facturation : https://www.runpod.io/console/billing', url: '/#s=s1' }))
  })

  it('un tour court (moins de 15 s) ne notifie pas', async () => {
    w.hook({ session_id: 's1', hook_event_name: 'UserPromptSubmit' })
    await settle()
    w.hook({ session_id: 's1', hook_event_name: 'Stop' })
    await settle()
    expect(send).not.toHaveBeenCalled()
  })
})

describe('arrière-plan (sous-agents, workflow, commandes)', () => {
  const sub = (over: Partial<Subagent> = {}): Subagent => ({ id: 'a1', kind: 'step', label: 'build:page', activity: 'Bash · npm test', workflow: 'wf', phase: 'Build', status: 'working', startedAt: NOW - 40 * MIN, ...over })

  it('L14 tour fini mais un sous-agent tourne : working, jamais terminée après 30 min ; workStartedAt = début de l’arrière-plan ; pas de file', () => {
    add(transcript({ lastActivityAt: NOW - 45 * MIN, queued: [{ key: 'old', at: NOW - 46 * MIN }], subagents: [sub(), sub({ id: 'a2', status: 'done', endedAt: NOW - 30 * MIN })] }))
    w.panes = [pane({ createdAt: NOW - 50 * MIN })]
    w.hooks.set('s1', { event: 'Stop', at: NOW - 45 * MIN, pid: ALIVE })
    expect(one()).toMatchObject({ status: 'working', background: 1, workStartedAt: NOW - 40 * MIN, queued: 0, live: true })
    // Fini : retour à la règle des 30 min.
    w.store.get('s1')!.subagents = [sub({ status: 'done', endedAt: NOW - MIN })]
    expect(one()).toMatchObject({ status: 'done', background: 0, workStartedAt: null })
  })

  it('L15 processus mort (pid mort, plus de pane) : tout passe « stopped », background 0, coupée (jamais « terminée ») ; /exit : terminée', () => {
    add(transcript({ lastActivityAt: NOW - 5 * MIN, subagents: [sub(), sub({ id: 'a2', status: 'done', endedAt: NOW - 30 * MIN })] }))
    w.hooks.set('s1', { event: 'Stop', at: NOW - 5 * MIN, pid: DEAD })
    const s = one()!
    expect(s).toMatchObject({ status: 'interrupted', interrupted: { reason: 'died' }, background: 0, live: false })
    expect(s.subagents.map((x) => [x.id, x.status])).toEqual([
      ['a1', 'stopped'],
      ['a2', 'done'],
    ])
    expect(s.subagents[0].endedAt).toBe(NOW - 5 * MIN)
    w.panes = [pane()]
    w.hooks.set('s1', { event: 'SessionEnd', at: NOW - MIN, pid: ALIVE, reason: 'prompt_input_exit' })
    expect(one()).toMatchObject({ status: 'done', background: 0 })
  })

  it('L16 une question à l’écran reste « à toi », même avec un arrière-plan', () => {
    add(transcript({ subagents: [sub()] }))
    w.panes = [pane({ screenAttention: 'Do you want to proceed?' })]
    expect(one()).toMatchObject({ status: 'needs_user', background: 1 })
  })

  it('L16b TLO : le tour finit sur une demande (valider RunPod, coller une adresse) avec 6 agents en arrière-plan → « à toi », action « coller », pas « travaille » ; une réponse de l’utilisateur lève l’attente', async () => {
    const ask = 'J’ai lancé six agents sur la recherche.\n\nValide la facturation RunPod, puis colle-moi l’adresse du pod ici.'
    add(transcript({ lastActivityAt: NOW - 40 * MIN, messages: [{ id: 'u', role: 'user', text: 'go', at: NOW - 50 * MIN }, { id: 'a', role: 'assistant', text: ask, at: NOW - 40 * MIN }], subagents: Array.from({ length: 6 }, (_, i) => sub({ id: `a${i}` })) }))
    w.panes = [pane({ createdAt: NOW - 60 * MIN })]
    w.hooks.set('s1', { event: 'Stop', at: NOW - 40 * MIN, pid: ALIVE })
    expect(one()).not.toMatchObject({ status: 'needs_user' })
    await judged()
    expect(one()).toMatchObject({ status: 'needs_user', background: 6, attention: 'Valide la facturation RunPod, puis colle-moi l’adresse du pod ici.', ask: { kind: 'paste' } })
    // Scarville répond : l'agent reprend, plus d'attente.
    const t = w.store.get('s1')!
    t.messages.push({ id: 'u2', role: 'user', text: 'https://pod.example', at: NOW })
    t.lastActivityAt = NOW
    w.hooks.set('s1', { event: 'UserPromptSubmit', at: NOW, pid: ALIVE })
    expect(one()).toMatchObject({ status: 'working' })
    expect(one()?.ask).toBeUndefined()
  })

  it('L16c un compte rendu sans demande, arrière-plan en cours : « travaille » comme avant', () => {
    add(transcript({ messages: [{ id: 'a', role: 'assistant', text: 'Lancé : six agents cherchent, je fais la synthèse quand ils ont fini.', at: NOW - MIN }], subagents: [sub()] }))
    w.panes = [pane()]
    w.hooks.set('s1', { event: 'Stop', at: NOW - MIN, pid: ALIVE })
    expect(one()).toMatchObject({ status: 'working' })
  })

  it('L17 ménage : une pane sans activité depuis 2 h mais avec un arrière-plan qui tourne n’est pas fermée', async () => {
    const t = add(transcript({ lastActivityAt: NOW - 180 * MIN, subagents: [sub({ startedAt: NOW - 170 * MIN })] }))
    w.panes = [pane({ createdAt: NOW - 200 * MIN })]
    w.hooks.set('s1', { event: 'Stop', at: NOW - 180 * MIN, pid: ALIVE })
    await (w as any).reapPanes()
    expect(mux.killWv).not.toHaveBeenCalled()
    t.subagents = [sub({ status: 'done', endedAt: NOW - 150 * MIN })]
    await (w as any).reapPanes()
    expect(mux.killWv.mock.calls).toEqual([[PANE]])
  })

  it('L18 « a fini » n’arrive qu’à la fin de l’arrière-plan, pas à la fin du tour', async () => {
    const send = vi.fn(async (_p: unknown) => {})
    w.push = { enabled: true, send } as any
    const t = add(transcript())
    w.panes = [pane()]
    w.hooks.set('s1', { event: 'Stop', at: NOW - MIN, pid: ALIVE })
    w.bump()
    await vi.advanceTimersByTimeAsync(250)
    w.hook({ session_id: 's1', hook_event_name: 'UserPromptSubmit' })
    await vi.advanceTimersByTimeAsync(20_000)
    t.subagents = [sub({ startedAt: Date.now() - 5000 })]
    t.messages.push({ id: 'a1', role: 'assistant', text: 'Workflow launched.', at: Date.now() })
    t.lastActivityAt = Date.now()
    w.hook({ session_id: 's1', hook_event_name: 'Stop' })
    await vi.advanceTimersByTimeAsync(250)
    expect(one()?.status).toBe('working')
    expect(send).not.toHaveBeenCalled()
    t.subagents = [sub({ status: 'done', endedAt: Date.now() })]
    t.messages.push({ id: 'result', role: 'assistant', text: 'The generated video is ready.', at: Date.now() })
    t.lastActivityAt = Date.now()
    w.bump()
    await vi.advanceTimersByTimeAsync(250)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ title: `${tr(P).doneTitle('demo')} · earlier`, category: 'result', body: 'The generated video is ready.' }))
  })

  it('L20 pont e-mail : la réponse part dès la fin du tour principal, sans attendre l’arrière-plan qu’il a lancé', async () => {
    const t = add(transcript({ lastActivityAt: NOW - 2000, subagents: [sub({ startedAt: NOW - 3000 })] }))
    t.messages.push({ id: 'a1', role: 'assistant', text: 'Workflow lancé.', at: NOW - 2000 })
    w.panes = [pane()]
    w.hooks.set('s1', { event: 'Stop', at: NOW - 1000, pid: ALIVE })
    expect(one()).toMatchObject({ status: 'working', background: 1, turnWorking: false })
    const reply = w.waitReply('s1', NOW - 5000, 60 * MIN)
    await vi.advanceTimersByTimeAsync(6000)
    await expect(reply).resolves.toMatchObject({ done: true, text: 'Workflow lancé.' })
  })

  it('L19 détail d’un sous-agent : ses derniers pas ; inconnu → rien', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-life-'))
    try {
      const file = path.join(dir, 's1.jsonl')
      const agent = path.join(dir, 's1', 'subagents', 'workflows', 'wf_1', 'agent-a1.jsonl')
      fs.mkdirSync(path.dirname(agent), { recursive: true })
      fs.writeFileSync(agent, JSON.stringify({ type: 'assistant', timestamp: new Date(NOW - MIN).toISOString(), message: { content: [{ type: 'tool_use', name: 'Bash', input: { description: 'Run the tests' } }] } }) + '\n')
      add(transcript({ file, subagents: [sub()] }))
      w.panes = [pane()]
      expect(await w.subagentAny('s1', 'a1')).toEqual({ subagent: expect.objectContaining({ id: 'a1', status: 'working' }), steps: [{ at: NOW - MIN, role: 'tool', text: 'Bash · Run the tests' }] })
      expect(await w.subagentAny('s1', 'nope')).toBeUndefined()
      expect(await w.subagentAny('zz', 'a1')).toBeUndefined()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('session coupée en plein travail', () => {
  const sub = (over: Partial<Subagent> = {}): Subagent => ({ id: 'a1', kind: 'agent', label: 'review', activity: 'Read', status: 'working', startedAt: NOW - 10 * MIN, ...over })
  const tick = async () => {
    await (w as any).watchPanes()
    await (w as any).watchCuts(Date.now())
  }
  /** Dépôt git jetable : propre, ou avec un fichier non commité. */
  function repo(dirty: boolean) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-cut-'))
    const git = (...a: string[]) => spawnSync('git', ['-C', dir, ...a], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
    git('init', '-q')
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a')
    git('add', '.')
    git('commit', '-qm', 'a')
    if (dirty) fs.writeFileSync(path.join(dir, 'a.txt'), 'b')
    return dir
  }

  it('C1 tour arrêté par une erreur d’API (limite d’usage, connexion) : coupée même processus vivant ; un nouveau message efface', () => {
    const t = add(transcript({ stopError: { at: NOW - MIN, reason: 'quota', text: 'Claude usage limit reached' } }))
    w.panes = [pane()]
    w.hooks.set('s1', { event: 'Stop', at: NOW - MIN, pid: ALIVE })
    expect(one()).toMatchObject({ status: 'interrupted', live: true, interrupted: { at: NOW - MIN, reason: 'quota', detail: 'Claude usage limit reached' } })
    t.stopError = undefined
    expect(one()?.status).toBe('idle')
    // claude -p (un script l'attend, pas une personne) : jamais « coupée ».
    w.panes = []
    w.hooks.set('s1', { event: 'Stop', at: NOW - MIN, pid: DEAD })
    Object.assign(t, { headless: true, phase: 'working', stopError: { at: NOW - MIN, reason: 'auth', text: 'expired' } })
    expect(one()?.status).toBe('done')
  })

  it('C2 processus tué en plein tour (kill-server) : coupée ; une fin voulue (/exit, fermer, ménage) : terminée ; SessionEnd « other » : coupée', async () => {
    const t = add(transcript({ phase: 'working', lastActivityAt: NOW - MIN }))
    w.hooks.set('s1', { event: 'PostToolUse', at: NOW - MIN, pid: DEAD })
    expect(one()).toMatchObject({ status: 'interrupted', interrupted: { reason: 'died', at: NOW - MIN } })
    w.hooks.set('s1', { event: 'SessionEnd', at: NOW, pid: DEAD, reason: 'other' })
    expect(one()?.status).toBe('interrupted')
    w.hooks.set('s1', { event: 'SessionEnd', at: NOW, pid: DEAD, reason: 'prompt_input_exit' })
    expect(one()?.status).toBe('done')
    w.hooks.set('s1', { event: 'PostToolUse', at: NOW - MIN, pid: DEAD })
    w.panes = [pane()]
    await w.close('s1')
    expect(one()?.status).toBe('done')
    t.phase = 'idle'
  })

  it('C3 la pane disparaît pendant qu’elle travaille : coupée (vue au passage, gardée après un redémarrage de weevilsd)', async () => {
    add(transcript({ lastActivityAt: NOW - MIN }))
    const p = pane()
    w.panes = [p]
    mux.listWv.mockResolvedValue([p])
    w.hooks.set('s1', { event: 'UserPromptSubmit', at: NOW, pid: ALIVE })
    await tick()
    expect(one()?.status).toBe('working')
    // tmux kill-server : plus de pane, plus de processus. Le transcript dit encore « idle » (dernier tour fini) : seul le passage le voit.
    mux.listWv.mockResolvedValue([])
    w.hooks.set('s1', { event: 'UserPromptSubmit', at: NOW, pid: DEAD })
    await tick()
    expect(one()).toMatchObject({ status: 'interrupted', interrupted: { reason: 'died', at: NOW } })
    vi.advanceTimersByTime(MIN)
    const t = w.store.get('s1')!
    w = new Weevils()
    add(t)
    w.hooks.set('s1', { event: 'UserPromptSubmit', at: NOW, pid: DEAD })
    expect(one()?.status).toBe('interrupted')
  })

  it('C4 arrêtée sans fin voulue avec du travail non commité : coupée ; dossier propre : terminée', async () => {
    for (const dirty of [true, false]) {
      w = new Weevils()
      const dir = repo(dirty)
      try {
        add(transcript({ cwd: dir, lastActivityAt: NOW - 5 * MIN }))
        const p = pane({ cwd: dir })
        mux.listWv.mockResolvedValue([p])
        w.hooks.set('s1', { event: 'Stop', at: NOW - 5 * MIN, pid: ALIVE })
        await tick()
        expect(one()?.status).toBe('idle')
        mux.listWv.mockResolvedValue([])
        w.hooks.set('s1', { event: 'Stop', at: NOW - 5 * MIN, pid: DEAD })
        await tick()
        expect(one()?.status, dirty ? 'dirty' : 'clean').toBe(dirty ? 'interrupted' : 'done')
        if (dirty) expect(one()?.interrupted?.reason).toBe('dirty')
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
      fs.rmSync(path.join(DATA_DIR, 'state.json'), { force: true })
    }
  })

  it('C5 arrière-plan qui tournait quand le processus est mort : coupée', () => {
    add(transcript({ subagents: [sub()] }))
    w.hooks.set('s1', { event: 'Stop', at: NOW - MIN, pid: DEAD })
    expect(one()).toMatchObject({ status: 'interrupted', background: 0, interrupted: { reason: 'died' } })
  })

  it('C6 reprise en un geste : --resume avec un message de reprise signé weevboss, qui pointe vers le dossier ; plus coupée', async () => {
    add(transcript({ phase: 'working', lastActivityAt: NOW - MIN }))
    w.hooks.set('s1', { event: 'PostToolUse', at: NOW - MIN, pid: DEAD })
    expect(one()?.status).toBe('interrupted')
    expect(await w.resume('s1')).toEqual({ id: 's1' })
    const [, dir, tool, , command, id] = mux.spawnWv.mock.calls[0] as [string, string, string, string, string[], string]
    expect([dir, tool, id]).toEqual([cwd, 'claude', 's1'])
    expect(command.slice(0, CLAUDE.length + 2)).toEqual([...CLAUDE, '--resume', 's1'])
    const t = tr(CO)
    expect(command.at(-1)).toBe(`[from:weevboss] ${t.resumePrompt(t.cutWhy('died'), cwd)}`)
    expect(command.at(-1)).toContain(cwd)
    expect(one()).toMatchObject({ status: 'working', live: true })
    expect(one()?.interrupted).toBeUndefined()
    // Remort plus tard, en plein tour : de nouveau coupée.
    vi.advanceTimersByTime(MIN)
    const tr2 = w.store.get('s1')!
    tr2.lastActivityAt = Date.now()
    w.panes = []
    expect(one()?.status).toBe('interrupted')
  })

  it('C7 laisser : redevient terminée ; une autre machine : relayé', async () => {
    add(transcript({ phase: 'working', lastActivityAt: NOW - MIN }))
    w.hooks.set('s1', { event: 'PostToolUse', at: NOW - MIN, pid: DEAD })
    expect(await w.dismiss('s1')).toEqual({ ok: true })
    expect(one()?.status).toBe('done')
    const call = vi.fn(async () => ({ id: 'r1' }))
    w.remotes = [{ has: (id: string) => id === 'r1', call } as any]
    await w.resume('r1')
    expect(call).toHaveBeenCalledWith('POST', '/api/sessions/r1/resume', {})
  })

  it('C8 annoncée une fois : notification push et message dans le fil de weevboss ; une coupure ancienne est seulement montrée', async () => {
    const send = vi.fn(async (_p: unknown) => {})
    const say = vi.fn()
    w.push = { enabled: true, send } as any
    w.setup = { say, messages: () => [], flags: () => undefined } as any
    add(transcript({ phase: 'working', lastActivityAt: NOW - MIN, messages: [{ id: 'm', role: 'user', text: 'build the page', at: NOW - MIN }] }))
    add(transcript({ id: 'old', file: '/nowhere/old.jsonl', phase: 'working', lastActivityAt: NOW - 8 * 60 * MIN }))
    w.hooks.set('s1', { event: 'PostToolUse', at: NOW - MIN, pid: DEAD })
    w.bump()
    await vi.advanceTimersByTimeAsync(250)
    expect(send).toHaveBeenCalledTimes(1)
    const title = one()!.title
    expect(send).toHaveBeenCalledWith({ title: tr(P).cutTitle('demo'), body: `${title} · ${tr(CO).cutWhy('died')}`, url: '/#s=s1', tag: 'cut-s1' })
    expect(say.mock.calls).toEqual([[tr(CO).cutSaid(title, 'demo', tr(CO).cutWhy('died'))]])
    // L'heure de la coupure se précise (SessionEnd arrivé après, puis vue au passage) : toujours le même épisode.
    w.hooks.set('s1', { event: 'SessionEnd', at: NOW, pid: DEAD, reason: 'other' })
    w.cuts.set('s1', { at: NOW + 1000, reason: 'died' })
    w.bump()
    await vi.advanceTimersByTimeAsync(250)
    expect(send).toHaveBeenCalledTimes(1)
    expect(say).toHaveBeenCalledTimes(1)
    expect(one('old')?.status).toBe('interrupted')
    // Reprise, puis nouvelle coupure : annoncée de nouveau.
    await w.resume('s1')
    vi.advanceTimersByTime(2 * MIN)
    const t = w.store.get('s1')!
    t.lastActivityAt = Date.now()
    w.panes = []
    w.bump()
    await vi.advanceTimersByTimeAsync(250)
    expect(one()?.status).toBe('interrupted')
    expect(send).toHaveBeenCalledTimes(2)
  })
})

describe('unknown foreign panes and live composers', () => {
  it('never reaps an old pane without a local transcript, including a foreign orchestrator', async () => {
    w.panes = [pane({ createdAt: NOW - 400 * MIN }), pane({ name: 'wv-foreign-boss', cwd: '/other/home/orchestrateur', createdAt: NOW - 600 * MIN })]
    await (w as any).reapPanes()
    expect(mux.killWv).not.toHaveBeenCalled()
  })
  it.each(['claude', 'codex'] as const)('a %s composer is never a question; progress remains working', async (tool) => {
    add(transcript({ tool, phase: 'working' }))
    mux.listWv.mockResolvedValue([pane({ tool })])
    mux.capture.mockResolvedValue('Do you want to proceed?\n› nn go\n• Working (36s • esc to interrupt)')
    await (w as any).watchPanes()
    expect(one()).toMatchObject({ status: 'working' })
    expect(one()?.attention).toBeUndefined()
    expect(one()?.choices).toBeUndefined()
  })
  it('returns labeled choices and validates a fresh menu before selecting', async () => {
    add(transcript({ tool: 'codex' }))
    const screen = 'Would you like to run this command?\n› 1. Yes, proceed\n2. No, tell Codex what to do differently\nPress enter to confirm or esc to cancel'
    mux.listWv.mockResolvedValue([pane({ tool: 'codex' })])
    mux.capture.mockResolvedValue(screen)
    await (w as any).watchPanes()
    const s = one()!
    expect(s.status).toBe('needs_user')
    expect(s.choices).toHaveLength(2)
    await w.key('s1', `choice:${s.choices![1].id}`)
    expect(mux.sendKey.mock.calls).toEqual([[PANE, 'down'], [PANE, 'enter']])
    mux.capture.mockResolvedValue('› nn go')
    await expect(w.key('s1', `choice:${s.choices![0].id}`)).rejects.toThrow()
    expect(mux.sendKey).toHaveBeenCalledTimes(2)
  })
})

describe('stable question notification identity', () => {
  it('background activity and wording refinement keep one event, a new user turn creates another', async () => {
    const t = add(transcript({ messages: [{ id: 'u1', role: 'user', text: 'work', at: NOW - MIN }, { id: 'a1', role: 'assistant', text: 'Which color?', at: NOW - MIN }] }))
    w.panes = [pane()]
    one()
    await judged()
    const first = one()!
    expect(first.status).toBe('needs_user')
    expect(first.noticeId).toBeTruthy()
    t.lastActivityAt = NOW
    t.messages[1].text = 'Which color would you prefer?'
    expect(one()?.noticeId).toBe(first.noticeId)
    t.messages.push({ id: 'u2', role: 'user', text: 'another task', at: NOW }, { id: 'a2', role: 'assistant', text: 'Which color?', at: NOW })
    one()
    await judged()
    expect(one()?.noticeId).not.toBe(first.noticeId)
  })
})


describe('session archive', () => {
  it('persists a reversible archive without touching the agent process or transcript', () => {
    add(transcript({ phase: 'working' }))
    w.panes = [pane()]
    w.archive('s1', true)
    expect(w.snapshot().sessions.find((s) => s.id === 's1')).toMatchObject({ archived: true, status: 'working' })
    expect(mux.killWv).not.toHaveBeenCalled()
    expect(mux.sendText).not.toHaveBeenCalled()
    expect(mux.sendKey).not.toHaveBeenCalled()
    const again = new Weevils()
    again.store.byFile.set('/nowhere/s1.jsonl', transcript({ phase: 'working' }))
    again.panes = [pane()]
    expect(again.snapshot().sessions.find((s) => s.id === 's1')?.archived).toBe(true)
    again.archive('s1', false)
    expect(again.snapshot().sessions.find((s) => s.id === 's1')?.archived).toBeUndefined()
    expect(again.panes).toHaveLength(1)
    expect(again.store.get('s1')).toBeDefined()
    expect(mux.killWv).not.toHaveBeenCalled()
  })
})

it('keeps a newly archived Codex pane archived when its transcript gets linked', () => {
  w.panes = [pane({ tool: 'codex', sessionId: undefined })]
  w.archive(PANE, true)
  add(transcript({ id: 'linked', tool: 'codex', openedAt: NOW - MIN }))
  ;(w as unknown as { linkCodexPanes(): void }).linkCodexPanes()
  expect(w.snapshot().sessions.find((s) => s.id === 'linked')?.archived).toBe(true)
  w.archive('linked', false)
  expect(w.snapshot().sessions.find((s) => s.id === 'linked')?.archived).toBeUndefined()
  expect(mux.killWv).not.toHaveBeenCalled()
})

it.each(['claude', 'codex'] as const)('%s completion reports with confirmations are idle; a real question still asks', async (tool) => {
  const t = add(transcript({ tool, messages: [
    { id: 'u', role: 'user', text: 'reprends TLO', at: NOW - MIN },
    { id: 'report', role: 'assistant', text: '[VPS] TLO repris par Codex à 16 h 32 : session liée et lecture des fichiers confirmées.\nPod supprimé, weevboss informé, aucune nouvelle dépense ni publication autorisée.', at: NOW },
  ] }))
  w.panes = [pane({ tool })]
  expect(one()).toMatchObject({ status: 'idle' })
  expect(one()?.ask).toBeUndefined()
  expect(one()?.attention).toBeUndefined()
  t.messages.push({ id: 'question', role: 'assistant', text: 'Quelle option préfères-tu ?', at: NOW })
  one()
  await judged()
  expect(one()).toMatchObject({ status: 'needs_user', attention: 'Quelle option préfères-tu ?' })
})

it('shows an existing app-server thread reached by the bridge without resuming it in another terminal', async () => {
 add(transcript({tool:'codex',originator:'codex-tui',delegationSources:new Map([['brief','boss']])}))
 expect(one()).toMatchObject({id:'s1',controllable:false,hasScreen:false})
 await expect(w.send('s1','continue')).rejects.toThrow()
 expect(mux.spawnWv).not.toHaveBeenCalled()
})

it('routes a connected app-server thread through its existing bridge without spawning a terminal', async () => {
  add(transcript({ tool: 'codex', originator: 'codex-tui', delegationSources: new Map([['brief', 'boss']]) }))
  const send = vi.fn(async () => {})
  ;(w as any).codexBridge = { can: (id: string) => id === 's1', send }
  w.bump()
  expect(one()).toMatchObject({ id: 's1', controllable: true, hasScreen: false })
  await w.send('s1', 'My direct answer')
  expect(send).toHaveBeenCalledWith('s1', 'My direct answer')
  expect(mux.spawnWv).not.toHaveBeenCalled()
})

it('never falls back to resume when an app-server connection disappears after the snapshot', async () => {
  add(transcript({ tool: 'codex', originator: 'codex-tui', delegationSources: new Map([['brief', 'boss']]) }))
  let connected = true
  ;(w as any).codexBridge = { can: () => connected, send: vi.fn() }
  w.bump()
  expect(one()!.controllable).toBe(true)
  connected = false
  await expect(w.send('s1', 'answer')).rejects.toThrow()
  expect(mux.spawnWv).not.toHaveBeenCalled()
})
it('uses current daemon activity instead of an old working terminal screen', () => {
 add(transcript({tool:'codex',phase:'working',originator:'codex-tui',delegationSources:new Map([['brief','boss']])}))
 let type = 'idle'
 ;(w as any).codexBridge = {can:()=>true,activityOf:()=>({type,waiting:false,at:NOW})}
 w.bump()
 expect(one()).toMatchObject({status:'idle',turnWorking:false,live:true})
 type='active';w.bump()
 expect(one()).toMatchObject({status:'working',turnWorking:true})
})

it('prefers a newer turn transition over cached daemon idle/active samples',()=>{
 const t=add(transcript({tool:'codex',phase:'working',lastActivityAt:NOW,originator:'codex-tui',delegationSources:new Map([['brief','boss']])}))
 let type='idle'
 ;(w as any).codexBridge={can:()=>true,activityOf:()=>({type,waiting:false,at:NOW-1000})}
 w.bump();expect(one()).toMatchObject({status:'working'})
 type='active';t.phase='idle'
 w.bump();expect(one()).toMatchObject({status:'idle'})
 // A command error is just recorded tool output; it is not a session error event.
 t.messages.push({id:'failed-command',role:'event',text:'Runs tests',at:NOW,toolDetails:{commands:['npm test'],output:'exit code 1'}})
 w.bump();expect(one()).toMatchObject({status:'idle'})
})

it('shows a stable informational gitless installation before any work, without inventing a repo or permitting dispatch',async()=>{
 const { InstallationIdentity }=await import('./recursive-identity.ts')
 const { MACHINE }=await import('./config.ts')
 const { withLang }=await import('./i18n.ts')
 const app=path.join(HOME,'projects','packaged-app')
 fs.mkdirSync(app,{recursive:true})
 const setup=(instance:InstanceType<typeof Weevils>)=>{(instance as any).installationIdentity=new InstallationIdentity(app,MACHINE.id)}
 setup(w)
 const get=(instance:InstanceType<typeof Weevils>)=>instance.localProjects([]).find(p=>p.kind==='installation')!
 const p=get(w)
 expect(p).toMatchObject({name:'weevils',kind:'installation',repos:[],where:{},lastActivityAt:0,
  installation:{source:'artifact',machineId:MACHINE.id},sourceAccess:{repo:null,canExecute:false,reason:'no-checkout'}})
 expect(p.workstream).toBeUndefined();expect(w.allRepos()).not.toContain('packaged-app')
 expect(JSON.stringify(p)).not.toContain(HOME)
 for(const locale of ['en','fr','en'] as const){w.bump();expect(withLang(locale,()=>w.snapshot()).projects.find(x=>x.id===p.id)).toEqual(p)}
 const restarted=new Weevils();setup(restarted);expect(get(restarted)).toEqual(p)
 const foreign={...p,id:'installation:other',installation:{...p.installation!,id:'other',machineId:'other'}}
 expect(w.projects([], [foreign]).filter(p=>p.kind==='installation')).toHaveLength(2)
 for(const tool of ['claude','codex'] as const){
  await expect(w.create({projectId:p.id,tool,text:'Work'})).rejects.toMatchObject({status:403})
  await expect(w.createIn(app,'Work','Work',[],{},tool)).rejects.toMatchObject({status:403})
 }
 expect(mux.spawnWv).not.toHaveBeenCalled()
 await expect(w.create({projectId:'demo',tool:'claude',text:'Other project'})).resolves.toHaveProperty('id')
})

it('enforces canonical source access for both agents without interrupting existing jobs or touching unrelated repos',async()=>{
 const { InstallationIdentity }=await import('./recursive-identity.ts')
 const { MACHINE }=await import('./config.ts')
 const app=path.join(HOME,'access-product')
 fs.mkdirSync(app,{recursive:true});expect(spawnSync('git',['init'],{cwd:app}).status).toBe(0)
 ;(w as any).installationIdentity=new InstallationIdentity(app,MACHINE.id)
 try{
  for(const tool of ['claude','codex'] as const){
   const id=`access-${tool}`;add(transcript({id,tool,cwd:app}));w.panes.push(pane({name:`wv-${id}`,sessionId:id,tool,cwd:app}))
  }
  fs.chmodSync(path.join(app,'.git'),0o500)
  expect(w.localProjects([])[0]).toMatchObject({sourceAccess:{canExecute:false,reason:'not-writable'}})
  for(const tool of ['claude','codex'] as const){
   await expect(w.create({projectId:'access-product',tool,text:'Do work'})).rejects.toMatchObject({status:403})
   await expect(w.send(`access-${tool}`,'Do work')).rejects.toMatchObject({status:403})
   await expect(w.createIn(app,'Auto','Do work',[],{},tool)).rejects.toMatchObject({status:403})
  }
  expect(mux.spawnWv).not.toHaveBeenCalled();expect(mux.sendText).not.toHaveBeenCalled();expect(mux.killWv).not.toHaveBeenCalled()
  expect(w.panes).toHaveLength(2)
  await expect(w.create({projectId:'demo',tool:'claude',text:'Unrelated work'})).resolves.toHaveProperty('id')
  fs.chmodSync(path.join(app,'.git'),0o700)
  await expect(w.create({projectId:'access-product',tool:'claude',text:'Now allowed'})).resolves.toHaveProperty('id')
 }finally{fs.chmodSync(path.join(app,'.git'),0o700)}
})

it('shares recursive repository identity between Claude/Codex on a fresh renamed installation without personal preferences',async()=>{
  const { InstallationIdentity }=await import('./recursive-identity.ts')
  const { MACHINE }=await import('./config.ts')
  const { withLang }=await import('./i18n.ts')
  const installation=path.join(HOME,'freshproduct'),unrelated=path.join(HOME,'projects','tlo')
  for(const dir of [installation,unrelated]){
    fs.mkdirSync(dir,{recursive:true})
    const init=spawnSync('git',['init'],{cwd:dir,stdio:'pipe'});expect(init.status).toBe(0)
  }
  ;(w as any).installationIdentity=new InstallationIdentity(installation,MACHINE.id)
  fs.mkdirSync(path.join(HOME,'private-unrelated'),{recursive:true})
  expect(w.allRepos()).not.toContain('private-unrelated')
  expect(w.repoDir('freshproduct')).toBe(installation)
  const project=w.localProjects([]).find(p=>p.id==='freshproduct')
  expect(project).toMatchObject({repos:['freshproduct'],workstream:{kind:'self-improvement',target:{machineId:MACHINE.id,projectId:'freshproduct',repo:'freshproduct'}}})
  const sourceMessages=[]
  for(const tool of ['claude','codex'] as const){
    const t=add(transcript({id:`self-${tool}`,file:`/none/self-${tool}`,tool,cwd:installation,phase:'working',lastActivityAt:NOW}))
    sourceMessages.push(t.messages[0])
    w.panes.push(pane({name:`pane-${tool}`,sessionId:t.id,tool,cwd:installation,pid:ALIVE}))
  }
  const unrelatedTranscript=add(transcript({id:'unrelated',file:'/none/unrelated',cwd:unrelated,firstPrompt:'Improve weevils and recursive identity',messages:[{id:'human',role:'user',text:'Improve weevils and recursive identity',at:NOW}]}))
  w.panes.push(pane({name:'pane-other',sessionId:'unrelated',cwd:unrelated,pid:ALIVE}))
  for(const locale of ['en','fr'] as const){
    const sessions=withLang(locale,()=>w.sessions(NOW))
    const own=sessions.filter(s=>s.id.startsWith('self-'))
    expect(own).toHaveLength(2)
    expect(own[0].workstream).toEqual(own[1].workstream)
    for(const s of own)expect(s).toMatchObject({status:'working',workstream:{kind:'self-improvement'}})
    expect(sessions.find(s=>s.id==='unrelated')?.workstream).toBeUndefined()
  }
  for(const t of w.store.all())if(t.id.startsWith('self-'))t.phase='idle'
  for(const s of w.sessions(NOW).filter(s=>s.id.startsWith('self-')))expect(s).toMatchObject({status:'idle',workstream:{kind:'self-improvement'}})
  expect(sourceMessages.every(m=>m.role==='user')).toBe(true)
  expect(unrelatedTranscript.messages[0].role).toBe('user')
  expect(JSON.stringify(project?.workstream)).not.toContain(HOME)
  expect(fs.existsSync(path.join(HOME,'.codex','config.toml'))).toBe(false)
  expect(fs.existsSync(path.join(DATA_DIR,'prefs.json'))).toBe(false)
  expect(mux.spawnWv).not.toHaveBeenCalled()
})

describe('jobs an agent started into a logs folder (r47)', () => {
  const job = (name: string, over: Partial<import('../shared/api.ts').H24Activity> = {}) => ({
    id: `job:${name}`, title: name, kind: 'job' as const, projectId: null, schedule: '', enabled: true, runState: 'waiting' as const,
    runStartedAt: null, lastEvent: 'done', canToggle: false, lastRunAt: NOW - 2 * MIN, ...over,
  })
  const bg = (jobs: Record<string, { label: string; at: number }>) => ({ launches: {}, notes: {}, stops: {}, calls: {}, sawPending: false, lastTurnEndAt: 0, logJobs: jobs })

  it('nested under the session that started them, in its words; the latest launch owns a reused log name', () => {
    add(transcript({ bg: bg({ 'get-host-mock': { label: 'Start the host mock', at: NOW - 10 * MIN }, 'pw-webkit': { label: 'Test run', at: NOW - 9 * MIN } }) }))
    add(transcript({ id: 's2', bg: bg({ 'get-host-mock': { label: 'Older mock', at: NOW - 60 * MIN } }) }))
    w.panes = [pane(), pane({ name: 'wv-demo-s2', sessionId: 's2' })]
    w.h24 = [job('get-host-mock', { runState: 'running', lastRunAt: NOW }), job('pw-webkit', { lastEvent: '1 failed, 12 passed' }), job('by-hand')]
    const subs = one()!.subagents
    expect(subs).toEqual([
      { id: 'job:get-host-mock', kind: 'shell', label: 'Start the host mock', activity: 'Start the host mock', status: 'working', startedAt: NOW - 10 * MIN },
      { id: 'job:pw-webkit', kind: 'shell', label: 'Test run', activity: 'Test run', status: 'failed', startedAt: NOW - 9 * MIN, endedAt: NOW - 2 * MIN },
    ])
    expect(subs.map((x) => `${x.label} ${x.activity}`).join(' ')).not.toMatch(/get-|pw-|by-hand|nohup|logs/)
    expect(one('s2')!.subagents).toEqual([])
    // A server left running is not the agent's turn: the session is not kept « working » by it.
    expect(one()).toMatchObject({ status: 'idle', background: 0 })
  })

  it('a log older than the launch belongs to an earlier run: not nested', () => {
    add(transcript({ bg: bg({ 'get-flow-phone': { label: 'Phone flow', at: NOW - MIN } }) }))
    w.panes = [pane()]
    w.h24 = [job('get-flow-phone', { lastRunAt: NOW - 30 * MIN })]
    expect(one()!.subagents).toEqual([])
  })
})
