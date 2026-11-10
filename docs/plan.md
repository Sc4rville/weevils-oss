# weevils plan: from prototype to a real cockpit

Written on November 8, 2026. Final goal: from the phone, monitor and drive my projects, my Claude Code / Codex
sessions and my LLM chats, sorted smartly, **on my existing subscriptions, with no API cost**.

This is the original plan, kept for context. Some choices changed on the way (tmux instead of zellij, an access code
instead of a passkey for now); the [state at the end](#state-on-november-8-2026-evening) says what was actually built.

## Principles

1. **Zero extra cost.** weevils never touches a token or a key. It drives the official `claude` and `codex` CLIs
   already logged in to my subscriptions on the server. Personal use of these tools = their normal use. The
   subscriptions' usage limits apply: anything that consumes (sorting, 24/7 jobs, the main agent) must stay frugal.
2. **The server is the source of truth.** A `weevilsd` daemon runs there permanently (a systemd user service); the
   phone app is only a window onto it.
3. **No demo option in the app anymore.** Fixtures are for tests only. The "demo" band goes away as soon as real
   data arrives.
4. **Security first.** Being able to type into a terminal = remote shell access. Nothing that writes before
   authentication.

## Architecture

```
phone (weevils PWA) ──HTTPS + SSE──▶ Caddy ──▶ weevilsd (server · Node 22 · SQLite)
                                                 ├─ reads    ~/.claude/projects/**/*.jsonl          (Claude Code sessions)
                                                 ├─ reads    ~/.codex/sessions/**/rollout-*.jsonl   (Codex sessions)
                                                 ├─ receives Claude Code hooks + Codex notify (live state)
                                                 ├─ drives   the terminal multiplexer (write, read the screen, list)
                                                 ├─ runs     claude -p / codex exec (headless, subscription)
                                                 ├─ reads    git + gh (repos, branches, commits, PRs)
                                                 └─ imports  ChatGPT / Claude.ai exports
```

Repo: the PWA + `server/` (weevilsd) + `shared/` (the types, already designed for the backend).

Facts checked on the server on November 8, 2026:
- every line of a Claude Code transcript carries `sessionId`, `cwd`, `gitBranch`, `isSidechain` (subagents);
- every Codex transcript starts with `session_meta`, which has the `cwd`;
- the multiplexer can type characters into a pane and dump its screen;
- `~/projects` holds families of repos (`shop-web`, `shop-api`…): a project = a family, not a repo.

## Phases

### Phase 0 · Foundation and security (1–2 days)
- Split app / server, SQLite database (`node:sqlite`), API + SSE stream.
- **Login with a passkey (Face ID)**, a single user, session cookie. No write route without it.
- weevilsd as a systemd user service, behind Caddy (`weevils.example.com`), every action logged.
- The PWA replaces its local store with an API client (same types).

**Done when** the phone logs in with Face ID and sees a real list of projects (even empty).

### Phase 1 · See what runs on the server (2–3 days)
- Claude Code collector: watch the `.jsonl` files, incremental reads (offset), user/assistant messages, tool calls,
  subagents (`isSidechain`), `cwd` → repo → project.
- Codex collector: the same on `rollout-*.jsonl`.
- **Exact live state** through Claude Code hooks (`SessionStart`, `UserPromptSubmit`, `Stop`, `Notification`,
  `SubagentStop`, `SessionEnd`) that ping weevilsd: working / your turn / available / done. For Codex: `notify` in
  `config.toml` (end of turn) + end of file.
- Live sessions from the multiplexer.
- Projects = families of repos in `~/projects` (prefix rule, editable in the app) + GitHub info through `gh`.

**Done when** I open `claude` in a terminal on the server and the session shows up in under 3 s in the right band,
with the right state.

### Phase 2 · Act from the phone (2–3 days)
- **Launch convention**: a small launcher `wv` starts `claude` / `codex` in a named multiplexer session
  (`wv-<repo>-<n>`). That is what makes writing into a live session possible.
- Send to a live session: type the text + Enter, after reading the screen so we never type into a menu by mistake.
- Session closed or started outside the multiplexer: headless resume `claude -p --resume <id>` /
  `codex exec resume <id>`, streamed answer.
- `+`: weevilsd opens a session in the repo and starts the agent with the first message.
- **"Your turn"**: the `Notification` hook (permission, question) triggers a **push notification on the phone**
  (Web Push, free, iOS 16.4+ PWA). The app shows the exact question on screen and sends the chosen answer.
- Guardrails: only messages to agents, never free shell commands; everything is logged.
- The demo band is removed.

**Done when**, from the phone, I answer a permission request of a Claude session on the server and see it go on.

### Phase 3 · LLM chat transcripts (2–3 days)
- **Reliable source**: the official ChatGPT (`conversations.json`) and Claude.ai (zip) exports. Idempotent importer
  (dedup by id), zip uploaded from the phone or a watched folder on the server.
- **Continuous source, optional**: a small weevils Chrome extension that sends a conversation to weevilsd when it is
  opened on chatgpt.com or claude.ai. My account and my browser, but reading their pages is brittle and a gray area
  of their terms: can be turned off, never required.
- Honest limit: no official way syncs the chats made in the phone apps automatically; they come in through the export.
- Chat mode on an imported conversation: we cannot write into ChatGPT / Claude.ai on their behalf. "Continue here"
  opens a headless Claude session with the conversation as context (subscription).

**Done when** an imported export gives readable, sorted, searchable conversations.

### Phase 4 · Smart, dynamic sorting (2 days)
1. **Deterministic, free, instant**: agent session → `cwd` → repo → project. Covers almost every session.
2. **Local, free**: embeddings on the server CPU (small multilingual model); similarity between a conversation and
   each project (README, names, conversations already sorted).
3. **Judge, on the subscription**: `claude -p --model haiku` only for uncertain cases, in batches, JSON answer
   `{project | new category, reason, confidence}`, cached.
- Corrections become reused examples; invented categories can be renamed and merged.
- Automatic re-sorting when a repo appears; "to sort" only under a confidence threshold; every placement says why.

**Done when** 90% of imported conversations are sorted without me.

### Phase 5 · Smooth file explorer (1–2 days)
- Read-only API, jailed in the repo (`git ls-files`, honors `.gitignore`), tree loaded on demand, cache and prefetch.
- Reading: rendered markdown, highlighted code (same font), images, search (ripgrep).
- **"What the agent changed"**: the files touched by a session (`Edit` / `Write` tools in the transcripts) and the
  diff of the last commits, reachable from the session.

**Done when** I browse a repo and read a file from the phone with no noticeable wait.

### Phase 6 · Real 24/7 (1–2 days)
- A 24/7 activity = a systemd user timer that runs `claude -p` or `codex exec` (subscription) in a repo.
- On / off = timer active or not; running = live process; last result = its output. Real pause / resume.

### Phase 7 · Real main agent (2 days)
- A headless Claude session with a weevils tool with limited powers: list the sessions, send a message, open,
  sort, summarize.
- It routes my orders ("pick the CRM back up") to the right session and asks for confirmation when it is ambiguous.

### Phase 8 · Style and UX (with the user)
Icons, cleanup, density, animations: after living a few days with the real data.

**Estimated total**: 2–3 weeks of agent work, delivered phase by phase, each phase usable on the phone.

## Risks

- **Undocumented transcript formats**: they change with CLI versions → tolerant parsers, tested on real files.
- **Typing into a terminal is brittle** (menus, prompts) → read the screen before each send, headless resume as a
  fallback.
- **Subscription quotas**: sorting and 24/7 consume; measure and cap.
- **Terms of use**: stay on the official CLIs; never extract the OAuth tokens for other tools.
- **Sessions started on another machine** (not the server): out of scope at first; later, a small relay there.

## Decisions to make

1. Authentication: Face ID passkey (recommended) or Tailscale.
2. Start sessions through `wv` from now on, so we can write to them live.
3. Conversations: exports only, or exports + Chrome extension.
4. Project = family of repos by prefix (`shop-*`, `game-*`).

## State on November 8, 2026 (evening)

Done and checked for real:
- weevilsd as a permanent service on the server, app served on its own domain, login with an access code or a QR
  code (Face ID passkey: to do).
- Claude Code and Codex sessions of the server **and of a second machine** (federation through a reverse SSH
  tunnel), sorted by project, exact state from the hooks.
- Write to a session, read the terminal screen, answer questions (keys), create a session, resume a closed one:
  tested end to end with Codex.
- Driving through tmux (`wv`), which survives weevilsd restarts.
- Smooth file explorer (cache + prefetch), on the machine that holds the repo.
- 24/7: long jobs from `~/logs` and `wv-*` timers.
- ChatGPT / Claude.ai conversations: import of the exports (zip or JSON, from the phone or `~/weevils-imports`),
  reading, "continue here" with an agent.
- Smart sorting: rules + ephemeral `codex exec` (subscription), invented categories, reused corrections.
- No demo data left in the app.

Left:
- Push notifications on the phone when a session waits.
- Face ID passkey instead of the code.
- A main agent with a real model (today: simple rules).
- Style and UX (phase 8), with the user.

Several of these landed the next day (push notifications, weevboss as a real Claude session): see
[changelog.md](changelog.md).
