import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { chipsInPlace, splitChips } from '../shared/setup.ts'

// Accueil et branchements (server/setup.ts) : puces, bloc de contexte, fichier de config, marche à suivre.
const cfg = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'setup-')), 'env')
fs.writeFileSync(cfg, '# a comment\nWEEVILS_PORT=4179\n#DEVIL_API_URL=\nOPENAI_API_KEY=old\n')
process.env.WEEVILS_CONFIG = cfg
const { writeConfig, withoutContext, installPlan, installStatus } = await import('./setup.ts')
const { default: M } = await import('./i18n/setup.ts')

describe('chips', () => {
  it('takes [[setup:x]] out of the text, keeps known bricks once, in order', () => {
    expect(splitChips('Plug it in: [[setup:devil]] then [[setup:nope]] [[setup:devil]] [[setup:github]]')).toEqual({ text: 'Plug it in: then', chips: ['devil', 'github'] })
  })
  it('leaves a text without chips untouched', () => {
    const t = 'two  spaces\n\n- a list'
    expect(splitChips(t)).toEqual({ text: t, chips: [] })
  })
  it('keeps a chip in the middle of a sentence where it was written, for the app to show as a button (never « via . »)', () => {
    const t = 'Colle le mot de passe Gmail de 16 lettres via [[setup:mail]]. Le pont démarrera alors tout seul.'
    expect(chipsInPlace(t)).toEqual({ text: t, chips: ['mail'] })
  })
  it('takes out the phone QR (shown under the message) and unknown bricks, keeps the others in place', () => {
    expect(chipsInPlace('Scan it [[setup:phone]] then [[setup:nope]] push [[setup:push]]')).toEqual({ text: 'Scan it then push [[setup:push]]', chips: ['phone', 'push'] })
  })
})

describe('context block', () => {
  it('is never shown: the user text comes back as typed', () => {
    expect(withoutContext('yes go ahead ⟦weevils — shown in your thread: you: The devil sends… | user: address : http://x⟧')).toBe('yes go ahead')
    expect(withoutContext('plain message')).toBe('plain message')
  })
})

describe('writeConfig', () => {
  it('replaces a live line, fills a commented example in place, appends the rest, keeps comments, mode 600', () => {
    writeConfig({ OPENAI_API_KEY: 'sk-new', DEVIL_API_URL: 'http://pc:11434/v1', DEVIL_MODEL: 'abli' })
    expect(fs.readFileSync(cfg, 'utf8')).toBe('# a comment\nWEEVILS_PORT=4179\n#DEVIL_API_URL=\nDEVIL_API_URL=http://pc:11434/v1\nOPENAI_API_KEY=sk-new\nDEVIL_MODEL=abli\n')
    expect(fs.statSync(cfg).mode & 0o777).toBe(0o600)
    expect(process.env.DEVIL_MODEL).toBe('abli')
  })
  it('a value cannot inject a second line; empty clears the key', () => {
    writeConfig({ DEVIL_MODEL: 'x\nWEEVILS_SAFE=0', OPENAI_API_KEY: '' })
    const text = fs.readFileSync(cfg, 'utf8')
    expect(text).toContain('DEVIL_MODEL=x WEEVILS_SAFE=0\n')
    expect(text).not.toMatch(/^WEEVILS_SAFE=/m)
    expect(text).toContain('OPENAI_API_KEY=\n')
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
  })
})

describe('installPlan', () => {
  const base = {
    machine: { kind: 'vps', mac: false, os: 'Ubuntu 24.04', cpus: 2, ramGb: 4, uptimeDays: 3, alwaysOn: true, host: 'box', user: 'me', sshTarget: 'me@box', agents: 2, others: [], othersAlwaysOn: false },
    reach: 'public', url: 'https://x', https: true, port: 4179, clone: '~/weevils',
    claude: { installed: true, logged: true }, codex: { installed: true, logged: true }, github: { installed: true, logged: true },
    voice: { spoken: 'edge', openai: false, https: true }, devil: { plugged: false }, mail: { on: false, authors: 0, pending: [] },
    phone: { devices: 1, push: 0 }, shortcut: false, security: { safe: false, https: true, exposedHttp: false }, quota: [],
    pkg: 'apt', sudo: 'yes', tools: { git: true, tmux: true, curl: true, python3: true, qrencode: true, pipx: true, uv: false, node: 22 }, projects: 0,
  } as const
  it('nothing missing: no command, nothing to guess', () => {
    const p = installPlan(structuredClone(base) as never)
    expect(p).toContain('all the essentials are already there')
    expect(p).not.toContain('```')
  })
  it('without sudo: everything goes to the home folder, then the sign-ins', () => {
    const s = structuredClone(base) as any
    Object.assign(s, { sudo: 'no' })
    s.github = { installed: false, logged: false }
    s.claude = { installed: false, logged: false }
    s.voice.spoken = null
    s.tools.pipx = false
    const p = installPlan(s)
    expect(p).toContain('curl -fsSL https://claude.ai/install.sh | bash')
    expect(p).toContain('cli/cli/releases/latest')
    expect(p).toContain('uv tool install edge-tts')
    expect(p).not.toContain('sudo apt')
    // Les connexions : des puces pour l'utilisateur, jamais « gh auth login » à taper.
    expect(p).toContain('[[setup:github]]')
    expect(p).not.toContain('gh auth login')
  })
  it('apt with sudo: the package manager', () => {
    const s = structuredClone(base) as any
    s.github = { installed: false, logged: false }
    s.tools.tmux = false
    expect(installPlan(s)).toContain('sudo apt update && sudo apt install -y tmux')
    expect(installPlan(s)).toContain('sudo apt update && sudo apt install -y gh')
  })
})

describe('guessBrick (Claude Code not signed in yet)', async () => {
  const { guessBrick } = await import('./setup.ts')
  it('finds the building block a newcomer asks about, in French or English', () => {
    expect(guessBrick('qu’est-ce que je dois installer ?')).toBe('install')
    expect(guessBrick('what do I need to install')).toBe('install')
    expect(guessBrick('comment je branche github')).toBe('github')
    expect(guessBrick('je veux un modèle abliterated')).toBe('devil')
    expect(guessBrick('mes agents bossent la nuit ?')).toBe('machine')
    expect(guessBrick('ChatGPT peut t’écrire ?')).toBe('mail')
    expect(guessBrick('salut')).toBeNull()
  })
})

describe('never a command for the user to type', () => {
  const base = {
    machine: { kind: 'vps', mac: false, os: 'Ubuntu 24.04', cpus: 2, ramGb: 4, uptimeDays: 3, alwaysOn: true, host: 'box', user: 'me', sshTarget: 'me@box', agents: 2, others: [], othersAlwaysOn: false },
    reach: 'local', url: 'http://127.0.0.1:4179', https: false, port: 4179, clone: '~/weevils',
    claude: { installed: false, logged: false }, codex: { installed: false, logged: false }, github: { installed: false, logged: false },
    voice: { spoken: null, openai: false, https: false }, devil: { plugged: false }, mail: { on: false, authors: 0, pending: [] },
    phone: { devices: 1, push: 0 }, shortcut: false, security: { safe: false, https: false, exposedHttp: true }, quota: [],
    pkg: 'apt', sudo: 'no', tools: { git: true, tmux: true, curl: true, python3: true, qrencode: true, pipx: false, uv: false, node: 22 }, projects: 0,
  } as any
  const COMMAND = /`|\bcurl\b|\bsudo\b|\bnpm\b|install\.sh|gh auth|\bssh |tailscale serve|weevils-service|~\/\.config/
  for (const lang of ['fr', 'en'] as const) {
    it(`${lang}: what weevboss writes in the thread`, () => {
      const t = M[lang]
      const texts: string[] = []
      for (const reach of ['local', 'lan', 'public'] as const)
        for (const https of [false, true]) {
          const s = { ...base, reach, https }
          texts.push(t.reachAsk(s), t.reachPrompt(reach === 'public'), t.machineAsk(s), t.voiceAsk(s), t.securityAsk(s), t.githubAsk(s), installStatus(s))
        }
      for (const kind of ['vps', 'server', 'container', 'vm', 'laptop', 'desktop', 'wsl'] as const) {
        const m = { ...base.machine, kind }
        texts.push(t.machine(m), t.claudeMissing(m), t.machineAsk({ ...base, machine: m }))
      }
      texts.push(t.claudeLogin, t.claudeLink('https://claude.com/x'), t.codexCode('https://auth.openai.com/codex/device', 'ABCD-EFGH'), t.machineNone, t.machineIn('root@203.0.113.7', 'Ubuntu'), t.githubNoCli('404'), t.quotaAsk([]), t.mailAsk, t.devilAsk(false, ''))
      for (const x of texts) expect(x, x).not.toMatch(COMMAND)
    })
  }
})

describe('weevboss automatic messages are never posted twice', async () => {
  const { Setup } = await import('./setup.ts')
  let bumps = 0
  const setup = new Setup({
    bump: () => void bumps++,
    feed: () => ({ machines: [{ id: 'box', name: 'box' }], projects: 0 }),
    remoteFacts: async () => [],
    devices: () => 1,
    push: () => 0,
    shortcut: () => false,
    seen: () => [],
    hasHistory: () => true,
    startMail: () => undefined,
    handoff: async () => undefined,
  })
  it('a brick explanation said again (a flow started twice) returns the message already there', () => {
    const before = setup.messages().length
    const a = setup.say('Pick your host below.', true)
    const b = setup.say('Pick your host below.', true)
    expect(b).toBe(a)
    expect(setup.lastSaid).toBe(a)
    expect(setup.messages().length).toBe(before + 1)
    // Still a refresh: the app brings the existing message back into view.
    expect(bumps).toBeGreaterThan(0)
  })
  it('a new event with the same text (a second cut after a resume, a retry that fails the same way) is posted again', () => {
    const before = setup.messages().length
    setup.say('The session “x” was cut mid-work: process stopped.')
    setup.say('The session “x” was cut mid-work: process stopped.')
    expect(setup.messages().length).toBe(before + 2)
  })
  it('a different text, or the same one long after, is posted', () => {
    const before = setup.messages().length
    setup.say('one')
    setup.say('two')
    expect(setup.messages().length).toBe(before + 2)
  })
  it('the machine flow started twice does not repeat the machine status', async () => {
    await setup.ask('machine')
    const n = setup.messages().length
    await setup.ask('machine')
    expect(setup.messages().length).toBe(n)
  })
  it('a flow retried with the same answers posts its answer and its result again, at the bottom', async () => {
    const n = setup.messages().length
    await setup.apply('author', { name: 'Ana', email: 'not-an-address' })
    const first = setup.lastSaid
    await setup.apply('author', { name: 'Ana', email: 'not-an-address' })
    const log = setup.messages()
    expect(log.length).toBe(n + 4)
    expect(log.at(-2)?.role).toBe('user')
    expect(setup.lastSaid).toBe(log.at(-1)?.id)
    expect(setup.lastSaid).not.toBe(first)
  })
})

describe('test sessions never reach the real weevboss thread', async () => {
  const { isTestBrief } = await import('./core.ts')
  it('a brief starting with TEST (after an optional signature) is a test', () => {
    expect(isTestBrief('[from:weevboss] TEST COUPURE (à ignorer) : lance sleep 75')).toBe(true)
    expect(isTestBrief('[test] cut detection')).toBe(true)
  })
  it('an ordinary brief is not, even about tests', () => {
    expect(isTestBrief('Test du paiement en staging')).toBe(false)
    expect(isTestBrief('[from:weevboss] ajoute des tests e2e')).toBe(false)
    expect(isTestBrief(undefined)).toBe(false)
    // Tapé à la main dans un terminal pour vérifier que Claude répond : une vraie session, qui prévient.
    expect(isTestBrief('TEST')).toBe(false)
    expect(isTestBrief('[from:weevboss] TESTÉ hier, à reprendre')).toBe(false)
  })
})

describe('[[setup:key:NOM]] : un secret demandé par un agent', async () => {
  const { Setup } = await import('./setup.ts')
  const { isSecretName } = await import('../shared/setup.ts')
  const setup = new Setup({
    bump: () => undefined,
    feed: () => ({ machines: [{ id: 'box', name: 'box' }], projects: 0 }),
    remoteFacts: async () => [],
    devices: () => 1,
    push: () => 0,
    shortcut: () => false,
    seen: () => [],
    hasHistory: () => true,
    startMail: () => undefined,
    handoff: async () => undefined,
  })
  it('seulement des clés et des jetons, jamais un réglage de weevils', () => {
    for (const ok of ['RUNPOD_API_KEY', 'STRIPE_API_KEY', 'HF_TOKEN', 'GITHUB_TOKEN']) expect(isSecretName(ok), ok).toBe(true)
    for (const no of ['WEEVILS_MAIL_TOKEN', 'PATH', 'runpod_api_key', 'RUNPOD_KEY', 'LD_PRELOAD', 'X_API_KEY\nY', 'A'.repeat(60) + '_TOKEN']) expect(isSecretName(no), no).toBe(false)
  })
  it('la valeur va dans la config, jamais dans le fil ni dans le journal ; le fil confirme', () => {
    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')))
    const secret = 'rpa_S3CRETvalue0123456789'
    setup.saveKey('RUNPOD_API_KEY', `  ${secret}  `)
    spy.mockRestore()
    expect(fs.readFileSync(cfg, 'utf8')).toContain(`RUNPOD_API_KEY=${secret}\n`)
    expect(process.env.RUNPOD_API_KEY).toBe(secret)
    const shown = setup.messages().map((m) => m.text).join('\n')
    expect(shown).toContain('RUNPOD_API_KEY : ••••')
    expect(shown).not.toContain(secret.slice(-4))
    expect(logs.join('\n')).not.toContain(secret.slice(-4))
    expect(logs.join('\n')).toContain('RUNPOD_API_KEY')
  })
  it('refuse un nom hors liste, une valeur vide ou sur plusieurs lignes', () => {
    expect(() => setup.saveKey('WEEVILS_PORT_TOKEN', 'x')).toThrow()
    expect(() => setup.saveKey('PATH', '/tmp')).toThrow()
    expect(() => setup.saveKey('HF_TOKEN', '  ')).toThrow()
    expect(() => setup.saveKey('HF_TOKEN', 'a\nEVIL=1')).toThrow()
    expect(fs.readFileSync(cfg, 'utf8')).not.toMatch(/^(PATH|EVIL|HF_TOKEN)=/m)
  })
})
