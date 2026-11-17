import fs from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { HOME, CODEX_DIR } from './config.ts'
import { preferredTool, providerStatus, providerReady } from './provider.ts'
import { forgetClaudeOauth } from './claude-credentials.ts'
// A Mac, on this Linux host: while a test sets mac.keychain, Claude's login is checked as on a Mac (platform « darwin »,
// that answer in place of the real `security`). Otherwise nothing changes: this host's own check.
const mac = vi.hoisted(() => ({ keychain: undefined as undefined | (() => boolean) }))
vi.mock('./claude-credentials.ts', async (orig) => {
 const real = await orig<typeof import('./claude-credentials.ts')>()
 return { ...real, claudeLoggedIn: (_p?: unknown, _h?: unknown, _n?: unknown, tokenOnly?: boolean) => (mac.keychain ? real.claudeLoggedIn('darwin', mac.keychain, undefined, tokenOnly) : real.claudeLoggedIn(undefined, undefined, undefined, tokenOnly)) }
})
afterEach(()=>{vi.unstubAllEnvs();mac.keychain=undefined;forgetClaudeOauth()})
it('requires the selected CLI and credentials, never substitutes another provider',()=>{
 const bin=path.join(HOME,'bin');fs.mkdirSync(bin,{recursive:true});vi.stubEnv('PATH',bin);vi.stubEnv('WEEVILS_PROVIDER','codex')
 expect(preferredTool()).toBe('codex');expect(providerReady()).toBe(false)
 fs.writeFileSync(path.join(bin,'codex'),'#!/bin/sh\nexit 0\n',{mode:0o700})
 const auth=path.join(path.dirname(CODEX_DIR),'auth.json');fs.mkdirSync(path.dirname(auth),{recursive:true});fs.writeFileSync(auth,'{}')
 expect(providerStatus()).toEqual({installed:true,logged:false})
 fs.writeFileSync(auth,JSON.stringify({tokens:{access_token:'fixture'}}))
 expect(providerReady()).toBe(true)
 vi.stubEnv('WEEVILS_PROVIDER','claude');expect(preferredTool()).toBe('claude');expect(providerReady()).toBe(false)
})

it('Claude: found where its installer put it even when the PATH lacks that folder; logged in by its file or by a key', () => {
 const empty = path.join(HOME, 'empty-path'); fs.mkdirSync(empty, { recursive: true })
 vi.stubEnv('PATH', empty); vi.stubEnv('WEEVILS_PROVIDER', 'claude'); vi.stubEnv('ANTHROPIC_API_KEY', ''); vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '')
 const bin = path.join(HOME, '.local', 'bin', 'claude'), file = path.join(HOME, '.claude', '.credentials.json')
 fs.rmSync(bin, { force: true }); fs.rmSync(file, { force: true })
 expect(providerStatus()).toEqual({ installed: false, logged: false })
 fs.mkdirSync(path.dirname(bin), { recursive: true }); fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
 expect(providerStatus()).toEqual({ installed: true, logged: false })
 fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: 'fixture' } }))
 expect(providerStatus()).toEqual({ installed: true, logged: true })
 expect(providerReady()).toBe(true)
 fs.rmSync(file)
 expect(providerReady()).toBe(false)
 vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'fixture')
 expect(providerReady()).toBe(true)
 fs.rmSync(bin)
})

it('Claude on a Mac: no credentials file, the login is the Keychain entry; without it, not logged in', () => {
 const empty = path.join(HOME, 'empty-path'); fs.mkdirSync(empty, { recursive: true })
 vi.stubEnv('PATH', empty); vi.stubEnv('WEEVILS_PROVIDER', 'claude'); vi.stubEnv('ANTHROPIC_API_KEY', ''); vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '')
 const bin = path.join(HOME, '.local', 'bin', 'claude')
 fs.mkdirSync(path.dirname(bin), { recursive: true }); fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
 fs.rmSync(path.join(HOME, '.claude', '.credentials.json'), { force: true }); fs.rmSync(path.join(HOME, '.claude.json'), { force: true })
 const asked = vi.fn(() => false)
 mac.keychain = asked
 expect(providerStatus()).toEqual({ installed: true, logged: false })
 // Asked once for a burst of checks (kept 15 s), and again after a new login was announced.
 for (let i = 0; i < 5; i++) expect(providerReady()).toBe(false)
 expect(asked).toHaveBeenCalledTimes(1)
 asked.mockReturnValue(true)
 forgetClaudeOauth()
 expect(providerStatus()).toEqual({ installed: true, logged: true })
 expect(providerReady()).toBe(true)
 // Codex is not Claude: its own file decides, the Keychain entry of Claude changes nothing.
 fs.rmSync(path.join(path.dirname(CODEX_DIR), 'auth.json'), { force: true })
 expect(providerStatus('codex').logged).toBe(false)
 fs.rmSync(bin)
})
