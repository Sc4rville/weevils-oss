// La couche tmux : la frontière entre ce que le téléphone envoie et le terminal (saisie littérale, touches permises)
// et le registre des sessions wv-* partagé avec le lanceur server/wv. tmux est simulé : on regarde les arguments.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// calls : les arguments sans le choix du serveur ; sockets : le serveur visé (« -L <nom> », sinon « default »).
const sh = vi.hoisted(() => ({ commands: [] as string[], calls: [] as string[][], sockets: [] as string[], out: '', by: {} as Record<string, string | null>, fail: false }))
vi.mock('node:child_process', () => ({
  execFile: (_cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    sh.commands.push(_cmd)
    if (_cmd === 'systemd-run') args = args.slice(args.indexOf('--') + 2)
    const socket = args[0] === '-L' ? args[1] : 'default'
    sh.calls.push(args[0] === '-L' ? args.slice(2) : args)
    sh.sockets.push(socket)
    const out = socket in sh.by ? sh.by[socket] : sh.out
    if (sh.fail || out === null) cb(new Error('no server running'), '', 'no server running on /tmp/tmux-1000/default')
    else cb(null, out, '')
  },
}))

const mux = await import('./mux.ts')

beforeEach(() => {
  sh.commands.length = 0
  sh.calls.length = 0
  sh.sockets.length = 0
  sh.by = {}
  sh.out = ''
  sh.fail = false
})
afterEach(() => {
  vi.useRealTimers()
})

describe('wvName', () => {
  it('« . » et « : » deviennent « _ » comme tmux le ferait : le nom retenu est celui de la session', () => {
    expect(mux.wvName('.ad9651b0c8', 'abc123')).toBe('wv-_ad9651b0c8-abc123')
    expect(mux.wvName('mon.site:v2', 'abc123')).toBe('wv-mon_site_v2-abc123')
    expect(mux.wvName('tic-tac-toe', 'abc123')).toBe('wv-tic-tac-toe-abc123')
    expect(mux.wvName('a-very-long-folder-name-indeed', 'f')).toBe('wv-a-very-long-folder-f')
  })
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

  it('pid de la pane (l’agent lui-même) quand tmux le donne', async () => {
    sh.out = line('wv-x-000000', 'claude', 'id', 't', '/d', '/d', '1', '4242') + '\n'
    expect((await mux.listWv())[0].pid).toBe(4242)
    sh.out = line('wv-x-000000', 'claude', 'id', 't', '/d', '/d', '1', '') + '\n'
    expect((await mux.listWv())[0].pid).toBeUndefined()
    expect(sh.calls[0][2]).toContain('#{pane_pid}')
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
    // L'agent part sans TMUX ni TMUX_PANE : son tmux de test ne peut pas viser le serveur de weevils.
    expect(first.slice(-9)).toEqual(['env', '-u', 'TMUX', '-u', 'TMUX_PANE', 'claude', '--session-id', 'u', 'hi'])
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

  it('argv exact : env -u TMUX -u TMUX_PANE juste avant la commande, après l’environnement calme (pas de shell)', async () => {
    await mux.spawnWv('wv-x', '/d', 'codex', 't', ['codex', 'resume', 'id', 'go'])
    const quiet = Object.entries(mux.QUIET_ENV).flatMap(([k, v]) => ['-e', `${k}=${v}`])
    expect(sh.calls[0]).toEqual(['new-session', '-d', '-s', 'wv-x', '-x', '120', '-y', '40', '-c', '/d', ...quiet, 'env', '-u', 'TMUX', '-u', 'TMUX_PANE', 'codex', 'resume', 'id', 'go'])
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

describe('serveur tmux dédié (garde-fou contre « tmux kill-server »)', () => {
  const row = (name: string) => [name, 'claude', 'id', 't', '/d', '/d', '1', '42'].join('\u001f')

  it('les sessions sont lancées et réglées sur « tmux -L weevils », jamais sur le serveur par défaut', async () => {
    expect(mux.SOCKET).toBe('weevils')
    await mux.spawnWv('wv-new-000000', '/d', 'claude', 't', ['claude'], 'u')
    expect(sh.sockets.every((x) => x === 'weevils')).toBe(true)
    await mux.sendText('wv-new-000000', 'hi').catch(() => undefined)
    await mux.killWv('wv-new-000000')
    expect(sh.sockets.every((x) => x === 'weevils')).toBe(true)
  })

  it('relecture : le serveur dédié, puis les sessions d’avant restées sur le serveur par défaut (pilotées là où elles vivent)', async () => {
    sh.by = { weevils: row('wv-new-000000') + '\n', default: [row('wv-old-111111'), row('wv-new-000000'), 'perso: 1 windows'].join('\n') + '\n' }
    const list = await mux.listWv()
    expect(list.map((s) => s.name)).toEqual(['wv-new-000000', 'wv-old-111111'])
    expect(sh.sockets).toEqual(['weevils', 'default'])
    sh.calls.length = sh.sockets.length = 0
    await mux.capture('wv-old-111111')
    await mux.capture('wv-new-000000')
    expect(sh.sockets).toEqual(['default', 'weevils'])
  })

  it('pas encore de serveur dédié : les anciennes sessions restent visibles', async () => {
    sh.by = { weevils: null, default: row('wv-old-111111') + '\n' }
    expect((await mux.listWv()).map((s) => s.name)).toEqual(['wv-old-111111'])
  })
})

describe('Codex active approval menu', () => {
  it('ignores command output, quoted options and the ordinary composer during work', () => {
    expect(mux.codexDialogOnScreen('exec requires approval?\n› 1. Yes\n2. No\nEnter to confirm\n• Working (36s • esc to interrupt)\n› 111')).toBeUndefined()
    expect(mux.codexDialogOnScreen('• Ran rg needs_user approval\n› 111\nGPT-6.1-Sol default')).toBeUndefined()
  })
  it('recognizes an actual Codex approval selector', () => {
    expect(mux.codexDialogOnScreen('Would you like to run this command?\n› 1. Yes, proceed\n2. No, tell Codex what to do differently\nPress enter to confirm or esc to cancel')).toBe('Would you like to run this command?')
  })
})

describe('throwaway tmux isolation', () => {
  it('creates TMUX_TMPDIR before even listing the legacy socket, including after deletion', async () => {
    const dir = path.join(process.env.HOME!, 'missing-tmux')
    vi.stubEnv('TMUX_TMPDIR', dir)
    try {
      expect(fs.existsSync(dir)).toBe(false)
      await mux.listWv()
      expect(fs.statSync(dir).isDirectory()).toBe(true)
      fs.rmSync(dir, { recursive: true })
      await mux.listWv()
      expect(fs.statSync(dir).isDirectory()).toBe(true)
    } finally { vi.unstubAllEnvs() }
  })
})

it('recognizes settings menus as controls, never as user questions', () => {
 for (const title of ['Select Reasoning Level for GPT-6-Astra','Select Model']) {
  const screen = `${title}\n\n1. Low\n› 2. Medium (default)\n3. High\nenter select · esc back`
  expect(mux.screenDialog(screen)?.kind).toBe('settings')
  expect(mux.dialogOnScreen(screen)).toBeDefined()
  expect(mux.attentionFromScreen(screen)).toBeUndefined()
  expect(mux.codexDialogOnScreen(screen)).toBeUndefined()
 }
})
