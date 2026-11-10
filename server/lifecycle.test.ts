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
vi.mock('./titles.ts', async (orig) => ({ ...(await orig<typeof import('./titles.ts')>()), llmTitles: async () => [] }))

const { Weevils } = await import('./core.ts')
const { DATA_DIR, HOME } = await import('./config.ts')
const { tr } = await import('./i18n.ts')
const CO = (await import('./i18n/core.ts')).default
const P = (await import('./i18n/push.ts')).default
const TipsM = (await import('./i18n/tips.ts')).default
type Transcript = import('./transcripts.ts').Transcript

const NOW = Date.parse('2026-11-09T12:00:00Z')
const MIN = 60_000
const PANE = 'wv-demo-abc123'
const cwd = path.join(HOME, 'projects', 'demo')
fs.mkdirSync(cwd, { recursive: true })
const ALIVE = process.pid
const DEAD = spawnSync('true').pid
const CLAUDE = ['claude', '--dangerously-skip-permissions']
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

  it('L5 ouverte dans un terminal que weevils ne pilote pas (processus vivant, pas de pane) : cachée', () => {
    add(transcript())
    w.hooks.set('s1', { event: 'Stop', at: NOW, pid: ALIVE })
    expect(one()).toBeUndefined()
    // Son processus est mort : terminée, visible, reprenable.
    w.hooks.set('s1', { event: 'Stop', at: NOW, pid: DEAD })
    expect(one()).toMatchObject({ status: 'done', live: false, controllable: true })
  })

  it('L6 sans hook : la phase lue dans le transcript, bornée dans le temps', () => {
    const t = add(transcript({ phase: 'working', lastActivityAt: NOW - 5 * MIN }))
    w.panes = [pane()]
    expect(one()?.status).toBe('working')
    t.lastActivityAt = NOW - 11 * MIN
    expect(one()?.status).toBe('idle')
    w.panes = []
    t.lastActivityAt = NOW - 31 * MIN
    expect(one()).toMatchObject({ status: 'done', live: false })
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
    expect([tool, title, command, sessionId]).toEqual(['codex', tr(CO).newSession, ['codex', '--dangerously-bypass-approvals-and-sandbox'], undefined])
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
    expect(mux.spawnWv.mock.calls[0].slice(1)).toEqual([HOME, 'codex', 'earlier', ['codex', 'resume', '--dangerously-bypass-approvals-and-sandbox', 's1', 'again'], 's1'])
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
    expect(send).toHaveBeenCalledWith({ title: tr(P).waitingTitle('demo'), body: 'Claude needs your permission to use Bash', url: '/#s=s1', tag: 's1' })
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
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ title: tr(P).doneTitle('demo'), body: 'All three buttons are in.' }))
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

  it('L15 processus mort (pid mort, plus de pane) ou SessionEnd : tout passe « stopped », background 0, terminée', () => {
    add(transcript({ lastActivityAt: NOW - 5 * MIN, subagents: [sub(), sub({ id: 'a2', status: 'done', endedAt: NOW - 30 * MIN })] }))
    w.hooks.set('s1', { event: 'Stop', at: NOW - 5 * MIN, pid: DEAD })
    const s = one()!
    expect(s).toMatchObject({ status: 'done', background: 0, live: false })
    expect(s.subagents.map((x) => [x.id, x.status])).toEqual([
      ['a1', 'stopped'],
      ['a2', 'done'],
    ])
    expect(s.subagents[0].endedAt).toBe(NOW - 5 * MIN)
    w.panes = [pane()]
    w.hooks.set('s1', { event: 'SessionEnd', at: NOW - MIN, pid: ALIVE })
    expect(one()).toMatchObject({ status: 'done', background: 0 })
  })

  it('L16 une question à l’écran reste « à toi », même avec un arrière-plan', () => {
    add(transcript({ subagents: [sub()] }))
    w.panes = [pane({ screenAttention: 'Do you want to proceed?' })]
    expect(one()).toMatchObject({ status: 'needs_user', background: 1 })
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
    w.bump()
    await vi.advanceTimersByTimeAsync(250)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ title: tr(P).doneTitle('demo') }))
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
