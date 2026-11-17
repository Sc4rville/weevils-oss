// Claude Code's login, read from its file or (on a Mac) from the Keychain. The Mac's side runs here on Linux: the
// platform and the `security` command are passed in. Nothing touches a real Keychain or the real HOME.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { claudeLoggedIn, claudeOauth, claudePlanName, forgetClaudeOauth, parseKeychain, type Probe } from './claude-credentials.ts'
import type { Exec } from './platform.ts'

const HOME = process.env.HOME!
const FILE = path.join(HOME, '.claude', '.credentials.json')
const ACCOUNT = path.join(HOME, '.claude.json')
const T0 = Date.parse('2026-11-13T10:00:00Z')
const MIN = 60_000

const login = (o: object) => JSON.stringify({ claudeAiOauth: o })
const inFile = (text: string) => {
  fs.mkdirSync(path.dirname(FILE), { recursive: true })
  fs.writeFileSync(FILE, text)
}
/** A `security` that answers with this text (or fails), and counts how often it was asked. */
const security = (answer: string | Error) => vi.fn<Exec>(async () => (answer instanceof Error ? Promise.reject(answer) : answer))

beforeEach(() => {
  // Whatever the developer's shell holds: these tests decide who is logged in.
  vi.stubEnv('ANTHROPIC_API_KEY', '')
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '')
  fs.rmSync(FILE, { force: true })
  fs.rmSync(ACCOUNT, { force: true })
  forgetClaudeOauth()
})
afterEach(() => vi.unstubAllEnvs())

describe('parseKeychain', () => {
  const json = login({ accessToken: 'tok', subscriptionType: 'max' })

  it('`security -w` prints the JSON as text, with its newline', () => {
    expect(parseKeychain(json + '\n')).toEqual({ accessToken: 'tok', subscriptionType: 'max' })
  })

  it('or as hex when the secret holds bytes it will not print (an accent, a newline)', () => {
    const accent = JSON.stringify({ claudeAiOauth: { accessToken: 'tok', subscriptionType: 'max' }, note: 'clé\n' })
    expect(parseKeychain(Buffer.from(accent, 'utf8').toString('hex') + '\n')).toEqual({ accessToken: 'tok', subscriptionType: 'max' })
    expect(parseKeychain(Buffer.from(json, 'utf8').toString('hex').toUpperCase())).toEqual({ accessToken: 'tok', subscriptionType: 'max' })
  })

  it('anything else is no login: empty, not JSON, JSON without claudeAiOauth, hex of something else, a bare number', () => {
    for (const out of ['', '\n', 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.', '{"mcpOAuth":{}}', '{"claudeAiOauth":"x"}', 'deadbeef', '1234', 'abc'])
      expect(parseKeychain(out)).toBeNull()
  })
})

describe('claudeOauth', () => {
  it('the file wins: the Keychain is not asked, on a Mac either', async () => {
    inFile(login({ accessToken: 'from-file', subscriptionType: 'pro' }))
    const run = security(login({ accessToken: 'from-keychain' }))
    expect(await claudeOauth('darwin', run, T0)).toEqual({ accessToken: 'from-file', subscriptionType: 'pro' })
    expect(await claudeOauth('linux', run, T0)).toEqual({ accessToken: 'from-file', subscriptionType: 'pro' })
    expect(run).not.toHaveBeenCalled()
  })

  it('Linux without a file, or with one that holds no token: null (or what the file says), `security` is never run', async () => {
    const run = security(login({ accessToken: 'from-keychain' }))
    expect(await claudeOauth('linux', run, T0)).toBeNull()
    inFile('{not json')
    expect(await claudeOauth('linux', run, T0)).toBeNull()
    inFile(login({ subscriptionType: 'pro' }))
    expect(await claudeOauth('linux', run, T0)).toEqual({ subscriptionType: 'pro' })
    expect(run).not.toHaveBeenCalled()
  })

  it('a Mac without the file: the Keychain entry « Claude Code-credentials », read with -w by /usr/bin/security', async () => {
    const run = security(login({ accessToken: 'from-keychain', subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' }) + '\n')
    expect(await claudeOauth('darwin', run, T0)).toEqual({ accessToken: 'from-keychain', subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' })
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0][0]).toBe('/usr/bin/security')
    expect(run.mock.calls[0][1]).toEqual(['find-generic-password', '-s', 'Claude Code-credentials', '-w'])
  })

  it('a Mac whose file holds no token (an old one, emptied): the Keychain is asked', async () => {
    inFile(login({ subscriptionType: 'pro' }))
    const run = security(login({ accessToken: 'from-keychain' }))
    expect((await claudeOauth('darwin', run, T0))?.accessToken).toBe('from-keychain')
  })

  it('a Mac: the hex form is read too', async () => {
    const run = security(Buffer.from(login({ accessToken: 'from-hex' }), 'utf8').toString('hex') + '\n')
    expect((await claudeOauth('darwin', run, T0))?.accessToken).toBe('from-hex')
  })

  it('`security` fails (no entry, locked Keychain, timeout): null, and the next call asks again', async () => {
    const run = security(new Error('exit 44'))
    expect(await claudeOauth('darwin', run, T0)).toBeNull()
    expect(await claudeOauth('darwin', run, T0 + 1000)).toBeNull()
    expect(run).toHaveBeenCalledTimes(2)
    // An answer that holds no login is no better, and is not kept.
    const empty = security('{}')
    expect(await claudeOauth('darwin', empty, T0)).toBeNull()
    expect(await claudeOauth('darwin', empty, T0 + 1000)).toBeNull()
    expect(empty).toHaveBeenCalledTimes(2)
  })

  it('a failure after a good read forgets the good read', async () => {
    expect((await claudeOauth('darwin', security(login({ accessToken: 'a' })), T0))?.accessToken).toBe('a')
    expect(await claudeOauth('darwin', security(new Error('locked')), T0 + 11 * MIN)).toBeNull()
    const run = security(login({ accessToken: 'b' }))
    expect((await claudeOauth('darwin', run, T0 + 11 * MIN + 1))?.accessToken).toBe('b')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('the Keychain is asked once, then again 10 minutes later', async () => {
    const run = security(login({ accessToken: 'a', expiresAt: T0 + 8 * 3600_000 }))
    await claudeOauth('darwin', run, T0)
    expect((await claudeOauth('darwin', run, T0 + 9 * MIN))?.accessToken).toBe('a')
    expect(run).toHaveBeenCalledTimes(1)
    await claudeOauth('darwin', run, T0 + 10 * MIN + 1)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('a token about to expire (under a minute left) is not served from memory: Claude Code may have renewed it', async () => {
    const run = security(login({ accessToken: 'old', expiresAt: T0 + 5 * MIN }))
    await claudeOauth('darwin', run, T0)
    await claudeOauth('darwin', run, T0 + 3 * MIN)
    expect(run).toHaveBeenCalledTimes(1)
    run.mockImplementation(async () => login({ accessToken: 'new', expiresAt: T0 + 8 * 3600_000 }))
    expect((await claudeOauth('darwin', run, T0 + 4 * MIN + 1))?.accessToken).toBe('new')
    expect(run).toHaveBeenCalledTimes(2)
    expect((await claudeOauth('darwin', run, T0 + 6 * MIN))?.accessToken).toBe('new')
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('forgetClaudeOauth (a refused token, a new login): the next read asks the Keychain again', async () => {
    const run = security(login({ accessToken: 'a' }))
    await claudeOauth('darwin', run, T0)
    await claudeOauth('darwin', run, T0 + 1000)
    expect(run).toHaveBeenCalledTimes(1)
    forgetClaudeOauth()
    await claudeOauth('darwin', run, T0 + 2000)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('a file that appears later wins over what the Keychain gave', async () => {
    await claudeOauth('darwin', security(login({ accessToken: 'from-keychain' })), T0)
    inFile(login({ accessToken: 'from-file' }))
    expect((await claudeOauth('darwin', security(new Error('never')), T0 + 1000))?.accessToken).toBe('from-file')
  })
})

describe('claudePlanName', () => {
  it('the plan of the file, lower case; nothing odd is let through', () => {
    expect(claudePlanName()).toBe('')
    inFile(login({ accessToken: 't', subscriptionType: 'Max' }))
    expect(claudePlanName()).toBe('max')
    inFile(login({ accessToken: 't', subscriptionType: 'max <script>' }))
    expect(claudePlanName()).toBe('')
    inFile(login({ accessToken: 't' }))
    expect(claudePlanName()).toBe('')
  })

  it('a Mac: empty until the Keychain was read once, then the plan it gave; empty again once forgotten', async () => {
    expect(claudePlanName()).toBe('')
    await claudeOauth('darwin', security(login({ accessToken: 't', subscriptionType: 'pro' })), T0)
    expect(claudePlanName()).toBe('pro')
    forgetClaudeOauth()
    expect(claudePlanName()).toBe('')
  })
})

describe('claudeLoggedIn', () => {
  const no: Probe = () => false

  it('a key in the environment: logged in, nothing else is looked at', () => {
    const has = vi.fn<Probe>(() => false)
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test')
    expect(claudeLoggedIn('darwin', has, T0)).toBe(true)
    expect(claudeLoggedIn('linux', has, T0)).toBe(true)
    vi.stubEnv('ANTHROPIC_API_KEY', '  ')
    expect(claudeLoggedIn('linux', has, T0)).toBe(false)
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'tok')
    expect(claudeLoggedIn('linux', has, T0)).toBe(true)
    expect(claudeLoggedIn('darwin', has, T0)).toBe(true)
    expect(has).not.toHaveBeenCalled()
  })

  it('the credentials file: logged in on both systems without asking the Keychain; an empty « {} » is not a login', () => {
    const has = vi.fn<Probe>(() => false)
    inFile(login({ accessToken: 't' }))
    expect(claudeLoggedIn('linux', has, T0)).toBe(true)
    expect(claudeLoggedIn('darwin', has, T0)).toBe(true)
    expect(has).not.toHaveBeenCalled()
    inFile('{}')
    expect(claudeLoggedIn('linux', has, T0)).toBe(false)
  })

  it('Linux with neither: not logged in, `security` is never run, ~/.claude.json does not count', () => {
    const has = vi.fn<Probe>(() => true)
    fs.writeFileSync(ACCOUNT, JSON.stringify({ oauthAccount: { emailAddress: 'u@example.com' } }))
    expect(claudeLoggedIn('linux', has, T0)).toBe(false)
    expect(has).not.toHaveBeenCalled()
  })

  it('a Mac: the Keychain entry is only looked for (no -w: no secret read, no dialog)', () => {
    const has = vi.fn<Probe>(() => true)
    expect(claudeLoggedIn('darwin', has, T0)).toBe(true)
    expect(has).toHaveBeenCalledTimes(1)
    expect(has.mock.calls[0]).toEqual(['/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials']])
    expect(claudeLoggedIn('darwin', no, T0 + 30_000)).toBe(false)
  })

  it('a Mac: the answer is kept 15 s (this is called often), then asked again', () => {
    const has = vi.fn<Probe>(() => true)
    expect(claudeLoggedIn('darwin', has, T0)).toBe(true)
    has.mockReturnValue(false)
    expect(claudeLoggedIn('darwin', has, T0 + 1000)).toBe(true)
    expect(claudeLoggedIn('darwin', has, T0 + 15_000)).toBe(true)
    expect(has).toHaveBeenCalledTimes(1)
    expect(claudeLoggedIn('darwin', has, T0 + 15_001)).toBe(false)
    expect(has).toHaveBeenCalledTimes(2)
    // A « no » is kept just as long, and forgetClaudeOauth (a new login) drops it at once.
    has.mockReturnValue(true)
    expect(claudeLoggedIn('darwin', has, T0 + 20_000)).toBe(false)
    forgetClaudeOauth()
    expect(claudeLoggedIn('darwin', has, T0 + 20_001)).toBe(true)
    expect(has).toHaveBeenCalledTimes(3)
  })

  it('a Mac whose Keychain cannot be asked (over SSH): the account Claude Code noted in ~/.claude.json counts', () => {
    expect(claudeLoggedIn('darwin', no, T0)).toBe(false)
    forgetClaudeOauth()
    fs.writeFileSync(ACCOUNT, JSON.stringify({ numStartups: 3, oauthAccount: { emailAddress: 'u@example.com' } }, null, 2))
    expect(claudeLoggedIn('darwin', no, T0)).toBe(true)
  })

  it('a Mac: ~/.claude.json without an account, with an empty one or unreadable is no login; a logout is seen', () => {
    for (const text of [JSON.stringify({ numStartups: 3 }), JSON.stringify({ oauthAccount: null }), '{broken']) {
      forgetClaudeOauth()
      fs.writeFileSync(ACCOUNT, text)
      expect(claudeLoggedIn('darwin', no, T0)).toBe(false)
    }
    forgetClaudeOauth()
    fs.writeFileSync(ACCOUNT, JSON.stringify({ oauthAccount: { emailAddress: 'u@example.com' } }))
    fs.utimesSync(ACCOUNT, new Date(T0), new Date(T0))
    expect(claudeLoggedIn('darwin', no, T0)).toBe(true)
    // Logged out: Claude Code rewrites the file without the account.
    fs.writeFileSync(ACCOUNT, JSON.stringify({ numStartups: 4 }))
    fs.utimesSync(ACCOUNT, new Date(T0 + 60_000), new Date(T0 + 60_000))
    expect(claudeLoggedIn('darwin', no, T0 + 60_000)).toBe(false)
  })

  // Not on a real Mac: there the default probe would ask the developer's own Keychain.
  it.skipIf(process.platform === 'darwin')('the default probe never throws: without /usr/bin/security (this host) the answer is « no »', () => {
    expect(claudeLoggedIn('darwin', undefined, T0)).toBe(false)
  })
})
