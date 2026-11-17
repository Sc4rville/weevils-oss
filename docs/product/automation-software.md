# Automation software lifecycle

This is shared product behavior for Claude, Codex and every installation. It does not depend on personal memory.

## Delete the automation, keep its work

`DELETE /api/auto/:id` (also `/api/optimizers/:id`) deletes a managed optimizer, not a repository.
The server persists a tombstone before success; repeated deletion is idempotent. Normal lists/details hide it
across reload. Existing source, configuration, conversations, outputs and run history remain available on disk.
Future triggers, queued starts, retries and relay starts are canceled. A run that already started finishes
in its original workspace, stays monitored and is archived once; it cannot schedule another run. A launch
still preparing its worktree is canceled before spawning an agent. A storage failure is an error, not success.
External systemd timers and log-discovered jobs are not silently deleted or adopted as scheduler-owned objects.

## Independent local repositories

Draft discussion and approval are separate phases. Both providers return a boolean `ready`; the server validates
the accumulated title, brief and target before exposing approval, even when the final response changes no fields.
This transition increments the proposal revision and never queues a run. Natural-language approval and assistant
claims about a button do not replace revision-checked acceptance. Software storage and the execution target are
separate: organizing an automation's source must not redirect its application work into the registry repository.

Legacy drafts are not bulk-promoted from assistant prose. After reviewing one full proposal,
`POST /api/optimizers/:id/prepare` takes `expectedRev`, `expectedTalkAt` (last stored discussion timestamp), and an
optional scope patch (`title`, `why`, `repo`, `prompt` only). It backs up the original, preserves identity/history/
schedule/source, and exposes the existing approval action without accepting. Stale reviews conflict; identical
retries reuse the persisted result. Deleted, refused, running and previously accepted records are ineligible.

The first user-created draft and retroactive adoption create `<configured project root>/automations/`:

- `registry/` is a local Git repository with relative ID-to-source references.
- `projects/auto-<stable-id>/` is an independent local Git repository for each automation.
- The parent folder is not a Git repository; there are no nested Git repositories or submodules.
- `.versions/<id>/<commit>/` holds immutable execution snapshots, separate from editable source.

Each source has a README, versioned manifest, configuration example, ignore rules and executable
`src/run.mjs`. Existing agent workflows are adopted as an explicit `agent-task` step adapter: it launches
the scheduler-supplied provider command, propagates status/signals and preserves the existing sandbox.
Their private title/purpose/instructions and target are local configuration referenced by manifest ID,
not copied into Git. This is a compatibility adapter, not an assertion that old agent workflows have
already been rewritten into deterministic domain-specific programs. The source can evolve to implement
the workflow directly through its entrypoint; only a committed compatible revision is promoted.
No model request or autonomous worker is required to create/adopt a repository.

The registry and sources contain only generated known files, with no local paths, hosts, credentials,
conversation text or arbitrary legacy files. Existing legacy code/output directories are preserved as
private runtime bindings and explicitly reported in `software.excluded` if present, not blindly committed.
There is no automatic remote creation or push. Existing Auto publication restrictions remain; GitHub
login alone is not authorization to create/publish repositories. A future remote policy must explicitly
cover owner, creation, push and visibility.

## Migration, version binding and recovery

On startup and on new creation, `Optimizers.adoptAll()` reconciles all stored objects, including old
refused/deleted ones. It makes a mode-600 backup of the original optimizer state before the first adoption.
Each object retains its original ID, schedule/timezone, state, conversations, runs and target workspace.
Provisioning is serialized and recorded by owned markers; retries reuse the same path/ID and commit.
Path collisions fail closed and retain the original folder. A dead process's complete provisioning lock
can be recovered; an incomplete/ambiguous lock requires review rather than overwriting unknown work.

A running legacy job receives `pending-running` source metadata without scanning or changing its directory,
version, process or schedule. Its old run is never falsely labeled with a source revision. After completion,
reconciliation marks it ready. Future runs execute the pinned software entrypoint inside the existing
sandbox and keep the old target/output workspace: source handoff does not require moving live files.
The run records `softwareId`, `sourceRevision` and a hash of its private configuration; configuration snapshots stay mode-600 in private installation storage, never in Git or public run details. Changing a selected revision affects future runs only.
A provider unavailable or sandbox failure continues to follow existing Auto failure/retry rules.

`GET /api/auto/adoption` exposes counts, errors and per-object bindings. This is engineering metadata;
it does not publish cards or vocals. `POST /api/auto/:id/source` with a full committed revision validates
identity/entrypoint and pins its files before selecting it. Dirty source is never executed. Symlinks,
submodules, invalid paths and oversized source trees are rejected. Selecting a previous revision is source
rollback; mutable state is never reverted blindly. Stateful upgrades still need explicit compatible data
migration, which this adoption does not perform.

`POST /api/auto/adoption/rollback` durably switches future launches back to the existing legacy runner.
It preserves all source repositories, active jobs, schedules, new user edits/deletions and histories; it does
not replace a live state file with an old backup. The original backup remains for inspected recovery.
Adoption stays disabled after restart following that rollback. No automation is run or deleted as migration QA.

Current scope covers the optimizer objects owned by Auto. External timers/jobs remain observed in place;
if present they require a separately validated owner/entrypoint mapping before changing their scheduler.
They are not claimed as migrated by this API's counts. There were zero such objects in the inspected live inventory.

## Readability and ordinary project sessions — product convention

An automation owns versioned software; it does not own the user's conversation. The source repository,
registry, run record and execution workspace are separate identities from the project session. A TLO
request belongs in an appropriate ordinary TLO session, reusing an existing compatible session or creating
an ordinary project session when necessary. A newly needed session appears under that project with a stable
task title and can receive later direct user requests; it is not permanently categorised as an Auto session. Neither the repository layout nor an automation-only chat or
file viewer is imposed as the primary interface. Context, requests and results enter the normal project flow.

Origin belongs to each request, not the whole session. A direct user request remains the user's request;
an automation request is explicitly labelled **Automated**, retaining its actual agent author where relevant.
Coordination and weevboss briefs keep the attribution rules in `session-contract.md`. Never infer the origin
from prose, a repository name, session ownership, or the presence of an automation somewhere in its history.
Show animation only while that request is demonstrably queued or working; an enabled schedule, adopted
repository, old run or idle session is not current activity. Make automation/run/source links available on
request. Group related progress and results for human readability while preserving material decisions,
errors and provenance. Delivery acceptance and an idle agent are not proof of successful completion.

These are the target semantics. The implementation below is an architecture preparation, not a claim that
ordinary-session routing is deployed. Source adoption alone did not implement this behavior.

## Architecture adjustment from the current runner

Verified baseline: `Optimizers.launch()` creates a provider through `createIn()` in an isolated automation
worktree, with `guardEnv`, provider restrictions and a sandbox; source adoption wraps that command in the
pinned software entrypoint. `owns()` includes the current or last session and is used for relay routing.
`record()` reads the session's last assistant message and cumulative tokens. These assumptions are unsafe
for attributing work in a shared conversation and must change together, not by relabelling the session.

### Request and run identity

Persist a server-owned envelope before dispatch. Proposed API/storage contract (not yet live):

```ts
type RequestOrigin =
  | { kind: 'user-request'; intentId: string }
  | { kind: 'automation-run'; intentId: string; automationId: string; runId: string }

interface AutomationDispatch {
  requestId: string              // stable outbox identity across transport retries
  origin: Extract<RequestOrigin, { kind: 'automation-run' }>
  projectId: string
  sessionId: string              // resolved and frozen before acceptance
  softwareId: string
  sourceRevision: string
  configRevision: string        // digest; private configuration never in messages/Git
  state: 'queued' | 'working' | 'succeeded' | 'failed' | 'cancelled' | 'uncertain'
  messageId?: string            // confirmed transcript identity
  turnIds: string[]             // actual turns handling this request, including relay
}
```

Keep origin separate from `Message.author` and `sourceThreadId`: the scheduler is authorized to stamp
`automation-run`, the normal user endpoint stamps `user-request`, and agent coordination retains its actual
runtime author. The automated incoming request uses the non-user message role; a scheduler dispatch identifies the automation,
without inventing a human or agent sender. Any relaying agent keeps its actual author alongside that origin.
Validate the origin against the scheduler-owned dispatch reservation before accepting it; a CLI `from` claim,
browser input or message text cannot claim automation execution. Legacy messages without
an origin remain unclassified unless exact recorded sender/run/message evidence supports projection;
never mark every message in an old Auto session as automated. Raw transcripts remain unchanged.

### Routing, execution and completion

1. Resolve the target project from the accepted automation configuration, independently of its source repo.
   Within the correct machine/project, prefer a persisted compatible session binding, then an available
   controllable project session. Freeze the destination with `requestId`; ambiguous or unavailable targets
   wait with an explicit reason. Create a normal project session only if no suitable session can serve it,
   under the existing session limit and an idempotent creation reservation. Never fall back silently to boss.
2. Persist the due occurrence, `runId`, `intentId`, pinned source/configuration revisions and target reservation
   before any dispatch. Use the durable intent registry to link already accepted equivalent user work;
   do not execute it again or relabel the user's original message. If that linked user work satisfies the
   request, record that relationship rather than claiming that an automated run executed. A recurring occurrence is a new run;
   retries and provider handoff retain the same run/request lineage, with recorded attempt identities.
3. Acquire a renewable execution reservation for the project/workspace/resources being changed. Distinct
   sessions can conflict too. Use the ordinary delivery queue without interrupting an active user turn.
   Yield to direct user work at a safe boundary; do not cancel an in-flight command or GPU job merely to
   change routing. No duplicate runner is launched while acknowledgement or effects are uncertain.
4. Preserve existing automation authorization, sandbox, denied operations and output restrictions. Reusing
   an unrestricted interactive CLI cannot silently grant those extra powers to Auto. Reuse is eligible
   only when its control adapter can enforce the execution scope and correlate this request's turns; until
   that capability exists, use a normal project session with the existing restricted runtime or leave the
   request queued with the capability reason. The source entrypoint evolves into a scoped runner/dispatch
   adapter; its current unconditional provider-spawn compatibility step is not executed a second time.
5. Correlate delivery, actual turn starts, commands/background jobs and final result with `requestId/runId`.
   A transport receipt starts no animation labelled working until execution is observed. A completion
   applies only to that request and its required jobs; another user answer, the session's last message,
   cumulative session tokens or a daemon restart cannot complete it. Missing evidence stays uncertain.
6. Append useful results to the same project flow, linked to the run, and archive only that run's evidence.
   Expose source/version and command details through existing disclosure patterns. UI may combine related
   updates, but must keep an actionable failure or material decision visible. Historical completion is
   static; a later user turn must not inherit an Automated label or animation.

### Adoption and rollout

Keep the existing source repositories, stable automation IDs, schedule definitions, user conversations,
source/config revision pins and tombstones. Back up/version the scheduler state before adding dispatch
records. Legacy running jobs finish in their existing directory and retain their real session/job ownership;
no injection into a second session while they run. Reconcile their final outcome once, then mark the next
run eligible for project routing. Completed history remains unchanged unless exact evidence permits an
additive link. Unknown old run origins stay unknown.

Deliver in bounded steps: (1) durable origin/intent/run records and recovery; (2) capability-gated session
selection, reservation and ordinary outbox dispatch; (3) message/run projection and UI; (4) enable future
runs after restart/retry evidence passes. Extend `owns`/relay decisions to the active run/turn, not all future
work in a formerly used session. Disabling the new router affects future dispatch only: preserve accepted
requests, active reservations/jobs, source repos and outcomes, and drain/reconcile them before changing
runner mode. Never restore a stale whole-state backup over new user decisions.

Required verification before enabling routing: a real-user request and an automated request in one session
retain separate origin and completion; busy-session queueing does not interrupt; two automations/direct
work touching one workspace cannot overlap; response loss/restart/relay cannot duplicate dispatch; deletion
cancels future/pending work while its active job follows the existing finish policy; source upgrade affects
only future runs; unresolved legacy provenance is not guessed; reload, EN/FR and theme changes preserve
IDs, grouping, decisions and activity truth. UI624 owns presentation; scheduler/transport owns these facts.

## Recursive visual identity

Identity is not permission. `Project`, `Session` and `Optimizer` expose a separate optional `sourceAccess`
for the canonical installation source: `{repo, machineId, canExecute, reason}`. Reasons are
`owned-writable`, `not-owned`, `not-writable`, `unavailable` and `no-checkout`; absence is unknown.
This local launch policy checks effective-user ownership and directory write/search access for
the source, Git common directory and execution directory. It grants neither GitHub publishing rights
nor a sandbox guarantee about everything an already-running agent could access. No fork is automatic.
The server rechecks at dispatch, independent of stale UI snapshots. New sessions/messages and Auto
accept/run are refused when denied; queued Auto work stays queued without a fabricated run or scheduled
time, and can resume when access is restored. Existing active jobs are not stopped. Other repositories
keep their existing controls. The UI must match the capability's machine/repo to the requested target,
not disable an entire mixed project merely because one repository is read-only.

`Project.installation` identifies the installation independently: `{id, machineId, source: 'checkout' |
'artifact'}`. A checkout adds this metadata to its real project. Without Git evidence, the server supplies
an informational `kind: 'installation'` entry with an installation-scoped ID, product name `weevils`, empty
`repos`/`where`, zero activity, no `workstream`, and `sourceAccess: {repo: null, machineId, canExecute: false,
reason: 'no-checkout'}`. It appears before any work, survives daemon restart/locale changes, and grants no
session target. Consumers can pin it and apply a static installation signature; they must not derive work,
an animation, a repository, or an execution permission from it. No checkout or fork is created. Other
projects remain available on an artifact installation; only requests targeting the installation are refused.

`Project`, `Session` and `Optimizer` may expose `workstream` with kind `self-improvement`, a stable
installation identity, an explicit machine/project/repository target and the evidence type. The server
compares the target's real Git common directory with the running installation's repository, including
linked worktrees. An unrelated clone with the same name/remote, a mention in prose or a thematic inferred
project is not sufficient. A missing verifiable repository identity stays unclassified. Auto uses its
configured target repository, independently of its own software repository. A targetless task needs a
separately verified structured intent binding; its title is not a substitute.

This field describes target context, not sender identity, live activity or an improvement already achieved.
The canonical project may be pinned while idle. Its working animation must still follow the existing
verified runtime state; absence/stale evidence does not animate. Per-message Automated signatures require
the request/run provenance contract above. Neither `workstream` nor the optimizer's sessionId authorizes
labelling all messages in a mixed session. Feed results require actual linked outcomes before describing
an improvement as delivered. Preserve the existing recursive theme tokens rather than adding a palette.

Recursive identity is a shared product default for every installation, independent of personal model,
effort or locale settings. The fresh-profile lifecycle regression uses a renamed local Git repository,
checks the same target metadata for Claude and Codex, keeps an unrelated project's user text unclassified,
and verifies working-to-idle changes without changing identity or creating personal preference files.
It invokes no agent, provider request or live job. UI theme tokens and project pinning consume this shared
identity; a personal profile import is not required to enable it.
