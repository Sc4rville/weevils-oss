import { nestedCalls, commandSummaries } from './codex-command-details.ts'
import { tr } from './i18n.ts'
import M from './i18n/codex-tools.ts'

/** Only fixed, translated labels leave this boundary; never copy arguments, URLs or code. */
export function codexToolLabel(name: string, input: unknown): string {
  const t = tr(M)
  const value = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const command = value.cmd ?? value.command
  const rawCommand = (Array.isArray(command) ? command.join(' ') : typeof command === 'string' ? command : '').trim()
  const cmd = commandSummaries([rawCommand])[0] ?? rawCommand
  const shell = () => {
    if (/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint|typecheck)\b/.test(cmd)) return t.test
    if (/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b/.test(cmd)) return t.build
    if (/^(?:rg|grep|find)\b/.test(cmd)) return t.search
    if (/^(?:cat|head|tail|sed|ls|pwd)\b/.test(cmd)) return t.read
    if (/^git\s+(?:status|diff|log|show|branch|worktree)\b/.test(cmd)) return t.git
    return t.command
  }
  const label = (raw: string): string => {
    const n = raw.split(/\.|__/).at(-1) ?? raw
    if (['exec_command', 'shell', 'local_shell', 'local_shell_call'].includes(n)) return shell()
    if (['apply_patch', 'write_file', 'edit_file'].includes(n)) return t.edit
    if (['read_file', 'list_dir'].includes(n)) return t.read
    if (['view_image', 'screenshot'].includes(n)) return t.image
    if (['write_stdin', 'wait', 'sleep', 'wait_agent'].includes(n)) return t.wait
    if (['send_message_to_thread', 'send_message', 'spawn_agent', 'followup_task'].includes(n)) return t.message
    if (['request_user_input', 'request_user_input_async'].includes(n)) return t.question
    if (raw.includes('web') || ['search_query', 'image_query'].includes(n)) return t.web
    return t.tool
  }
  if (name.split('.').at(-1) === 'exec') {
    const labels = [...new Set(nestedCalls(input).map(call => call.command ? codexToolLabel(call.name, {cmd:call.command}) : label(call.name)))]
    return labels.length ? labels.slice(0, 3).join(' · ') : t.command
  }
  return label(name)
}

/** Stable categories let the client follow its selected locale after a refresh. */
export function codexToolKinds(name: string, input: unknown): string[] {
  const catalog=tr(M)
  return codexToolLabel(name,input).split(' · ').flatMap(label=>Object.entries(catalog).filter(([,value])=>value===label).map(([key])=>key))
}
