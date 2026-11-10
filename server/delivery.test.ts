// Envoi et livraison vérifiée : un message tapé dans la pane tmux n'est « livré » que s'il y a une preuve (hook
// UserPromptSubmit, message dans le transcript, ou texte visible à l'écran), sinon un seul nouvel essai puis une erreur.
// tmux est simulé (mux.ts, en gardant la vraie lecture d'écran) ; les minuteries sont factices.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message, Tool } from '../shared/api.ts'

const mux = vi.hoisted(() => ({
  sendText: vi.fn(async (_name: string, _text: string, _submit?: 'Enter' | 'Tab') => {}),
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
type Transcript = import('./transcripts.ts').Transcript

const NOW = Date.parse('2026-11-09T12:00:00Z')
const PANE = 'wv-demo-abc123'
const cwd = path.join(HOME, 'projects', 'demo')
fs.mkdirSync(cwd, { recursive: true })

let w: InstanceType<typeof Weevils>
let t: Transcript

function transcript(over: Partial<Transcript> = {}): Transcript {
  const tool = over.tool ?? 'claude'
  return {
    id: 's1',
    tool,
    file: `/nowhere/${over.id ?? 's1'}.jsonl`,
    cwd,
    openedAt: NOW - 120_000,
    lastActivityAt: NOW - 60_000,
    workStartedAt: null,
    phase: 'idle',
    messages: [{ id: 'm0', role: 'user', text: 'earlier', at: NOW - 60_000 }],
    subagents: [],
    offset: 0,
    partial: '',
    queued: [],
    ...over,
  }
}
function setup(tool: Tool = 'claude') {
  // Les hooks persistés par un test précédent (state.json) ne doivent pas confirmer ceux d'après.
  fs.rmSync(path.join(DATA_DIR, 'state.json'), { force: true })
  w = new Weevils()
  t = transcript({ tool })
  w.store.byFile.set(t.file, t)
  w.panes = [{ name: PANE, tool, sessionId: 's1', title: 't', cwd, createdAt: NOW - 60_000 }]
}
/** Lance l'action et fait défiler le temps (sondages de 300 ms, délai de 6 s par essai). Renvoie le résultat ou l'erreur. */
async function run<T>(p: Promise<T>): Promise<T | Error> {
  const out = p.catch((e: Error) => e)
  await vi.advanceTimersByTimeAsync(20_000)
  return out
}
/** Ce que fait Claude Code quand le message arrive : son hook UserPromptSubmit, un peu après la frappe. */
const hookAfterSend = () =>
  mux.sendText.mockImplementation(async () => {
    setTimeout(() => w.hook({ session_id: 's1', hook_event_name: 'UserPromptSubmit' }), 100)
  })
/** Ce que fait le transcript quand le message arrive (codex : pas de hook). */
const transcriptAfterSend = (m: Omit<Message, 'id' | 'at'>) =>
  mux.sendText.mockImplementation(async () => {
    t.messages.push({ id: `m${t.messages.length}`, at: Date.now(), ...m })
  })
const textsSent = () => mux.sendText.mock.calls.map((c) => c[1])

beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
  for (const f of Object.values(mux)) f.mockReset()
  mux.capture.mockResolvedValue('')
  mux.listWv.mockResolvedValue([])
  setup()
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('send : preuves de réception', () => {
  it('D1 hook UserPromptSubmit : livré au premier essai, sans touche', async () => {
    hookAfterSend()
    expect(await run(w.send('s1', 'hello'))).toEqual({ id: 's1' })
    expect(mux.sendText.mock.calls).toEqual([[PANE, 'hello']])
    expect(mux.sendKey).not.toHaveBeenCalled()
    expect(w.hooks.get('s1')?.event).toBe('UserPromptSubmit')
  })

  it('D2 codex sans hook : le message apparaît dans le transcript', async () => {
    setup('codex')
    transcriptAfterSend({ role: 'user', text: 'hello' })
    expect(await run(w.send('s1', 'hello'))).toEqual({ id: 's1' })
    expect(mux.sendText).toHaveBeenCalledTimes(1)
  })

  it('D3 le texte visible à l’écran, sans dialogue par-dessus', async () => {
    mux.capture.mockResolvedValue('› hello world message\n  ? for shortcuts')
    expect(await run(w.send('s1', 'hello world message'))).toEqual({ id: 's1' })
    expect(mux.sendText).toHaveBeenCalledTimes(1)
  })

  it('D3b un message court (< 8 caractères) ne se confirme pas par l’écran seul', async () => {
    mux.capture.mockResolvedValue('› ok\n  ? for shortcuts')
    const r = await run(w.send('s1', 'ok'))
    expect(r).toBeInstanceOf(Error)
    expect((r as Error).message).toBe(tr(CO).notReceived(tr(CO).noConfirmation))
    expect(mux.sendText).toHaveBeenCalledTimes(2)
  })

  it('D6 message long : seul son début (48 caractères) est cherché à l’écran', async () => {
    const text = 'please refactor the main menu so that it has three buttons and a footer'
    mux.capture.mockResolvedValue(`│ › ${text.slice(0, 56)}│\n  ? for shortcuts`)
    expect(await run(w.send('s1', text))).toEqual({ id: 's1' })
    expect(mux.sendText).toHaveBeenCalledTimes(1)
  })

  it('D7 message signé (codex) : confirmé par le transcript, qui le garde sans signature, et tapé une seule fois', async () => {
    setup('codex')
    transcriptAfterSend({ role: 'orchestrator', author: 'weevboss', text: 'fais le menu principal du jeu avec trois boutons' })
    expect(await run(w.send('s1', 'fais le menu principal du jeu avec trois boutons', 'weevboss'))).toEqual({ id: 's1' })
    expect(textsSent()).toEqual(['[from:weevboss] fais le menu principal du jeu avec trois boutons'])
  })

  it('D7b le transcript ne confirme pas un message d’avant l’envoi', async () => {
    setup('codex')
    t.messages.push({ id: 'old', role: 'user', text: 'hello again', at: NOW - 30_000 })
    const r = await run(w.send('s1', 'hello again'))
    expect(r).toBeInstanceOf(Error)
    expect(mux.sendText).toHaveBeenCalledTimes(1)
  })
})

describe('send : dialogues et échecs', () => {
  const compact = ['', '  Your context is at 400k tokens. Enable auto-compact?', '', '  ❯ 1. Yes, enable auto-compact', '    2. Not now', '', '  Enter to select · Esc to dismiss'].join('\n')
  const trust = ' Quick safety check: Is this a project you created or one you trust? (Like your own code)\n ❯ No, exit\n   Yes, I trust this folder\n Enter to confirm · Esc to cancel'

  it('D4 un menu à l’écran avant l’envoi : Échap d’abord', async () => {
    mux.capture.mockResolvedValueOnce(compact)
    hookAfterSend()
    expect(await run(w.send('s1', 'hello'))).toEqual({ id: 's1' })
    expect(mux.sendKey.mock.calls).toEqual([[PANE, 'esc']])
    expect(mux.sendKey.mock.invocationCallOrder[0]).toBeLessThan(mux.sendText.mock.invocationCallOrder[0])
  })

  it('D4b le dialogue de confiance : Entrée (Échap quitterait claude)', async () => {
    mux.capture.mockResolvedValueOnce(trust)
    hookAfterSend()
    expect(await run(w.send('s1', 'hello'))).toEqual({ id: 's1' })
    expect(mux.sendKey.mock.calls).toEqual([[PANE, 'enter']])
  })

  it('D5 jamais confirmé : deux essais exactement, puis une erreur', async () => {
    const r = await run(w.send('s1', 'hello'))
    expect(r).toBeInstanceOf(Error)
    expect((r as Error).message).toContain(tr(CO).noConfirmation)
    expect(mux.sendText).toHaveBeenCalledTimes(2)
  })

  it('D5b un dialogue apparu après le premier essai : fermé, nouvel essai, livré', async () => {
    let n = 0
    mux.sendText.mockImplementation(async () => {
      if (++n === 2) setTimeout(() => w.hook({ session_id: 's1', hook_event_name: 'UserPromptSubmit' }), 100)
    })
    // Écrans : avant l'envoi (rien), pendant le premier essai (le menu), puis plus rien.
    mux.capture.mockImplementation(async () => (n === 1 && mux.sendKey.mock.calls.length === 0 ? compact : ''))
    expect(await run(w.send('s1', 'hello'))).toEqual({ id: 's1' })
    expect(mux.sendText).toHaveBeenCalledTimes(2)
    expect(mux.sendKey.mock.calls).toEqual([[PANE, 'esc']])
  })
})

describe('send : routage et erreurs', () => {
  it('D8 session d’une autre machine : relayée signée, rien dans tmux', async () => {
    const call = vi.fn(async () => ({ id: 'r1' }))
    w.remotes = [{ has: (id: string) => id === 'r1', call } as any]
    expect(await run(w.send('r1', 'x', 'weevboss'))).toEqual({ id: 'r1' })
    expect(call).toHaveBeenCalledWith('POST', '/api/sessions/r1/send', { text: '[from:weevboss] x' })
    expect(mux.sendText).not.toHaveBeenCalled()
  })

  it('D9 message vide, session inconnue', async () => {
    expect(((await run(w.send('s1', '  '))) as Error).message).toBe(tr(CO).emptyMessage)
    expect(((await run(w.send('nope', 'hello'))) as Error).message).toBe(tr(CO).sessionNotFound)
    expect(mux.sendText).not.toHaveBeenCalled()
  })

  it('D9b session ouverte dans un terminal que weevils ne pilote pas : « unmanaged », pas « introuvable »', async () => {
    const other = transcript({ id: 's2', file: '/nowhere/s2.jsonl' })
    w.store.byFile.set(other.file, other)
    // Processus vivant (le nôtre), aucune pane weevils.
    w.hooks.set('s2', { event: 'Stop', at: NOW - 50_000, pid: process.pid })
    expect(((await run(w.send('s2', 'hello'))) as Error).message).toBe(tr(CO).unmanaged)
    expect(mux.sendText).not.toHaveBeenCalled()
    expect(mux.spawnWv).not.toHaveBeenCalled()
  })
})

describe('attach, key, command', () => {
  it('D10 photo : déposée dans l’inbox, l’agent reçoit son chemin', async () => {
    hookAfterSend()
    expect(await run(w.attach('s1', 'look', [{ name: 'a.jpg', type: 'image/jpeg', data: 'eA==' }]))).toEqual({ id: 's1' })
    const sent = textsSent()[0]
    expect(sent).toMatch(/^look \(photo: .*\/\.local\/share\/weevils\/inbox\/\d{4}-\d{2}-\d{2}-a\.jpg\)$/)
    const file = /\(photo: (.*)\)$/.exec(sent)![1]
    expect(file.startsWith(HOME)).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe('x')
  })

  it('D11 touches : Échap refusé sur le dialogue de confiance ; chiffre transmis ; sans écran, erreur', async () => {
    w.panes[0].screenAttention = 'Is this a project you trust?'
    expect(((await run(w.key('s1', 'esc'))) as Error).message).toBe(tr(CO).escWouldClose)
    expect(mux.sendKey).not.toHaveBeenCalled()
    await run(w.key('s1', '1'))
    expect(mux.sendKey.mock.calls).toEqual([[PANE, '1']])
    w.panes = []
    expect(((await run(w.key('s1', '1'))) as Error).message).toBe(tr(CO).noScreen)
  })

  it('D12 /model : tapé, et sa confirmation acceptée par Entrée tant qu’elle est là', async () => {
    const menu = ['  Switch model?', '  Your next response will be slower and use more tokens', '  ❯ 1. Yes, switch to Sonnet 5.5', '    2. No, go back'].join('\n')
    // Avant (rien à fermer), puis deux fois le menu, puis plus rien.
    mux.capture.mockResolvedValueOnce('').mockResolvedValueOnce(menu).mockResolvedValueOnce(menu)
    expect(await run(w.command('s1', '/model opus'))).toEqual({ ok: true })
    expect(textsSent()).toEqual(['/model opus'])
    expect(mux.sendKey.mock.calls).toEqual([
      [PANE, 'enter'],
      [PANE, 'enter'],
    ])
  })

  it('D12b /exit : refusé avant tout appel à tmux', async () => {
    const r = await run(w.command('s1', '/exit'))
    expect(r).toBeInstanceOf(Error)
    expect(mux.capture).not.toHaveBeenCalled()
    expect(mux.sendText).not.toHaveBeenCalled()
  })
})

describe('Codex queued delivery', () => {
  it('queues exactly once using Tab while working, never Escape or a duplicate retry', async () => {
    setup('codex')
    t.phase = 'working'
    const text = 'Please check the queue marker once'
    mux.capture.mockResolvedValue(`• Working (12s • esc to interrupt)\nQueued follow-up inputs\n  ↳ ${text}\n› `)
    const result = await run(w.send('s1', text))
    expect(result).not.toBeInstanceOf(Error)
    expect(mux.sendText.mock.calls).toEqual([[PANE, text, 'Tab']])
    expect(mux.sendKey).not.toHaveBeenCalled()
  })
  it('never blindly retries an unconfirmed Codex delivery', async () => {
    setup('codex')
    t.phase = 'working'
    mux.capture.mockResolvedValue('• Working (12s • esc to interrupt)\n› ')
    await run(w.send('s1', 'A message not visible yet'))
    expect(mux.sendText).toHaveBeenCalledTimes(1)
    expect(mux.sendKey).not.toHaveBeenCalled()
  })
})
