# Changelog

A short summary of what changed after the first working version.

## 2026-11-17

### Bring your conversations
- Claude Code and Codex conversations from another computer, resumed here in one tap. Both tools keep a conversation
  only on the machine where it ran (one file each; neither account syncs local sessions). On a new machine, the first
  screen offers « bring my conversations from another computer », and weevboss can put the same button anywhere
  (`[[setup:history]]`): one line to paste in that computer's terminal (`server/bring.sh`: reads, sends, installs
  nothing), its 300 most recent conversations listed by title, a tap brings one. The project is found among the local
  clones or cloned (same git address), its folder paths are rewritten, and the conversation opens as a finished session
  that resumes with the next message. A machine already connected to this weevils (`WEEVILS_REMOTES`) lists its own
  without the line. Details: `server/bring.ts`.

## 2026-11-13

### macOS
- weevils installs and runs on a **Mac** (Apple Silicon and Intel) with the same command, by hand or through an AI
  agent (`AGENTS.md`). The installer runs under the bash 3.2 that macOS ships, never as root, and takes tmux, jq,
  Node.js and qrencode from **Homebrew** (installed too when it is missing). `--domain` is refused there (Caddy stays
  Linux only); `--url` and `--lan` work, and Tailscale is the way in for the phone.
- The service is a **launchd agent** of your session (`~/Library/LaunchAgents/com.github.sc4rville.weevilsd.plist`),
  started at login and restarted if it stops. `weevils-service start|stop|restart|status|logs` drives it as on Linux;
  logs in `~/.local/share/weevils/weevilsd.log`. Over SSH with no session open on the Mac's screen, weevilsd runs in
  the background until the next restart.
- Claude Code's login is read from the **Keychain**. weevilsd keeps the Mac awake while it is plugged in
  (`WEEVILS_KEEP_AWAKE=0` turns that off); a closed laptop lid still puts it to sleep.
- The install summary has two new keys, `os` (`linux` or `macos`) and `arch`. The systemd timers of the auto band and
  the bwrap jail stay Linux only. Details: [install.md](install.md#macos).

## 2026-11-10

### For you
- Next to weevboss at the top, a second word: **for you**, a stream of what the agents did, ask and suggest. One
  full-width band per item: a session's result (green), its question (amber) or why it stopped, a word from weevboss,
  a mail from an outside agent (unfolds in place), suggested automations as a carousel (✓ / ×), a way for weevils to
  serve you better, alerts, bold « did you know » about what is really in a repo, milestones, and bars that say where
  the day stands. Reply under an item, open the real conversation, launch an action: it slides out of the stream.
- The preview lives in the top band; a tap opens the stream full screen, with a line of participants to isolate
  weevboss, an outside agent, the sessions, the media or the ideas. The stream ends: « up to date ».
- **Media on purpose**: `weevils show <file> "caption"` (any session, or weevboss) puts an image or a video in the
  stream; files named in the last message of a turn join its result. Served by `GET /api/foryou/media/<id>` with
  `Range`, only for files the stream listed. `weevils post "…" [--action "label::brief"]` lets weevboss say a word
  there, with buttons.
- **Voice messages**: a word from weevboss or from an outside agent can be listened to, each speaker in its own voice.
- Generated items (weevboss's digest, ideas, insights) are written by weevilsd on a budget: only while the stream is
  being looked at, never past 85 % of a usage window, 12 model calls a day at most. Plan and state: [foryou.md](foryou.md).
### Codex relay when Claude hits its usage limit
- weevilsd watches three signals, in plain code (no model call): the limit message Claude Code writes in a transcript
  (with its reset time), sessions that stop dead or API errors piling up, and the subscription quota read live (5-hour
  and weekly windows, the figures of the usage page).
- From 90 % of a window, Codex writes a **takeover plan** for every Claude session at work, read-only and in the
  background (`codex exec --sandbox read-only --ephemeral`), and one line says so, once per window (“you're at 90% of your week,
  I'm keeping Codex warm”); the next message is the switch, nothing in between. At 97 % (the limit has no grace period; the threshold is a setting, `WEEVILS_RELAY_AT` before any
  choice in the app) the switch is made ahead of the cut: weevboss answers through Codex (same folder, `AGENTS.md` =
  its instructions, same `weevils` command) and every working session is told to finish its step and stop. A limit
  seen after the fact opens the same episode.
- Each stopped session gets its plan (done, left, risks, what Codex intends to do), shown in one grouped view, under
  weevboss' thread and in the session's page: **approve**, **adjust** (Codex rewrites it with your note) or **wait for
  Claude**, one by one or all at once. Nothing is touched before the approval; approved, a Codex session opens in the
  same folder, linked to the Claude one (a small “relay” sign). Setting: propose a plan (default) / automatic / never.
- Background tasks of the auto band follow the same rule: on Codex only inside the bwrap jail (Codex has no deny
  list), otherwise they wait. At the reset time everything goes back to Claude: weevboss is told what Codex said in
  its place, sessions left to Claude are resumed, waiting tasks are released.
- `POST /api/relay` (mode, switchAt), `POST /api/relay/plans/:id|all` (go, adjust, wait), `POST
  /api/sessions/:id/relay` (ask for a plan). To try it on a throwaway server: `WEEVILS_FAKE_CLAUDE_USAGE=<file>`
  (a file shaped like the usage API's answer).
- Fixed on the way: an unclosed block in `src/styles.css` swallowed every rule written after it (inline setup chips,
  the language choices, masked secrets).

### Sessions cut off mid-work
- A session that dies while it was working (process or pane gone, tmux killed, crash), that stops on an API error
  (usage limit, expired login, failed compaction) or that stops without a clean end and leaves uncommitted work is now
  **interrupted**: a red row with a one-tap **resume**, a red counter in its project band (also when folded), a red
  band in its thread (resume / dismiss). Never shown as done, never with the green star.
- Each new interruption sends a push notification and posts a line in weevboss' thread; `weevils sessions` lists
  them first. Resume (`POST /api/sessions/:id/resume`, `weevils resume <id>`) restarts it with `--resume` and a message
  pointing it to its work on disk. A clean end (`/exit`, `/clear`, closed from the app, idle cleanup) is never one.
- Agent sessions now live on their own tmux server (`tmux -L weevils`; `WEEVILS_TMUX_SOCKET` to rename it): a
  `tmux kill-server` run by an agent no longer closes them. Sessions started before stay on the default server
  until they end; `wv ls` / `wv a` see both.

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
