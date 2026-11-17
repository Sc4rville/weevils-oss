# Installing weevils

One command on a Linux machine or VPS (Ubuntu/Debian tested; dnf and pacman supported for packages), or on a Mac
(Apple Silicon or Intel: see [macOS](#macos) for what differs). On Windows, use WSL2 (see below).

```sh
git clone https://github.com/Sc4rville/weevils-oss && cd weevils && ./install.sh
# once the repo is public:
curl -fsSL https://raw.githubusercontent.com/Sc4rville/weevils-oss/main/install.sh | bash
```

Run it again any time: it updates (git pull, npm ci and build only when something changed) and keeps your settings.

Or ask your AI agent: paste `install https://github.com/Sc4rville/weevils-oss` into Claude Code or Codex. It follows
[AGENTS.md](../AGENTS.md) (see [With an AI agent](#with-an-ai-agent) below).

## What it does

1. Checks the system and installs what is missing (with sudo, after asking): git, curl, tmux (>= 3.2), jq, python3,
   Node.js >= 22.18 (NodeSource), plus `dbus-user-session` on systemd machines and `qrencode` for the QR code.
   An older Node (18, 20) is upgraded; if an old one in `/usr/local/bin` still comes first in your PATH, weevils
   uses the new one in `/usr/bin` and tells you. Without a terminal and without `--yes`, every "install?" question
   is answered no. On a Mac, everything comes from Homebrew, without sudo.
2. Claude Code is required (weevboss runs on it): if it is missing, it offers to install it with the official
   installer (`curl -fsSL https://claude.ai/install.sh | bash`, into `~/.local/bin`). Codex is optional: it only
   prints the command (`npm i -g @openai/codex`, with `sudo` when npm's global folder is not yours). If Claude Code
   is not logged in yet, the end screen says "almost ready: run claude once to log in".
3. Clones weevils into `--dir` (default `~/weevils`) when piped from curl, or uses the clone it runs from.
4. Writes your settings to `~/.config/weevils/env` from `.env.example`. Values already there are kept;
   a flag you pass (`--name`, `--lang`, `--port`, `--domain`, `--lan`, `--machine`) updates its key. A new config
   takes the first free pair of ports from 4179/4180. As root, it sets `WEEVILS_SAFE=1` (see below).
5. `npm ci` and `vite build`.
6. `server/install.sh`: commands in `~/.local/bin` (`wv`, `weevils`, `weevils-service`, `weevils-hook`) and the
   service — a `systemd --user` unit with linger (survives logout and reboot; it warns when linger can't be turned
   on), or a background process where there is no systemd (containers, WSL), controlled with
   `weevils-service start|stop|status|logs`, plus an `@reboot` line in your crontab. On a Mac: a launchd agent.
7. In your Claude Code settings (`~/.claude/settings.json`, saved once to `settings.json.bak-weevils`): the
   `weevils-hook` hook on six events (your other hooks are kept; weevils hooks whose script is gone are removed),
   and, unless `WEEVILS_SAFE=1`, `skipDangerousModePermissionPrompt: true`, so Claude Code's one-time warning about
   running without permission prompts doesn't end the first session. Nothing else there: weevils sessions get
   their quiet variables (no auto-update, no tips) per session.
8. With `--domain` (Linux only): Caddy (official apt repo, or the distribution's package on dnf and pacman) and a
   site in `/etc/caddy/weevils.caddy`, imported from your Caddyfile (an existing Caddyfile keeps its sites; the
   original is kept in `Caddyfile.bak-weevils`). If Caddy rejects the result (say the domain is already a site
   there), both files go back exactly as they were. When ufw is active, it offers to open ports 80 and 443. Then it
   checks that `https://<domain>` answers, and says what to look at (DNS, ports, Caddy logs) when it doesn't. A
   re-run keeps the site and points it to the current port.
9. Prints the address, the access code and the login link (`…/#k=<code>`), with its QR code when a phone can open
   it (`--domain`, `--url`, `--lan`, or a `WEEVILS_PUBLIC_URL`). Without any of them, it lists the ways in instead
   (below). It ends on what is already there (your Claude Code projects of the last 3 days, or your repos in
   `~/projects`) and the first thing to try in the app.
10. Writes the hand-off file `~/.local/share/weevils/install.json` (see below), read by weevboss (`weevils setup`)
    so its welcome in the thread picks up where the install stopped.

### Permissions

Agents run without permission prompts (`claude --dangerously-skip-permissions`, `codex
--dangerously-bypass-approvals-and-sandbox`), so they never wait for you while you're away; the end screen says so.
`WEEVILS_SAFE=1` in `~/.config/weevils/env` keeps the prompts (you answer them from the app); `wv` follows it too.
Claude Code refuses to skip them as root, so a root install sets `WEEVILS_SAFE=1`. A regular user with sudo is better.

## Options

| option | |
|---|---|
| `--yes` | no questions, defaults everywhere |
| `--agent` | for an AI agent: `--yes`, no colours, sudo only without a password, a summary at the end (below) |
| `--name <first name>` | how the agents call you |
| `--lang en\|fr` | language of the installer and of the server (default: the one in your settings, else your locale) |
| `--domain <host>` | HTTPS through Caddy; the domain must point to the machine, ports 80/443 open. Linux only |
| `--url <https://…>` | the address the phone opens when something else serves HTTPS in front (`tailscale serve`, your own proxy to 127.0.0.1:4179); sets `WEEVILS_PUBLIC_URL` |
| `--lan` | listen on every interface (`WEEVILS_HOST=0.0.0.0`) for a phone on the same home network, plain http |
| `--port <n>` | port of weevilsd on 127.0.0.1 (default 4179); a re-run moves the Caddy site too |
| `--dir <path>` | install directory when piped from curl (default `~/weevils`) |
| `--secondary <ssh-host>` | a second machine: see below |
| `--machine <id>` | id and name of this machine (default: hostname) |
| `--no-update` | no git pull |
| `--uninstall` | removes weevils (see below) |
| `--purge` | with `--uninstall`: also deletes your settings, access code and data |

Bad values (`--port abc`, `--lang de`, a domain with spaces) stop the script before it changes anything; a domain
given as a URL (`https://host/`) is cut down to its host. `WEEVILS_REPO=<git url>` clones from another repo (a fork,
a mirror, a local `file://` path). The script is one function called on its last line, so a download cut short
runs nothing.

## Reaching it from the phone

Without `--domain`, weevilsd listens on 127.0.0.1 only, and the end screen shows no QR code (`http://localhost` on
a phone is the phone itself). The ways in:

- **A domain** pointing to the machine: `./install.sh --domain <host>` (HTTPS, recommended on a server; Linux only).
- **Tailscale**, with the phone and the machine on the same tailnet: `sudo tailscale serve --bg 4179` (no `sudo` on a
  Mac), then `./install.sh --url https://<machine>.<tailnet>.ts.net` (the address it prints): the end screen then
  shows that link with its QR code, and notifications use it.
- **The same home network**: `./install.sh --lan` (`WEEVILS_HOST=0.0.0.0`). The end screen shows the machine's
  address and a QR code. It is plain http: never on a VPS (the access code would travel in clear; the installer
  warns when the address is not a private one), and the phone allows neither the microphone nor notifications
  over http. The login cookie is only marked Secure behind HTTPS.
- **From a computer**, an SSH tunnel: `ssh -L 4179:127.0.0.1:4179 you@server`, then http://localhost:4179.

**WSL2**: the phone can't reach WSL as is. Use Tailscale (on Windows or in WSL), or `networkingMode=mirrored` in
`%UserProfile%\.wslconfig` (then `--lan`), and add `vmIdleTimeout=-1` there too, or WSL stops, and weevilsd with
it, when no terminal is open.

## macOS

The same command works on a Mac, Apple Silicon or Intel. What differs from Linux:

- **Requirements.** Run the installer as yourself, never as root and never with `sudo`: it stops if you do, because
  Homebrew refuses to run as root. Packages come from [Homebrew](https://brew.sh). When it is missing, the installer
  offers to install it with Homebrew's official installer, which asks for your Mac password (you need an
  administrator account). Run by an AI agent, that step needs sudo without a password; otherwise the summary says
  `status=needs_sudo` and gives the command to run once in the Terminal app. A Mac that already has every tool
  (from MacPorts, for example) needs no Homebrew.
- **Intel Macs.** Homebrew's installer no longer runs on Intel Macs. With Homebrew already installed, nothing
  changes. Without it, the installer stops and names the missing tools: install them with
  [MacPorts](https://www.macports.org) (git and python3 also come with Apple's developer tools,
  `xcode-select --install`), then run it again.
- **What it installs.** From Homebrew, when they are missing: git, curl, tmux, jq, python3, qrencode, and Node.js
  when yours is older than 22.18 (if an older one still comes first in your PATH, weevils uses Homebrew's and tells
  you). Claude Code comes from its official installer, as on Linux. Settings, data and commands live in the same
  places: `~/.config/weevils`, `~/.local/share/weevils`, `~/.local/bin`.
- **Service.** A launchd agent of your session, `~/Library/LaunchAgents/com.github.sc4rville.weevilsd.plist`: it
  starts when you log in and is restarted if it stops. It runs in your session because that is where the Keychain,
  which holds Claude Code's login on a Mac, can be reached. `weevils-service start|stop|restart|status|logs` controls
  it; the logs are in `~/.local/share/weevils/weevilsd.log`. No crontab line on a Mac.
- **Over SSH.** With no session open on the Mac's screen there is nowhere to load a launchd agent: weevilsd runs as
  a background process until the next restart of the Mac, and the installer says so. Log in on the Mac's screen and
  run the installer again: launchd then starts it at every login.
- **Phone access.** `--domain` is refused (it sets up Caddy, on Linux only); `--url` and `--lan` work. The simple way
  is Tailscale: install [its app](https://tailscale.com/download/mac), sign in, then `tailscale serve --bg 4179`
  (no sudo) and `./install.sh --url https://<mac>.<tailnet>.ts.net`. If your shell does not find `tailscale`, the
  command is inside the app: `/Applications/Tailscale.app/Contents/MacOS/Tailscale`.
- **Several machines.** A Mac can be the main machine or a `--secondary` one; its tunnel is a second launchd agent,
  `com.github.sc4rville.weevils-tunnel`.
- **Uninstalling.** `./install.sh --uninstall` stops weevilsd and removes its launchd agents, with the rest listed
  under [Uninstalling](#uninstalling). Homebrew and the packages it installed stay.

Limits on a Mac:

- weevils runs while your session is open. It keeps the Mac awake while it is plugged in (`WEEVILS_KEEP_AWAKE=0` in
  `~/.config/weevils/env` turns that off), but a laptop with its lid closed still goes to sleep, and your agents
  stop with it. For agents that work at night, a small VPS is better as the main machine; the Mac can then join it
  with `--secondary`.
- Two things stay Linux only: the systemd timers shown in the auto band, and the bwrap jail that background tasks
  run in.

## With an AI agent

[AGENTS.md](../AGENTS.md) is written for an agent asked to install weevils: check the machine, clone, run
`./install.sh --agent`, sort out the phone's way in, and end with one message in the user's language (link, QR
code, home screen, first thing to try). The installer also acts as `--agent` by itself when it sees it is run by
Claude Code (`CLAUDECODE=1`) or Codex (a `CODEX_*` variable other than `CODEX_HOME`) with no terminal: the user asked
their agent to install it, which is the consent `--yes` stands for. Even then sudo is only used with `-n`; when it
wants a password, the script stops with `status=needs_sudo` and the command to run once from a terminal.

The output ends with a block to parse, `key=value` per line (an agent gets it even when the install fails):

```text
--- weevils summary ---
status=ok                      # ok | needs_sudo | failed (then error=…)
role=main
url=http://localhost:4179      # what the phone opens, without the code
code=…
link=http://localhost:4179/#k=…
mode=local                     # public | lan | local
https=no
port=4179
ready=yes                      # Claude Code installed and logged in
claude_installed=yes
claude_logged=yes
codex_installed=no
codex_logged=no
gh_installed=no
gh_logged=no
gh_login=
projects=0                     # ~/.claude/projects folders with a session in the last 3 days
projects_all=0
repos=0                        # git repos in ~/projects (WEEVILS_PROJECTS)
tailscale=no
tailscale_name=
os=linux                       # linux | macos
arch=x86_64                    # uname -m: x86_64, aarch64, arm64 (Apple Silicon)
laptop=no
wsl=no
sudo=yes                       # yes | password | no
name=Ana
dir=/home/ana/weevils
qrencode=yes
handoff=/home/ana/.local/share/weevils/install.json
next=read /home/ana/weevils/AGENTS.md steps 6 and 7, then write the final message
lang=en
agent=claude                   # claude | codex | (empty)
--- end ---
```

With `status=needs_sudo`, `needs=` says what needs root and `retry=` gives the same install for a terminal.

### The hand-off file

Every successful install of a main machine writes `~/.local/share/weevils/install.json` (atomically, mode 600):

```json
{ "v": 1, "at": 1762743000000, "by": "agent", "agent": "claude", "url": "http://localhost:4179", "mode": "local",
  "phoneLink": false, "lang": "en", "ready": { "claude": true, "codex": false, "gh": false }, "projects": 0, "repos": 0 }
```

`by`: `agent` (`--agent` or detected), `terminal` (a person saw the end screen), `script` (`--yes` without a
terminal). `phoneLink`: the end screen printed a link a phone can open (`mode` public or lan). `projects` and
`repos` count like the summary.

## Uninstalling

```sh
./install.sh --uninstall            # or: curl … | bash -s -- --uninstall
```

Stops the service and removes its units (on a Mac: its launchd agents), the commands in `~/.local/bin` (`wv`,
`weevils`, `weevils-service`, `weevils-hook`), the weevils hooks in `~/.claude/settings.json`, the `@reboot` crontab
line, and the Caddy site (`/etc/caddy/weevils.caddy` and its import line, with sudo; the public URL that came with
it is cleared). It keeps `~/.config/weevils` (settings, access code) and `~/.local/share/weevils` (data) unless
`--purge`, the clone, the agent sessions still open in tmux, linger, and `skipDangerousModePermissionPrompt` in your
Claude settings.

## Several machines

Install the main machine first, then on each other machine (it needs `ssh <main host>` to work without a password):

```sh
curl -fsSL https://raw.githubusercontent.com/Sc4rville/weevils-oss/main/install.sh | bash -s -- --secondary <main ssh host>
```

The secondary machine runs its own weevilsd (no app, no weevboss) and a reverse SSH tunnel to the main machine.
It registers itself there (`weevils-service add-remote <id>` adds it to `WEEVILS_REMOTES` and picks a free port from
4192), so its sessions show up in the main app.

Conversations already on another computer (Claude Code or Codex, before weevils was there) come over without
installing anything on it: « bring my conversations » in the app shows one line to paste in that computer's terminal,
then its conversations, one tap each (`server/bring.ts`). A secondary machine lists its own conversations there by
itself.

## Testing the installer

```sh
test/docker/run.sh          # all scenarios, ends with PASS or FAIL
```

It installs the HEAD commit in blank `ubuntu:24.04` containers: a systemd "VPS" (install from a clone as a sudo
user, service + linger, login over http, the end screen without a domain, idempotent re-run, `--domain` with Caddy,
a port change that moves the Caddy site, a `--secondary` machine federated over SSH, reboot, `--uninstall` then a
new install), a plain container without systemd (piped install as root: Claude Code from its official installer,
`WEEVILS_SAFE=1`, background fallback, `--uninstall --purge`), and the hard cases (`test/docker/run.sh edge`):
truncated downloads, no terminal without `--yes`, a user without sudo and without tmux, Node 20 from NodeSource
and Node 18 from Ubuntu upgraded, a Node 20 tarball shadowing the new one, `cat install.sh | bash -s` as a sudo user
with a `file://` repo and `--dir`, a re-run after editing the config by hand (every value kept, API key never
printed), `--lang fr` without a single English line, `--lan`, and a Caddy that already serves another site (kept,
left untouched when Caddy rejects the new domain, and following a port change). Claude Code is a stub there, except
in the plain scenario. On a machine that has the `heavy` helper, builds go through it.

The macOS paths have their own harness, which needs no Mac: `test/macos/run.sh` runs the scripts in a Docker
container that stands in for one, under bash 3.2 (the bash macOS ships). To try a real Mac, `docs/ci/macos.yml` is
an optional GitHub Actions workflow for a macOS runner.

## Seeing weevils as a newcomer

```sh
scripts/fresh.sh up --port 4177 --url https://fresh.example.com   # once: builds the image, starts, prints the login link
scripts/fresh.sh reset                                            # blank again
scripts/fresh.sh build                                            # new image from the HEAD commit, then blank
```

A second, blank weevils next to yours, in its own Docker container (`weevils-fresh`): Ubuntu 24.04, Node 22, Claude
Code installed but not logged in, a user without sudo, weevils put in place by its own `install.sh` from a clone of
the committed HEAD. No key, no repo, no mail, no project, no session: its own disk, network and loopback, so it can
neither read your data nor reach your weevilsd (which only trusts its own loopback). Limited to 2 CPUs and 2 GB.

It listens on `127.0.0.1:<port>`; put a reverse proxy in front for HTTPS (Caddy: `reverse_proxy 127.0.0.1:<port>`).
The login link stays the same across resets (the access code is kept in `~/.config/weevils-fresh/`). After a reset,
every device that opens the app forgets what it kept about the old instance (intro done, theme, hints…): the server's
install id changed.
