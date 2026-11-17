import { tr } from './i18n.ts'
import P from './i18n/provider.ts'
/** Local provider choice and credential presence; never logs in or calls an AI. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Tool } from '../shared/api.ts'
import { CODEX_DIR } from './config.ts'
import { claudeLoggedIn } from './claude-credentials.ts'
import { which } from './platform.ts'
export const preferredTool = (): Tool => process.env.WEEVILS_PROVIDER === 'codex' ? 'codex' : 'claude'
let route: ((tool: Tool) => Tool | null) | undefined
export function setProviderRoute(select: (tool: Tool) => Tool | null) { route = select }
/** Runtime quota routing does not rewrite the user's configured provider/model/effort. */
export function availableTool(tool = preferredTool()): Tool {
 const selected = route ? route(tool) : tool
 if (!selected) throw new Error(tr(P).waiting)
 return selected
}
const read = (file: string): any => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }
export function codexLogged(): boolean {
 const auth = read(path.join(path.dirname(CODEX_DIR), 'auth.json'))
 return !!(auth?.tokens?.access_token || auth?.OPENAI_API_KEY || process.env.OPENAI_API_KEY?.trim())
}
export function providerStatus(tool: Tool = preferredTool()): { installed: boolean; logged: boolean } {
 // Same lookup as the setup (Homebrew's folders on a Mac) and the same login check (the Keychain on a Mac).
 const installed = !!which(tool, process.platform, os.homedir())
 // As before: a key in the environment or Claude's token in the credentials file. On a Mac: the Keychain as well.
 const logged = tool === 'codex' ? codexLogged() : claudeLoggedIn(undefined, undefined, undefined, true)
 return {installed,logged}
}
export const providerReady = () => { const s=providerStatus();return s.installed && s.logged }

export const providerUnavailable = (tool: Tool = preferredTool()) => tr(P).unavailable(tool === 'codex' ? 'Codex' : 'Claude')
