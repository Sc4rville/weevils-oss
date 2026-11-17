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
  // Un Mac : Homebrew, avec le compte de l'utilisateur. Jamais sudo, jamais apt, jamais un binaire Linux.
  const mac = (over: Record<string, unknown> = {}) => {
    const s = structuredClone(base) as any
    Object.assign(s.machine, { kind: 'laptop', mac: true, os: 'macOS 15.1', alwaysOn: false })
    Object.assign(s, { pkg: 'brew', sudo: 'password', reach: 'local', url: 'http://127.0.0.1:4179', https: false }, over)
    s.github = { installed: false, logged: false }
    s.codex = { installed: false, logged: false }
    s.voice.spoken = null
    s.tools = { ...s.tools, tmux: false, qrencode: false, pipx: false }
    return s
  }
  it('a Mac with Homebrew: brew for everything, no sudo (not even the « no sudo here » note), no apt', () => {
    const p = installPlan(mac())
    expect(p).toContain('`brew install tmux qrencode`')
    expect(p).toContain('`brew install gh`')
    expect(p).toContain('`brew install pipx && pipx install edge-tts`')
    expect(p).toContain('`npm i -g --prefix ~/.local @openai/codex`')
    expect(p).not.toMatch(/\bsudo\b|\bapt\b|linux_|fnm/i)
    // A standard account (no admin rights) changes nothing: brew installs as the person.
    expect(installPlan(mac({ sudo: 'no' }))).toBe(p)
    const old = mac()
    old.tools.node = 20
    expect(installPlan(old)).toContain('`brew install node`')
  })
  it('a Mac without Homebrew: the installer brings it; what goes in the home folder is the macOS build', () => {
    const s = mac({ pkg: null })
    s.tools.node = 20
    const p = installPlan(s)
    expect(p).toContain('Homebrew is missing on this Mac')
    expect(p).toContain('~/weevils/install.sh --agent')
    expect(p).toMatch(/macOS_(arm64|amd64)\.zip/)
    expect(p).toContain('uv tool install edge-tts')
    expect(p).not.toMatch(/\bsudo\b|\bapt\b|linux_|fnm|brew install/)
    // Everything from Homebrew is there: nothing to say about it.
    const full = mac({ pkg: null })
    full.tools = { ...full.tools, tmux: true, qrencode: true }
    expect(installPlan(full)).not.toContain('Homebrew')
  })
  it('Linux is untouched: the same commands as before, to the letter', async () => {
    const { ghNoSudo, installCommand } = await import('./setup.ts')
    expect(ghNoSudo('linux', 'x64')).toBe(
      `mkdir -p ~/.local/bin && curl -fsSL "$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | grep -o 'https://[^"]*linux_amd64.tar.gz' | head -1)" | tar xz -C /tmp && mv /tmp/gh_*_linux_amd64/bin/gh ~/.local/bin/`,
    )
    expect(ghNoSudo('linux', 'arm64')).toContain('linux_arm64.tar.gz')
    const s = structuredClone(base) as any
    expect(installCommand('codex', s)).toBe('npm i -g --prefix ~/.local @openai/codex')
    expect(installCommand('gh', s)).toBe('sudo apt update && sudo apt install -y gh')
    expect(installCommand('gh', { ...s, sudo: 'password' })).toBe(ghNoSudo('linux'))
    s.voice.spoken = null
    s.tools.pipx = false
    expect(installCommand('edge', s)).toBe('sudo apt install -y pipx && pipx ensurepath && pipx install edge-tts')
    s.tools.node = 20
    expect(installPlan({ ...s, sudo: 'no' })).toContain('~/.local/share/fnm/fnm install 22')
  })
  it('gh on a Mac without Homebrew: the macOS zip for this processor, in ~/.local/bin', async () => {
    const { ghNoSudo, installCommand } = await import('./setup.ts')
    const arm = ghNoSudo('darwin', 'arm64')
    expect(arm).toContain("grep -o 'https://[^\"]*macOS_arm64.zip'")
    expect(arm).toContain('unzip -qo')
    expect(arm).toContain('/gh_*_macOS_arm64/bin/gh ~/.local/bin/')
    expect(arm).not.toMatch(/linux|tar xz|\bsudo\b/)
    expect(ghNoSudo('darwin', 'x64')).toContain('macOS_amd64.zip')
    expect(installCommand('gh', mac({ pkg: null }))).toMatch(/macOS_(arm64|amd64)\.zip/)
    expect(installCommand('gh', mac())).toBe('brew install gh')
  })
})

describe('what the machine is (macOS branches, run on Linux)', async () => {
  const { pkgManager, sudo, shellEnv, installEnv, machineKind, agentRoom } = await import('./setup.ts')
  it('package manager: Homebrew on a Mac only when it is there, never guessed', () => {
    const has = (...cmds: string[]) => (c: string) => cmds.includes(c)
    expect(pkgManager('darwin', has('brew'))).toBe('brew')
    expect(pkgManager('darwin', has())).toBeNull()
    expect(pkgManager('darwin', has('apt-get'))).toBeNull()
    expect(pkgManager('linux', has('apt-get', 'brew'))).toBe('apt')
    expect(pkgManager('linux', has('dnf'))).toBe('dnf')
    expect(pkgManager('linux', has('pacman'))).toBe('pacman')
    expect(pkgManager('linux', has('brew'))).toBeNull()
  })
  it('admin rights: the real checks on a Mac too (an admin account, a standard one)', async () => {
    const exec = (sudoOk: boolean, groups: string) => async (cmd: string) => (cmd === 'sudo' ? { ok: sudoOk, out: '' } : { ok: true, out: groups })
    const yes = () => true
    expect(await sudo(0, yes, exec(false, ''))).toBe('yes')
    expect(await sudo(501, yes, exec(true, 'staff'))).toBe('yes')
    expect(await sudo(501, yes, exec(false, 'staff everyone localaccounts admin _appstore'))).toBe('password')
    expect(await sudo(502, yes, exec(false, 'staff everyone localaccounts _lpoperator'))).toBe('no')
    expect(await sudo(1000, yes, exec(false, 'me adm sudo docker'))).toBe('password')
    expect(await sudo(1000, () => false, exec(true, 'sudo'))).toBe('no')
  })
  it('the PATH of installs and sign-ins: Homebrew folders on a Mac, nothing new on Linux', () => {
    const env = { PATH: '/usr/bin:/bin', FOO: '1' }
    expect(shellEnv('linux', env, '/home/me')).toEqual({ FOO: '1', PATH: '/home/me/.local/bin:/home/me/.npm-global/bin:/usr/bin:/bin' })
    expect(installEnv('linux', env, '/home/me')).toEqual(shellEnv('linux', env, '/home/me'))
    const mac = shellEnv('darwin', env, '/Users/me')
    expect(mac.PATH).toBe('/Users/me/.local/bin:/Users/me/.npm-global/bin:/usr/bin:/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin')
    expect(mac.NONINTERACTIVE).toBeUndefined()
    // An install never waits for an answer from brew.
    expect(installEnv('darwin', env, '/Users/me')).toMatchObject({ PATH: mac.PATH, NONINTERACTIVE: '1', HOMEBREW_NO_ENV_HINTS: '1', FOO: '1' })
  })
  it('machine kind: a Mac is a laptop when it has a battery, whatever it is called or runs in', () => {
    const k = (o: Partial<Parameters<typeof machineKind>[0]>) => machineKind({ wsl: false, mac: false, virt: '', laptop: false, publicIp: false, provider: false, ...o })
    expect(k({ mac: true, laptop: true })).toBe('laptop')
    expect(k({ mac: true })).toBe('desktop')
    expect(k({ mac: true, virt: 'apple', publicIp: true, provider: true })).toBe('desktop')
    // Linux, as before.
    expect(k({ wsl: true, virt: 'wsl', laptop: true })).toBe('wsl')
    expect(k({ virt: 'docker', publicIp: true })).toBe('container')
    expect(k({ virt: 'kvm', publicIp: true })).toBe('vps')
    expect(k({ virt: 'kvm', provider: true })).toBe('vps')
    expect(k({ virt: 'kvm' })).toBe('vm')
    expect(k({ laptop: true, publicIp: true })).toBe('laptop')
    expect(k({ publicIp: true })).toBe('server')
    expect(k({})).toBe('desktop')
  })
  it('room for agents: a Mac keeps 4 GB for macOS and its apps, a server 1.5', () => {
    expect([2, 4, 8, 15.5].map((gb) => agentRoom(gb, false))).toEqual([1, 2, 6, 14])
    expect([4, 8, 16, 36].map((gb) => agentRoom(gb, true))).toEqual([1, 4, 12, 32])
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
      // Un Mac (portable ou fixe) : les mêmes phrases, plus celles du chemin Tailscale.
      for (const kind of ['laptop', 'desktop'] as const) {
        const m = { ...base.machine, kind, mac: true, os: 'macOS 15.1', alwaysOn: false, host: 'MacBook-Air.local' }
        for (const sudo of ['password', 'no'] as const)
          for (const pkg of ['brew', null])
            for (const reach of ['local', 'lan', 'public'] as const) {
              const s = { ...base, machine: m, sudo, pkg, reach, https: false }
              const said = [t.reachAsk(s), t.reachMacGo]
              // Rien n'y demande les droits administrateur, un VPS ou un nom de domaine : le Mac est à son propriétaire.
              for (const x of said) expect(x, x).not.toMatch(/admin rights|droits administrateur|VPS|\bserver|\bserveur|domain|domaine|sudo/i)
              expect(said[0]).toContain('Tailscale')
              texts.push(...said, t.reachMacDomain('weevils.example.com'), t.machine(m), t.claudeMissing(m), t.machineAsk(s), t.voiceAsk(s), t.securityAsk(s), t.githubAsk(s), installStatus(s))
            }
      }
      texts.push(t.claudeLogin, t.claudeLink('https://claude.com/x'), t.codexCode('https://auth.openai.com/codex/device', 'ABCD-EFGH'), t.machineNone, t.machineIn('root@203.0.113.7', 'Ubuntu'), t.githubNoCli('404'), t.quotaAsk([]), t.mailAsk, t.devilAsk(false, ''))
      for (const x of texts) expect(x, x).not.toMatch(COMMAND)
    })
  }
})

describe('what weevboss is handed on a Mac', async () => {
  const { reachBrief, machineBrief } = await import('./setup.ts')
  const state = (mac: boolean) =>
    ({
      machine: { kind: mac ? 'laptop' : 'vps', mac, os: mac ? 'macOS 15.1' : 'Ubuntu 24.04', cpus: 8, ramGb: 16, uptimeDays: 1, alwaysOn: !mac, host: 'box', user: 'me', sshTarget: 'me@box', agents: 12, others: [], othersAlwaysOn: false },
      reach: 'local', port: 4179, clone: '~/weevils', sudo: mac ? 'password' : 'yes', pkg: mac ? 'brew' : 'apt',
    }) as any
  it('reach: the Tailscale app and its own command, a link when it is missing, then install.sh --url; never sudo, the Linux script or a domain', () => {
    for (const domain of ['', 'weevils.example.com']) {
      const b = reachBrief(state(true), domain)
      expect(b).not.toMatch(/\bsudo\b|tailscale\.com\/install\.sh|--domain|Caddy|systemctl|WEEVILS_PUBLIC_URL/)
      expect(b).toContain('/Applications/Tailscale.app/Contents/MacOS/Tailscale')
      expect(b).toContain('https://tailscale.com/download/mac')
      expect(b).toContain('serve --bg 4179`')
      expect(b).toContain('`~/weevils/install.sh --agent --url https://')
      expect(b).toContain('never ask the user to type one')
      expect(b).toContain('[[setup:phone]]')
    }
  })
  it('reach on Linux: as before', () => {
    expect(reachBrief(state(false), '')).toContain('`sudo tailscale serve --bg 4179`')
    expect(reachBrief(state(false), '')).toContain('https://tailscale.com/install.sh')
    expect(reachBrief(state(false), 'weevils.example.com')).toContain('`~/weevils/install.sh --yes --domain weevils.example.com`')
  })
  it('plugging a VPS from a Mac: weevils-service, never systemctl or admin rights, nothing ssh-ing back into the Mac', () => {
    const o = { target: 'root@203.0.113.7', user: 'root', host: '203.0.113.7', port: 22, provider: 'Hetzner', about: 'Ubuntu 24.04' }
    const b = machineBrief({ ...o, here: state(true) })
    expect(b).not.toMatch(/\bsudo\b|ssh back/)
    expect(b).toContain('weevils-service')
    expect(b).toContain('never systemctl')
    expect(b).toContain('make this machine its secondary')
    expect(machineBrief({ ...o, here: state(false) })).not.toMatch(/\bMac\b|launchd/)
  })
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
    // The brand, never the variable name or the file it lands in.
    expect(shown).toContain('my RunPod key: ••••')
    expect(shown).toContain('RunPod key saved on this machine')
    expect(shown).not.toMatch(/RUNPOD_API_KEY|config\/weevils/)
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
