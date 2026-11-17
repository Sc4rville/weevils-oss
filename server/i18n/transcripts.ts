// Messages of server/transcripts.ts. Speaker labels go into the renamer's prompt material (digestOf).
import { defineMessages } from '../i18n.ts'

export default defineMessages({
  fr: {
    subagent: 'sous-agent',
    task: 'tâche',
    /** Background command (Bash run_in_background) without a description. */
    command: 'commande',
    /** A command run in the background, or a job writing its log, when the agent gave it no description (never the raw command). */
    bgCommand: 'Commande en arrière-plan',
    /** Same, when the command runs tests (vitest, playwright…). */
    testRun: 'Test',
    /** Workflow whose name is unknown. */
    workflow: 'workflow',
    /** Codex tool call without a name, in the session's event lines. */
    tool: 'outil',
    newSession: 'nouvelle session',
    userLabel: 'utilisateur',
    said: (who: string, text: string) => `${who} : ${text}`,
  },
  en: {
    subagent: 'subagent',
    task: 'task',
    command: 'command',
    bgCommand: 'Background command',
    testRun: 'Test run',
    workflow: 'workflow',
    tool: 'tool',
    newSession: 'new session',
    userLabel: 'user',
    said: (who: string, text: string) => `${who}: ${text}`,
  },
})
