// Messages of server/transcripts.ts. Speaker labels go into the renamer's prompt material (digestOf).
import { defineMessages } from '../i18n.ts'

export default defineMessages({
  fr: {
    subagent: 'sous-agent',
    task: 'tâche',
    /** Background command (Bash run_in_background) without a description. */
    command: 'commande',
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
    workflow: 'workflow',
    tool: 'tool',
    newSession: 'new session',
    userLabel: 'user',
    said: (who: string, text: string) => `${who}: ${text}`,
  },
})
