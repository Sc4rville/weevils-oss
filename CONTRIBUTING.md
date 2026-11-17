# Contributing

Thanks for helping. Bug reports, small fixes and translations are all welcome.

## Setup

```sh
npm install
npm run dev     # the app on http://127.0.0.1:4178 with hot reload, /api proxied to a weevils server on :4179
```

The app needs a running server. To run a throwaway one next to a real install (its own home, tmux server and ports,
no weevboss), build the app and start it:

```sh
npm run build
scripts/test-copy.sh up mytest 4410     # in its own Docker container: own HOME, data, ports and tmux server
scripts/test-copy.sh link mytest        # its login link
scripts/test-copy.sh tmux mytest ls     # tmux inside the copy only
scripts/test-copy.sh down mytest
```

Never start a test copy by hand next to a real install, and never run `tmux -L weevils kill-server`: with a
`TMUX_TMPDIR` that doesn't exist yet, tmux falls back to the real server and closes every live agent session (it
happened twice on 2026-11-14). The launcher needs Docker and refuses to start without it; on a real install the tmux
guard (`server/tmux-guard`, installed as `~/.local/bin/tmux`) refuses such a command anyway.

`scripts/fresh.sh up` runs a complete blank install in a Docker container instead (what a newcomer sees).

## Before a pull request

```sh
npm run check   # typecheck (app + server), i18n check, shell syntax, tests
```

If you touch `install.sh` or `server/install.sh`, also run the installer end to end in blank Ubuntu containers
(needs Docker, takes a while): `test/docker/run.sh`. The shell scripts run on a Mac too, under its bash 3.2 and BSD
tools: `test/macos/run.sh` checks that without a Mac, in a Docker container that stands in for one, and
`docs/ci/macos.yml` is an optional GitHub Actions workflow for a real Mac.

Tests never touch your real `~/.config`, `~/.claude` or weevils data: they run with a temporary `HOME`. Check a live
behaviour (a session cut mid-work, a notification) on the throwaway server above, never on the instance someone uses
every day. If a test session has to run on a real instance anyway, start its brief with `[test]`: it shows in the app
but never notifies and never posts in weevboss's thread. A live weevils also refuses anything that speaks to weevboss
as the user (a message, live voice, a For you tap) unless it comes from a browser signed in with the access code: a
script, `curl` or an automated browser on the same machine gets a 403, even though loopback is trusted for the rest.
Agents and the `weevils` command still write there, signed with their name. Live voice and weevboss tests run on
`scripts/test-copy.sh`, which lets the copy's own scripts in (`WEEVILS_ALLOW_LOCAL_VOICE=1`). The one test
that talks to a live server is opt-in: `WEEVILS_LIVE_TEST=1 npx vitest run test/live`.

## Layout

- `server/`: the server (Node 22, TypeScript run directly, almost no dependency). It reads the Claude Code / Codex
  transcripts, receives the Claude Code hooks, drives the `wv-*` tmux sessions, and serves the app and the API.
- `src/`: the app (React, Vite, Motion). `shared/`: types and helpers used by both.
- `install.sh` (the installer), `server/install.sh` (commands, hooks, service), `server/wv` (the `wv` command).
- `test/docker/`, `test/macos/`: installer tests (Linux, macOS). `scripts/fresh.sh`: a blank install in Docker.

## Rules of the house

Session controls, delivery and activity must follow the [shared product contract](docs/product/session-contract.md), for both agents and a fresh profile.

All shared improvements also follow the [canonical release workflow](docs/release-workflow.md): implement, test,
commit and push in `Sc4rville/weevils-oss`; integrate approved workers' contributions into `main` before the next export.
Keep personal configuration and secrets outside source. RC2 is an immutable historical snapshot, not today's product.
Generate release candidates from a canonical source SHA with `scripts/release.py`; do not maintain a separate OSS
feature copy. Always distinguish canonical, candidate, tested and running revisions. No publication is implied.

- **Every user-facing string goes through a catalog**, English and French side by side with the same keys:
  `src/i18n/<area>.ts` for the app, `server/i18n/<area>.ts` for the server. `npm run i18n:check` catches hard-coded
  strings. To add a language, add it to `Lang`, `LANGS` and `LANG_NAMES` in `shared/i18n.ts`, then a block in every
  catalog; the shell scripts and weevboss's prompt (`server/orchestrator.<lang>.md`) have their own strings.
- **The look**: flat colour bands, bold type, sharp corners, no shadows, no permanent help text.
- **Small commits**, `type(scope): what and why` (`fix(install): …`, `feat(app): …`). Many existing commit messages
  and code comments are in French; new ones can be in English.
- No new runtime dependency without a good reason.

## Security

Anyone who can reach the server with the access code can type into your agents, which is shell access on the
machine. Please report security issues privately to the maintainer rather than in a public issue.
