// How weevils starts an agent: the base command (with or without permission prompts) and, for project sessions only,
// the standing plain-voice rule (server/i18n/plain-voice.ts). weevboss keeps the bare command: it has its own system
// prompt (server/boss-turns.ts, --append-system-prompt-file) and its own voice.
import { installationLang, type Lang } from './i18n.ts'
import PlainVoice from './i18n/plain-voice.ts'
import LivingResults from './i18n/living-results.ts'

/** Agents ask before acting (answered from the app) unless the person turned that off: WEEVILS_SAFE=0 (installer
 *  --no-ask-permissions). Unset counts as asking. */
export const askPermissions = (env: NodeJS.ProcessEnv = process.env): boolean => env.WEEVILS_SAFE?.trim() !== '0'
const SAFE = askPermissions()
/** weevboss's Claude command, bare. */
export const CLAUDE: readonly string[] = SAFE ? ['claude'] : ['claude', '--dangerously-skip-permissions']
/** weevboss's Codex flags, bare. */
export const CODEX_FLAGS: readonly string[] = SAFE ? [] : ['--dangerously-bypass-approvals-and-sandbox']

/** The rule, in the installation's language (the one picked in the app), read at launch time. */
export const plainVoice = (l: Lang = installationLang()): string => PlainVoice[l].rule

export const projectInstructions = (l: Lang = installationLang()): string => plainVoice(l) + '\n\n' + LivingResults[l].rule

/** A project session's Claude command: the bare one plus the plain-voice rule appended to Claude Code's system prompt. */
export const projectClaude = (l?: Lang): string[] => [...CLAUDE, '--append-system-prompt', projectInstructions(l)]

/** A project session's Codex flags (after « codex » or « codex resume »): the rule as developer instructions. The value
 *  is TOML; a JSON string is a valid TOML basic string. */
export const projectCodexFlags = (l?: Lang): string[] => [...CODEX_FLAGS, '-c', `developer_instructions=${JSON.stringify(projectInstructions(l))}`]
