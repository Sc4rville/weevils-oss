# Installing weevils

One command on a Linux machine or VPS (Ubuntu/Debian tested; dnf and pacman supported for packages). Linux only:
macOS is not supported yet; on Windows, use WSL2 (see below).

```sh
git clone https://github.com/Sc4rville/weevils-oss weevils && cd weevils && ./install.sh
# once the repo is public:
curl -fsSL https://raw.githubusercontent.com/Sc4rville/weevils-oss/main/install.sh | bash
```

Run it again any time: it updates (git pull, npm ci and build only when something changed) and keeps your settings.

## What it does

1. Checks the system and installs what is missing (with sudo, after asking): git, curl, tmux (>= 3.2), jq, python3,
   Node.js >= 22.18 (NodeSource), plus `dbus-user-session` on systemd machines and `qrencode` for the QR code.
   An older Node (18, 20) is upgraded; if an old one in `/usr/local/bin` still comes first in your PATH, weevils
   uses the new one in `/usr/bin` and tells you. Without a terminal and without `--yes`, every "install?" question
   is answered no.
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
   `weevils-service start|stop|status|logs`, plus an `@reboot` line in your crontab.
7. In your Claude Code settings (`~/.claude/settings.json`, saved once to `settings.json.bak-weevils`): the
   `weevils-hook` hook on six events (your other hooks are kept; weevils hooks whose script is gone are removed),
   and, unless `WEEVILS_SAFE=1`, `skipDangerousModePermissionPrompt: true`, so Claude Code's one-time warning about
   running without permission prompts doesn't end the first session. Nothing else there: weevils sessions get
   their quiet variables (no auto-update, no tips) per session.
8. With `--domain`: Caddy (official apt repo, or the distribution's package on dnf and pacman) and a site in
   `/etc/caddy/weevils.caddy`, imported from your Caddyfile (an existing Caddyfile keeps its sites; the original is
   kept in `Caddyfile.bak-weevils`). If Caddy rejects the result (say the domain is already a site there), both
   files go back exactly as they were. When ufw is active, it offers to open ports 80 and 443. Then it checks that
   `https://<domain>` answers, and says what to look at (DNS, ports, Caddy logs) when it doesn't. A re-run keeps
   the site and points it to the current port.
9. Prints the address, the access code and the login link (`…/#k=<code>`), with its QR code when a phone can open
   it (`--domain`, `--lan`, or a `WEEVILS_PUBLIC_URL`). Without any of them, it lists the ways in instead (below).

### Permissions

Agents run without permission prompts (`claude --dangerously-skip-permissions`, `codex
--dangerously-bypass-approvals-and-sandbox`), so they never wait for you while you're away; the end screen says so.
`WEEVILS_SAFE=1` in `~/.config/weevils/env` keeps the prompts (you answer them from the app); `wv` follows it too.
Claude Code refuses to skip them as root, so a root install sets `WEEVILS_SAFE=1`. A regular user with sudo is better.

## Options

| option | |
|---|---|
| `--yes` | no questions, defaults everywhere |
| `--name <first name>` | how the agents call you |
| `--lang en\|fr` | language of the installer and of the server (default: the one in your settings, else your locale) |
| `--domain <host>` | HTTPS through Caddy; the domain must point to the machine, ports 80/443 open |
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

- **A domain** pointing to the machine: `./install.sh --domain <host>` (HTTPS, recommended).
- **Tailscale**, with the phone and the machine on the same tailnet: `sudo tailscale serve --bg 4179`, then open the
  `https://<machine>.<tailnet>.ts.net` address it prints (set it as `WEEVILS_PUBLIC_URL` for the login link and
  notifications).
- **The same home network**: `./install.sh --lan` (`WEEVILS_HOST=0.0.0.0`). The end screen shows the machine's
  address and a QR code. It is plain http: never on a VPS (the access code would travel in clear; the installer
  warns when the address is not a private one), and the phone allows neither the microphone nor notifications
  over http. The login cookie is only marked Secure behind HTTPS.
- **From a computer**, an SSH tunnel: `ssh -L 4179:127.0.0.1:4179 you@server`, then http://localhost:4179.

**WSL2**: the phone can't reach WSL as is. Use Tailscale (on Windows or in WSL), or `networkingMode=mirrored` in
`%UserProfile%\.wslconfig` (then `--lan`), and add `vmIdleTimeout=-1` there too, or WSL stops, and weevilsd with
it, when no terminal is open.

## Uninstalling

```sh
./install.sh --uninstall            # or: curl … | bash -s -- --uninstall
```

Stops the service and removes its units, the commands in `~/.local/bin` (`wv`, `weevils`, `weevils-service`,
`weevils-hook`), the weevils hooks in `~/.claude/settings.json`, the `@reboot` crontab line, and the Caddy site
(`/etc/caddy/weevils.caddy` and its import line, with sudo; the public URL that came with it is cleared). It keeps
`~/.config/weevils` (settings, access code) and `~/.local/share/weevils` (data) unless `--purge`, the clone, the
agent sessions still open in tmux, linger, and `skipDangerousModePermissionPrompt` in your Claude settings.

## Several machines

Install the main machine first, then on each other machine (it needs `ssh <main host>` to work without a password):

```sh
curl -fsSL https://raw.githubusercontent.com/Sc4rville/weevils-oss/main/install.sh | bash -s -- --secondary <main ssh host>
```

The secondary machine runs its own weevilsd (no app, no weevboss) and a reverse SSH tunnel to the main machine.
It registers itself there (`weevils-service add-remote <id>` adds it to `WEEVILS_REMOTES` and picks a free port from
4192), so its sessions show up in the main app.

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
