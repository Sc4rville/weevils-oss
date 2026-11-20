// What a Claude Code / Codex terminal screen means, for a phone that never shows a terminal.
//
// readScreen() turns a captured pane (tmux capture-pane) into one of:
//   question — one plain question with labeled answers (permissions, plans, choices, unknown menus);
//   auto     — a dialog weevils answers by itself, because the answer is safe and already authorized
//              (folder trust, bypass-mode warning, update and model nudges, resume, usage-limit wait…);
//   picker   — a settings menu (/model, /effort, resume list): never a question, closed when nobody asked for it;
//   hold     — a calm status line (usage limit, signed out, stopped): nothing to answer;
//   none     — the composer or ordinary output.
// The recorded screens these rules come from are in test/fixtures/terminal/ (server/terminal.test.ts replays them).

import { createHash } from 'node:crypto'
import { tr } from './i18n.ts'
import M from './i18n/terminal.ts'

export type Agent = 'claude' | 'codex'

export interface MenuOption {
  /** Label as written on screen, number and key hint removed. */
  raw: string
  description?: string
  checked?: boolean
}

export interface Menu {
  /** Lines between the dialog's top rule and its first option, trimmed, without decoration. */
  heading: string[]
  options: MenuOption[]
  /** Index of the option under the cursor. */
  selected: number
  footer: string
  numbered: boolean
}

export interface Choice {
  /** `<token>:<menu index>`: the token changes with the question, so a stale tap never hits another dialog. */
  id: string
  label: string
}

export type TerminalState =
  | { kind: 'none' }
  | {
      kind: 'question'
      /** Known state name, or 'unknown' (logged so it gets a proper translation later). */
      name: string
      question: string
      detail?: string
      choices: Choice[]
      menu?: Menu
      /** Menu index of a free-text row ("Type something."): a message sent now answers the question. */
      typeIndex?: number
      multi?: boolean
    }
  | { kind: 'auto'; name: string; menu?: Menu; pick: number | 'enter'; hold?: Hold }
  | { kind: 'picker'; name: string; menu?: Menu }
  | { kind: 'hold'; name: string; hold: Hold }

export interface Hold {
  reason: 'quota' | 'auth' | 'died' // i18n-ignore : code de raison, pas un texte affiché
  text: string
}

export interface Reading {
  state: TerminalState
  /** The agent's ordinary input box is on screen (it can take a message). */
  composer: boolean
  /** A live progress indicator is on screen. */
  working: boolean
  /** Codex follow-up messages waiting in its queue. */
  queued: number
}

// ---------------------------------------------------------------- lines

const BOX = /[│╭╮╰╯┃┆┊]/g
const RULE = /^\s*[─━▔]{16,}/
const DASHED = /^\s*╌{4,}/
const MARK = /^(\s*)([❯›>])(\s+)(\S.*)$/

/** Box decoration becomes blank (a search box border is no dialog rule); trailing spaces go. */
const clean = (l: string) => (/^\s*[╭╰][─]+[╮╯]\s*$/.test(l) ? '' : l.replace(BOX, ' ').replace(/\s+$/, ''))
const indent = (l: string) => l.length - l.trimStart().length
const blank = (l: string) => !l.trim()

/** Spinner or retry line of a turn at work. A finished turn ("✻ Baked for 9s · done") has no ellipsis. */
const WORKING = /^\s*(?:[·✢✳✶✻✽*]\s+\S[^\n]*…|[•●◦∙]\s+(?:Working|Thinking|Running|Reconnecting)\b[^\n]*(?:\(|…)|Reconnecting\.\.\.)/u

export function workingOnScreen(text: string): boolean {
  return text.trimEnd().split('\n').slice(-14).some((l) => WORKING.test(l))
}

/** The ordinary input box: Claude's "❯" between two rules, Codex's "›" over its status line. */
function composerAt(lines: string[], i: number): boolean {
  const m = MARK.exec(lines[i]) ?? /^(\s*)([❯›>])(\s*)$/.exec(lines[i])
  if (!m) return false
  let up = i - 1
  while (up >= 0 && blank(lines[up])) up--
  if (up >= 0 && RULE.test(lines[up]) && m[1].length === 0) {
    for (let k = i + 1; k < Math.min(lines.length, i + 8); k++) if (RULE.test(lines[k])) return true
  }
  if (m[2] === '›' || m[2] === '>') {
    const after = lines.slice(i + 1, i + 5).join('\n')
    if (/\? for shortcuts|← for agents|for agents ·|tab to queue|⏎ send|ctrl\+j newline/i.test(after)) return true
    if (/^\s*›\s+Ask Codex to do anything/.test(lines[i])) return true
  }
  // The old boxed composer: "│ > text │" with "? for shortcuts" under the box.
  if (m[2] === '>' && /\? for shortcuts/.test(lines.slice(i + 1, i + 4).join('\n'))) return true
  return false
}

// "esc to interrupt" alone is the working footer, not a dialog's.
const FOOTER = /enter(?: to)? (?:confirm|select|continue|submit|set)|enter (?:select|continue|submit|confirm|default)|esc(?:ape)? (?:to )?(?:cancel|back|dismiss|skip|exit|go back|clear)|↑.*↓|←\/→ to adjust|tab to (?:amend|add notes|toggle)|to navigate|press enter to confirm|ctrl\+g to edit|shift\+tab to approve|\(y\/n\)/i
const NUMBER = /^(\d{1,2})[.)]\s+(.*)$/
const CHECK = /^\[( |x|X|✔|✓|✗)\]\s*/
const KEYHINT = /\s*\((?:[a-z]|esc|enter|tab|shift\+tab|ctrl\+[a-z]|⏎)\)\s*$/i

/** The option rows around a cursor line, with their descriptions; undefined when it is not a menu. */
function menuAt(lines: string[], ci: number): Menu | undefined {
  const m = MARK.exec(lines[ci])
  if (!m) return undefined
  const textCol = m[1].length + m[2].length + m[3].length
  // "❯ ✔ Dark mode": the other rows align with the label, after the check mark.
  const labelCol = /^[✔✓]\s/.test(m[4]) ? textCol + 2 : textCol
  const numbered = NUMBER.test(m[4])
  // Rows align with the cursor's text; tests and old captures also put numbered rows flush with the cursor.
  const isOpt = (l: string) => indent(l) === textCol || indent(l) === labelCol || (numbered && indent(l) === m[1].length && NUMBER.test(l.trim()))
  // Region of the dialog: from its top rule (Claude) or a blank-line gap, never further than 24 lines up.
  let top = ci - 1
  let gap = 0
  while (top >= 0 && ci - top < 24) {
    const l = lines[top]
    if (RULE.test(l)) break
    if (blank(l)) { if (++gap >= 3) break } else gap = 0
    top--
  }
  top = Math.max(0, top + 1)
  // Block: walk up over option rows, descriptions and single blank lines.
  let a = ci
  for (let j = ci - 1; j >= top; j--) {
    const l = lines[j]
    if (blank(l)) { if (j - 1 >= top && !blank(lines[j - 1]) && indent(lines[j - 1]) >= textCol) continue; break }
    if ((indent(l) < textCol && !isOpt(l)) || DASHED.test(l)) break
    if (numbered && indent(l) === textCol && !NUMBER.test(l.trim())) break
    a = j
  }
  // …and down, including a rule that separates the last options ("4. Chat about this").
  let b = ci
  for (let j = ci + 1; j < lines.length; j++) {
    const l = lines[j]
    if (blank(l)) { if (j + 1 < lines.length && !blank(lines[j + 1]) && indent(lines[j + 1]) >= textCol && !FOOTER.test(lines[j + 1])) continue; break }
    if (RULE.test(l)) { if (j + 1 < lines.length && isOpt(lines[j + 1]) && NUMBER.test(lines[j + 1].trim())) continue; break }
    if ((indent(l) < textCol && !isOpt(l)) || (FOOTER.test(l) && indent(l) <= textCol)) break
    b = j
  }
  while (a < ci && !isOpt(lines[a])) a++
  const options: MenuOption[] = []
  let selected = -1
  let last: MenuOption | undefined
  const multiRows = lines.slice(a, b + 1).some((l) => CHECK.test(l.trim().replace(/^[❯›>]\s*/, '').replace(NUMBER, '$2')))
  for (let j = a; j <= b; j++) {
    const l = lines[j]
    if (blank(l) || RULE.test(l)) continue
    const row = j === ci || isOpt(l)
    let text = (j === ci ? m[4] : l.trim()).trim().replace(/^[✔✓]\s+/, '')
    if (row && numbered && !NUMBER.test(text)) {
      // A numbered menu: an unnumbered row at option level is a description, except the multi-select "Submit".
      if (last) last.description = [last.description, text].filter(Boolean).join(' ')
      continue
    }
    if (!row) {
      if (multiRows && /^Submit$/i.test(text)) { options.push((last = { raw: 'Submit' })); continue }
      if (last) last.description = [last.description, text].filter(Boolean).join(' ')
      continue
    }
    text = text.replace(NUMBER, '$2')
    const checked = CHECK.exec(text)
    if (checked) text = text.slice(checked[0].length)
    // Codex pads a description after the label on the same row.
    const [label, ...rest] = text.split(/\s{2,}/)
    const opt: MenuOption = { raw: label.replace(KEYHINT, '').replace(/\s*✔$/, '').trim() }
    if (rest.length) opt.description = rest.join(' ').replace(KEYHINT, '').trim()
    if (checked) opt.checked = checked[1] !== ' '
    if (j === ci) selected = options.length
    options.push((last = opt))
  }
  if (selected < 0 || !options.length) return undefined
  const footer = lines.slice(b + 1, b + 5).filter((l) => !blank(l) && !RULE.test(l)).slice(0, 2).join(' · ').trim()
  const hasFooter = FOOTER.test(footer)
  const asks = lines.slice(top, a).some((l) => /\?\s*$/.test(l))
  const titled = lines.slice(top, a).some((l) => /^\s*(?:Choose|Select)\b/.test(l))
  if (!hasFooter && !(options.length >= 2 && (numbered || asks || titled))) return undefined
  // Nothing but status lines may follow a menu without a footer: otherwise it is quoted text in the thread.
  if (!hasFooter && !titled && lines.slice(b + 1).some((l) => !blank(l) && !RULE.test(l) && !/^\s*[─━]+\s*\S*\s*─?\s*$/.test(l))) return undefined
  const heading = lines.slice(top, a).map((l) => l.trim()).filter((l) => l && !DASHED.test(l) && !RULE.test(l))
  return { heading, options, selected, footer, numbered }
}

/** The menu at the bottom of the screen, if any: the lowest cursor line that is neither the composer nor history. */
function findMenu(lines: string[], agent: Agent): Menu | undefined {
  const composerBelow = (i: number) => lines.slice(i + 1).some((_, k) => composerAt(lines, i + 1 + k))
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 40); i--) {
    if (!MARK.test(lines[i]) || composerAt(lines, i)) continue
    const menu = menuAt(lines, i)
    if (!menu) continue
    // The agent is at work below it: a menu printed in its output, nothing is waiting.
    if (lines.slice(i + 1).some((l) => WORKING.test(l))) continue
    // A menu over a live composer is a quoted one in the thread. Claude's dialogs replace the composer; only a Codex
    // modal sits over it, with its own footer.
    if (composerBelow(i) && (agent === 'claude' || !FOOTER.test(menu.footer))) continue
    return menu
  }
  return undefined
}

// ---------------------------------------------------------------- meaning

const nameFor = (agent: Agent | undefined) => (agent ?? 'claude')

interface Ctx {
  agent: Agent
  /** The session runs in a folder inside the user's project roots (PROJECT_ROOTS): only there is folder trust answered. */
  trustedFolder: boolean
  menu: Menu
  head: string
  labels: string[]
  lines: string[]
}

const token = (parts: unknown) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 12)

const find = (menu: Menu, re: RegExp) => menu.options.findIndex((o) => re.test(o.raw))

/** The question line of a heading: the last one ending with "?", without bullet or "Reason:". */
function questionLine(heading: string[]): string | undefined {
  const q = [...heading].reverse().find((l) => /\?\s*(?:\(|$)/.test(l) && !/^[←→]/.test(l))
  if (!q) return undefined
  // Columns of an overlay can share a line with the menu under it: keep the segment holding the question.
  const part = q.split(/\s{2,}/).filter((x) => x.includes('?'))[0] ?? q
  const s = part.trim().replace(/^[●•◆]\s*/, '').replace(/^Reason:\s*/i, '')
  // "Quick safety check: Is this a project…? (Like your own code…)" → up to the question mark.
  return s.slice(0, s.lastIndexOf('?') + 1).trim() || undefined
}

/** A short title for a menu weevils doesn't know: its question, else its first meaningful heading line. */
function titleOf(c: Ctx): string {
  const q = questionLine(c.menu.heading)
  if (q) return q.length > 160 ? `${q.slice(0, 157)}…` : q
  const first = c.menu.heading.find((l) => l.length > 3 && !/^[←→⌕]/.test(l) && !/^(?:\/|~\/|\.\.\/)/.test(l) && !/^[─╌]/.test(l))
  return first && first.length <= 120 ? first.replace(/:$/, '') : tr(M).chooseGeneric(c.agent)
}

/** Plain labels for permission answers. */
function answerLabel(raw: string): string {
  const t = tr(M)
  if (/during this session|for this session|for the session|for this conversation|switch to accept edits|accept edits/i.test(raw)) return t.allowSession
  if (/don.?t ask (?:me )?again|always allow|in the future|^yes,? and (?:allow|always)/i.test(raw) && !/^no\b/i.test(raw)) return t.allowAlways
  if (/^yes$|^yes,? (?:proceed|allow|run|just this once|once|grant)\b|^allow(?: once)?$|^approve$/i.test(raw)) return t.allow
  if (/^no\b.*(?:in the future|always|don.?t ask)/i.test(raw)) return t.denyAlways
  if (/^no\b|^deny\b|^reject\b|^cancel$/i.test(raw)) return t.deny
  return raw
}

const shorten = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** Lines between the first pair of dashed rules (command or file preview of a Claude permission). */
function boxed(lines: string[]): string[] {
  const start = lines.findIndex((l) => DASHED.test(l))
  if (start < 0) return []
  const end = lines.findIndex((l, i) => i > start && DASHED.test(l))
  return lines.slice(start + 1, end < 0 ? undefined : end).map((l) => l.trim()).filter(Boolean)
}

/** Looks like shell text (a path, a pipe, a redirection, a heredoc, a well-known command word), not a sentence. */
const SHELLY = /[/\\;|<>`$=]|&&|^(?:cd|python3?|node|npx|npm|pnpm|yarn|bun|git|bash|sh|ls|cat|rm|mv|cp|curl|wget|ffmpeg|docker|make|sed|grep|find|tmux)\b/i

/** « Claude wants to run a command (why) »: never the command itself in the question; the command goes in the detail. */
function runQuestion(agent: Agent, cmd: string, why: string[]): { question: string; detail: string } {
  const t = tr(M)
  // The dialog sometimes puts the description where the command goes and the other way round: the shell text is the command.
  if (!SHELLY.test(cmd)) { const real = why.find((w) => SHELLY.test(w)); if (real) { why = [cmd, ...why.filter((w) => w !== real)]; cmd = real } }
  const plain = why.map((w) => w.trim()).find((w) => w && !SHELLY.test(w) && w.length <= 120)
  const reason = plain ? plain.charAt(0).toLowerCase() + plain.slice(1).replace(/[.:]$/, '') : ''
  const rest = why.map((w) => w.trim()).filter((w) => w && w !== plain)
  return { question: reason ? t.wantsRunWhy(agent, reason) : t.wantsRun(agent), detail: [shorten(cmd, 160), ...rest].join(' · ') }
}

function permission(c: Ctx, rawRegion: string[]): { question: string; detail?: string } | undefined {
  const t = tr(M)
  const h = c.menu.heading
  const q = questionLine(h) ?? ''
  const header = h[0] ?? ''
  const box = boxed(rawRegion)
  const boilerplate = /^\/permissions to update|^Permission rule .* requires confirmation|^Esc to cancel|^Tab to amend|^Do you want|^Would you like/i
  const qAt = h.findIndex((l) => l.includes(q) && q)
  const scope = c.agent === 'codex' && qAt >= 0 ? h.slice(qAt + 1) : h.slice(1)
  const extra = scope.filter((l) => !boilerplate.test(l) && !box.includes(l) && !l.includes(q || '\u0000'))
  let m: RegExpExecArray | null
  if ((m = /^Do you want to (create|make this edit to|edit|overwrite|delete) (.+)\?$/i.exec(q))) {
    const file = m[2].split('/').pop() ?? m[2]
    return { question: /create/i.test(m[1]) ? t.wantsCreate(c.agent, file) : t.wantsEdit(c.agent, file) }
  }
  if (/^(?:Bash|Shell|PowerShell) command$|^Run command$/i.test(header) || /run (?:the following|this) command/i.test(q)) {
    const cmd = box[0] ?? extra.find((l) => /^\$\s/.test(l))?.replace(/^\$\s*/, '') ?? extra[c.agent === 'codex' ? 0 : 1] ?? extra[0]
    const why = c.agent === 'claude' ? extra.filter((l) => l !== cmd && l !== box[0]) : []
    return cmd ? runQuestion(c.agent, cmd.replace(/^\$\s*/, ''), why) : undefined
  }
  if (/fetch/i.test(header) || /fetch this content/i.test(q)) {
    const url = [...extra, ...box].find((l) => /https?:\/\/|\w+\.\w{2,}/.test(l))
    return { question: t.wantsOpen(c.agent, shorten(url ?? header)) }
  }
  if ((m = /network access to ["“]?([^"”?]+)["”]?\?/i.exec(q))) return { question: t.wantsReach(c.agent, m[1]) }
  if (/make the following edits/i.test(q)) {
    const files = extra.map((l) => /^(?:Destination:\s*)?(\S+\.\w+)(?:\s+\([+-]\d.*\))?$/.exec(l)?.[1]).filter(Boolean).map((f) => f!.split('/').pop()!)
    return { question: files.length === 1 ? t.wantsEdit(c.agent, files[0]) : t.wantsEditFiles(c.agent), ...(files.length > 1 ? { detail: files.join(' · ') } : {}) }
  }
  if (/grant these permissions/i.test(q)) return { question: t.wantsMore(c.agent), ...(extra.length ? { detail: shorten(extra.join(' · '), 160) } : {}) }
  if (/send input to|type into/i.test(q)) return { question: t.wantsTerminalInput(c.agent) }
  if (/^Tool use$|^MCP tool|tool call\?/i.test(header) || /tool call\?/i.test(q)) {
    const quoted = /tool ["“]([^"”]+)["”]/.exec(h.join(' '))?.[1]
    const tool = quoted ?? (extra[0] ?? '').replace(/\s*\(.*$/, '').replace(/\s*\(MCP\)$/, '').trim()
    return { question: t.wantsTool(c.agent, tool || 'a tool') }
  }
  if (/^Do you want to proceed\?$/i.test(q) && header && header !== q) {
    const what = box[0] ?? extra[0]
    // A command shown as the dialog's own title (newer Claude Code): plain words up front, the command behind « details ».
    if (SHELLY.test(header)) return runQuestion(c.agent, header, what && what !== header && !SHELLY.test(what) ? [what] : [])
    if (what && SHELLY.test(what)) return { question: header, detail: shorten(what, 160) }
    return { question: what ? `${header} · ${shorten(what)}` : header }
  }
  return undefined
}

const isPermissionMenu = (c: Ctx) =>
  /Do you want to proceed\?|Do you want to (?:create|make this edit|edit|overwrite|delete) |allow Claude to fetch|Would you like to (?:run|make the following edits|grant)|approve network access|tool call\?|send input/i.test(c.head) &&
  c.labels.some((l) => /^(?:yes|allow|approve)\b/i.test(l)) && c.labels.some((l) => /^(?:no|deny|reject|cancel)\b/i.test(l))

function question(c: Ctx, name: string, q: string, labels?: (raw: string, i: number) => string | null, detail?: string): TerminalState {
  const keep: Choice[] = []
  let typeIndex: number | undefined
  const tok = token([q, c.labels])
  const multiMenu = c.menu.options.some((o) => o.checked !== undefined)
  c.menu.options.forEach((o, i) => {
    // The free-text row, empty ("Type something.") or being typed into ("In my Dropbox folder█").
    if (/^type something\.?$/i.test(o.raw) || /█$/.test(o.raw)) { typeIndex = i; return }
    if (/^chat about this$/i.test(o.raw)) return
    const label = o.raw === 'Submit' && multiMenu ? tr(M).submitAnswers : labels ? labels(o.raw, i) : o.raw
    if (label === null || keep.some((k) => k.label === label)) return
    keep.push({ id: `${tok}:${i}`, label: o.checked ? `✓ ${label}` : label })
  })
  return { kind: 'question', name, question: q, ...(detail ? { detail } : {}), choices: keep, menu: c.menu, ...(typeIndex !== undefined ? { typeIndex } : {}), ...(multiMenu ? { multi: true } : {}) }
}

/** Usage limit reset time as the agent wrote it ("5am (Europe/Paris)", "6:12 PM", "Nov 13, 4pm"). */
function resetTime(text: string): string | undefined {
  const m = /(?:resets|try again at|continue automatically at|available again at)\s+([^·\n.]+?(?:\([^)]*\))?)(?:\s*[·.]|\s*$)/im.exec(text)
  return m?.[1].replace(/\s*\((?:[A-Za-z_]+\/[A-Za-z_]+)\)/, '').trim()
}

function classifyMenu(c: Ctx, rawRegion: string[]): TerminalState {
  const t = tr(M)
  const { menu, head, labels } = c
  const pick = (re: RegExp) => find(menu, re)
  let i: number

  // ---- theme (first launch on a blank profile, or /theme): keep the one already selected.
  if (/text style|choose .*theme|syntax theme/i.test(head + ' ' + c.lines.join(' ')) && labels.some((l) => /^(?:dark|light) mode/i.test(l)))
    return { kind: 'auto', name: 'theme', menu, pick: menu.selected }

  // ---- settings menus and panels: weevils opens them only through its own commands (model controls), never a question.
  const first = menu.heading.find((l) => l.length > 2) ?? ''
  const all = `${menu.footer} ${head} ${menu.options.map((o) => `${o.raw} ${o.description ?? ''}`).join(' ')}`
  if (/^(?:Select (?:model|Model and Effort|Reasoning Level|Reasoning|approval mode|permissions)|Effort|Resume session|Update Model Permissions|Rewind|↯?\s*Fast mode|Manage MCP servers|Permissions|Settings\s+Status|Status\s+Config)\b/i.test(first) ||
      /←\/→ to adjust|Enter to set as default|s (?:to use|for) this session only|Type to search|Type to filter|enter default · s session|Ctrl\+A to show all projects|←\/→ to switch/i.test(all)) {
    if (!/trust|update now|sign in|login method/i.test(head + labels.join(' '))) return { kind: 'picker', name: 'settings', menu }
  }

  // ---- signed out: a login menu the phone can't finish. Calm status, the session waits for a person on the machine.
  if (/select login method|sign in with chatgpt|use an openai api key|sign in another way|log ?in to (?:claude|codex)/i.test(head + ' ' + labels.join(' ')))
    return { kind: 'hold', name: 'signin', hold: { reason: 'auth', text: t.signin(c.agent) } } // i18n-ignore : code de raison, pas un texte affiché

  // ---- folder trust: answered yes (by label) only for a folder inside the user's project roots, the folders weevils
  // pre-marks; anywhere else the person decides, like any other question.
  if (/trust (?:this|the files in this) folder|quick safety check|do you trust/i.test(head + ' ' + labels.join(' '))) {
    if (/pre-approves|adds \d+ director|mint HTTP headers|continue without these permissions/i.test(head + ' ' + labels.join(' ')))
      return question(c, 'trust-rules', t.trustRules(c.agent), (raw) => (/^yes/i.test(raw) ? t.trustYes : /^no/i.test(raw) ? t.trustNo : raw))
    if ((i = pick(/^(?:yes,? i trust|trust and continue|yes,? continue|yes,? proceed|trust)/i)) >= 0) {
      if (c.trustedFolder) return { kind: 'auto', name: 'trust', menu, pick: i }
      return question(c, 'trust', t.trustFolder(c.agent), (raw, k) => (k === i ? t.trustYes : /^(?:no|back|exit|quit)\b/i.test(raw) ? t.trustStop : raw))
    }
  }

  // ---- bypass-permissions warning at launch: never accepted for the person. It shows only when someone turned off
  // permission prompts (WEEVILS_SAFE=0) and Claude Code's own setting does not skip it: they answer it themselves.
  if (/bypass permissions mode|dangerously-skip/i.test(head) && (i = pick(/^yes,? i accept|^yes,? continue anyway|^i understand/i)) >= 0)
    return question(c, 'bypass-warning', t.bypassWarning(c.agent), (raw, k) => (k === i ? t.bypassAccept : /^(?:no|exit|quit)\b/i.test(raw) ? t.bypassStop : raw))

  // ---- updates are weevils' job (and `npm -g` would fail without root): skip.
  if ((i = pick(/^skip$/i)) >= 0 && labels.some((l) => /^update now/i.test(l))) return { kind: 'auto', name: 'update', menu, pick: i }
  if (/new version is available|update now\?|update available/i.test(head) && (i = pick(/^(?:no|skip|not now|later)\b/i)) >= 0) return { kind: 'auto', name: 'update', menu, pick: i }

  // ---- nudges to change model or plan: the configured model stays (product contract), keep waiting.
  if ((i = pick(/^(?:use existing model|keep current model|keep (?:using )?(?:my|the) current|dismiss and keep waiting|keep waiting|not now|no,? not now|no,? thanks|maybe later|no,? keep manual|no \(default\))$/i)) >= 0 &&
      /model|faster|upgrade|daybreak|credit|new|announc|try|turn on|plugin|default permission mode|fullscreen|renderer/i.test(head + ' ' + labels.join(' ')) && !isPermissionMenu(c))
    return { kind: 'auto', name: 'nudge', menu, pick: i }

  // ---- model/effort confirmation after a model control sent from the app.
  if (/^(?:switch model|change (?:effort level|model)|use .* for this session)\?/im.test(menu.heading.join('\n')) && (i = pick(/^yes\b/i)) >= 0)
    return { kind: 'auto', name: 'switch-model', menu, pick: i }

  // ---- resuming a session weevils reopened: the recommended way, or the session's own folder.
  if (/resume this conversation\?/i.test(head)) return { kind: 'auto', name: 'resume', menu, pick: Math.max(0, pick(/recommended/i)) }
  if ((i = pick(/^use session directory/i)) >= 0) return { kind: 'auto', name: 'resume-folder', menu, pick: i }

  // ---- AskUserQuestion review step: the answers are already chosen.
  if (/ready to submit your answers\?|review your answers/i.test(head) && (i = pick(/^submit answers/i)) >= 0) return { kind: 'auto', name: 'submit-answers', menu, pick: i }

  // ---- usage limit menu: wait (free), never pay. The session continues by itself at the reset.
  if (/what do you want to do\?|usage limit|session limit|weekly limit|rate.?limit/i.test(head) && labels.some((l) => /\bwait\b/i.test(l))) {
    const when = resetTime(labels.join('\n') + '\n' + c.lines.join('\n'))
    const hold: Hold = { reason: 'quota', text: when ? t.limitUntil(when) : t.limit } // i18n-ignore : code de raison, pas un texte affiché
    i = pick(/^wait here.*continue automatically/i)
    if (i < 0) i = pick(/^(?:stop and )?wait\b/i)
    return { kind: 'auto', name: 'usage-limit', menu, pick: i, hold }
  }

  // ---- plans
  if (/would you like to proceed\?|ready to code\?/i.test(head) && labels.some((l) => /^yes/i.test(l)) && labels.some((l) => /tell claude what to change|keep planning|no,? keep/i.test(l)))
    return question(c, 'plan', t.planReady(c.agent), (raw) => (/auto|accept edits|bypass/i.test(raw) && /^yes/i.test(raw) ? t.planStart : /^yes,? (?:and )?manually|^yes$/i.test(raw) ? t.planStartAsk : /tell claude what to change/i.test(raw) ? null : /keep planning|^no/i.test(raw) ? t.planKeep : raw),
      boxed(rawRegion).slice(0, 2).join(' · ') || undefined)
  if (/implement this plan\?/i.test(head))
    return question(c, 'plan', t.planReady(c.agent), (raw) => (/^yes/i.test(raw) ? t.planStart : /^no/i.test(raw) ? t.planKeep : null))
  if (/enter plan mode\?/i.test(head)) return question(c, 'enter-plan', t.enterPlan(c.agent), (raw) => (/^yes/i.test(raw) ? t.planFirst : /^no/i.test(raw) ? t.planNo : raw))

  // ---- launch questions
  let m: RegExpExecArray | null
  if ((m = /New MCP servers? found in this project:?\s*(.*)/i.exec(head)))
    return question(c, 'mcp-new', t.mcpNew(m[1].split(/\s{2,}| MCP servers may/)[0].trim() || 'MCP'), (raw) => (/all future/i.test(raw) ? t.mcpUseAll : /^use this/i.test(raw) ? t.mcpUse : /without/i.test(raw) ? t.mcpSkip : raw))
  if (/external CLAUDE\.md|external imports/i.test(head + labels.join(' ')))
    return question(c, 'external-imports', t.imports, (raw) => (/^yes/i.test(raw) ? t.yes : /^no/i.test(raw) ? t.no : null))
  if (/trust these settings|managed settings|organization settings/i.test(head + labels.join(' ')))
    return question(c, 'managed-settings', t.settingsTrust, (raw) => (/^yes/i.test(raw) ? t.yes : /^no/i.test(raw) ? t.no : raw))
  if (/use this API key\?/i.test(head)) return question(c, 'api-key', t.apiKey(c.agent), (raw) => (/^yes/i.test(raw) ? t.yes : /^no/i.test(raw) ? t.no : raw))

  // ---- permissions (Claude tools, Codex approvals), from the dialog itself: what, and why.
  if (isPermissionMenu(c)) {
    const p = permission(c, rawRegion)
    if (p) return question(c, 'permission', p.question, (raw) => answerLabel(raw), p.detail)
    return question(c, 'permission', titleOf(c), (raw) => answerLabel(raw))
  }

  // ---- a question the agent asks (AskUserQuestion, request_user_input) or any other menu: its own words.
  const known = !!questionLine(menu.heading)
  return question(c, known ? 'choice' : 'unknown', titleOf(c))
}

// ---------------------------------------------------------------- holds without a menu

/** What follows the last prompt the agent received: an old error higher in the scrollback is no longer true. */
function lastBlock(lines: string[]): string[] {
  let end = lines.length
  for (let i = lines.length - 1; i >= 0; i--) if (composerAt(lines, i)) { end = i; break }
  let start = 0
  for (let i = end - 1; i >= 0; i--) {
    const m = MARK.exec(lines[i])
    if (m && !composerAt(lines, i) && m[1].length === 0) { start = i + 1; break }
  }
  return lines.slice(start, end)
}

function holdOf(lines: string[], agent: Agent): Hold | undefined {
  const t = tr(M)
  const block = lastBlock(lines).join('\n')
  if (/has been suspended\. Run `fg`/.test(lines.slice(-6).join('\n'))) return { reason: 'died', text: t.stopped(agent) } // i18n-ignore : code de raison, pas un texte affiché
  if (/you(?:'|’)ve hit your (?:session |weekly |usage |daily )?limit|usage limit reached|you(?:'|’)ve reached your usage limit/i.test(block)) {
    const when = resetTime(block)
    return { reason: 'quota', text: when ? t.limitUntil(when) : t.limit } // i18n-ignore : code de raison, pas un texte affiché
  }
  if (/please run \/login|oauth token has expired|invalid api key|authentication_error|token (?:refresh )?failed|could not be refreshed|logged out|401 unauthorized|sign in again/i.test(block))
    return { reason: 'auth', text: t.signin(agent) } // i18n-ignore : code de raison, pas un texte affiché
  return undefined
}

// ---------------------------------------------------------------- entry point

/** opts.trustedFolder: the session's folder is inside the user's project roots (insideRoots in server/config.ts). */
export function readScreen(text: string, agent?: Agent, opts: { trustedFolder?: boolean } = {}): Reading {
  const who = nameFor(agent)
  const lines = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split('\n').map(clean)
  while (lines.length && blank(lines[lines.length - 1])) lines.pop()
  const composer = lines.slice(-12).some((_, k, arr) => composerAt(lines, lines.length - arr.length + k))
  const working = workingOnScreen(lines.join('\n'))
  const queued = (text.split('Queued follow-up inputs')[1]?.split(/^[›❯>]/m)[0].match(/^\s*↳/gm) ?? []).length
  const done = (state: TerminalState): Reading => ({ state, composer, working, queued })

  // A shell-style [y/n] question on the last lines.
  const yn = lines.slice(-6).map((l) => l.trim()).find((l) => /\?\s*\[y\/n\]:?\s*$/i.test(l))
  if (yn) {
    const q = yn.replace(/\s*\[y\/n\]:?\s*$/i, '')
    const tok = token(q)
    return done({ kind: 'question', name: 'yes-no', question: q, choices: [{ id: `${tok}:y`, label: tr(M).yes }, { id: `${tok}:n`, label: tr(M).no }] })
  }

  const tail = lines.slice(-4).join(' ')
  if (/esc back\s+↑\/↓ move|esc dismiss & close/i.test(tail)) return done({ kind: 'picker', name: 'panel' })

  const menu = findMenu(lines, who)
  if (menu) {
    // The raw dialog region, decoration kept, for boxed previews (commands, files, plans).
    const head = menu.heading.join('\n')
    const firstOpt = menu.options[0]?.raw ?? ''
    const end = lines.findLastIndex((l) => l.includes(firstOpt))
    let start = end
    while (start > 0 && end - start < 40 && !RULE.test(lines[start - 1])) start--
    const region = lines.slice(start, end)
    return done(classifyMenu({ agent: who, trustedFolder: opts.trustedFolder === true, menu, head, labels: menu.options.map((o) => o.raw), lines: lines.slice(-12) }, region))
  }

  // Settings slider without a cursor line (/effort), a Claude panel (/usage, /config, /fast: a "▔" top rule, an
  // Esc footer and no composer), Codex's task list or warnings panel: nobody's question, closed when nobody asked.
  if (/←\/→ to adjust.*Esc to cancel/i.test(tail)) return done({ kind: 'picker', name: 'panel' })
  if (!composer && /Esc to (?:cancel|clear|close)\s*$/i.test(lines.at(-1) ?? '') && lines.slice(-30).some((l) => /^\s*▔{16,}/.test(l)))
    return done({ kind: 'picker', name: 'panel' })
  // "Press Enter to continue…" (security notes, login success) has a single answer.
  if (/press enter to continue/i.test(lines.slice(-4).join(' '))) return done({ kind: 'auto', name: 'press-enter', pick: 'enter' })

  const hold = holdOf(lines, who)
  if (hold && !working) return done({ kind: 'hold', name: hold.reason, hold })
  return done({ kind: 'none' })
}

/** Keys that move the cursor from the selected option to `index` (the caller then confirms with Enter). */
export function moves(menu: Menu, index: number): ('up' | 'down')[] {
  const n = index - menu.selected
  return Array.from({ length: Math.abs(n) }, () => (n < 0 ? 'up' : 'down'))
}

/** The fallback question for a pane stuck on a screen nothing above understood. */
export function stuckQuestion(text: string, agent?: Agent): TerminalState {
  return { kind: 'question', name: 'unknown-stuck', question: tr(M).stuck(nameFor(agent)), choices: stuckChoices(text) }
}

/** Continue (Enter) / Go back (Esc) for this exact screen: the ids only match while the screen stays the same. */
export function stuckChoices(text: string): Choice[] {
  const t = tr(M)
  const tok = token(['stuck', text.slice(-400)])
  return [{ id: `${tok}:enter`, label: t.stuckContinue }, { id: `${tok}:esc`, label: t.stuckBack }]
}

/** Short stable id of a screen, for "has it changed" and for the log of unknown screens. */
export const screenId = (text: string) => token(text.replace(/\s+$/gm, '').split('\n').slice(-30))

/** A screen worth keeping for a later translation: paths, addresses and long tokens removed. */
export function redactScreen(text: string): string {
  return text
    .replace(/\/(?:home|Users)\/[^/\s]+/g, '/home/user')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, 'someone@example.com')
    .replace(/\b(?:sk|pk|ghp|gho|xox[bp])[-_][A-Za-z0-9_-]{8,}/g, '[key]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[token]')
    .replace(/#k=[A-Za-z0-9_-]+/g, '#k=[code]')
}
