# weevils

<img src="public/branding/weevboss.svg" width="96" alt="weevils official logo">

**Watch and drive your Claude Code and Codex sessions from your phone**, on your own machine, with the subscriptions
you already have.

*An AI agent installing this for someone? Clone it and follow [AGENTS.md](AGENTS.md): it installs everything
without asking them anything first.*

<!-- Historical capture: recorded before the official logo update. -->
<img src="docs/first-run.gif" width="280" alt="weevils on a fresh install: the 3-card intro, the empty home, the first hint">

- **Every session, sorted by project**: what each agent is doing right now, and the full thread.
- **Reply from the phone**: write to a session, answer its questions with one tap, send a photo, dictate, start a
  new session or resume an old one.
- **weevboss**: one chat at the top that reads your sessions and passes work on to them.
- **Several machines, one app**: a laptop and a server show up side by side.

Core session control uses your own Claude Code or Codex account. Provider subscription or usage charges still apply; optional voice services may charge separately.

## Release status

This is a private release candidate. Friends can clone it only after the owner grants repository access or approves public visibility. The intended public installation URL is https://github.com/Sc4rville/weevils-oss.

## Install it with your AI agent

Paste this into Claude Code or Codex, on the machine that will run weevils:

```text
install https://github.com/Sc4rville/weevils-oss
```

It clones the repo, runs the installer without asking you anything first, sets up how your phone reaches the machine
and hands you the link. The steps it follows are in [AGENTS.md](AGENTS.md).

## Install

**AI agents: don't use this section and don't ask the user for these answers: follow [AGENTS.md](AGENTS.md).**

You need a Linux machine (a VPS, a home server, or WSL2), preferably a regular user with sudo. The installer adds missing prerequisites and Claude Code. Sign in with your own Claude account for weevboss; see the Codex-only limitations below.

```sh
git clone https://github.com/Sc4rville/weevils-oss weevils && cd weevils && ./install.sh
```

The installer asks for your first name, your language and a domain (optional, see below), then installs what
is missing (git, tmux, Node 22…, with sudo after asking), sets up the background service and prints a link and a QR
code. It takes a few minutes. Run it again any time to update; your settings are kept.

How the phone reaches the machine:

| | |
|---|---|
| `--domain weevils.example.com` | **recommended**: HTTPS with an automatic certificate (the domain must point to the machine, ports 80/443 open). Needed for the installed app, notifications and the mic. |
| `--lan` | same Wi-Fi, plain http: fine to try at home, never on a VPS |
| neither | the app stays on 127.0.0.1: use an SSH tunnel from a computer, or [Tailscale](https://tailscale.com) (`tailscale serve --bg 4179`, then `./install.sh --url https://<machine>.<tailnet>.ts.net`) |

Other options: `--yes` (no questions), `--agent` (for an AI agent: no questions, a machine-readable summary at the
end), `--url <https://…>` (HTTPS already served by something else, like `tailscale serve`), `--name`, `--lang en|fr`, `--port`, `--secondary <ssh host>` (add a second
machine), `--uninstall` (`--purge` also deletes settings and data). Everything the script does:
[docs/install.md](docs/install.md).

## Claude or Codex

The installer can be run from either Claude Code or Codex. The full experience, including weevboss, currently requires a signed-in Claude Code account. Codex sessions use your own separate Codex login. **A Codex-only account does not power weevboss.**

For session control with Codex and no Claude subscription, run the installer above, then disable weevboss before using the app:

```sh
weevils-service config set WEEVILS_ORCHESTRATOR 0
weevils-service restart
codex login
cd ~/projects/my-app
wv codex "Read this project and summarize it"
```

The installer may install the Claude executable; you do not need to sign in to Claude for this limited mode. Its readiness summary still checks Claude, so it may say Claude login is missing even though Codex session control is available. Background features that invoke Claude also remain unavailable. Fresh installer and package checks use disposable homes; authenticated model work requires the installing person to sign in. See [release validation](docs/release-readiness.md) for tested coverage and remaining blockers.

## Shared code and private data

This repository contains the application, generic prompts, translations, tests, and installation scripts. It does not contain a running account. Each installation owns its provider logins, access code, projects, sessions, memories and preferences. Settings live in `~/.config/weevils`; application state lives in `~/.local/share/weevils`; provider credentials stay in their respective Claude/Codex home directories. Keep these outside Git and never share your phone login link.

For a separate single-user Docker trial that mounts no host account or projects, follow [scripts/friend/README.txt](scripts/friend/README.txt). Give each friend a separate container and volume; this is not a shared multi-user service.

## First session

1. Scan the QR code (or open the link) on your phone: you are logged in.
2. Add it to the home screen (iPhone: Share → Add to Home Screen; Android: Install app).
3. On the machine, start a session in one of your repos (they live in `~/projects` by default, change it with
   `WEEVILS_PROJECTS`):
   ```sh
   cd ~/projects/my-app && wv "fix the failing test"
   ```
   `wv` alone opens Claude Code, `wv codex` opens Codex, `wv ls` lists sessions, `wv a` attaches to one.
4. The session shows up under its project. Tap it to read along and reply.
5. Or skip the terminal: tap `+` on a project, or just ask weevboss at the top.

Sessions opened in a plain terminal (without `wv`) are hidden: weevils can't write to them safely.

<img src="docs/screenshot.png" alt="weevils with a few sessions running: projects, a session waiting for an answer, weevboss, the machines">

## Voice

- **Dictation** (the mic button): needs an OpenAI API key (`OPENAI_API_KEY`, paid per use) and HTTPS.
- **Spoken replies** (tap the logo to talk to weevboss): free with [edge-tts](https://github.com/rany2/edge-tts)
  (`pipx install edge-tts`), or nicer with Cartesia (`CARTESIA_API_KEY`).

With an OpenAI key, quick answers and spoken summaries also use OpenAI; without one they use Claude on your
subscription.

## E-mail

Other agents (a CI bot, another assistant) can write to your sessions by e-mail, through an alias of your inbox.
Only senders you declare get through. Setup and rules: [docs/email.md](docs/email.md).

## Settings

One file outside the repo, `~/.config/weevils/env`, created by the installer from [`.env.example`](.env.example),
which explains every setting. After a change: `weevils-service restart` (for the port or the domain, run
`./install.sh` again).

## Security

- **The access code is shell access.** Anyone with it can type into your agents. It lives in
  `~/.config/weevils/secret`; keep it private.
- **Agents run without permission prompts** (`--dangerously-skip-permissions`), so they never wait for you while you
  are away. Set `WEEVILS_SAFE=1` to keep the prompts and answer them from the phone.
- **Use HTTPS** (`--domain`) for anything beyond your home network.
- **Requests from the machine itself are trusted without the code** (the `weevils` command, a second machine's
  tunnel). If you put a proxy other than the installer's Caddy in front, it must send `X-Forwarded-For`
  (nginx: `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`).
- **Lost a phone?** `rm ~/.config/weevils/secret ~/.local/share/weevils/tokens.json && weevils-service restart`, then
  log in again with the new code (`cat ~/.config/weevils/secret`).
- The machine page shows a few facts about the server (CPU, memory, disk). It only looks up the hosting provider
  online if you set `WEEVILS_DISCOVER=1`. The quota page reads your Claude Code / Codex login to show your usage.

## More

Branding rollout status and historical screenshots: [docs/branding.md](docs/branding.md).

- [docs/install.md](docs/install.md): installer details, several machines, tests
- [CONTRIBUTING.md](CONTRIBUTING.md): development setup, checks, how the code is laid out
- [docs/changelog.md](docs/changelog.md): what changed

English and French throughout. Application source and documentation: Apache-2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE). Earlier MIT notices are retained in [LICENSE-MIT](LICENSE-MIT). Asset clearance status: [ASSETS.txt](ASSETS.txt).
