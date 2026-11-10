// Relais Codex vu de weevilsd (server/core.ts) : weevboss qui répond par Codex pendant la limite de Claude (même dossier,
// AGENTS.md, contexte caché), le fil qui mêle les deux, le retour sur Claude avec ce que Codex a dit, les sessions liées
// (« relais ») et l'annonce de coupure laissée au relais. tmux est simulé.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session, Tool } from '../shared/api.ts'

// weevboss tourne sur cette machine (les tests ont un WEEVILS_MACHINE, qui le coupe par défaut).
vi.hoisted(() => void (process.env.WEEVILS_ORCHESTRATOR = '1'))
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
const { DATA_DIR, HOME, ORCH_DIR } = await import('./config.ts')
const { setLang } = await import('./i18n.ts')
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
  vi.clearAllTimers()
  vi.useRealTimers()
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
    expect(command.slice(0, 2)).toEqual(['codex', '--dangerously-bypass-approvals-and-sandbox'])
    expect(command.at(-1)).toMatch(/^où en sont mes sessions \? ⟦weevils — tu es weevboss, sur Codex pendant que Claude est indisponible \(limite d'usage atteinte jusqu'à 18 h\)/)
    expect(command.at(-1)).toContain('user: lance les tests du panier | you: c’est lancé dans demo')
    expect(command.join(' ')).not.toContain('claude')
    expect(res).toEqual({ id: name })
    expect(r.boss).toMatchObject({ pane: name })
    // Les consignes de l'orchestrateur, identiques pour les deux outils.
    expect(fs.readFileSync(path.join(ORCH_DIR, 'AGENTS.md'), 'utf8')).toBe(fs.readFileSync(path.join(ORCH_DIR, 'CLAUDE.md'), 'utf8'))
    expect(fs.readFileSync(path.join(ORCH_DIR, 'AGENTS.md'), 'utf8').length).toBeGreaterThan(200)
  })

  it('K2 le fil mêle Claude et Codex, sans le contexte caché ; au retour, Claude reçoit ce que Codex a dit et la pane de Codex est fermée', async () => {
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
    expect(mux.killWv).toHaveBeenCalledWith('wv-orchestrateur-abc')
    const command = (mux.spawnWv.mock.calls.at(-1) as unknown[])[4] as string[]
    expect(command.slice(0, 4)).toEqual(['claude', '--dangerously-skip-permissions', '--resume', 'boss'])
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
    expect(mux.spawnWv.mock.calls[0].slice(1, 5)).toEqual([sub, 'codex', 'refonte', ['codex', '--dangerously-bypass-approvals-and-sandbox', '[from:weevboss] Tu prends le relais']])
    expect(id).toBe(mux.spawnWv.mock.calls[0][0])
    expect(host.resolve(id)).toBe(id)
  })
})
