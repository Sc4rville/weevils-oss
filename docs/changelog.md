# Changelog

A short summary of what changed after the first working version.

## 2026-11-09

### Open source
- No personal data in the code: one config file outside the repo (`~/.config/weevils/env`, template
  [`.env.example`](../.env.example)).
- English and French everywhere (app, server, installer, `wv`); the language follows the browser and can be changed
  in the bottom band. A test fails on any hard-coded user-facing string.
- One-command installer (`install.sh`) for a main or a secondary machine, optional HTTPS through Caddy, tested in
  blank Docker containers (`test/docker/run.sh`). See [install.md](install.md).
- First-run onboarding (three cards: a machine, a session, weevboss), replayable from the settings.
- Tips and action cards built from the real state (a session waiting for a while, idle sessions to close, a machine
  often maxed out…).
- First-tap hints: the first time you tap the voice logo, the green star, a project's `+` or `!`, or the 24/7 band (and the first time the repos page or conversation mode opens), a
  small flat bubble says what it is and what to do with it, once, remembered by the server for every device.
- `scripts/fresh.sh`: a blank install in an isolated Docker container, to see weevils as a newcomer; reset in one
  command.
- Ready for strangers: README rewritten (with captures of a blank install), MIT license, CONTRIBUTING, commented
  `.env.example`, `docs/email.md`. Settings that only made sense on one machine are now variables with neutral
  defaults (`WEEVILS_LOGS_DIR`, `WEEVILS_INBOX_DIR`, `WEEVILS_EXPOSE_SITES_DIR`, `WEEVILS_DISCOVER`, edge-tts voices).
  The hosting-provider lookup (ipinfo.io and a weekly web search) is off unless `WEEVILS_DISCOVER=1`.
- Security: a request counts as local (trusted without the code) only from 127.0.0.1 with no proxy header, a
  loopback Host and no Origin from another site or another local server, so a web page open on the machine or a DNS
  rebinding can no longer drive the agents. The permission-prompt trade-off (`WEEVILS_SAFE`) is documented.
- Installer: Linux checked first, WSL note, no useless QR code without a domain (the ways in are listed), `--lan`,
  Claude Code offered and its login checked, root keeps permission prompts, Caddy follows a port change, HTTPS
  checked at the end, `--uninstall [--purge]`; it no longer changes global Claude Code settings.
- Tests on the critical paths: sending, delivery and the session lifecycle (tmux layer, transcripts, status
  machine), hermetic (temporary HOME). Fixed on the way: a signed message to a Codex session was typed twice and
  reported as not received; a photo send left a duplicate "sending" bubble. `npm run check` = typecheck (app and
  server) + i18n + shell syntax + tests, ready for CI (`docs/ci/ci.yml`).
- Devil mode is turned on per device from the settings in the bottom band (shown when `DEVIL_API_URL` is set).

### weevboss, the orchestrator
- The top band is a chat with a dedicated Claude session (hidden from the projects) that has the `weevils` command
  (`sessions`, `read`, `send`, `new`, `projects`) and writes into the sessions itself. It can pick a GitHub repo,
  create a project, start or reuse a session, change a session's mode (`/model`, `/effort`…), and choose the machine.
- Three voices in every thread: you, weevboss (or another author), the agent.
- Calm by default: a general chat that grows to half the screen at most.
- Devil mode: another model behind an OpenAI-compatible API can join the same thread.
- External agents can write to the sessions by e-mail (authors + e-mail bridge, see [email.md](email.md)).

### Sessions
- The session page is the real conversation (you / the agent / what it is doing), in the project's color; the
  terminal screen is still there, folded, as a fallback. A pending question shows up in the thread with its answer keys.
- Stricter question detector: "your turn" only for a real dialog (dialog footer + options), no more false alarms.
- Short live titles: what the session talks about now (2–5 words) and what it does now (≤ 7 words), renamed
  periodically by an ephemeral `codex exec` on the subscription. A title set in the tool (`/rename`) always wins.
- Messages sent while the agent works (queued, mid-turn) show up in the thread.
- Sessions opened in a terminal that weevils cannot drive are hidden; done sessions are folded and limited to the
  most recent.
- A session outside any repo goes to the project it talks about; "misc" only when nothing matches.
- One-line session rows: tool sign (claude / codex, machine), current activity and its duration.

### Feed
- Living band order: projects with running agents move to the top (your turn > working > open > the rest by
  activity), with animation.
- Bright green spinning stars and breathing dots while an agent works.
- Faster thread: the last 60 messages first (the rest on demand), long user messages folded to 5 lines.

### Phone
- Photos in a session: resized on the phone (≤ 1600 px JPEG), dropped on the session's machine
  (`~/.local/share/weevils/inbox/`), the agent gets the path.
- Dictation (OpenAI transcription) in the sessions and in weevboss; spoken summaries.
- Installable app: add it to the home screen from Safari (Share → Add to Home Screen); enter the access code once
  in the app, then notifications become possible.
