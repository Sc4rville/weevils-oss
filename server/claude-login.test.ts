import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as login from './claude-login.ts'

// A stand-in for « claude auth login --claudeai », as the real CLI 2.1 behaves without a terminal: the address inside an
// OSC 8 hyperlink, written in two pieces; the code read from stdin. A good code saves the login and the CLI lingers
// (it does not exit); a bad one fails like the real one.
const URL = 'https://claude.com/cai/oauth/authorize?code=true&client_id=c&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&code_challenge=abc&state=xyz'
const P = URL.replace(/%/g, "%%")
const FAKE = `#!/bin/sh
printf 'Opening browser to sign in…\\nIf the browser didn'"'"'t open, visit: \\033]8;;${P.slice(0, 60)}'
sleep 0.6
printf '${P.slice(60)}\\007${P}\\033]8;;\\007\\nPaste code here if prompted > '
read code
if [ "$code" = "good#xyz" ]; then echo '{"claudeAiOauth":{}}' > "$CREDS"; echo 'Login successful.'; sleep 30
else echo "Login failed: That code wasn't accepted."; exit 1; fi
`

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) {
    login.cancel(deps(d))
    fs.rmSync(d, { recursive: true, force: true })
  }
})

function deps(root: string): login.LoginDeps {
  const creds = path.join(root, 'creds.json')
  return { dir: path.join(root, 'claude-login'), bin: path.join(root, 'claude'), env: { ...process.env, CREDS: creds }, logged: () => fs.existsSync(creds) }
}
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-claude-login-'))
  dirs.push(root)
  fs.writeFileSync(path.join(root, 'claude'), FAKE, { mode: 0o755 })
  return root
}

describe('Claude Code sign-in driven by weevils', () => {
  it('reads the whole sign-in address out of the OSC 8 link, never a half-written one', () => {
    expect(login.loginUrl(`visit: \x1b]8;;${URL.slice(0, 60)}`)).toBe('')
    expect(login.loginUrl(`visit: \x1b]8;;${URL}\x07${URL}\x1b]8;;\x07\nPaste code here`)).toBe(URL)
  })

  it('hands the code to the same login after weevilsd restarted, and sees the login even if the CLI never exits', async () => {
    const root = setup()
    expect(await login.start(deps(root))).toBe(URL)
    // A new server process: nothing kept in memory, only the folder.
    const after = deps(root)
    expect(login.pending(after)?.url).toBe(URL)
    expect(await login.start(after)).toBe(URL) // a second tap gives the same page, not a new login
    expect(await login.submit(after, ' good#xyz \n')).toEqual({ ok: true })
    expect(login.pending(after)).toBeNull()
  }, 20_000)

  it('says why a wrong code failed, and a retry starts a fresh sign-in', async () => {
    const root = setup()
    await login.start(deps(root))
    const r = await login.submit(deps(root), 'bad#code')
    expect(r).toEqual({ ok: false, why: "That code wasn't accepted." })
    expect(await login.submit(deps(root), 'good#xyz')).toEqual({ ok: false, why: 'expired' })
    expect(await login.start(deps(root))).toBe(URL)
  }, 20_000)
})
