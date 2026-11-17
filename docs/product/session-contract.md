# Session controls and evidence

This is a product contract shared by Claude and Codex. The FR/EN orchestrator templates ship the same rules to `CLAUDE.md` and `AGENTS.md`, including on a fresh installation. Personal memory may personalize a brief; it is not an implementation dependency for controls, delivery or activity display.

## Observable behavior

- A send acknowledgement means accepted for delivery, potentially queued. It does not prove that an agent has read the message or completed its turn. Preserve delivery identity on retry. Codex's existing native queue is used while a turn is active; sending does not interrupt that turn or start another conversation.
- Model and reasoning controls use the available model catalog, update the existing thread's future-turn settings and verify readback. A tap on a model or effort is the whole action: no confirmation step, apply button, sheet, toast or banner; readback is silent, the tapped word alone shows the pending change, and only a failed readback adds one inline line. The picker stays in the page flow and wraps inside it on a phone-width screen. A menu command is not sent as chat. An older recorded turn context describes that older turn, not necessarily the next-turn setting.
- Activity follows runtime samples and recorded turn transitions. A newer transition supersedes an older cached sample. A command's nonzero exit status is not evidence that the agent session died. Genuine questions/approvals alone warrant attention.
- Tool groups and individual steps begin collapsed. Opening a step reveals the recorded command and result, or an explicit absence. Commands and results are redacted before they cross the session API, truncated excerpts are marked, and strings are rendered as text rather than HTML.
- The compact action combines a translated category with concrete executable/subcommand names when known. Literal descriptions and nested tool names remain inspectable. Do not replace every tool by another generic synonym for “exec”.
- Extracted wrapper arguments are evidence of the submitted program, not proof that every conditional branch ran. A wrapper's output belongs to its recorded call identifier; do not invent a separate outcome for each nested call. Dynamic arguments are unknown, never evaluated by the parser.
- Explicit app locale controls generated product text independently of chat language; proper names and identifiers remain intact. No automatic QA cards, raw commit announcements or diagnostic vocals belong in the user feed.
- An explicit shared thread name (or Claude custom title) is the canonical topic, ahead of generated translations, inherited handoff names and old first prompts. Read names for stored as well as loaded threads without resuming them, and retain confirmed names across daemon outages and weevils restarts. A retitle refresh may update activity separately; it must not overwrite an intentional topic or rewrite the original transcript.

## Provider limits and handoffs

Quota evidence is separate from CLI/authentication presence. Fresh account windows and recorded quota stops drive
temporary routing only when automatic relay is authorized; configured provider, model and effort remain unchanged.
Old rollout headers retain their observation timestamp. A quota reset is shown only when the source supplies it;
expiry alone is not proof of availability. The private provider ledger survives daemon restart.

Codex work can pass to Claude after the source turn has stopped. The private handoff ledger preserves source and
destination IDs, transcript location, user context and existing-job monitoring instructions before dispatch.
An active turn or genuine question is not interrupted, old historical cuts are not revived, and automation work
continues through its scheduler's guarded workspace. A lost launch acknowledgement is uncertain: reconcile the
reserved target if it appears, otherwise never blindly create another worker. Existing panes/jobs remain intact.

If both providers are unavailable, normal send/attachment/action entrypoints retain their original durable outbox
IDs, payloads, device locale and lane order. A typed pre-dispatch wait can retry after a bounded polling delay;
an uncertain delivery cannot. No LLM is needed to preserve or inspect the queue, and no new paid provider is selected.
Main-thread controls/activity follow the effective owner, with cross-provider context carried when it changes.

## Message authorship

Agent coordination uses the canonical `weevils send` route. The local runtime session ID is resolved against known sessions before dispatch; that identity takes precedence over an inherited `WEEVILS_FROM`. The server signs the actual author and source thread together. Unknown local agent origins remain agents, never the user. Browser/proxied requests cannot claim a source thread. The compatibility file-based adapter in `server/agent-coordinate.mjs` delegates to this route and never calls the daemon directly.

The normal CLI, native bridge and transcript projection preserve the source ID. Coordination is collapsed with its actual source; weevboss briefs remain visible. Native bridge source metadata takes precedence over a conflicting signature in its body; the conflicting text is retained verbatim. Known mail authors retain their existing verified mail path. Ordinary user text is never classified by its wording.

Historical corrections require exact target/message/source/call IDs and verification against the recorded outgoing call. `message-origins.json` in the private data directory stores approved projections with an integrity digest, not a classifier. Raw transcripts are untouched; removing an annotation restores their original projection. No HTTP endpoint accepts arbitrary historical author claims. A same-OS-user client that bypasses Weevils and writes directly to an external daemon remains outside this boundary: migrate that client to canonical delivery rather than pretending its unsigned text proves an author.

Automated work follows the [ordinary project flow contract](automation-software.md#readability-and-ordinary-project-sessions--product-convention): structured origin is attached to the request/run, independently of the actual author, never inferred for the entire session.

## Verification without personal state

`test/codex-recorded-wrapper.test.tsx` replays a real recorded orchestration call and its structured result through `TranscriptStore`, the serializable API message contract and the normal `Messages` component. It opens the group and the individual step and checks the literal command and result.

`server/relay-core.test.ts` creates the generated instructions in a temporary home. Both agents receive identical rules, the default profile has no personal name/domain, and a synthetic private-memory sentinel is not imported. No actual agent, model request, tmux session or render is started. This test does not import the separately prepared portable profile into a user's instance.

Parser, runtime, delivery and UI regressions also live in `server/codex-command-details.test.ts`, `server/codex-bridge.test.ts`, `server/lifecycle.test.ts`, `server/transcripts.test.ts`, `src/ui/model-controls.test.tsx`, `test/model-picker-layout.test.ts` and `src/ui/session-reading.test.tsx`.
