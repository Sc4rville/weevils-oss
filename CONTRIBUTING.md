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
T=$(mktemp -d); env -u WEEVILS_REMOTES HOME=$T TMUX_TMPDIR=$T WEEVILS_PORT=4410 WEEVILS_HOOK_PORT=4411 \
  WEEVILS_ORCHESTRATOR=0 node server/index.ts
```

`scripts/fresh.sh up` runs a complete blank install in a Docker container instead (what a newcomer sees).

## Before a pull request

```sh
npm run check   # typecheck (app + server), i18n check, shell syntax, tests
```

If you touch `install.sh` or `server/install.sh`, also run the installer end to end in blank Ubuntu containers
(needs Docker, takes a while): `test/docker/run.sh`.

Tests never touch your real `~/.config`, `~/.claude` or weevils data: they run with a temporary `HOME`. Check a live
behaviour (a session cut mid-work, a notification) on the throwaway server above, never on the instance someone uses
every day. If a test session has to run on a real instance anyway, start its brief with `[test]`: it shows in the app
but never notifies and never posts in weevboss's thread. The one test
that talks to a live server is opt-in: `WEEVILS_LIVE_TEST=1 npx vitest run test/live`.

## Layout

- `server/`: the server (Node 22, TypeScript run directly, almost no dependency). It reads the Claude Code / Codex
  transcripts, receives the Claude Code hooks, drives the `wv-*` tmux sessions, and serves the app and the API.
- `src/`: the app (React, Vite, Motion). `shared/`: types and helpers used by both.
- `install.sh` (the installer), `server/install.sh` (commands, hooks, service), `server/wv` (the `wv` command).
- `test/docker/`: installer tests. `scripts/fresh.sh`: a blank install in Docker.

## Rules of the house

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
