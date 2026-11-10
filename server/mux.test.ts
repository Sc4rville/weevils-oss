// La couche tmux : la frontière entre ce que le téléphone envoie et le terminal (saisie littérale, touches permises)
// et le registre des sessions wv-* partagé avec le lanceur server/wv. tmux est simulé : on regarde les arguments.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sh = vi.hoisted(() => ({ calls: [] as string[][], out: '', fail: false }))
vi.mock('node:child_process', () => ({
  execFile: (_cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    sh.calls.push(args)
    if (sh.fail) cb(new Error('no server running'), '', 'no server running on /tmp/tmux-1000/default')
    else cb(null, sh.out, '')
  },
}))

const mux = await import('./mux.ts')

beforeEach(() => {
  sh.calls.length = 0
  sh.out = ''
  sh.fail = false
})
afterEach(() => {
  vi.useRealTimers()
})

describe('sendText', () => {
  it('saisie littérale (-l), retours à la ligne aplatis, puis Entrée à part', async () => {
    vi.useFakeTimers()
    const p = mux.sendText('wv-a', 'a\n  b ')
    await vi.advanceTimersByTimeAsync(200)
    await p
    expect(sh.calls).toEqual([
      ['send-keys', '-t', '=wv-a:', '-l', 'a b'],
      ['send-keys', '-t', '=wv-a:', 'Enter'],
    ])
  })

  it('un texte qui ressemble à une touche reste du texte', async () => {
    vi.useFakeTimers()
    const p = mux.sendText('wv-a', 'C-c')
    await vi.advanceTimersByTimeAsync(200)
    await p
    expect(sh.calls[0]).toEqual(['send-keys', '-t', '=wv-a:', '-l', 'C-c'])
  })
})

describe('sendKey', () => {
  it('touches nommées traduites pour tmux', async () => {
    await mux.sendKey('wv-a', 'enter')
    await mux.sendKey('wv-a', 'shift-tab')
    await mux.sendKey('wv-a', 'esc')
    expect(sh.calls).toEqual([
      ['send-keys', '-t', '=wv-a:', 'Enter'],
      ['send-keys', '-t', '=wv-a:', 'BTab'],
      ['send-keys', '-t', '=wv-a:', 'Escape'],
    ])
  })

  it('chiffres 1–9 et y/n en saisie littérale', async () => {
    await mux.sendKey('wv-a', '3')
    await mux.sendKey('wv-a', 'y')
    expect(sh.calls).toEqual([
      ['send-keys', '-t', '=wv-a:', '-l', '3'],
      ['send-keys', '-t', '=wv-a:', '-l', 'y'],
    ])
  })

  it.each(['rm', 'C-c', '0', 'Enter', '12', ''])('refuse %j sans rien envoyer', async (key) => {
    await expect(mux.sendKey('wv-a', key)).rejects.toThrow()
    expect(sh.calls).toEqual([])
  })
})

describe('listWv', () => {
  const line = (...f: string[]) => f.join('\u001f')

  it('ne garde que les sessions wv-* et lit leurs options', async () => {
    sh.out = [
      line('wv-demo-abc123', 'codex', '', '', '', '/home/u/projects/demo', '1700000000'),
      line('perso', 'claude', 'x', 't', '/x', '/x', '1700000000'),
      line('wv-other-def456', 'claude', 'uuid-1', 'fix the menu', '/home/u/projects/other', '/tmp', '1700000100'),
      '',
    ].join('\n')
    const list = await mux.listWv()
    expect(sh.calls[0][0]).toBe('list-sessions')
    expect(list).toEqual([
      { name: 'wv-demo-abc123', tool: 'codex', sessionId: undefined, title: 'new session', cwd: '/home/u/projects/demo', createdAt: 1_700_000_000_000 },
      { name: 'wv-other-def456', tool: 'claude', sessionId: 'uuid-1', title: 'fix the menu', cwd: '/home/u/projects/other', createdAt: 1_700_000_100_000 },
    ])
  })

  it('tmux 3.4 (Ubuntu 24.04) rend le séparateur en octal « \\037 » : lu pareil', async () => {
    sh.out = ['wv-orchestrateur-64f403', 'claude', 'aa62', 'weevboss', '/home/u/.local/share/weevils/orchestrateur', '/home/u', '1794200000'].join('\\037') + '\n'
    expect(await mux.listWv()).toEqual([{ name: 'wv-orchestrateur-64f403', tool: 'claude', sessionId: 'aa62', title: 'weevboss', cwd: '/home/u/.local/share/weevils/orchestrateur', createdAt: 1_794_200_000_000 }])
  })

  it('un outil inconnu est claude', async () => {
    sh.out = line('wv-x-000000', 'bash', 'id', 't', '/d', '/d', '1') + '\n'
    expect((await mux.listWv())[0].tool).toBe('claude')
  })

  it('pas de serveur tmux : aucune session', async () => {
    sh.fail = true
    expect(await mux.listWv()).toEqual([])
  })
})

describe('spawnWv', () => {
  it('commande en arguments (sans shell), environnement calme, puis options @wv_*', async () => {
    await mux.spawnWv('wv-x', '/d', 'claude', 't', ['claude', '--session-id', 'u', 'hi'], 'u')
    const [first, ...opts] = sh.calls
    expect(first.slice(0, 10)).toEqual(['new-session', '-d', '-s', 'wv-x', '-x', '120', '-y', '40', '-c', '/d'])
    for (const [k, v] of Object.entries(mux.QUIET_ENV)) {
      const i = first.indexOf(`${k}=${v}`)
      expect(i, k).toBeGreaterThan(0)
      expect(first[i - 1]).toBe('-e')
    }
    expect(first.slice(-4)).toEqual(['claude', '--session-id', 'u', 'hi'])
    expect(opts).toEqual([
      ['set-option', '-t', '=wv-x:', '@wv_tool', 'claude'],
      ['set-option', '-t', '=wv-x:', '@wv_title', 't'],
      ['set-option', '-t', '=wv-x:', '@wv_cwd', '/d'],
      ['set-option', '-t', '=wv-x:', '@wv_session_id', 'u'],
    ])
  })

  it('sans identifiant (codex) : pas de @wv_session_id', async () => {
    await mux.spawnWv('wv-x', '/d', 'codex', 't', ['codex', 'hi'])
    expect(sh.calls.map((c) => c[3])).not.toContain('@wv_session_id')
    expect(sh.calls).toHaveLength(4)
  })

  it('un texte avec des caractères de shell reste un seul argument', async () => {
    await mux.spawnWv('wv-x', '/d', 'claude', 't', ['claude', 'hi; rm -rf ~ $(id)'])
    expect(sh.calls[0].at(-1)).toBe('hi; rm -rf ~ $(id)')
  })
})

describe('cibles', () => {
  it('killWv et capture visent la session exacte (=nom:)', async () => {
    await mux.killWv('wv-x')
    sh.out = 'ligne 1\nligne 2  \n\n\n'
    expect(await mux.capture('wv-x')).toBe('ligne 1\nligne 2')
    expect(sh.calls).toEqual([
      ['kill-session', '-t', '=wv-x:'],
      ['capture-pane', '-p', '-J', '-t', '=wv-x:'],
    ])
  })

  it('une erreur tmux remonte avec son message', async () => {
    sh.fail = true
    await expect(mux.killWv('wv-x')).rejects.toThrow(/no server running/)
  })
})
