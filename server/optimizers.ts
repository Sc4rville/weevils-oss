import { AutomationWorkspaces } from './automation-workspaces.ts'
import { preferredTool, providerReady } from './provider.ts'
// The « auto » band that never sleeps: from the memory and the real projects, weevils proposes background tasks
// (« optimizers »: harden a repo's tests, watch a topic the user cares about, prepare content, explore an idea they
// mentioned). Each one is accepted or refused with one tap. Accepted ones run in a normal Claude session (visible in
// its project) when the machine is free — no agent working for 5 min, load and memory under the `heavy` thresholds —
// one at a time, on a local branch in its own git worktree, never destructive, paid or published without the user's go.
//
// Where a task works: never under DATA_DIR (weevils hides every session there, it is weevboss's). A repo task gets a git
// worktree that weevils makes itself, <root>/.auto/<repo>/<id> on branch auto/<slug>-<id>: place() skips the hidden
// folder and files the session under the repo's project, and the user's own checkout is never touched. A task without a
// repo works in <projects>/.auto/.<id> (all hidden: the session goes to the misc project, or where its talk points).
//
// Stored in DATA_DIR/optimizers.json (outside every repo). Proposal rounds only on the main machine with Claude
// logged in: a few minutes after start, then every 6 h at most, sooner when the memory changed (30 min apart at
// least, or as soon as it settles after a round that proposed nothing), only while fewer than 3 proposals wait for an
// answer; a failed round backs off 1 h (doubling), never a loop.
//
// Each task can be talked over before (and after) it is accepted (talk(), POST /api/optimizers/:id/talk): a short
// exchange with the model that answers about it and rewrites it when asked (what, when, how often, how intense, on which
// repo). Every field of the rewrite is checked here, never trusted; the exchange stays on the task (where it came from)
// and its gist goes into the brief at launch. Conditions: not before a moment, inside a daily window, every N (a
// recurring task goes back to the queue for its next run when one ends).
//
// Never pushed, published or paid without the user: the brief says so, Claude Code's deny list (DENY) blocks the plain
// commands, the session's environment (guardEnv) leaves gh logged out, git unable to push and no MCP connector, and the
// session runs in a jail (jailArgs, bwrap) where the keys and logins are gone and the user's files read-only.

import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import type http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AutoDetail, AutoMachine, AutoRun, AutoRunDetail, AutoSuggestion, Optimizer, OptimizerField, OptimizerLine, OptimizerTalkReply, Session } from '../shared/api.ts'
import { detectLang } from '../shared/detect-lang.ts'
import { RunArchive, blobPath, extractLinks, gitFiles, headOf, mtimeFiles, IMAGE_MIME, MAX_REPORT } from './auto-runs.ts'
import { fmtLocal, nextRun, nextStart, parseEvery, parseLocal, parseWindow, serverTz, validTz, windowText, MAX_AHEAD_MS, type Window } from './auto-time.ts'
import { DATA_DIR, MACHINE, PORT, PROJECT_ROOTS, PROJECTS_DIR, privateDirs } from './config.ts'
import type { Weevils } from './core.ts'
import { claudeAvailable, claudeHaiku, parseJson, smart, relay as relayAnswer } from './fast.ts'
import { lang, tr, user, withLang, type Lang } from './i18n.ts'
import O from './i18n/optimizers.ts'
import SM from './i18n/sleep.ts'
import type { RecapAuto } from './sleep.ts'
import type { Memory } from './memory.ts'
import { availableMem, type Platform } from './platform.ts'
import { ownTask } from './own-words.ts'
import { claudeLogged } from './setup.ts'
import { sessionTokens } from './usage.ts'

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL, params: string[]) => Promise<void> | void
type Json = (res: http.ServerResponse, status: number, body: unknown) => void
type ReadBody = (req: http.IncomingMessage) => Promise<any>

/** Proposals waiting for an answer: no new round past this. */
export const MAX_WAITING = 3
/** A proposal answered (accepted or refused) brings a round to refill the list, never closer than this to the last one. */
export const REFILL_GAP_MS = 10 * 60_000
export const FIRST_ROUND_MS = 4 * 60_000
export const ROUND_EVERY_MS = 6 * 3600_000
/** A memory change brings the next round forward, but never closer than this to the previous one. */
export const ROUND_MEMORY_MS = 30 * 60_000
/** …and once the memory has been still for this long (an exchange with a weevil writes several memories). */
const MEMORY_SETTLE_MS = 2 * 60_000
export const BACKOFF_MS = 3600_000
export const BACKOFF_MAX_MS = 12 * 3600_000
/** The machine is free when no local agent has been working for this long… */
export const IDLE_MS = 5 * 60_000
/** …the 1-minute load is under this × cores and this much memory is available (the thresholds of `heavy`). */
export const LOAD_FACTOR = 1.5
export const MIN_FREE_BYTES = 2 * 1024 ** 3
/** A running task whose session is gone this long, or that runs longer than MAX_RUN_MS, has failed. */
export const VANISH_MS = 3 * 60_000
export const MAX_RUN_MS = 2 * 3600_000
/** …or 1.5 × its estimate when that is longer, never past this. */
export const MAX_RUN_CAP_MS = 6 * 3600_000
/** A task stopped by a usage limit, an expired login or an API error goes back to the queue this long, this many tries. */
export const RETRY_MS = 3600_000
export const MAX_TRIES = 3
/** The supervisor: how often it looks at the runs (and how long a relaunch waits), how many relaunches a task gets in a
 *  row before it is reported as still failing, how long a run may sit still or on a question. */
export const SUPERVISE_MS = 15 * 60_000
export const MAX_RELAUNCHES = 2
export const STALL_MS = 45 * 60_000
export const ASK_MS = 5 * 60_000
/**
 * A run that ended « ok » but says it could not do its job because something refused it (a permission, the sandbox,
 * a folder it could not read): a blocked run, relaunched like a failed one. Matched on its note and last words.
 */
export const BLOCKED_RE = /permission[^\n]{0,80}\b(denied|blocked|refused)|\b(denied|blocked|refused)\b[^\n]{0,40}\b(permission|sandbox|policy)|sandbox[^\n]{0,20}\bblock|permission policy|not allowed in an automation|couldn'?t (read|access|run) [^\n]{0,60}(outside|permission|denied|sandbox)/i
/** A refusal of what stays denied on purpose (publishing, pushing, paying): relaunching would meet it again. */
const HARD_DENIAL_RE = /\b(publish\w*|push\w*|deploy\w*|purchas\w*|payment|paid|spend\w*)\b/i
export const isBlocked = (text: string | undefined): boolean => !!text && BLOCKED_RE.test(text) && !HARD_DENIAL_RE.test(text)
/** Finished tasks stay in the band this long. */
export const KEEP_MS = 3 * 24 * 3600_000
const TICK_MS = 60_000
const MAX_STORED = 200
const KINDS = ['tests', 'watch', 'content', 'explore', 'other'] as const
/** The exchange kept on a task: its last lines, each one cut to this. */
export const MAX_TALK = 12
export const TALK_CHARS = 500
/** One exchange turn: the model may take its time (it may rewrite the whole brief). */
const TALK_TIMEOUT_MS = 120_000
/** After a failed turn, the same task waits this long before the model is asked again (never a loop). */
export const TALK_BACKOFF_MS = 20_000
/** A task keeps this many runs (and their archives); this many failures in a row and a recurring one stops coming back. */
export const MAX_RUNS = 30
export const MAX_FAILED_RUNS = 3
/** What a rewrite may change, in the order the app shows them. */
const SCOPE = ['title', 'why', 'kind', 'repo', 'prompt'] as const
const TERMS = ['est', 'priority', 'heavy', 'notBefore', 'window', 'every', 'onSleep', 'stopOnWake'] as const

/**
 * What an unattended task may never do, enforced by Claude Code itself (deny rules hold even without permission
 * prompts): push, anything through gh, publish a package or an image, expose a port, send data with curl or wget,
 * reach another machine, sudo, kill weevils' tmux, delete outside its folder, read keys and secrets, edit the user's
 * configuration. Rules are wildcards checked on each part of a compound command (`cd x && git push`), wrappers
 * (`timeout`, `VAR=…`, `env`) removed; `bash -c "…"`, `eval` or a script still pass them: the environment barriers
 * (guardEnv) stop the plain commands those run, the jail (jailArgs) what a task does on purpose. The brief says it too.
 */
/**
 * The automation permission profile: what an unattended run may do without a prompt (sessions start with permissions
 * skipped, so nothing ever waits on a prompt; this list is the explicit side, for a session started in safe mode
 * too). weevils' CLI: read the sessions and the request ledger, start a session, message one, post or show in For you.
 * git: commit on its own branch (weevils pushes that branch itself at the end of a run, see pushBranch: the agent never
 * holds a push credential). Tests and builds through `heavy`. RunPod (GPU renders, paid: the person's choice).
 */
export const AUTO_WEEVILS = ['sessions', 'read', 'asks', 'projects', 'new', 'send', 'post', 'show', 'page', 'pages'] as const
/** Every other subcommand of server/weevils-cli, denied by name (and refused by the CLI under WEEVILS_SCOPE). */
export const WEEVILS_DENIED = ['ask', 'goal', 'goals', 'trace', 'mem', 'memory', 'resume', 'recall', 'boss', 'setup', 'config', 'tour'] as const
function weevilsDeny(): string[] {
  return ['Bash(weevils)', ...WEEVILS_DENIED.flatMap((c) => [`Bash(weevils ${c})`, `Bash(weevils ${c} *)`, `Bash(*/weevils ${c})`, `Bash(*/weevils ${c} *)`])]
}
export const ALLOW = [
  ...AUTO_WEEVILS.flatMap((c) => [`Bash(weevils ${c})`, `Bash(weevils ${c} *)`]),
  'Bash(git add *)',
  'Bash(git commit *)',
  'Bash(git status*)',
  'Bash(git diff*)',
  'Bash(git log*)',
  'Bash(git show*)',
  'Bash(git fetch*)',
  'Bash(heavy *)',
  'Bash(runpodctl *)',
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
]
const curlSends = ['-X', '--request', '-d', '--data', '--json', '-F', '--form', '-T', '--upload-file'].flatMap((f) => [`Bash(curl ${f}*)`, `Bash(curl * ${f}*)`])
const COMMON_DENY = [
  'Bash(git push*)',
  'Bash(git -C * push*)',
  'Bash(git -c * push*)',
  'Bash(git --git-dir* push*)',
  'Bash(git --work-tree* push*)',
  'Bash(git send-email*)',
  'Bash(git config --global*)',
  'Bash(gh)',
  'Bash(gh *)',
  'Bash(*/gh *)',
  'Bash(* publish)',
  'Bash(* publish *)',
  'Bash(twine upload*)',
  'Bash(docker push*)',
  'Bash(docker * push*)',
  'Bash(docker login*)',
  'Bash(podman push*)',
  'Bash(expose*)',
  'Bash(*/expose *)',
  ...curlSends,
  'Bash(wget *--post*)',
  'Bash(wget *--method*)',
  'Bash(wget *--body*)',
  'Bash(ssh *)',
  'Bash(scp *)',
  'Bash(sftp *)',
  'Bash(rsync *)',
  'Bash(sudo *)',
  'Bash(su *)',
  'Bash(pkexec *)',
  'Bash(crontab *)',
  'Bash(systemctl *)',
  // Every way out of the session: tmux and systemd start commands outside it (no barriers, no jail), weevils' own CLI
  // starts or messages a full session, claude and codex start an agent without this list.
  'Bash(tmux)',
  'Bash(tmux *)',
  'Bash(*/tmux *)',
  'Bash(systemd-run *)',
  // weevils' CLI: only the subcommands of the profile (AUTO_WEEVILS); every other one is denied by name, and the CLI
  // refuses them itself under WEEVILS_SCOPE=automation (guardEnv). Its helpers (weevils-update, weevils-service) too.
  ...weevilsDeny(),
  'Bash(weevils-*)',
  'Bash(*/weevils-*)',
  'Bash(weevilsd*)',
  'Bash(wv *)',
  'Bash(claude *)',
  'Bash(*/claude *)',
  'Bash(codex *)',
  'Bash(*/codex *)',
  'Bash(pkill *)',
  'Bash(killall *)',
  'Bash(rm * ~*)',
  'Bash(rm * $HOME*)',
  'Bash(rm * /)',
  'Bash(rm * ..*)',
  'Bash(*.config/gh*)',
  'Bash(*.ssh/*)',
  'Bash(*.credentials.json*)',
  'Read(~/.ssh/**)',
  'Read(~/.aws/**)',
  'Read(~/.config/gh/**)',
  'Read(~/.config/weevils/**)',
  'Read(~/.claude.json)',
  'Read(~/.claude/.credentials.json)',
  'Read(~/.netrc)',
  'Read(~/.git-credentials)',
  'Read(~/.npmrc)',
  'Read(~/.docker/config.json)',
  'Read(**/.env)',
  'Read(**/.env.*)',
  'Edit(~/.ssh/**)',
  'Edit(~/.claude/**)',
  'Edit(~/.claude.json)',
  'Edit(~/.config/**)',
  'Edit(~/.local/share/weevils/**)',
  'Edit(~/.bashrc)',
  'Edit(~/.profile)',
  'Edit(~/.gitconfig)',
  // Claude Code's own ways to reach another session or a cloud agent (which has GitHub write access of its own).
  'SendMessage',
  'ListAgents',
  'RemoteTrigger',
  // Nobody answers an unattended run: a question goes to For you (weevils post) and the run carries on.
  'AskUserQuestion',
]
/**
 * Added on a Mac, where a task has no jail and the logins are not files: the Keychain holds Claude Code's login, the
 * token gh keeps there and the passwords git saved, and its command line prints them (security find-generic-password,
 * dump-keychain, export…), as do `gh auth token` and git's own helper. The same words anywhere in a command are
 * denied too (`sh -c "security …"`), like *.credentials.json above. launchd starts commands outside the session,
 * like systemd-run above; a LaunchAgent or a zsh start file would run later in the user's own session.
 */
export const MAC_DENY = [
  'Bash(security)',
  'Bash(security *)',
  'Bash(*/security *)',
  'Bash(*find-generic-password*)',
  'Bash(*find-internet-password*)',
  'Bash(*dump-keychain*)',
  'Bash(*Claude Code-credentials*)',
  'Bash(*gh auth *)',
  'Bash(git credential*)',
  'Bash(git -C * credential*)',
  'Bash(*git-credential-*)',
  'Bash(launchctl *)',
  'Bash(*/launchctl *)',
  'Read(~/Library/Keychains/**)',
  'Edit(~/Library/LaunchAgents/**)',
  'Edit(~/.zshrc)',
  'Edit(~/.zshenv)',
  'Edit(~/.zprofile)',
  'Edit(~/.zlogin)',
  'Edit(~/.bash_profile)',
]
/** The deny list of this machine: the common rules, plus the Mac ones on a Mac. */
export const denyList = (platform: Platform = process.platform): string[] => (platform === 'darwin' ? [...COMMON_DENY, ...MAC_DENY] : COMMON_DENY)
export const DENY = denyList()
/**
 * The extra arguments of an optimizer's claude session: the deny list as flag settings, and no MCP server at all (the
 * user's claude.ai connectors and plugins can send mail, publish or spend credits; an empty --mcp-config with
 * --strict-mcp-config leaves none).
 */
export const SAFETY_ARGS = ['--settings', JSON.stringify({ permissions: { allow: ALLOW, deny: DENY }, disableClaudeAiConnectors: true }), '--strict-mcp-config', `--mcp-config=${JSON.stringify({ mcpServers: {} })}`]

/** A push URL weevils rewrites every remote to: no such git transport, so a push fails at once, before any network. */
export const NO_PUSH_URL = 'weevils-no-push://'
/** The URL starts a push may take (pushInsteadOf rewrites them all to NO_PUSH_URL; fetch is untouched). */
const PUSH_PREFIXES = ['https://', 'http://', 'ssh://', 'git://', 'git@', 'file://', '/']
/** Variables that hand out a login or a paid key (plus any …TOKEN, …SECRET, …API_KEY in weevils' own environment). */
const SECRET_VARS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'SSH_AUTH_SOCK', 'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'CARGO_REGISTRY_TOKEN', 'TWINE_PASSWORD', 'DOCKER_AUTH_CONFIG']
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|CREDENTIALS?)$/i
/** Claude's own login (an OAuth token or an API key may be how it runs) and weevils' hooks keep theirs. */
const KEEP_NAME = /^(ANTHROPIC_|CLAUDE_|WEEVILS_|RUNPOD_)/

/**
 * The environment of an optimizer's session (only theirs: the user's own sessions keep everything). These hold even when
 * a command slips past the deny list (`bash -c`, a script, an alias):
 * - gh has no account: an empty config dir of its own, no token variable → every gh call (and gh's git credential
 *   helper) runs logged out;
 * - git never pushes: every push URL is rewritten to an unknown transport (a remote, an explicit URL, git -C …), ssh
 *   refuses to run for git, no credential helper, no prompt, no askpass; fetch and clone over https still work;
 * - no ssh agent, no docker login, no publishing token, no paid-API key from weevils' environment, no claude.ai connector.
 * `guard` is a folder of weevils' (emptied before each task): gh/ and docker/ inside are the empty configs.
 */
export function guardEnv(guard: string, env: NodeJS.ProcessEnv = process.env, platform: Platform = process.platform): { set: Record<string, string>; unset: string[] } {
  // A program that always fails, where the system has it (a Mac has no /bin/false).
  const no = platform === 'darwin' ? '/usr/bin/false' : '/bin/false'
  const git: [string, string][] = [
    ['remote.pushDefault', NO_PUSH_URL],
    ...PUSH_PREFIXES.map((p): [string, string] => [`url.${NO_PUSH_URL}.pushInsteadOf`, p]),
    // An empty helper empties the list, global and per-URL ones (gh sets credential.https://github.com.helper).
    ['credential.helper', ''],
    ['credential.https://github.com.helper', ''],
    ['credential.https://gist.github.com.helper', ''],
  ]
  const set: Record<string, string> = {
    GH_CONFIG_DIR: path.join(guard, 'gh'),
    GH_PROMPT_DISABLED: '1',
    DOCKER_CONFIG: path.join(guard, 'docker'),
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: no,
    SSH_ASKPASS: no,
    SSH_ASKPASS_REQUIRE: 'never',
    GCM_INTERACTIVE: 'never',
    GIT_SSH_COMMAND: no,
    GIT_CONFIG_COUNT: String(git.length),
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    // weevils' CLI talks to weevilsd on its real port; under this scope it runs only the profile's subcommands, and
    // weevilsd itself answers a jailed caller only on those routes (server/jail-peer.ts).
    WEEVILS_PORT: String(PORT),
    WEEVILS_SCOPE: 'automation',
  }
  git.forEach(([k, v], i) => {
    set[`GIT_CONFIG_KEY_${i}`] = k
    set[`GIT_CONFIG_VALUE_${i}`] = v
  })
  const found = Object.keys(env).filter((k) => SECRET_NAME.test(k) && !KEEP_NAME.test(k) && !(k in set))
  return { set, unset: [...new Set([...SECRET_VARS, ...found])] }
}

/** Hidden in the jail (an empty folder there): keys, logins, weevils' own config, the user's sockets. */
const JAIL_HIDE = ['.ssh', '.config/gh', '.config/hub', '.codex', '.config/weevils', '.config/weevils-get', '.aws', '.azure', '.config/gcloud', '.kube', '.docker', '.gnupg', '.password-store']
/** Hidden files (/dev/null there): logins kept in one file. */
const JAIL_HIDE_FILES = ['.netrc', '.git-credentials', '.npmrc', '.pypirc', '.cargo/credentials', '.cargo/credentials.toml']
/** Read-only in the jail: what runs later in the user's own sessions, unjailed (shell start files, ~/.local/bin, git and
 *  Claude Code's settings, hooks, skills and plugins, systemd user units). */
const JAIL_RO = ['.bashrc', '.bash_profile', '.bash_login', '.profile', '.zshrc', '.zshenv', '.zprofile', '.config/fish', '.config/environment.d', '.gitconfig', '.config/git', '.local/bin', '.config/systemd', '.config/autostart', '.claude/settings.json', '.claude/settings.local.json', '.claude/CLAUDE.md', '.claude/hooks', '.claude/commands', '.claude/agents', '.claude/skills', '.claude/plugins']

/**
 * The jail of an optimizer's session (bwrap's arguments, the command follows): the same files and network, minus what
 * lets a task act as the user beyond its folder. The environment barriers (guardEnv) stop a plain `git push` or `gh`,
 * but the task can undo them (`bash -c 'GH_CONFIG_DIR=~/.config/gh gh …'`); these it can't:
 * - hidden: ssh keys, gh / cloud / registry logins, weevils' data and config, the user's runtime sockets (ssh agent, dbus
 *   and systemd → no systemd-run, other Claude sessions), the tmux and zellij servers (no command started outside the
 *   jail), docker's socket (root in all but name);
 * - read-only: every project root except the task's own folder (worktree and report) and its repo's .git (commits),
 *   whose config and hooks stay read-only (a core.fsmonitor or a hook would run in the user's next git command), and
 *   the files listed in JAIL_RO;
 * - no new privileges: sudo, su, pkexec, crontab and at raise nothing.
 * - its own process namespace: weevilsd recognises its loopback calls (server/jail-peer.ts) and answers only the routes
 *   of the profile's CLI subcommands (AUTO_WEEVILS), never the file explorer, the config or the ledger's writes.
 * Not covered: the network (a script can still send what it reads), Claude Code's own login and ~/.claude.json.
 */
export function jailArgs(o: { home: string; hide: string[]; roots: string[]; rw: string[]; git?: string; /** kept visible among JAIL_HIDE: the login of the agent that runs the task (Codex: .codex) */ show?: string[] }, exists: (p: string) => boolean = fs.existsSync): string[] {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p)
    } catch {
      return p
    }
  }
  const pick = (list: string[]) => [...new Set(list.filter((p) => exists(p)).map(real))]
  const home = (list: string[]) => list.map((p) => path.join(o.home, p))
  // Plus the person's own private folders (WEEVILS_PRIVATE_DIRS).
  const hide = pick([...home(JAIL_HIDE.filter((p) => !o.show?.includes(p))), ...privateDirs(process.env, o.home), ...o.hide])
  const files = pick([...home(JAIL_HIDE_FILES), '/run/docker.sock', '/var/run/docker.sock', '/run/podman/podman.sock'])
  const ro = pick([...home(JAIL_RO), ...o.roots])
  const rw = pick([...o.rw, ...(o.git ? [o.git] : [])])
  const gitRo = o.git ? pick([path.join(o.git, 'config'), path.join(o.git, 'hooks')]) : []
  return [
    '--dev-bind', '/', '/',
    ...hide.flatMap((p) => ['--tmpfs', p]),
    ...files.flatMap((p) => ['--ro-bind', '/dev/null', p]),
    ...ro.flatMap((p) => ['--ro-bind', p, p]),
    ...rw.flatMap((p) => ['--bind', p, p]),
    ...gitRo.flatMap((p) => ['--ro-bind', p, p]),
    // Its own process namespace: weevilsd tells a jailed caller on loopback from the user's own scripts by it
    // (server/jail-peer.ts) and lets it reach only the profile's routes.
    '--unshare-pid', '--proc', '/proc',
    '--die-with-parent',
    '--',
  ]
}

/** One decision of the supervisor: relaunched after a failed, blocked or stalled run; gave up after MAX_RELAUNCHES;
 *  sent a run's question to For you. */
export interface Supervision { at: number; action: 'relaunch' | 'gave-up' | 'asked'; why: string }

type Stored = Optimizer & {
  proposalPreparation?: { at: number; source: 'conversation' | 'review'; revision: number; requestHash?: string }
  lifecycle?: {at:number;action:'refuse'|'restore-draft';source?:'api'|'internal';priorEndedAt?:number;wasDraft?:boolean}[]
  creationKey?: string
  runSourceRevision?: string
  runConfigRevision?: string
  /** Durable deletion: keep source/history and finish an already running job once. */
  deletedAt?: number
  /** The agent's brief, as the model wrote it (the safety rules are added at launch). */
  prompt: string
  acceptedAt?: number
  /** The session was seen working (its return to idle then means done). */
  seenWorking?: boolean
  /** Last time the session was seen in the snapshot. */
  seenAt?: number
  /** Starts stopped by a usage limit, a login or an API error. */
  tries?: number
  /** Waits for Claude to be back (server/relay.ts): released as soon as it is. */
  held?: boolean
  /** The agent of the current (or last) run: Codex while Claude is at its limit. */
  tool?: 'claude' | 'codex'
  /** When the run in progress was due (its slot: not before, its window's opening, its acceptance), whatever delayed
   *  its start; a recurring task's next run steps from it, so a late start never pushes the following ones. */
  slotAt?: number
  /** How long the run in progress may last, fixed when it starts (an estimate rewritten meanwhile is for the next run). */
  limitMs?: number
  /** Its local branch, fixed at the first start (a later run or a retry finds the same worktree). */
  branch?: string
  /** A change of scope agreed while it was running: applied when it comes back for its next run. */
  pending?: Partial<Pick<Stored, (typeof SCOPE)[number]>>
  /** HEAD of its worktree when the run in progress started: what it changed is diffed from there. */
  baseCommit?: string
  /** « Run now » (POST …/run): it starts as soon as the machine is free, its schedule unchanged. */
  runNow?: boolean
  /** onSleep: the night (sleep's since) its last run started in; one run per night. */
  sleepRunFor?: number
  /** Relaunches by the supervisor since its last good run (at most MAX_RELAUNCHES in a row). */
  relaunches?: number
  /** What the supervisor did and why (the last 20): the morning recap and the log read it. */
  supervision?: Supervision[]
  /** The question of the run in progress was sent to For you (once per run). */
  askedAt?: number
}
interface State {
  adoptionPaused?: boolean
  items: Stored[]
  lastRoundAt: number
  /** The last round proposed nothing (a blank install): the next memory change is not held 30 min. */
  lastEmpty?: boolean
  fails: number
  failUntil: number
  /** A proposal was answered at this time: a round may refill the list (REFILL_GAP_MS after the last one). */
  refillAt?: number
}

export interface Proposal {
  title: string
  why: string
  repo: string | null
  kind: Optimizer['kind']
  heavy: boolean
  priority: 1 | 2 | 3
  est: number
  prompt: string
}

/** What the runner reads about the machine (injected in tests). */
export interface Sys {
  load: () => number
  cpus: () => number
  free: () => number
  logged: () => boolean
  /** git -C <repo> worktree add <dir> -b <branch> <base> (from <base>, else the checkout's HEAD). */
  worktree: (repo: string, dir: string, branch: string, base?: string) => Promise<void>
  /** What a task's branch starts from: the repo's current main (see mainRef), undefined outside git. */
  base: (repo: string) => Promise<string | undefined>
  /** Brings an existing task worktree up to <base> before a run (see refreshWorktree). */
  refresh: (dir: string, base: string) => Promise<'ff' | 'merged' | 'kept'>
  /** Pushes the task's own branch to origin, never anything else (see pushBranch). */
  push: (dir: string, branch: string, base?: string) => Promise<boolean>
  /** Tries the jail (bwrap <args> true): true when it holds, false without bwrap on this machine; throws if it fails. */
  jail: (args: string[]) => Promise<boolean>
  /** HEAD of the task's worktree <dir> of <repo>: where a run starts from (undefined outside git). */
  head: (repo: string, dir: string) => Promise<string | undefined>
}
const gitWorktree = (repo: string, dir: string, branch: string, base?: string) =>
  new Promise<void>((resolve, reject) =>
    execFile('git', ['-C', repo, 'worktree', 'add', dir, '-b', branch, ...(base ? [base] : [])], { timeout: 60_000 }, (e, _out, err) => (e ? reject(new Error(String(err || e.message).trim().split('\n').pop())) : resolve())),
  )
/** One git command in <dir>: its trimmed output, or null when it fails. */
const gitOut = (dir: string, args: string[], timeout = 30_000) =>
  new Promise<string | null>((resolve) => execFile('git', ['-C', dir, ...args], { timeout }, (e, out) => resolve(e ? null : String(out).trim())))
/**
 * The repo's current main, what a task branches from (a task once branched from whatever the checkout had out, and
 * kept that old base for every later run): origin's default branch (main when unknown), fetched first; the local one
 * when it holds origin's (unpushed commits), origin's when it is ahead, the local one when they diverged.
 */
export async function mainRef(repo: string, git = gitOut): Promise<string | undefined> {
  if ((await git(repo, ['rev-parse', '--git-dir'])) === null) return undefined
  const def = (await git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']))?.replace(/^origin\//, '') || 'main'
  await git(repo, ['fetch', '-q', 'origin', def], 60_000)
  const local = (await git(repo, ['rev-parse', '--verify', '-q', `refs/heads/${def}`])) ? def : undefined
  const remote = (await git(repo, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${def}`])) ? `origin/${def}` : undefined
  if (local && remote) return (await git(repo, ['merge-base', '--is-ancestor', local, remote])) !== null && (await git(repo, ['merge-base', '--is-ancestor', remote, local])) === null ? remote : local
  return local ?? remote
}
/**
 * Before a run, an existing task worktree catches up with main: fast-forward when it has nothing of its own, a merge
 * when it has (its history and any pushed branch stay intact; a conflict is aborted and the worktree kept as it was).
 * A worktree with uncommitted changes is left alone.
 */
export async function refreshWorktree(dir: string, base: string, git = gitOut): Promise<'ff' | 'merged' | 'kept'> {
  const dirty = await git(dir, ['status', '--porcelain'])
  if (dirty === null || dirty !== '') return 'kept'
  if ((await git(dir, ['merge-base', '--is-ancestor', base, 'HEAD'])) !== null) return 'kept'
  if ((await git(dir, ['merge-base', '--is-ancestor', 'HEAD', base])) !== null) return (await git(dir, ['merge', '-q', '--ff-only', base])) !== null ? 'ff' : 'kept'
  if ((await git(dir, ['merge', '-q', '--no-edit', base], 60_000)) !== null) return 'merged'
  await git(dir, ['merge', '--abort'])
  return 'kept'
}
/**
 * After a run, weevils (not the agent: it holds no push credential) pushes the task's own branch to origin when the run
 * committed something: only an auto/… branch, never main, never forced.
 */
export async function pushBranch(dir: string, branch: string, base?: string, git = gitOut): Promise<boolean> {
  if (!/^auto\/[\w.-]+$/.test(branch)) return false
  if ((await git(dir, ['remote', 'get-url', 'origin'])) === null) return false
  if (base && (await git(dir, ['rev-list', '--count', `${base}..HEAD`])) === '0') return false
  return (await git(dir, ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], 120_000)) !== null
}
/** bwrap exists on Linux only: on a Mac the answer is known (no jail), nothing is started to find out. */
export const tryJail = (args: string[], platform: Platform = process.platform, run: typeof execFile = execFile) =>
  new Promise<boolean>((resolve, reject) => {
    if (platform === 'darwin') return resolve(false)
    run('bwrap', [...args, 'true'], { timeout: 15_000 }, (e, _out, err) =>
      !e ? resolve(true) : (e as NodeJS.ErrnoException).code === 'ENOENT' ? resolve(false) : reject(new Error(String(err || e.message).trim().split('\n').pop())),
    )
  })
/** How often a Mac's available memory is read again (vm_stat, in the background). */
export const MEM_REFRESH_MS = 20_000
/**
 * The memory a task can get, read on the spot (Sys.free is synchronous). Linux: os.freemem(), which is MemAvailable.
 * macOS: os.freemem() only counts untouched pages (a few hundred MB on an idle Mac: no task would ever start), so the
 * value comes from vm_stat (availableMem in server/platform.ts), read again in the background from the first call on;
 * os.freemem() until the first answer arrives.
 */
export function memGauge(platform: Platform = process.platform, read: () => Promise<number> = () => availableMem(platform), free: () => number = () => os.freemem(), everyMs = MEM_REFRESH_MS): () => number {
  if (platform !== 'darwin') return free
  let last: number | undefined
  let started = false
  const refresh = () =>
    void read().then(
      (n) => (last = n),
      () => undefined,
    )
  return () => {
    if (!started) {
      started = true
      refresh()
      setInterval(refresh, everyMs).unref?.()
    }
    return last ?? free()
  }
}
/** The note of a queued task that waits for Claude on a Mac, in every language (a task keeps the one it was given). */
const MAC_NOTES: string[] = [O.fr.noJailMac, O.en.noJailMac]
const realSys: Sys = { load: () => os.loadavg()[0], cpus: () => os.cpus().length || 1, free: memGauge(), logged: () => preferredTool() === 'codex' ? providerReady() : claudeLogged(), worktree: gitWorktree, base: (repo) => mainRef(repo), refresh: (dir, base) => refreshWorktree(dir, base), push: (dir, branch, base) => pushBranch(dir, branch, base), jail: tryJail, head: headOf }

// ---------------------------------------------------------------- pure helpers (tested)

/** The runs as the app reads them: newest first (stored oldest first), an older line ({ at, ok, note }) starting when
 *  it ended. */
export const newestFirst = (runs: AutoRun[]): AutoRun[] => runs.map((r) => (typeof r.startedAt === 'number' ? r : { ...r, startedAt: r.at })).reverse()

/** A rewrite from the model, checked: null clears a condition (as soon as possible, any time, just once). */
export interface Patch {
  title?: string
  why?: string
  kind?: Optimizer['kind']
  repo?: string | null
  prompt?: string
  est?: number
  priority?: 1 | 2 | 3
  heavy?: boolean
  notBefore?: number | null
  window?: Window | null
  every?: number | null
  /** « When I sleep » (true), or back to its times (null). */
  onSleep?: true | null
  stopOnWake?: true | null
}

const oneLine = (s: unknown, max: number) =>
  String(s ?? '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["«“'\s]+|["»”'\s]+$/g, '')
    .slice(0, max)
    .trim()

/**
 * A title or a why line as the app shows it: one line, no quotes around words (« mygame », "the site" → mygame, the
 * site); apostrophes stay.
 */
export function tidy(s: unknown, max: number): string {
  return oneLine(String(s ?? '').replace(/[«»“”„‟"]/g, ' ').replace(/\s+([,.)])/g, '$1').replace(/\(\s+/g, '('), max)
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
const words = (s: string) => new Set(norm(s).split(' ').filter((w) => w.length > 2))

/** Same task title, or nearly (most of its words shared with one already proposed). */
export function isRepeat(title: string, known: { title: string }[]): boolean {
  const n = norm(title)
  const a = words(title)
  return known.some((k) => {
    if (norm(k.title) === n) return true
    const b = words(k.title)
    if (!a.size || !b.size) return false
    let both = 0
    for (const w of a) if (b.has(w)) both++
    return both / (a.size + b.size - both) >= 0.6
  })
}

/**
 * A reply that is not work: a usage limit, an expired login, an API error. Claude Code writes them as the agent's
 * answer, short; a real summary that mentions a limit is longer than this and does not start like one.
 */
export function isStall(msg: string): boolean {
  const m = msg.trim()
  if (!m || m.length > 200) return false
  return /^(api error\b|you['’]ve (hit|reached) your|claude (ai )?usage limit|usage limit|\d+-hour limit|weekly limit|limit reached|failed to authenticate|login expired|oauth|invalid api key|credit balance|request timed out|overloaded|please run \/login)/i.test(m)
}

/** Which stop it was, for a short note in the app (the raw message stays in the log). */
export function stallKind(msg: string): 'limit' | 'login' | 'api' {
  if (/limit|credit/i.test(msg)) return 'limit'
  if (/auth|login|oauth|api key|\/login/i.test(msg)) return 'login'
  return 'api'
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/**
 * The model's proposals, checked: a title and a brief, a repo that really is on the machine (else null), a known kind,
 * priority 1–3, a rough estimate, nothing already proposed (in any state: refused and done are never proposed again),
 * at most `max`.
 */
export function parseProposals(raw: unknown, repos: string[], known: { title: string }[], max = MAX_WAITING, said: readonly string[] = []): Proposal[] {
  const r = raw as { tasks?: unknown; proposals?: unknown } | null
  const list: unknown[] = Array.isArray(raw) ? raw : Array.isArray(r?.tasks) ? r.tasks : Array.isArray(r?.proposals) ? r.proposals : []
  const out: Proposal[] = []
  for (const x of list as Record<string, unknown>[]) {
    if (out.length >= max) break
    if (!x || typeof x !== 'object') continue
    const title = tidy(x.title, 80)
    const prompt = String(x.prompt ?? '').trim().slice(0, 6000)
    if (title.length < 3 || prompt.length < 20) continue
    if (isRepeat(title, [...known, ...out])) continue
    const want = typeof x.repo === 'string' ? x.repo.trim() : ''
    const repo = want ? (repos.find((n) => n === want) ?? repos.find((n) => n.toLowerCase() === want.toLowerCase()) ?? null) : null
    // The user's own idea says so; a why that only hands their wish back to them is dropped (server/own-words.ts).
    const why = tidy(x.why, 220)
    const own = ownTask({ title, why }, said)
    out.push({
      title,
      why: own.why === null ? why : own.own ? tr(O).ownWhy : '',
      repo,
      kind: (KINDS as readonly string[]).includes(String(x.kind)) ? (x.kind as Optimizer['kind']) : 'other',
      heavy: x.heavy === true,
      priority: clamp(Math.round(Number(x.priority)) || 2, 1, 3) as 1 | 2 | 3,
      est: clamp(Math.round(Number(x.est)) || 30, 5, 120),
      prompt,
    })
  }
  return out
}

/** Short reply choices from the model: bounded plain strings, once each. */
export function parseSuggestions(raw: unknown): AutoSuggestion[] {
  if (!Array.isArray(raw)) return []
  const out: AutoSuggestion[] = []
  for (const x of raw) {
    if (typeof x !== 'string') continue
    const text = tidy(x, 160)
    if (text.length < 2 || out.some((s) => norm(s.text) === norm(text))) continue
    out.push({ label: text, text })
    if (out.length === 4) break
  }
  return out
}

/** A short question and nothing else (« c'est quoi ? », « what did it find? »): no request for a change. */
export const bareQuestion = (said: string) => /\?\s*$/.test(said) && !/[,;:]/.test(said) && said.trim().split(/\s+/).length <= 6

/** A field cleared on purpose: null, or a word that says so (an empty string is no answer: ignored). */
const isNull = (v: unknown) => v === null || (typeof v === 'string' && /^(null|none|never|once|aucune?|jamais|une fois)$/i.test(v.trim()))

/**
 * The model's rewrite of a task, every field checked (never trusted): a title and a why that read well, a known kind,
 * a repo that really is on the machine (else ignored; null: its own folder), a full brief, an estimate of 5 min to
 * 4 h, priority 1–3, a start within 60 days (in the user's zone), a daily window of 30 min at least, a period of
 * 1 h to 90 days. Anything else is dropped, field by field.
 */
export function parsePatch(raw: unknown, ctx: { repos: string[]; tz: string; now: number }): Patch {
  const x = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const p: Patch = {}
  if ('title' in x) {
    const t = tidy(x.title, 60)
    if (t.length >= 3) p.title = t
  }
  if ('why' in x) {
    const w = tidy(x.why, 220)
    if (w.length >= 3) p.why = w
  }
  if ((KINDS as readonly string[]).includes(String(x.kind))) p.kind = x.kind as Optimizer['kind']
  if ('repo' in x) {
    if (isNull(x.repo)) p.repo = null
    else if (typeof x.repo === 'string') {
      const want = x.repo.trim()
      const hit = ctx.repos.find((n) => n === want) ?? ctx.repos.find((n) => n.toLowerCase() === want.toLowerCase())
      if (hit) p.repo = hit
    }
  }
  if (typeof x.prompt === 'string') {
    const b = x.prompt.trim().slice(0, 6000)
    if (b.length >= 20) p.prompt = b
  }
  const num = (v: unknown) => (typeof v === 'number' || (typeof v === 'string' && v.trim()) ? Number(v) : NaN)
  const est = num(x.est)
  if (Number.isFinite(est)) p.est = clamp(Math.round(est), 5, 240)
  const pr = num(x.priority)
  if (Number.isFinite(pr)) p.priority = clamp(Math.round(pr), 1, 3) as 1 | 2 | 3
  if (typeof x.heavy === 'boolean') p.heavy = x.heavy
  if ('notBefore' in x) {
    if (isNull(x.notBefore)) p.notBefore = null
    else {
      const at = typeof x.notBefore === 'number' ? x.notBefore : parseLocal(x.notBefore, ctx.tz)
      // Already past (a few minutes of slack): as soon as possible. Too far or unreadable: ignored.
      if (at !== null && Number.isFinite(at) && at <= ctx.now + MAX_AHEAD_MS && at > ctx.now - 24 * 3600_000) p.notBefore = at > ctx.now + 60_000 ? at : null
    }
  }
  if ('window' in x) {
    if (isNull(x.window)) p.window = null
    else {
      const w = parseWindow(x.window)
      if (w) p.window = w
    }
  }
  if ('every' in x) {
    if (isNull(x.every) || x.every === 0 || x.every === false) p.every = null
    else {
      const e = parseEvery(x.every)
      if (e) p.every = e
    }
  }
  // Booleans only (a word is no answer): false or null go back to the times.
  for (const k of ['onSleep', 'stopOnWake'] as const) if (k in x && (typeof x[k] === 'boolean' || x[k] === null)) p[k] = x[k] === true ? true : null
  return p
}

/** The last lines of an exchange, each one cut (what is kept on a task). */
export function capTalk(lines: OptimizerLine[], max = MAX_TALK): OptimizerLine[] {
  return lines.slice(-max).map((l) => ({ ...l, text: l.text.length > TALK_CHARS ? `${l.text.slice(0, TALK_CHARS - 1).trimEnd()}…` : l.text }))
}

/**
 * What the agent reads at launch about the negotiation: the requests that rewrote the task and the last answer that
 * did, 2 to 4 lines. Empty when nothing was changed (questions only, or accepted as proposed).
 */
export function agreedDigest(talk: OptimizerLine[] | undefined, line: { user: (s: string) => string; auto: (s: string) => string }): string {
  const lines = talk ?? []
  const turns = lines.flatMap((l, i) => (l.who === 'auto' && l.changed?.length && lines[i - 1]?.who === 'user' ? [{ asked: lines[i - 1].text, answer: l.text }] : []))
  if (!turns.length) return ''
  const cut = (s: string, n: number) => (s.length > n ? `${oneLine(s, n - 1)}…` : oneLine(s, n))
  return [...turns.slice(-3).map((x) => line.user(cut(x.asked, 200))), line.auto(cut(turns.at(-1)!.answer, 320))].join('\n')
}

/** How long a task may run: 2 h, or 1.5 × its estimate when longer, 6 h at most. */
export const runLimit = (est?: number) => clamp(Math.round((est ?? 0) * 1.5) * 60_000, MAX_RUN_MS, MAX_RUN_CAP_MS)

/** A period as the model reads it: « 7d », « 12h », « 90min ». */
export function fmtSpan(ms: number): string {
  const h = ms / 3600_000
  if (h >= 24 && Number.isInteger(h / 24)) return `${h / 24}d`
  if (h >= 1 && Number.isInteger(h)) return `${h}h`
  return `${Math.round(ms / 60_000)}min`
}

/** Branch-safe short name: « Harden the tests of mygame » → « harden-the-tests-of-mygame ». */
export function slug(title: string): string {
  return norm(title).replace(/ /g, '-').slice(0, 32).replace(/-+$/, '') || 'task'
}

/** What keeps the oldest accepted task from starting, or null when the machine is free. */
export function freeReason(m: { idleFor: number; load: number; cpus: number; free: number }): AutoMachine['wait'] {
  if (m.idleFor < IDLE_MS) return 'busy'
  if (m.load >= LOAD_FACTOR * m.cpus) return 'load'
  if (m.free < MIN_FREE_BYTES) return 'ram'
  return null
}

// ---------------------------------------------------------------- the optimizers

export class Optimizers {
  readonly w: Weevils
  readonly memory: Memory
  readonly file: string
  /** <projects>/.auto: the workspaces of the tasks without a repo (<projects>/.auto/.<id>). */
  readonly dir: string
  /** What each run left (DATA_DIR/auto/<id>/<startedAt>.json): its report, last words, files, links, images. */
  readonly archive: RunArchive
  private s: State
  private sys: Sys
  /** Last look of the supervisor (look). */
  private supervisedAt = 0
  private bootAt = Date.now()
  /** Last time a local agent (or weevboss) was seen working. */
  private lastBusyAt = Date.now()
  private memChangedAt = 0
  private rounding: Promise<void> | null = null
  private launching = false
  private noJailSaid = false
  /** bwrap works on this machine (asked once, when Claude first hits its limit); never on a Mac, known without asking. */
  private bwrap: boolean | undefined
  private platform: Platform
  private probingJail = false
  private auto = false
  readonly software: AutomationWorkspaces
  private adopting = false
  private adoptionErrors = new Map<string,string>()
  /** Tasks with an exchange turn in flight (one at a time each), and those waiting after a failed one. */
  private talking = new Set<string>()
  /** Built-in automations (server/cost.ts): run inside weevilsd, no agent session, never in the one-at-a-time slot. */
  private builtins = new Map<string, (now: number) => Promise<{ ok: boolean; note: string; report?: string }>>()
  private builtinBusy = new Set<string>()
  private builtinReports = new Map<string, string>()
  private talkFailUntil = new Map<string, number>()
  /** Archives being written (the git diff of a run that just ended): settled() waits for them. */
  private writing = new Set<Promise<void>>()

  constructor(w: Weevils, memory: Memory, opts: { file?: string; /** default <projects>/.auto */ dir?: string; /** default auto/ beside file */ archive?: string; softwareRoot?:string; sys?: Partial<Sys>; platform?: Platform } = {}) {
    this.w = w
    this.memory = memory
    this.platform = opts.platform ?? process.platform
    if (this.platform === 'darwin') this.bwrap = false
    this.file = opts.file ?? path.join(DATA_DIR, 'optimizers.json')
    this.dir = opts.dir ?? path.join(PROJECTS_DIR, '.auto')
    this.archive = new RunArchive(opts.archive ?? path.join(path.dirname(this.file), 'auto'))
    this.software = new AutomationWorkspaces(opts.softwareRoot ?? (opts.file ? path.join(path.dirname(opts.file),'automation-workspaces') : path.join(PROJECTS_DIR,'automations')))
    const sys = opts.sys ?? {}
    this.sys = {
      load: () => (sys.load ?? realSys.load)(),
      cpus: () => (sys.cpus ?? realSys.cpus)(),
      free: () => (sys.free ?? realSys.free)(),
      logged: () => (sys.logged ?? realSys.logged)(),
      worktree: (repo, dir, branch, base) => (sys.worktree ?? realSys.worktree)(repo, dir, branch, base),
      base: (repo) => (sys.base ?? realSys.base)(repo),
      refresh: (dir, base) => (sys.refresh ?? realSys.refresh)(dir, base),
      push: (dir, branch, base) => (sys.push ?? realSys.push)(dir, branch, base),
      jail: (args) => (sys.jail ?? realSys.jail)(args),
      head: (repo, d) => (sys.head ?? realSys.head)(repo, d),
    }
    this.s = (() => {
      try {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<State>
        const items = (Array.isArray(raw.items) ? raw.items : []).filter((o) => o && typeof o.id === 'string' && typeof o.title === 'string' && typeof o.state === 'string')
        return { items, adoptionPaused:raw.adoptionPaused===true, lastRoundAt: Number(raw.lastRoundAt) || 0, lastEmpty: raw.lastEmpty === true, fails: Number(raw.fails) || 0, failUntil: Number(raw.failUntil) || 0, refillAt: Number(raw.refillAt) || 0 }
      } catch {
        return { items: [], lastRoundAt: 0, fails: 0, failUntil: 0 }
      }
    })()
    memory.onChange(() => (this.memChangedAt = Date.now()))
  }

  /** Proposal rounds and the runner loop (main machine only). */
  start() {
    this.auto = true
    void this.adoptAll()
    setInterval(() => this.tick(), TICK_MS).unref?.()
  }

  /**
   * A built-in automation: its runner, and its row in the auto page created once (recurring every `every` ms, first run
   * in two minutes, on weevils' own repo when this server runs from a checkout: the recursive signature). A row the user
   * deleted or refused is never created again; pausing, running now and the run history work as for any other task.
   */
  registerBuiltin(kind: NonNullable<Optimizer['builtin']>, run: (now: number) => Promise<{ ok: boolean; note: string; report?: string }>, seed: { title: string; why: string; every: number; repo: string | null }, now = Date.now()) {
    this.builtins.set(kind, run)
    if (this.s.items.some((o) => o.builtin === kind)) return
    const o: Stored = { id: crypto.randomBytes(5).toString('hex'), title: seed.title, why: seed.why, repo: seed.repo, kind: 'other', heavy: false, state: 'queued', userCreated: true, builtin: kind, prompt: '', createdAt: now, acceptedAt: now, every: seed.every, notBefore: now + 2 * 60_000 }
    this.s.items.push(o)
    this.changed()
  }

  private async runBuiltin(o: Stored, now: number) {
    const run = o.builtin ? this.builtins.get(o.builtin) : undefined
    if (!run || this.builtinBusy.has(o.id)) return
    this.builtinBusy.add(o.id)
    o.startedAt = now
    o.slotAt = o.runNow ? now : (o.notBefore ?? now)
    delete o.runNow
    try {
      const r = await run(now)
      if (r.report) this.builtinReports.set(o.id, r.report)
      this.finish(o, Date.now(), r.ok, r.note)
    } catch (e) {
      this.finish(o, Date.now(), false, oneLine((e as Error).message, 160))
    } finally {
      this.builtinBusy.delete(o.id)
      this.builtinReports.delete(o.id)
      delete o.slotAt
      this.changed()
    }
  }

  /** Adopt metadata/source while preserving every old path and scheduler identity. No active cwd is changed. */
  async adoptAll() {
    if(this.adopting || this.s.adoptionPaused)return
    this.adopting=true
    try {
      if(!this.s.items.length)return
      const backup=path.join(path.dirname(this.file),'automation-adoption-backup.json')
      if(!fs.existsSync(backup)) {fs.mkdirSync(path.dirname(backup),{recursive:true});fs.writeFileSync(backup,JSON.stringify(this.s,null,2),{mode:0o600,flag:'wx'})}
      for(const o of this.s.items){
        if(o.builtin)continue
        if(o.software?.status==='ready' || (o.software?.status==='pending-running' && o.state==='running'))continue
        try {
          const previous=o.software
          o.software=this.software.adopt(o.id,this.workspace(o),o.state==='running',previous)
          try{this.save(true)}catch(e){o.software=previous;throw e}
          this.adoptionErrors.delete(o.id)
        }catch(e){this.adoptionErrors.set(o.id,(e as Error).message)}
        await new Promise<void>(resolve=>setImmediate(resolve))
      }
      this.w.bump()
    }finally{this.adopting=false}
  }
  adoptionStatus(){
    return {enabled:!this.s.adoptionPaused,total:this.s.items.length,ready:this.s.items.filter(o=>o.software?.status==='ready').length,pendingRunning:this.s.items.filter(o=>o.software?.status==='pending-running').length,errors:[...this.adoptionErrors].map(([id,error])=>({id,error})),items:this.s.items.map(o=>({id:o.id,state:o.state,deleted:!!o.deletedAt,software:o.software}))}
  }
  /** Reversible execution pointer only. Keep source, configuration, active runs and all histories intact. */
  rollbackAdoption(){
    const previous=this.s.adoptionPaused;this.s.adoptionPaused=true
    try{this.save(true)}catch(e){this.s.adoptionPaused=previous;throw e}
    this.w.bump();return {ok:true}
  }

  promoteSoftware(id:string,revision:string){
    const o=this.get(id)
    if(!o?.software)return null
    const previous=o.software
    o.software=this.software.select(previous,revision)
    try{this.save(true)}catch(e){o.software=previous;throw e}
    this.w.bump();return {ok:true,revision:o.software.revision}
  }

  private save(strict = false) {
    // Too many: the oldest refused or finished ones go; a task still waiting, queued (a recurring one lives on) or
    // running is never dropped.
    if (this.s.items.length > MAX_STORED) {
      const live = (o: Stored) => o.state === 'proposed' || o.state === 'queued' || o.state === 'running'
      const keep = new Set([...this.s.items.filter(live), ...this.s.items.filter((o) => !live(o)).sort((a, b) => (b.endedAt ?? b.createdAt) - (a.endedAt ?? a.createdAt))].slice(0, MAX_STORED))
      for (const o of this.s.items) if (o.deletedAt) keep.add(o)
      for (const o of this.s.items) if (!keep.has(o)) this.dropArchive(o.id)
      this.s.items = this.s.items.filter((o) => keep.has(o))
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.s, null, 1))
      fs.renameSync(tmp, this.file)
    } catch (e) {
      console.error(`[auto] écriture : ${(e as Error).message}`)
      if (strict) throw e
    }
  }

  private changed() {
    this.save()
    this.w.bump()
  }

  private dropArchive(id: string) {
    try {
      this.archive.drop(id)
    } catch {
      /* never written */
    }
  }

  /** A proposal round is running (the drawer shows a band filling in its place). */
  get roundBusy(): boolean {
    return this.rounding !== null
  }

  /** The archives still being written (tests, and a clean stop). */
  async settled(): Promise<void> {
    while (this.writing.size) await Promise.all([...this.writing])
  }

  // ---------------------------------------------------------------- what the app sees

  /** For the snapshot: proposed, queued, running and finished in the last 3 days (never the refused ones). */
  list(now = Date.now()): Optimizer[] {
    const rank = { running: 0, queued: 1, proposed: 2, done: 3, failed: 3, refused: 4 } as const
    return this.s.items
      .filter((o) => !o.deletedAt && o.state !== 'refused' && (o.state === 'proposed' || o.state === 'queued' || o.state === 'running' || now - (o.endedAt ?? o.createdAt) < KEEP_MS))
      .sort((a, b) => rank[a.state] - rank[b.state] || (a.state === 'proposed' ? (a.priority ?? 2) - (b.priority ?? 2) || a.createdAt - b.createdAt : 0) || (b.endedAt ?? 0) - (a.endedAt ?? 0) || (a.acceptedAt ?? 0) - (b.acceptedAt ?? 0))
      .map((o) => this.view(o, now))
  }

  /** A task as the app sees it: without the brief and the runner's bookkeeping; when it may start, if its time holds
   *  it; what its next run will be, when that was rewritten while it runs. */
  view(o: Stored, now = Date.now()): Optimizer {
    const { prompt: _p, proposalPreparation: _pp, seenWorking: _w, seenAt: _s, tries: _t, held: _h, tool: _tool, branch: _b, pending: _n, limitMs: _l, slotAt: _sl, baseCommit: _c, runNow: _r, runSourceRevision: _sr, runConfigRevision: _cr, creationKey:_ck, lifecycle:_lc, sleepRunFor: _sf, relaunches: _rl, supervision: _sv, askedAt: _ak, ...v } = o
    const at = o.state === 'queued' ? this.timeAt(o, now) : now
    const out: Optimizer = at > now ? { ...v, startAt: at } : { ...v }
    const recovery=o.lifecycle?.findLast(event=>event.action==='restore-draft')
    if(recovery)out.recoveredAt=recovery.at
    if(o.repo){out.workstream=this.w.workstreamForRepo?.(o.repo);out.sourceAccess=this.w.sourceAccessForRepo?.(o.repo)}
    if (o.runNow) out.runRequested = true
    // Stored oldest first (older files read the same); the app reads the newest first.
    if (o.runs) out.runs = newestFirst(o.runs)
    // Agreed while it runs, for its next run: shown under its row (the brief itself stays here).
    if (o.pending) out.next = { title: o.pending.title ?? o.title }
    return out
  }

  /** When its conditions let a task start (now when it has none, or when it was asked to run now). */
  private timeAt(o: Stored, now: number): number {
    // « When I sleep »: at once when sleep mode makes it due, or relaunched by the supervisor (its retryAt holds it).
    // Otherwise its own times, kept as the fallback: it still runs on a night sleep mode never came (sleepHeld()
    // holds the ones that have no times).
    if (o.runNow || o.relaunches || (o.onSleep && this.sleepDue(o, now))) return now
    return o.notBefore || o.window ? nextStart(o, now, o.tz ?? serverTz()) : now
  }

  /** Sleep mode (server/sleep.ts), set at start on the main machine. */
  sleep: { readonly on: boolean; readonly since: number | null } | null = null

  /**
   * A « when I sleep » task with no times of its own waits for a night it has not run in yet. One with times (window,
   * every, not before) is never held by sleep mode: they are its fallback, so it runs whether or not the user turned
   * sleep mode on. Asked to run now, or relaunched by the supervisor, it goes at any hour.
   */
  private sleepHeld(o: Stored, now = Date.now()): boolean {
    if (!o.onSleep || o.runNow || o.relaunches) return false
    if (o.notBefore || o.window || o.every) return false
    return !this.sleepDue(o, now)
  }

  /**
   * Sleep mode makes a « when I sleep » task due: a night it has not run in yet and, when it repeats (every), its
   * period nearly over (slack: half the period, at most 12 h, so a night that starts early still counts, and a run
   * from its fallback window earlier the same night is not run again).
   */
  private sleepDue(o: Stored, now: number): boolean {
    const s = this.sleep
    if (!o.onSleep || !s?.on || s.since === null || o.sleepRunFor === s.since) return false
    if (!o.every) return true
    const slack = Math.min(o.every / 2, 12 * 60 * 60_000)
    return now >= (o.notBefore ?? 0) - slack && now >= (o.startedAt ?? 0) + slack
  }

  /**
   * Sleep mode turned on or off. On: the « when I sleep » tasks are due (next tick). Off: a run of one that stops on
   * wake is stopped (its agent interrupted, the run recorded as stopped), and the others keep going.
   */
  sleepChanged(on: boolean, now = Date.now()) {
    if (!on)
      for (const o of this.s.items)
        if (o.state === 'running' && o.onSleep && o.stopOnWake && !o.deletedAt) {
          const sid = o.sessionId ? (this.w.sessionIdOf?.(o.sessionId) ?? o.sessionId) : undefined
          if (sid) void Promise.resolve().then(() => this.w.key(sid, 'esc')).catch((e) => console.error(`[auto] arrêt au réveil de « ${o.title} » : ${(e as Error).message}`))
          this.finish(o, now, false, tr(SM).stoppedOnWake)
        }
    this.changed()
    if (this.auto) setTimeout(() => this.tick(), 1000).unref?.()
  }

  /** What the morning recap reads of each automation (server/sleep.ts nightRecap). */
  recapAutos(): RecapAuto[] {
    const stopped = tr(SM).stoppedOnWake
    return this.s.items.filter((o) => !o.builtin && o.state !== 'proposed' && o.state !== 'refused').map((o) => ({ id: o.id, title: o.title, runs: o.runs ?? [], state: o.state, startedAt: o.startedAt, sessionId: o.sessionId, stoppedNote: stopped, supervision: o.supervision ?? [] }))
  }

  /**
   * The trigger, set from the auto page without a model: « when I sleep » (and whether it stops on wake), or back to
   * running when nothing else runs. The task's version moves on (an older ✓ no longer holds). null: no such task, or
   * already over.
   */
  setTrigger(id: string, raw: unknown): Optimizer | null {
    const o = this.get(id)
    if (!o || o.builtin || (o.state !== 'proposed' && o.state !== 'queued' && o.state !== 'running')) return null
    const x = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const p: Patch = {}
    if (typeof x.onSleep === 'boolean') p.onSleep = x.onSleep ? true : null
    if (typeof x.stopOnWake === 'boolean') p.stopOnWake = x.stopOnWake ? true : null
    const changed = this.patch(o, p)
    if (changed.length) {
      const now = Date.now()
      o.changed = { at: now, fields: changed }
      o.rev = (o.rev ?? 0) + 1
      console.log(`[auto] « ${o.title} » : déclencheur ${o.onSleep ? `quand je dors${o.stopOnWake ? ', arrêt au réveil' : ''}` : 'normal'}`)
    }
    this.changed()
    if (this.auto) setTimeout(() => this.tick(), 1000).unref?.()
    return this.view(o)
  }

  /**
   * Its name and its family in the drawer, set by hand (the user, weevboss): nothing else changes, no model, no new
   * version to accept. title: 1-60 characters; group: up to 24, empty or null takes it out of its family. null: no such
   * task, or a value out of bounds.
   */
  label(id: string, raw: unknown): Optimizer | null {
    const o = this.get(id)
    if (!o || o.deletedAt || o.state === 'refused') return null
    const x = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const clean = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : undefined)
    const title = clean(x.title)
    const group = x.group === null ? '' : clean(x.group)
    if (title === undefined && group === undefined) return null
    if (title !== undefined && (!title || title.length > 60)) return null
    if (group !== undefined && group.length > 24) return null
    if (title) o.title = title
    if (group !== undefined) {
      if (group) o.group = group
      else delete o.group
    }
    this.changed()
    return this.view(o)
  }

  /** The machine as the runner sees it (snapshot). */
  machine(now = Date.now()): AutoMachine {
    const load = this.sys.load()
    const cpus = this.sys.cpus()
    const free = this.sys.free()
    return { load: Math.round(load * 100) / 100, cpus, freeGb: Math.round((free / 1024 ** 3) * 10) / 10, wait: freeReason({ idleFor: now - this.lastBusyAt, load, cpus, free }) }
  }

  get(id: string) {
    return this.s.items.find((o) => o.id === id && !o.deletedAt)
  }

  /** Delete the automation, not its files or running job. Persist before acknowledging. */
  remove(id:string): {ok:true;running:boolean}|null {
    const o=this.s.items.find(x=>x.id===id)
    if(!o)return null
    if(o.deletedAt)return {ok:true,running:o.state==='running'}
    const previous={...o}
    o.deletedAt=Date.now()
    if(o.state!=='running')o.state='refused'
    delete o.pending; delete o.runNow; delete o.retryAt; delete o.held; delete o.waiting
    try { this.save(true) } catch(e) { for(const key of Object.keys(o))delete (o as any)[key];Object.assign(o,previous);throw e }
    this.w.bump()
    return {ok:true,running:o.state==='running'}
  }

  /** Recover the existing, never accepted draft; this cannot enable a trigger or start a job. */
  restoreDraft(id:string,expectedEndedAt?:number):Optimizer|null {
    const o=this.s.items.find(x=>x.id===id)
    if(!o || !o.userCreated || !o.draft || o.deletedAt || o.acceptedAt || o.sessionId)return null
    if(o.state==='proposed')return this.view(o)
    if(o.state!=='refused'||(expectedEndedAt!==undefined&&o.endedAt!==expectedEndedAt))return null
    const backupDir=path.join(path.dirname(this.file),'automation-recovery')
    fs.mkdirSync(backupDir,{recursive:true,mode:0o700})
    const backup=path.join(backupDir,`${o.id}-${o.endedAt ?? o.createdAt}.json`)
    if(!fs.existsSync(backup))fs.writeFileSync(backup,JSON.stringify(o,null,2),{mode:0o600,flag:'wx'})
    const previous={...o}
    o.state='proposed'
    o.lifecycle=[...(o.lifecycle??[]),{at:Date.now(),action:'restore-draft' as const,priorEndedAt:o.endedAt,wasDraft:true}].slice(-100)
    delete o.endedAt
    try{this.save(true)}catch(e){for(const key of Object.keys(o))delete (o as any)[key];Object.assign(o,previous);throw e}
    console.log(`[auto] ${o.id} draft restored; original decline ${previous.endedAt ?? 'unknown'}`)
    this.w.bump()
    return this.view(o)
  }

  private completeProposal(o: Pick<Stored, 'title' | 'prompt' | 'repo'>): boolean {
    return o.title.trim().length >= 3 && o.prompt.trim().length >= 20 &&
      (o.repo === null || this.w.allRepos().includes(o.repo))
  }

  /** Explicit review of a legacy draft, never inference from its assistant's prose. This only exposes the normal
   * approval action. The caller must review the full stored proposal and supply its revision; no job is accepted.
   * Only source/scope corrections are allowed here: scheduling, history, IDs and software ownership stay intact. */
  prepareProposal(id: string, expectedRev: number, expectedTalkAt: number, raw: unknown = {}): Optimizer | null {
    const o = this.get(id)
    if (!o || o.deletedAt || o.state !== 'proposed' || !o.userCreated || o.acceptedAt || o.sessionId || this.talking.has(id) || !Number.isInteger(expectedRev) || expectedRev < 0 || !Number.isFinite(expectedTalkAt) || expectedTalkAt !== (o.talk?.at(-1)?.at ?? 0)) return null
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const input = raw as Record<string, unknown>
    if (Object.keys(input).some(k => !['title', 'why', 'repo', 'prompt'].includes(k))) return null
    const p = parsePatch(input, { repos: this.w.allRepos(), tz: o.tz ?? serverTz(), now: Date.now() })
    if (Object.keys(input).some(k => !(k in p) || input[k] !== p[k as keyof Patch])) return null
    const requestHash = crypto.createHash('sha256').update(JSON.stringify([id, expectedRev, expectedTalkAt, p])).digest('hex')
    if (!o.draft && o.proposalPreparation?.requestHash === requestHash && o.rev === o.proposalPreparation.revision) return this.view(o)
    if (!o.draft || (o.rev ?? 0) !== expectedRev || !this.completeProposal({ ...o, ...p })) return null
    const backupDir = path.join(path.dirname(this.file), 'automation-recovery')
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 })
    const backup = path.join(backupDir, `${id}-prepare-${expectedRev}.json`)
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, JSON.stringify(o, null, 2), { mode: 0o600, flag: 'wx' })
    const previous = structuredClone(o)
    const changed = this.patch(o, p)
    const now = Date.now()
    delete o.draft
    o.rev = expectedRev + 1
    o.proposalPreparation = { at: now, source: 'review', revision: o.rev, requestHash }
    if (changed.length) o.changed = { at: now, fields: changed }
    try { this.save(true) } catch (e) {
      for (const key of Object.keys(o)) delete (o as any)[key]
      Object.assign(o, previous)
      throw e
    }
    this.w.bump()
    return this.view(o)
  }

  /** A fresh creation conversation, without a model call or an executable brief. */
  create(creationKey?:string): Optimizer {
    if(creationKey){
      const existing=this.s.items.find(o=>o.creationKey===creationKey)
      if(existing){if(existing.deletedAt)throw new Error(tr(O).notFound);return this.view(existing)}
    }
    const t = tr(O)
    const now = Date.now()
    const o: Stored = { id: crypto.randomBytes(5).toString('hex'), title: t.newTitle, why: '', repo: null, kind: 'other', heavy: false, state: 'proposed', draft: true, userCreated: true, prompt: '', createdAt: now, talk: [{ who: 'auto', text: t.newQuestion, at: now, suggestions: this.creationSuggestions() }] }
    if(creationKey)o.creationKey=creationKey
    this.s.items.push(o)
    try{this.save(true)}catch(e){this.s.items=this.s.items.filter(item=>item!==o);throw e}
    this.w.bump()
    if(this.auto)void this.adoptAll()
    return this.view(o)
  }

  /** Immediate suggestions from real project activity and prior usage, with useful fallbacks on a blank install. */
  private creationSuggestions(): AutoSuggestion[] {
    const t = tr(O)
    const snap = this.w.snapshot()
    const known = new Set(this.w.allRepos())
    const projects = snap.projects.filter((p) => p.kind === 'repo' && p.repos.some((r) => known.has(r)))
    const activeAt = (p: (typeof projects)[number]) => Math.max(p.lastActivityAt, ...snap.sessions.filter((s) => s.projectId === p.id).map((s) => s.lastActivityAt))
    const project = [...projects].sort((a, b) => activeAt(b) - activeAt(a))[0]
    const name = project ? tidy(project.name, 60) : ''
    const watch = [...this.s.items].filter((o) => o.kind === 'watch' && (o.state === 'queued' || o.state === 'running' || o.state === 'done')).sort((a, b) => (b.endedAt ?? b.startedAt ?? b.createdAt) - (a.endedAt ?? a.startedAt ?? a.createdAt))[0]
    const topic = watch ? tidy(watch.title, 60) : ''
    return [
      { label: t.suggestFollowLabel(name), text: t.suggestFollowText(name) },
      { label: t.suggestWatchLabel(topic), text: t.suggestWatchText(topic) },
      { label: t.suggestSummaryLabel(name), text: t.suggestSummaryText(name) },
      { label: t.suggestReminderLabel, text: t.suggestReminderText },
    ]
  }

  /**
   * One tap: the proposal, as it stands after the exchange (the version on screen: `rev`, when given, must match),
   * waits for a free machine and its time. Never while the model is rewriting it.
   */
  accept(id: string, rev?: number): boolean | 'busy' {
    const o = this.get(id)
    if (!o || o.state !== 'proposed') return false
    if (o.draft || this.talking.has(id) || (rev !== undefined && rev !== (o.rev ?? 0))) return 'busy'
    if(o.repo)this.w.assertRepoExecution?.(o.repo)
    o.state = 'queued'
    o.acceptedAt = Date.now()
    this.s.refillAt = o.acceptedAt
    this.changed()
    if (this.auto) setTimeout(() => this.tick(), 1000).unref?.()
    return true
  }

  /** Refused (or taken back before it starts): kept for the prompt (never proposed again), hidden from the app. */
  refuse(id: string, source:'api'|'internal'='internal'): boolean {
    const o = this.get(id)
    if (!o || (o.state !== 'proposed' && o.state !== 'queued') || (o.draft && source==='api')) return false
    if (o.state === 'proposed') this.s.refillAt = Date.now()
    o.lifecycle=[...(o.lifecycle??[]),{at:Date.now(),action:'refuse' as const,source,wasDraft:!!o.draft}].slice(-100)
    o.state = 'refused'
    o.endedAt = Date.now()
    delete o.waiting
    delete o.retryAt
    delete o.paused
    delete o.runNow
    this.changed()
    return true
  }

  /**
   * Paused by the user (an accepted task, queued or running): the runner skips it, it waits as « paused ». A running
   * one ends its run and then waits. Played again: back to its turn and its time. false: no such task, or not accepted.
   */
  pause(id: string, paused: boolean): boolean {
    const o = this.get(id)
    if (!o || (o.state !== 'queued' && o.state !== 'running')) return false
    if (paused) {
      o.paused = true
      delete o.runNow
      if (o.state === 'queued') o.waiting = 'paused'
    } else {
      delete o.paused
      if (o.waiting === 'paused') delete o.waiting
    }
    this.changed()
    if (this.auto) setTimeout(() => this.tick(), 1000).unref?.()
    return true
  }

  /**
   * « Run now »: a queued task starts as soon as the machine is free, whatever its time, its retry or its pause; a
   * recurring one keeps its schedule (its next run stays where it was). false: no such task, or not waiting in the queue.
   */
  runNow(id: string): boolean {
    const o = this.get(id)
    if (!o || o.state !== 'queued') return false
    if(o.repo)this.w.assertRepoExecution?.(o.repo)
    o.runNow = true
    delete o.paused
    delete o.retryAt
    if (o.waiting === 'paused' || o.waiting === 'later' || o.waiting === 'time') delete o.waiting
    this.changed()
    if (this.auto) setTimeout(() => this.tick(), 1000).unref?.()
    return true
  }

  // ---------------------------------------------------------------- the exchange about a task

  /**
   * One turn of the exchange about a task (typed or spoken, any state but refused): the model answers and may rewrite
   * it (parsePatch checks every field). What changes depends on the state (patchable): all of it before it starts;
   * while it runs, its conditions now and its scope at its next run (the running session is never touched); nothing
   * once it is over. The exchange stays on the task. One turn at a time per task; a model that fails answers with a
   * note from the catalog, nothing changes and the question is not kept. null: no such task.
   */
  async talk(id: string, text: string, tz?: unknown): Promise<OptimizerTalkReply | null> {
    const o = this.get(id)
    if (!o || o.state === 'refused') return null
    const said = text.replace(/\s+/g, ' ').trim().slice(0, TALK_CHARS)
    const was = o.state
    const replyLang: Lang = detectLang(said) ?? lang()
    const note = (k: 'talkFailed' | 'talkBusy' | 'talkMoved' | 'talkHeld' | 'talkIncomplete'): OptimizerTalkReply => ({ reply: withLang(replyLang, () => tr(O)[k]), item: this.view(o), changed: [], failed: true })
    if (!said) return { reply: '', item: this.view(o), changed: [] }
    if (this.talking.has(id)) return note('talkBusy')
    const held = !!this.w.relay?.holdUntil()
    const onCodex = preferredTool() === 'codex' ? providerReady() : held && !!this.w.relay?.autoOnCodex()
    if (Date.now() < (this.talkFailUntil.get(id) ?? 0) || (held && !onCodex) || (!onCodex && !this.sys.logged())) return note('talkFailed')
    const zone = validTz(tz) ?? o.tz ?? serverTz()
    this.talking.add(id)
    try {
      let out: { reply?: unknown; patch?: unknown; ready?: unknown; suggestions?: unknown } | null = null
      let untrusted = false
      try {
        const turn = this.talkTurn(o, said, zone, replyLang)
        untrusted = turn.untrusted
        out = parseJson(await (onCodex ? relayAnswer : smart)(turn.prompt, TALK_TIMEOUT_MS))
      } catch (e) {
        // Never the message itself: claude's command line holds the whole prompt (the memory).
        const err = e as NodeJS.ErrnoException & { killed?: boolean }
        console.error(`[auto] échange sur « ${o.title} » : ${err.killed ? 'délai dépassé' : `échec (${err.code ?? '?'})`}`)
      }
      let reply = typeof out?.reply === 'string' ? oneLine(out.reply, 700) : ''
      if (!reply) {
        this.talkFailUntil.set(id, Date.now() + TALK_BACKOFF_MS)
        return note('talkFailed')
      }
      this.talkFailUntil.delete(id)
      // The task moved on while the model thought (a run ended, came back, was stopped): its answer was written for
      // the old state and may say a change was made that this state no longer takes. Nothing changes, nothing is kept.
      // (The runner never starts a task during a turn: tick() leaves it for the next one.)
      if (o.state !== was || o.deletedAt) return note('talkMoved')
      const now = Date.now()
      const p = parsePatch(out?.patch, { repos: this.w.allRepos(), tz: zone, now })
      // A natural-language promise is never a phase transition. Both providers must return a real boolean;
      // readiness applies to the accumulated proposal, not just fields changed in the last response.
      const rejectedField = out?.patch && typeof out.patch === 'object' && Object.keys(out.patch).some(k => !(k in p))
      if (o.draft && (typeof out?.ready !== 'boolean' || (out.ready && (rejectedField || !this.completeProposal({ ...o, ...p }))))) return note('talkIncomplete')
      // The prompt carried what an agent wrote (its report, its last words: maybe a web page's text). A short bare
      // question never rewrites the task then, nor does a move to a repo the user did not name: such a rewrite comes
      // from that text, not from them. Nothing changes, nothing is kept, and the reply says so.
      if (untrusted && (o.state === 'queued' || o.state === 'running') && this.differs(o, p) && (bareQuestion(said) || (p.repo && p.repo !== o.repo && !norm(said).includes(norm(p.repo))))) {
        console.log(`[auto] « ${o.title} » : réécriture écartée (pas demandée)`)
        return note('talkHeld')
      }
      const changed = this.patch(o, p)
      const prepared = o.draft && out?.ready === true
      if (prepared) {
        delete o.draft
        // The server, not the model, promises the approval action after validating its existence.
        reply = withLang(replyLang, () => tr(O).talkPrepared)
      }
      if (validTz(tz)) o.tz = zone
      o.talk = capTalk([...(o.talk ?? []), { who: 'user', text: said, at: now }, { who: 'auto', text: reply, at: Date.now(), ...(o.draft ? { suggestions: parseSuggestions(out?.suggestions) } : {}), ...(changed.length ? { changed } : {}) }])
      if (changed.length || prepared) {
        if (changed.length) o.changed = { at: now, fields: changed }
        o.rev = (o.rev ?? 0) + 1
        if (prepared) o.proposalPreparation = { at: now, source: 'conversation', revision: o.rev }
        console.log(`[auto] « ${o.title} » réécrite (${changed.join(', ')})`)
      }
      this.changed()
      if (changed.length && this.auto) setTimeout(() => this.tick(), 1000).unref?.()
      return { reply, item: this.view(o), changed }
    } finally {
      this.talking.delete(id)
    }
  }

  /** Applies a checked rewrite as the task's state allows; the fields that really changed (what the app flashes). */
  private patch(o: Stored, p: Patch): OptimizerField[] {
    if (o.state !== 'proposed' && o.state !== 'queued' && o.state !== 'running') return []
    const changed: OptimizerField[] = []
    const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
    for (const k of TERMS) {
      if (!(k in p) || same(o[k], p[k])) continue
      if (p[k] === null) delete o[k]
      else (o as unknown as Record<string, unknown>)[k] = p[k]
      changed.push(k)
    }
    let next = false
    for (const k of SCOPE) {
      if (!(k in p)) continue
      if (o.state === 'running') {
        // Its session already has its brief: the new scope waits for its next run, and only a task that comes back
        // has one (the model is told so: rules_running_once).
        if (!o.every && !o.onSleep) continue
        const was = o.pending && k in o.pending ? o.pending[k] : o[k]
        if (same(was, p[k])) continue
        const pending: Record<string, unknown> = { ...o.pending }
        if (same(o[k], p[k])) delete pending[k]
        else pending[k] = p[k]
        o.pending = pending as Stored['pending']
        next = true
        continue
      }
      // Set now: an older agreement for the next run no longer holds.
      if (o.pending) delete o.pending[k]
      if (same(o[k], p[k])) continue
      ;(o as unknown as Record<string, unknown>)[k] = p[k]
      changed.push(k)
    }
    // « When I sleep » keeps its times as the fallback (sleepHeld()); without it, nothing stops on wake.
    if (!o.onSleep && o.stopOnWake) {
      delete o.stopOnWake
      if (!changed.includes('stopOnWake')) changed.push('stopOnWake')
    }
    if (o.pending && !Object.keys(o.pending).length) delete o.pending
    if (next) changed.push('next')
    // A new scope before the first start: a fresh branch name follows the new title.
    if (o.state !== 'running' && (changed.includes('title') || changed.includes('repo')) && !o.startedAt) delete o.branch
    return changed
  }

  /** A rewrite that would change something on this task (a field the task does not already have). */
  private differs(o: Stored, p: Patch): boolean {
    const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
    return ([...TERMS, ...SCOPE] as const).some((k) => k in p && !same(o[k], p[k]))
  }

  /** The prompt of one exchange turn (also read by the tests). */
  talkPrompt(o: Stored, said: string, tz: string, replyLang: Lang, now = Date.now()): string {
    return this.talkTurn(o, said, tz, replyLang, now).prompt
  }

  /** The prompt, and whether it carries what an agent wrote (untrusted: see talk()). */
  private talkTurn(o: Stored, said: string, tz: string, replyLang: Lang, now = Date.now()): { prompt: string; untrusted: boolean } {
    const t = tr(O)
    const name = user()
    const when = [o.onSleep ? t.whenSleep(!!o.stopOnWake) : '', o.notBefore && o.notBefore > now ? t.whenNotBefore(fmtLocal(o.notBefore, tz)) : '', o.window ? t.whenWindow(windowText(o.window)) : ''].filter(Boolean).join(', ') || t.whenAsap
    const item = t.talkItem({
      title: o.title,
      why: o.why,
      kind: o.kind,
      repo: o.repo,
      est: o.est ?? 30,
      priority: o.priority ?? 2,
      heavy: o.heavy,
      when,
      every: [o.onSleep ? t.everySleep : '', o.every ? t.everyEvery(fmtSpan(o.every)) : ''].filter(Boolean).join(', ') || t.everyOnce,
      prompt: o.prompt,
    })
    const history = (o.talk ?? []).map((l) => (l.who === 'user' ? t.lineUser(name, l.text) : t.lineAuto(l.text))).join('\n')
    const weekday = new Intl.DateTimeFormat(lang() === 'fr' ? 'fr-FR' : 'en-US', { weekday: 'long', timeZone: tz }).format(now)
    const repos = this.w.allRepos().slice(0, 80).join(', ')
    const machine = t.machine(this.sys.cpus(), Math.round(os.totalmem() / 1024 ** 3), `${os.platform()} ${os.arch()}`)
    const rules = o.draft ? t.rules_draft : o.state === 'proposed' ? t.rules_proposed : o.state === 'queued' ? t.rules_queued : o.state === 'running' ? (o.every || o.onSleep ? t.rules_running : t.rules_running_once) : t.rules_ended
    const live = this.liveText(o, now, tz)
    const prompt = t.talk({
      user: name,
      state: t[`state_${o.state}`],
      rules,
      item,
      live: live.text,
      memory: this.memory.asText(),
      projects: this.projectsText(),
      repos,
      machine,
      now: `${weekday} ${fmtLocal(now, tz)} (${tz})`,
      history,
      said: t.lineUser(name, said),
      replyLang: t.langName(replyLang),
      appLang: t.langName(lang()),
    })
    return { prompt, untrusted: live.untrusted }
  }

  /**
   * What a started task did: the agent's last words (running), its last news and report (over), its past runs. What
   * an agent wrote is fenced as data (a nonce the text cannot close), never as instructions; untrusted: there is some.
   */
  private liveText(o: Stored, now: number, tz: string): { text: string; untrusted: boolean } {
    const t = tr(O)
    const out: string[] = []
    const nonce = crypto.randomBytes(4).toString('hex')
    let untrusted = false
    const fence = (text: string) => {
      untrusted = true
      return t.untrusted(nonce, text.replaceAll(nonce, ''))
    }
    if (o.state === 'running') {
      const d = o.sessionId ? this.w.detail?.(o.sessionId) : undefined
      let said = (d?.messages ?? [])
        .filter((m) => m.role === 'assistant' && m.text.trim())
        .slice(-2)
        .map((m) => m.text.replace(/\s+/g, ' ').trim().slice(0, 900))
      if (!said.length) {
        const s = o.sessionId ? this.w.snapshot().sessions.find((x) => x.id === o.sessionId) : undefined
        if (s?.lastMessage) said = [s.lastMessage.slice(0, 900)]
      }
      out.push(t.liveRunning(Math.round((now - (o.startedAt ?? now)) / 60_000), said.length ? fence(said.join('\n')) : ''))
    } else if (o.state === 'done' || o.state === 'failed') out.push(t.liveEnded(t[`state_${o.state}`], o.lastEvent ? fence(o.lastEvent) : ''))
    if (o.state !== 'proposed') {
      const report = this.reportFile(o)
      try {
        const text = fs.readFileSync(report, 'utf8').trim().slice(0, 1500)
        if (text) out.push(t.liveReport(fence(text)))
      } catch {
        /* no report (yet) */
      }
    }
    if (o.runs?.length) out.push(t.liveRuns(fence(o.runs.slice(-4).map((r) => t.runLine(fmtLocal(r.at, tz), r.ok, r.note ?? '')).join('\n'))))
    return { text: out.join('\n\n'), untrusted }
  }

  /** Where a task writes its report (beside its worktree, or in its workspace). */
  private reportFile(o: Stored): string {
    const cwd = this.workspace(o)
    return o.repo ? path.join(path.dirname(cwd), `${o.id}.md`) : path.join(cwd, 'report.md')
  }

  // ---------------------------------------------------------------- the runner

  /** Every minute: follow the running task, say what the queue waits for, start the next one, maybe propose. */
  tick(now = Date.now()) {
    if(this.auto)void this.adoptAll()
    let dirty = this.follow(now)
    if (now - this.supervisedAt >= SUPERVISE_MS) {
      this.supervisedAt = now
      dirty = this.look(now) || dirty
    }
    const snap = this.w.snapshot()
    const running = this.s.items.find((o) => o.state === 'running')
    const busy =
      !!snap.mainWorking || snap.sessions.some((s) => s.machineId === MACHINE.id && s.status === 'working' && s.id !== running?.sessionId)
    if (busy) this.lastBusyAt = now
    const reason = this.machine(now).wait
    for (const o of this.s.items)
      if (o.builtin && !o.deletedAt && o.state === 'queued' && !o.paused && this.timeAt(o, now) <= now) void this.runBuiltin(o, now)
    const queue = this.s.items.filter((o) => !o.deletedAt && o.state === 'queued' && !o.builtin).sort((a, b) => (a.acceptedAt ?? a.createdAt) - (b.acceptedAt ?? b.createdAt))
    // Claude at its limit (server/relay.ts): new tasks start on Codex when the relay is automatic, otherwise every
    // task waits for the reset time.
    const selected = this.w.relay?.executionTool?.(preferredTool())
    const providerHold = selected === null
    const hold = selected === 'claude' ? 0 : this.w.relay?.holdUntil(now) ?? 0
    // Codex has no deny list: only on a machine where the jail holds (probed once), otherwise the tasks wait too.
    if ((hold || preferredTool() === 'codex') && this.bwrap === undefined && !this.probingJail) {
      this.probingJail = true
      void this.sys
        .jail(['--dev-bind', '/', '/', '--'])
        .catch(() => false)
        .then((ok) => {
          this.bwrap = ok
          this.probingJail = false
          if(this.auto)queueMicrotask(()=>this.tick())
        })
    }
    const codex = (selected !== undefined ? selected === 'codex' : preferredTool() === 'codex' ? providerReady() : !!hold && !!this.w.relay?.autoOnCodex()) && this.bwrap === true
    // The asynchronous jail probe may have held these tasks on the previous tick. Once an authorized
    // Codex route is safe (or Claude's hold ended), that provider hold is no longer a scheduled time.
    if (codex || (!hold && !providerHold))
      for (const o of queue)
        if (o.held) {
          delete o.held
          delete o.retryAt
          dirty = true
        }
    if ((hold && !codex) || providerHold)
      for (const o of queue)
        if (!o.held || (o.retryAt ?? 0) < (providerHold ? now : hold)) {
          o.held = true
          o.retryAt = providerHold ? (this.w.relay?.retryAt() ?? now + 60_000) : hold
          dirty = true
        }
    // On a Mac a task that would run on Codex never starts (no jail there): it says why instead of waiting in silence,
    // and stops saying it once Claude is the one that runs it.
    const macNote = this.platform === 'darwin' && (selected !== undefined ? selected === 'codex' : preferredTool() === 'codex') ? tr(O).noJailMac : undefined
    for (const o of queue)
      if (macNote ? o.lastEvent !== macNote : MAC_NOTES.includes(o.lastEvent ?? '')) {
        if (macNote) o.lastEvent = macNote
        else delete o.lastEvent
        dirty = true
      }
    // Stopped by a limit or an error: it waits for its retry time, the others go first. Same for one held by its
    // conditions (not before, its window, its next run).
    // Paused by the user: skipped until played again. Asked to run now: first in line, whatever its time.
    const later = (o: Stored) => !!o.retryAt && o.retryAt > now
    const blocked=(o:Stored)=>!!o.repo&&this.w.sourceAccessForRepo?.(o.repo)?.canExecute===false
    const ready = queue.filter((o) => !blocked(o) && (!this.auto || this.s.adoptionPaused || o.software?.status==='ready') && !o.paused && !later(o) && !this.sleepHeld(o, now) && this.timeAt(o, now) <= now).sort((a, b) => Number(!!b.runNow) - Number(!!a.runNow) || Number(!!b.onSleep) - Number(!!a.onSleep))
    // What the user wants run never waits for other agents to rest (they may work all day, or till morning as the
    // night's ghosts): an automation they created or asked for, « when I sleep », run now, or a supervisor relaunch
    // waits only for the machine's load and memory (and quota, see later()). Only an idea weevils proposed by itself
    // stays polite and waits for the agents to rest.
    const wanted = (o: Stored) => !!(o.userCreated || o.onSleep || o.runNow || o.relaunches)
    // « busy » hides the load and memory behind it: read them on their own for these.
    const calm = reason === 'busy' ? freeReason({ idleFor: IDLE_MS, load: this.sys.load(), cpus: this.sys.cpus(), free: this.sys.free() }) : reason
    const reasonFor = (o: Stored | undefined) => (o && wanted(o) ? calm : reason)
    queue.forEach((o) => {
      const i = ready.indexOf(o)
      const wait = o.paused ? 'paused' : blocked(o) ? undefined : i < 0 ? (later(o) ? 'later' : this.sleepHeld(o, now) ? 'sleep' : 'time') : running || this.launching || i > 0 ? 'queue' : (reasonFor(o) ?? undefined)
      if (o.waiting !== wait) {
        if (wait) o.waiting = wait
        else delete o.waiting
        dirty = true
      }
    })
    if (dirty) this.changed()
    // Never without Claude logged in: the session would open on a login screen and sit there.
    // Nor while it is being talked over: its rewrite would land on a running session and be lost. It keeps its turn,
    // the next tick takes it.
    const available = selected === null ? false : selected === 'codex' ? codex : codex || this.sys.logged()
    if (!running && !this.launching && !reasonFor(ready[0]) && ready[0] && !this.talking.has(ready[0].id) && available) void this.launch(ready[0], now, { tool: codex ? 'codex' : selected ?? 'claude' })
    if (this.roundDue(now)) void this.round(now)
  }

  /**
   * The running task's session. Working, or blocked on a question (needs_user: it keeps the one-at-a-time slot) → still
   * running. At rest: a limit or API error → back to the queue for later; a turn still open (a long silent command reads
   * as idle after 10 min) → still running; ended with a real reply → done; ended without one → failed. Gone or too long
   * → failed.
   */
  private follow(now: number): boolean {
    const o = this.s.items.find((x) => x.state === 'running')
    if (!o || this.launching) return false
    const t = tr(O)
    const end = (state: 'done' | 'failed', note: string) => this.finish(o, now, state === 'done', note)
    const limit = o.limitMs ?? runLimit(o.est)
    if (!o.deletedAt && now - (o.startedAt ?? now) > limit) return end('failed', t.timedOut(Math.round(limit / 3600_000)))
    const sid = o.sessionId ? (this.w.sessionIdOf?.(o.sessionId) ?? o.sessionId) : undefined
    const s = sid ? this.w.snapshot().sessions.find((x) => x.id === sid) : undefined
    if (!s) return now - Math.max(o.seenAt ?? o.startedAt ?? now, this.bootAt) > VANISH_MS ? end('failed', t.vanished) : false
    if (o.sessionId !== s.id) o.sessionId = s.id
    o.seenAt = now
    // Unattended, a question never blocks the run: after ASK_MS it goes to For you, and the agent carries on.
    if (s.status === 'needs_user' && !o.askedAt && now - (s.lastActivityAt || now) >= ASK_MS) return this.ask(o, s, now)
    if (s.status === 'working' || s.status === 'needs_user') {
      if (o.seenWorking || s.status !== 'working') return false
      o.seenWorking = true
      return true
    }
    // Handed over to Codex (told to stop before the limit, or cut by it): it waits for its plan's fate, or for Claude.
    if (this.w.relay?.holds(s.id)) return this.hold(o, now)
    const last = s.lastMessage ?? ''
    if (isStall(last)) return this.later(o, now, last)
    // Codex stopped the same way (its own limit, its login, its API).
    if (s.tool === 'codex' && s.status === 'interrupted' && s.interrupted && s.interrupted.reason !== 'died' && s.interrupted.reason !== 'dirty')
      return this.later(o, now, s.interrupted.reason === 'quota' ? 'usage limit' : s.interrupted.reason === 'auth' ? 'login expired' : 'api error')
    if (this.turnOpen(s)) return false
    // A short task can start and finish between two looks: past the start-up delay, at rest means it ended.
    if (!o.seenWorking && now - (o.startedAt ?? now) <= VANISH_MS) return false
    if (s.messageCount < 2) return end('failed', t.noWork)
    return end('done', oneLine(last, 160))
  }

  /**
   * The supervisor's look, every SUPERVISE_MS at any hour (sleep mode or not): a running task whose session sat still
   * for STALL_MS (no transcript activity, not working) is ended as stalled, which relaunches it (supervise). Failed and
   * blocked runs are relaunched as they end; this look catches the ones that never end on their own.
   */
  private look(now: number): boolean {
    const o = this.s.items.find((x) => x.state === 'running')
    if (!o || this.launching || o.deletedAt) return false
    const sid = o.sessionId ? (this.w.sessionIdOf?.(o.sessionId) ?? o.sessionId) : undefined
    const s = sid ? this.w.snapshot().sessions.find((x) => x.id === sid) : undefined
    if (!s || s.status === 'working') return false
    const since = Math.max(s.lastActivityAt || 0, o.startedAt ?? 0)
    if (now - since < STALL_MS) return false
    console.log(`[auto] superviseur : « ${o.title} » immobile depuis ${Math.round((now - since) / 60_000)} min`)
    return this.finish(o, now, false, tr(O).stalled(Math.round((now - since) / 60_000)))
  }

  /**
   * A run just ended. Failed (not stopped on wake, deleted, or out of quota: those wait on their own) or blocked (it says
   * a permission or the sandbox stopped it): back to the queue, relaunched SUPERVISE_MS later through the normal queue
   * (machine load, memory, quota holds all apply), MAX_RELAUNCHES times in a row at most, then reported as still
   * failing. A « when I sleep » task relaunches too, sleep mode on or off. A good run resets the count.
   * true: the supervisor decided the task's state.
   */
  private supervise(o: Stored, now: number, ok: boolean, note: string): boolean {
    const said = o.sessionId ? this.w.detail?.(o.sessionId)?.messages.filter((m) => m.role === 'assistant' && m.text.trim()).at(-1)?.text : undefined
    const blocked = isBlocked(note) || (ok && isBlocked(said?.slice(0, 2000)))
    if (ok && !blocked) {
      delete o.relaunches
      return false
    }
    // Stopped by Claude itself (limit, login, API): later() already retried it MAX_TRIES times, spaced out.
    const quota = [O.fr, O.en].some((l) => [l.stall_limit, l.stall_login, l.stall_api].includes(note))
    if (o.deletedAt || o.builtin || note === tr(SM).stoppedOnWake || quota) return false
    const why = blocked ? oneLine(isBlocked(note) ? note : said ?? note, 160) : note
    const log = (action: Supervision['action']) => (o.supervision = [...(o.supervision ?? []), { at: now, action, why }].slice(-20))
    if ((o.relaunches ?? 0) >= MAX_RELAUNCHES) {
      log('gave-up')
      delete o.relaunches
      console.log(`[auto] superviseur : « ${o.title} » toujours en échec après ${MAX_RELAUNCHES} relances (${why})`)
      return false
    }
    o.relaunches = (o.relaunches ?? 0) + 1
    log('relaunch')
    this.takePending(o)
    delete o.paused
    delete o.sleepRunFor
    delete o.seenWorking
    delete o.seenAt
    delete o.askedAt
    o.state = 'queued'
    o.retryAt = now + SUPERVISE_MS
    o.waiting = 'later'
    o.lastEvent = blocked ? why : note
    console.log(`[auto] superviseur : « ${o.title} » ${blocked ? 'bloquée' : 'en échec'} (${why}) · relance ${o.relaunches}/${MAX_RELAUNCHES} dans ${SUPERVISE_MS / 60_000} min`)
    return true
  }

  /** A run's question goes to For you; the agent is told to carry on without it (its dialog closed). */
  private ask(o: Stored, s: Session, now: number): boolean {
    const t = tr(O)
    o.askedAt = now
    const question = oneLine(s.attention || s.lastMessage || '', 600)
    o.supervision = [...(o.supervision ?? []), { at: now, action: 'asked' as const, why: oneLine(question, 160) }].slice(-20)
    try {
      this.w.foryou?.add({ id: `auto-ask:${o.id}:${o.startedAt ?? now}`, kind: 'boss', tone: 'neutral', who: 'weevils', title: t.askTitle(o.title), text: question || t.askTitle(o.title), open: { page: 'auto', id: o.id } })
    } catch (e) {
      console.error(`[auto] question de « ${o.title} » : ${(e as Error).message}`)
    }
    void Promise.resolve()
      .then(() => this.w.key(s.id, 'esc'))
      .then(() => this.w.send(s.id, t.askNudge))
      .catch((e) => console.error(`[auto] relance de « ${o.title} » après sa question : ${(e as Error).message}`))
    console.log(`[auto] superviseur : la question de « ${o.title} » part dans « pour toi », la tâche continue`)
    return true
  }

  /** After a run, its own branch goes to origin (pushBranch: auto/… only, never forced), in the background. */
  private pushRun(o: Stored) {
    if (!o.repo || !o.branch || o.deletedAt || o.builtin) return
    const place = this.place(o)
    if (!place?.cwd || !fs.existsSync(place.cwd)) return
    const { branch, baseCommit, startedAt, id, title } = o
    void this.sys
      .push(place.cwd, branch, baseCommit)
      .then((pushed) => {
        if (!pushed) return
        const r = this.get(id)?.runs?.find((x) => x.startedAt === startedAt)
        if (r) {
          r.pushed = branch
          this.changed()
        }
        console.log(`[auto] « ${title} » : branche ${branch} poussée`)
      })
      .catch((e) => console.error(`[auto] push de « ${title} » : ${(e as Error).message}`))
  }

  /** The agent's turn has not ended: its transcript waits for a tool's result and no Stop hook came since. */
  private turnOpen(s: Session): boolean {
    if (!s.live) return false
    const tr = this.w.store?.get(s.id)
    if (tr?.phase !== 'working') return false
    const h = this.w.hooks?.get(s.id)
    return !(h && (h.event === 'Stop' || h.event === 'SessionEnd') && h.at >= tr.lastActivityAt - 2000)
  }

  /**
   * A run is over. A one-off task ends there (done or failed). A recurring one keeps the run's line and goes back to
   * the queue for its next occurrence (one period after the slot it was due at, with the scope agreed while it ran),
   * unless its last runs all failed.
   */
  private finish(o: Stored, now: number, ok: boolean, note: string): true {
    o.endedAt = now
    o.lastEvent = note
    // Whatever recording meets, the task leaves « running »: a runner wedged on one task would start no other.
    let runs: AutoRun[]
    try {
      runs = this.record(o, now, ok, note)
    } catch (e) {
      console.error(`[auto] passage de « ${o.title} » non enregistré : ${(e as Error).message}`)
      runs = o.runs ?? []
    }
    this.pushRun(o)
    if (this.supervise(o, now, ok, note)) return true
    if (!o.deletedAt && (o.every || o.onSleep)) {
      const streak = runs.slice(-MAX_FAILED_RUNS)
      // A run stopped on wake is no failure of the task.
      const stopped = tr(SM).stoppedOnWake
      if (ok || streak.length < MAX_FAILED_RUNS || streak.some((r) => r.ok || r.note === stopped)) {
        this.takePending(o)
        o.state = 'queued'
        // From the slot it was due at, not from when it could start: a busy evening never drifts the next nights.
        // « When I sleep »: the next night is its next time, its own period the fallback.
        if (o.every) o.notBefore = Math.max(nextRun(o.slotAt ?? o.startedAt ?? now, o.every, now), o.notBefore ?? 0)
        delete o.waiting
        delete o.retryAt
        delete o.tries
        delete o.seenWorking
        delete o.seenAt
        console.log(`[auto] « ${o.title} » ${ok ? 'faite' : 'échouée'} · prochain passage ${o.onSleep ? `à la prochaine nuit${o.notBefore ? ` ou au plus tard ${new Date(o.notBefore).toISOString()}` : ''}` : new Date(o.notBefore ?? now).toISOString()}`)
        return true
      }
    }
    delete o.pending
    delete o.paused
    delete o.runNow
    o.state = ok ? 'done' : 'failed'
    return true
  }

  /**
   * Every run is recorded, one-off or recurring: its summary on the task (the last MAX_RUNS, oldest first; the count and
   * the tokens never capped), and what it left in the archive (written in the background: the git diff).
   */
  private record(o: Stored, now: number, ok: boolean, note: string): AutoRun[] {
    const startedAt = o.startedAt ?? now
    const sessionId = o.sessionId
    const t = sessionId ? this.w.store?.get(sessionId) : undefined
    const tokens = t?.file ? sessionTokens(t.file, t.tool) : 0
    const run: AutoRun = { ...(o.runSourceRevision?{softwareId:o.id,sourceRevision:o.runSourceRevision,configRevision:o.runConfigRevision}:{}), at: now, startedAt, ok, ...(note ? { note } : {}), ...(tokens ? { tokens } : {}), ...(sessionId ? { sessionId } : {}) }
    const before = o.runs ?? []
    o.runCount = (o.runCount ?? before.length) + 1
    if (tokens) o.tokens = (o.tokens ?? 0) + tokens
    const runs = [...before.filter((r) => r.startedAt !== startedAt), run].slice(-MAX_RUNS)
    o.runs = runs
    // Read now, before the next run overwrites them: the report (beside the worktree, rewritten every run) and the
    // agent's last words.
    // Its repo gone (renamed, deleted, out of the roots): no report, no files, the run is still recorded.
    const place = o.builtin ? null : this.place(o)
    const reportFile = place ? this.reportFile(o) : undefined
    let report: string | undefined = o.builtin ? this.builtinReports.get(o.id) : undefined
    try {
      if (reportFile && fs.statSync(reportFile).mtimeMs >= startedAt - 2000) report = fs.readFileSync(reportFile, 'utf8').slice(0, MAX_REPORT).trim() || undefined
    } catch {
      /* no report this run */
    }
    const said = sessionId ? this.w.detail?.(sessionId)?.messages.filter((m) => m.role === 'assistant' && m.text.trim()).at(-1)?.text : undefined
    const message = (said ?? (sessionId ? this.w.snapshot().sessions.find((x) => x.id === sessionId)?.lastMessage : undefined) ?? '').trim().slice(0, 4000) || undefined
    const job = this.writeRun(o, run, { cwd: place?.cwd, repoDir: place?.repoDir, base: o.baseCommit, report, reportFile, message, keep: runs.map((r) => r.startedAt) })
    this.writing.add(job)
    void job.finally(() => this.writing.delete(job))
    return runs
  }

  /** The archive of one run: its files (git diff from where it started, or what it wrote in its workspace), links,
   *  images (copied), then the file count on its summary. */
  private async writeRun(o: Stored, run: AutoRun, x: { cwd?: string; repoDir?: string; base?: string; report?: string; reportFile?: string; message?: string; keep: number[] }) {
    try {
      const files = !x.cwd ? [] : ((x.base && x.repoDir ? await gitFiles(x.repoDir, x.cwd, x.base, run.startedAt) : null) ?? mtimeFiles(x.cwd, run.startedAt, run.at, x.reportFile ? [x.reportFile] : []))
      const images = this.archive.copyImages(o.id, run.startedAt, files)
      const detail: AutoRunDetail = { run: { ...run, ...(files.length ? { files: files.length } : {}) }, ...(x.report ? { report: x.report } : {}), ...(x.message ? { message: x.message } : {}), files, links: extractLinks(x.report, x.message), images }
      this.archive.write(o.id, detail)
      this.archive.prune(o.id, x.keep)
      const r = this.get(o.id)?.runs?.find((y) => y.startedAt === run.startedAt)
      // Even an empty diff marks the archive ready; the open page must read its report after the async git read.
      if (r) {
        r.files = files.length
        this.changed()
      }
    } catch (e) {
      console.error(`[auto] archive de « ${o.title} » : ${(e as Error).message}`)
    }
  }

  // ---------------------------------------------------------------- what the automation page reads

  /** GET /api/auto/:id for a task: its runs, newest first; the tokens of the run in progress. null: no such task. */
  detail(id: string): AutoDetail | null {
    const o = this.get(id)
    if (!o || o.state === 'refused') return null
    const out: AutoDetail = { id, runs: newestFirst(o.runs ?? []), machine: MACHINE.id }
    if (o.state === 'running' && o.sessionId) {
      const t = this.w.store?.get(o.sessionId)
      out.liveTokens = t?.file ? sessionTokens(t.file, t.tool) : 0
    }
    return out
  }

  /** GET /api/auto/:id/runs/:at: what that run (ended at `at`) did and left; a run older than its archive has only
   *  its summary. null: no such run. */
  runDetail(id: string, at: number): AutoRunDetail | null {
    const o = this.get(id)
    const run = o?.state === 'refused' ? undefined : newestFirst(o?.runs ?? []).find((r) => r.at === at)
    if (!o || !run) return null
    const d = this.archive.read(id, run.startedAt)
    return d ? { ...d, run: { ...d.run, ...run } } : { run, files: [], links: [], images: [] }
  }

  /** GET /api/auto/:id/blob?path=: an image of the task, from its archive or its workspace (blobPath). */
  blob(id: string, p: unknown): { file: string; type: string } | null {
    const o = this.get(id)
    if (!o || o.state === 'refused') return null
    let home: string
    try {
      home = this.archive.home(id)
    } catch {
      return null
    }
    const file = blobPath(p, [this.place(o)?.cwd, home].filter((x) => x !== undefined))
    return file ? { file, type: IMAGE_MIME[path.extname(file).toLowerCase()] } : null
  }

  /** Back to the queue: the scope agreed while it ran becomes its scope. */
  private takePending(o: Stored) {
    Object.assign(o, o.pending ?? {})
    delete o.pending
  }

  /** Stopped by a limit, a login or an API error: no work was done, it goes back to the queue for later (a few tries). */
  private later(o: Stored, now: number, why: string): boolean {
    if(o.deletedAt)return this.finish(o,now,false,why)
    o.tries = (o.tries ?? 0) + 1
    o.lastEvent = tr(O)[`stall_${stallKind(why)}`]
    if (o.tries >= MAX_TRIES) {
      console.log(`[auto] « ${o.title} » abandonnée après ${o.tries} essais (${oneLine(why, 160)})`)
      return this.finish(o, now, false, o.lastEvent)
    }
    this.takePending(o)
    o.state = 'queued'
    // A usage limit with a known reset time: back then, not in an hour.
    const hold = stallKind(why) === 'limit' && o.tool !== 'codex' ? (this.w.relay?.holdUntil(now) ?? 0) : 0
    o.retryAt = hold || now + RETRY_MS
    if (hold) o.held = true
    o.waiting = 'later'
    console.log(`[auto] « ${o.title} » arrêtée (${oneLine(why, 160)}) · nouvel essai dans ${Math.round((o.retryAt - now) / 60_000)} min`)
    return true
  }

  /** The task's session is handed over to Codex: back in the queue, its worktree kept, until its plan is approved or Claude is back. */
  private hold(o: Stored, now: number): boolean {
    if(o.deletedAt)return this.finish(o,now,false,tr(O).stall_limit)
    o.state = 'queued'
    o.held = true
    o.retryAt = this.w.relay?.holdUntil(now) || now + RETRY_MS
    o.waiting = 'later'
    o.lastEvent = tr(O).stall_limit
    console.log(`[auto] « ${o.title} » attend le relais Codex ou le retour de Claude`)
    return true
  }

  /** The session of one of the tasks (its current or last run). */
  owns(sessionId: string): boolean {
    return this.s.items.some((o) => !!o.sessionId && (o.sessionId === sessionId || this.w.sessionIdOf?.(o.sessionId) === sessionId))
  }

  /** Claude is back (or gone): tasks that waited for it are released, and the queue is looked at now. */
  poke() {
    if (!(this.w.relay?.holdUntil() ?? 0))
      for (const o of this.s.items)
        if (o.held) {
          delete o.held
          if (o.state === 'queued') delete o.retryAt
        }
    this.changed()
    if (this.auto) setTimeout(() => this.tick(), 1000).unref?.()
  }

  /**
   * The approved takeover plan of a task's session (server/relay.ts): the task restarts on Codex in the same worktree,
   * behind the same barriers. Returns the new session; throws when it cannot start (the task then waits for Claude).
   */
  async relayRun(sessionId: string, text: string, tool: 'claude' | 'codex' = 'codex', targetId?: string): Promise<string> {
    const o = this.s.items.find((x) => !!x.sessionId && (x.sessionId === sessionId || this.w.sessionIdOf?.(x.sessionId) === sessionId))
    if (!o || o.deletedAt || (o.state !== 'queued' && o.state !== 'running')) throw new Error(tr(O).vanished)
    if(o.repo)this.w.assertRepoExecution?.(o.repo)
    if (!(await this.sys.jail(['--dev-bind', '/', '/', '--']))) throw new Error(this.noJail())
    await this.launch(o, Date.now(), { tool, relay: text, sessionId: targetId })
    if (o.state !== 'running' || !o.sessionId) throw new Error(o.lastEvent || tr(O).startFailed)
    return o.sessionId
  }

  /** Its workspace and repo, or null when its repo is no longer on the machine (workspace() would throw). */
  private place(o: Stored): { cwd: string; repoDir?: string } | null {
    try {
      return { cwd: this.workspace(o), ...(o.repo ? { repoDir: this.w.repoDir(o.repo) } : {}) }
    } catch {
      return null
    }
  }

  /** Where a task works: its own git worktree beside its repo, or a hidden folder of its own (see the top of the file). */
  workspace(o: { id: string; repo: string | null }): string {
    return o.repo ? path.join(path.dirname(this.w.repoDir(o.repo)), '.auto', o.repo, o.id) : path.join(this.dir, `.${o.id}`)
  }

  /** The guard folder of guardEnv, emptied before each task (a task may have written in gh's or docker's config). */
  guard(): string {
    const dir = path.join(this.dir, '.guard')
    for (const sub of ['gh', 'docker']) {
      fs.rmSync(path.join(dir, sub), { recursive: true, force: true })
      fs.mkdirSync(path.join(dir, sub), { recursive: true, mode: 0o700 })
    }
    return dir
  }

  /** Why a Codex task cannot start here: no jail on this machine (said in the Mac's own words on a Mac). */
  private noJail(): string {
    return this.platform === 'darwin' ? tr(O).noJailMac : tr(O).noJail
  }

  /**
   * The jail of a task (jailArgs), tried before the session starts: bwrap's command prefix, or [] on a machine without
   * bwrap (macOS…), where the environment barriers and the deny list are all there is. A jail that fails stops the task.
   */
  private async jail(o: Stored, cwd: string, guard: string, show: string[] = []): Promise<string[]> {
    const uid = os.userInfo().uid
    const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`
    const tmp = process.env.TMUX_TMPDIR || '/tmp'
    const repoGit = o.repo ? path.join(this.w.repoDir(o.repo), '.git') : undefined
    const args = jailArgs({
      home: os.homedir(),
      hide: [DATA_DIR, runtime, path.join(tmp, `tmux-${uid}`), path.join(os.tmpdir(), `zellij-${uid}`)],
      roots: PROJECT_ROOTS,
      // The task's folder: its worktree and the report beside it, or its workspace; the guard's empty configs.
      rw: [o.repo ? path.dirname(cwd) : cwd, guard],
      git: repoGit && fs.statSync(repoGit, { throwIfNoEntry: false })?.isDirectory() ? repoGit : undefined,
      show,
    })
    if (await this.sys.jail(args)) return ['bwrap', ...args]
    if (!this.noJailSaid) console.log(`[auto] ${this.platform === 'darwin' ? 'pas de prison sur macOS' : 'bwrap absent'} : les tâches tournent sans prison (barrières d'environnement et interdits seuls)`)
    this.noJailSaid = true
    return []
  }

  /** Starts a task in a Claude session: in its own worktree of its repo (on a fresh local branch), or in its workspace. */
  private async launch(o: Stored, now: number, on: { tool?: 'claude' | 'codex'; sessionId?: string; /** the approved takeover plan, first in the brief */ relay?: string } = {}) {
    if(o.deletedAt)return
    // A queued job remains queued with a sourceAccess explanation, no synthetic failed run or new worktree.
    if(o.repo&&this.w.sourceAccessForRepo?.(o.repo)?.canExecute===false)return
    const tool = on.tool ?? preferredTool()
    this.launching = true
    o.state = 'running'
    o.startedAt = now
    o.tool = tool
    o.limitMs = runLimit(o.est)
    // Asked to run now, a recurring task keeps its schedule: its slot is the one before the run it was waiting for.
    o.slotAt = o.runNow && o.every && o.notBefore && o.notBefore > now ? o.notBefore - o.every : Math.min(now, this.timeAt(o, o.notBefore ?? o.acceptedAt ?? now))
    if (o.onSleep && this.sleep?.on && this.sleep.since !== null) o.sleepRunFor = this.sleep.since
    if (o.runNow && !o.every) delete o.notBefore
    delete o.runNow
    delete o.baseCommit
    delete o.waiting
    delete o.lastEvent
    delete o.retryAt
    delete o.held
    delete o.seenWorking
    delete o.seenAt
    delete o.sessionId
    this.changed()
    let step: 'branch' | 'jail' | 'start' = 'start'
    try {
      const cwd = this.workspace(o)
      delete o.runSourceRevision
      const sourceRunner=!this.s.adoptionPaused && o.software?.status==='ready' ? this.software.pin(o.software) : undefined
      if(sourceRunner){
        o.runSourceRevision=o.software!.revision
        const configuration={title:o.title,why:o.why,prompt:o.prompt,repo:o.repo,every:o.every,notBefore:o.notBefore,window:o.window,tz:o.tz}
        o.runConfigRevision=crypto.createHash('sha256').update(JSON.stringify(configuration)).digest('hex')
        const configs=path.join(path.dirname(this.file),'automation-configs',o.id)
        fs.mkdirSync(configs,{recursive:true,mode:0o700})
        const configFile=path.join(configs,o.runConfigRevision+'.json')
        if(!fs.existsSync(configFile))fs.writeFileSync(configFile,JSON.stringify(configuration,null,2),{mode:0o600,flag:'wx'})
        this.changed()
      }
      // A retry or the next run of a recurring task finds its worktree already there (same branch).
      const fresh = !!o.repo && !fs.existsSync(cwd)
      const branch = (!fresh && o.branch) || `auto/${slug(o.title)}-${o.id.slice(0, 4)}`
      // From the repo's current main, and an existing worktree brought up to it first (never left on an old base).
      const base = o.repo ? await this.sys.base(this.w.repoDir(o.repo)).catch(() => undefined) : undefined
      if (o.repo && fresh) {
        step = 'branch'
        fs.mkdirSync(path.dirname(cwd), { recursive: true })
        await this.sys.worktree(this.w.repoDir(o.repo), cwd, branch, base)
        step = 'start'
      } else {
        fs.mkdirSync(cwd, { recursive: true })
        if (o.repo && base) {
          const how = await this.sys.refresh(cwd, base).catch(() => 'kept' as const)
          if (how !== 'kept') console.log(`[auto] « ${o.title} » : worktree remis sur ${base} (${how})`)
        }
      }
      if (o.repo) {
        o.branch = branch
        o.baseCommit = await this.sys.head(this.w.repoDir(o.repo), cwd)
      }
      const writesReport = !o.repo || o.kind === 'watch' || o.kind === 'content' || o.kind === 'explore'
      const brief = tr(O).brief({
        title: o.title,
        branch,
        checkout: o.repo ? this.w.repoDir(o.repo) : '',
        // Beside the worktree, never in it (the branch stays the work itself).
        report: this.reportFile(o),
        inRepo: !!o.repo,
        writesReport,
        heavy: o.heavy,
        prompt: o.prompt,
        minutes: o.est ?? 60,
        agreed: agreedDigest(o.talk, { user: tr(O).agreedUser, auto: tr(O).agreedAuto }),
      })
      const text = on.relay ? `${on.relay}\n\n${tr(O).relayRules}\n${brief}` : brief
      const guard = this.guard()
      step = 'jail'
      // Codex has no deny list: its tasks run only inside the jail (which keeps its login, nothing else of the user's).
      const wrap = await this.jail(o, cwd, guard, tool === 'codex' ? ['.codex'] : [])
      const executionWrap=sourceRunner ? [...wrap,'node',sourceRunner,'--'] : wrap
      if (tool === 'codex' && !wrap.length) throw new Error(this.noJail())
      step = 'start'
      if(o.deletedAt){o.state='refused';return}
      const { id } = tool === 'codex' ? await this.w.createIn(cwd, o.title, text, [], { ...guardEnv(guard, process.env, this.platform), wrap:executionWrap }, 'codex') : await this.w.createIn(cwd, o.title, text, SAFETY_ARGS, { ...guardEnv(guard, process.env, this.platform), wrap:executionWrap }, 'claude', on.sessionId)
      o.sessionId = id
      o.seenAt = Date.now()
      console.log(`[auto] lancée : ${o.title} (${cwd})${tool === 'codex' ? ' · sur Codex (Claude à sa limite)' : ''}`)
    } catch (e) {
      // The app shows a short note; the raw error (tmux, git) stays in the log.
      this.finish(o, Date.now(), false, step === 'branch' ? tr(O).branchFailed : tr(O).startFailed)
      console.error(`[auto] lancement de « ${o.title} » (${step}) : ${(e as Error).message}`)
    } finally {
      this.launching = false
      this.changed()
    }
  }

  // ---------------------------------------------------------------- proposal rounds

  private waiting() {
    return this.s.items.filter((o) => o.state === 'proposed' && !o.draft && !o.userCreated).length
  }

  /** A round is due: first one a few minutes after start, then every 6 h, sooner after a memory change (2 min after
   *  it settles when the last round proposed nothing, else 30 min after the last round at least). */
  roundDue(now = Date.now()): boolean {
    if (this.rounding || now < this.s.failUntil || this.waiting() >= MAX_WAITING || !this.sys.logged() || !claudeAvailable()) return false
    if (!this.s.lastRoundAt) return now - this.bootAt >= FIRST_ROUND_MS
    const since = now - this.s.lastRoundAt
    if (since >= ROUND_EVERY_MS) return true
    // A proposal was answered: the list is refilled (one round, 10 min after the last one at least).
    if ((this.s.refillAt ?? 0) > this.s.lastRoundAt && since >= REFILL_GAP_MS) return true
    // After an empty round there is nothing to crowd: the first new memory is worth a round as soon as it settles. It
    // takes a memory change after that round to come back, so never a loop.
    const gap = this.s.lastEmpty ? MEMORY_SETTLE_MS : ROUND_MEMORY_MS
    return this.memChangedAt > this.s.lastRoundAt && since >= gap && now - this.memChangedAt >= MEMORY_SETTLE_MS
  }

  /** The real projects as prompt lines: name, repos, the latest sessions' titles. */
  private projectsText(): string {
    const snap = this.w.snapshot()
    const since = Date.now() - 14 * 24 * 3600_000
    return [...snap.projects]
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .slice(0, 12)
      .map((p) => {
        const titles = snap.sessions
          .filter((s) => s.projectId === p.id && s.lastActivityAt > since && s.title)
          .slice(0, 4)
          .map((s) => s.title)
        const repos = p.repos.filter((r) => r !== p.name)
        return `- ${p.name}${repos.length ? ` [${repos.join(', ')}]` : ''}${titles.length ? ` : ${titles.join(' · ')}` : ''}`
      })
      .join('\n')
  }

  /** The prompt of a round (also read by the tests). */
  proposalPrompt(max = MAX_WAITING): string {
    const t = tr(O)
    const history = [...this.s.items]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 40)
      .map((o) => t.historyLine(o.title, t[`state_${o.state}`], o.state === 'refused' ? '' : o.why))
      .join('\n')
    const repos = this.w.allRepos().slice(0, 80).join(', ')
    const machine = t.machine(this.sys.cpus(), Math.round(os.totalmem() / 1024 ** 3), `${os.platform()} ${os.arch()}`)
    return t.propose(user(), max, this.memory.asText(), this.projectsText(), repos, machine, history)
  }

  /** One round with the model: up to 3 − (proposals waiting) new ones. Never two at once, backoff on failure. */
  round(now = Date.now()): Promise<void> {
    if (this.rounding) return this.rounding
    this.rounding = (async () => {
      const max = MAX_WAITING - this.waiting()
      try {
        const raw = parseJson<unknown>(await claudeHaiku(this.proposalPrompt(max), 180_000))
        // i18n-ignore : raison de l'échec, seulement dans le journal
        if (raw === null) throw new Error('no JSON')
        const props = parseProposals(raw, this.w.allRepos(), this.s.items, max, this.memory.list().map((m) => m.text))
        for (const p of props) this.s.items.push({ ...p, id: crypto.randomBytes(5).toString('hex'), state: 'proposed', createdAt: Date.now() })
        this.s.lastRoundAt = now
        this.s.lastEmpty = props.length === 0
        this.s.fails = 0
        this.s.failUntil = 0
        console.log(`[auto] ${props.length} proposition(s) (${lang()})`)
      } catch (e) {
        this.s.fails++
        const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_MS * 2 ** (this.s.fails - 1))
        this.s.failUntil = now + wait
        console.error(`[auto] propositions : ${(e as Error).message} · nouvel essai dans ${Math.round(wait / 60_000)} min`)
      } finally {
        this.save()
      }
    })().finally(() => {
      this.rounding = null
      this.w.bump()
    })
    // The drawer shows the round as it runs (snapshot.autoRound).
    this.w.bump()
    return this.rounding
  }
}

/** The timers' and jobs' side of the automation page (core.ts): their runs and one run's log. */
export interface H24Auto {
  detail: (id: string) => Promise<AutoDetail | null>
  run: (id: string, at: number) => Promise<AutoRunDetail | null>
}

/**
 * POST /api/optimizers/:id/accept { rev? } · …/refuse · …/talk { text, tz? } → OptimizerTalkReply · …/pause { paused }
 * · …/run (now, as soon as the machine is free) · GET /api/auto/:id → AutoDetail · GET /api/auto/:id/runs/:at →
 * AutoRunDetail · GET /api/auto/:id/blob?path= → an image. An :id of a timer or a job (timer:…, job:…) goes to `h24`.
 */
export function optimizerRoutes(o: Optimizers, json: Json, readBody: ReadBody, h24?: H24Auto): [string, RegExp, Handler][] {
  const isH24 = (id: string) => /^(timer|job):/.test(id)
  const missing = (res: http.ServerResponse) => json(res, 404, { error: tr(O).notFound })
  // A malformed escape is no id (404, not a 500).
  const decode = (raw: string) => {
    try {
      return decodeURIComponent(raw)
    } catch {
      return ''
    }
  }
  return [
    ['GET', /^\/api\/auto\/adoption$/, (_req,res)=>json(res,200,o.adoptionStatus())],
    ['POST', /^\/api\/auto\/adoption\/rollback$/, (_req,res)=>json(res,200,o.rollbackAdoption())],
    ['POST', /^\/api\/auto\/([\w-]+)\/source$/, async(req,res,_u,[id])=>{
      const body=await readBody(req);const result=o.promoteSoftware(id,String(body.revision??''))
      return result?json(res,200,result):missing(res)
    }],
    ['DELETE', /^\/api\/(?:auto|optimizers)\/([\w-]+)$/, (_req,res,_u,[id]) => {
      const result=o.remove(id)
      return result ? json(res,200,result) : missing(res)
    }],
    ['POST', /^\/api\/optimizers$/, (req, res) => {
      const key=req.headers?.['idempotency-key']
      if(key && (typeof key!=='string'||key.length>128))return json(res,400,{ok:false})
      return json(res,201,{item:o.create(typeof key==='string'?key:undefined)})
    }],
    ['POST', /^\/api\/optimizers\/([\w-]+)\/restore-draft$/, async(req,res,_u,[id])=>{
      const body=await readBody(req).catch(()=>({}))
      const item=o.restoreDraft(id,typeof body.expectedEndedAt==='number'?body.expectedEndedAt:undefined)
      return item?json(res,200,{item}):missing(res)
    }],
    ['POST', /^\/api\/optimizers\/([\w-]+)\/prepare$/, async (req, res, _u, [id]) => {
      const body = await readBody(req)
      const item = o.prepareProposal(id, body?.expectedRev as number, body?.expectedTalkAt as number, body?.patch ?? {})
      return json(res, item ? 200 : 409, item ? { item } : { error: tr(O).talkIncomplete })
    }],
    ['POST', /^\/api\/optimizers\/([\w-]+)\/accept$/, async (req, res, _u, [id]) => {
      const body = await readBody(req).catch(() => ({}))
      const rev = Number.isInteger(body?.rev) ? Number(body.rev) : undefined
      const ok = o.accept(id, rev)
      json(res, ok === true ? 200 : ok === 'busy' ? 409 : 404, { ok: ok === true })
    }],
    ['POST', /^\/api\/optimizers\/([\w-]+)\/talk$/, async (req, res, _u, [id]) => {
      const body = await readBody(req)
      const r = await o.talk(id, String(body?.text ?? ''), body?.tz)
      json(res, r ? 200 : 404, r ?? { reply: '', changed: [], failed: true })
    }],
    ['POST', /^\/api\/optimizers\/([\w-]+)\/refuse$/, (_req, res, _u, [id]) => {
      if(o.get(id)?.draft)return json(res,409,{error:tr(O).draftKept})
      const ok = o.refuse(id,'api')
      json(res, ok ? 200 : 404, { ok })
    }],
    ['POST', /^\/api\/optimizers\/([\w-]+)\/pause$/, async (req, res, _u, [id]) => {
      const body = await readBody(req).catch(() => ({}))
      if (typeof body?.paused !== 'boolean') return json(res, 400, { ok: false })
      const ok = o.pause(id, body.paused)
      json(res, ok ? 200 : 404, { ok })
    }],
    // The trigger without a model: { onSleep?: boolean, stopOnWake?: boolean } (the auto page's « when I sleep »).
    ['POST', /^\/api\/optimizers\/([\w-]+)\/trigger$/, async (req, res, _u, [id]) => {
      const body = await readBody(req).catch(() => ({}))
      if (typeof body?.onSleep !== 'boolean' && typeof body?.stopOnWake !== 'boolean') return json(res, 400, { ok: false })
      const item = o.setTrigger(id, body)
      return item ? json(res, 200, { item }) : missing(res)
    }],
    // Name and family by hand: { title?, group? } (weevboss tidying the drawer, no rewrite by a model).
    ['POST', /^\/api\/optimizers\/([\w-]+)\/label$/, async (req, res, _u, [id]) => {
      const body = await readBody(req).catch(() => ({}))
      if (!o.get(id)) return missing(res)
      const item = o.label(id, body)
      return item ? json(res, 200, { item }) : json(res, 400, { ok: false })
    }],
    ['POST', /^\/api\/optimizers\/([\w-]+)\/run$/, (_req, res, _u, [id]) => {
      const ok = o.runNow(id)
      json(res, ok ? 200 : 404, { ok })
    }],
    ['GET', /^\/api\/auto\/([^/]+)$/, async (_req, res, _u, [raw]) => {
      const id = decode(raw)
      const d = isH24(id) ? await h24?.detail(id) : o.detail(id)
      return d ? json(res, 200, d) : missing(res)
    }],
    ['GET', /^\/api\/auto\/([^/]+)\/runs\/(\d+)$/, async (_req, res, _u, [raw, at]) => {
      const id = decode(raw)
      const d = isH24(id) ? await h24?.run(id, Number(at)) : o.runDetail(id, Number(at))
      return d ? json(res, 200, d) : missing(res)
    }],
    ['GET', /^\/api\/auto\/([^/]+)\/blob$/, (_req, res, url, [raw]) => {
      const id = decode(raw)
      const b = isH24(id) ? null : o.blob(id, url.searchParams.get('path'))
      if (!b) return missing(res)
      let size: number
      try {
        size = fs.statSync(b.file).size
      } catch {
        return missing(res)
      }
      res.writeHead(200, { 'content-type': b.type, 'content-length': size, 'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff' })
      fs.createReadStream(b.file).on('error', () => res.destroy()).pipe(res)
    }],
  ]
}
