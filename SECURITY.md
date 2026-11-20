# Security

weevils lets you watch and drive the Claude Code and Codex sessions of one machine from your phone. That machine's
agents run as you, with your files. This page says what the install does and doesn't do, what leaves your machine,
and how to turn each part off or remove it. It is served at https://get.scarville.tech/security.

## The recommended setup: a server of its own

The setup page (https://tryweevils.scarville.tech) recommends a small rented server, which it can create for you at
Hetzner. Agents then work on a machine that holds nothing else of yours. Your Hetzner API token stays in your
browser: the page calls Hetzner's API directly (`api.hetzner.cloud`), and the token never reaches the setup service.
After the server exists, you can delete the token in Hetzner's console. The page only works when it is open.

On your own computer, weevils works the same way, but its agents can reach everything your user can. There:

- agents ask before acting (Claude Code's permission prompts, answered from the app). `--no-permission-prompts` turns
  that off, as on a server.
- the phone reaches the computer through a Cloudflare quick tunnel to weevils' port on `127.0.0.1` (`cloudflared`,
  from Cloudflare's GitHub release, checked against the SHA-256 GitHub publishes for it). Only weevils'
  app is behind it, and only with your access code (72 random bits; a wrong code waits 800 ms). `--no-link` installs
  without it: weevils stays on this machine until you set up a way in (Tailscale, for one).

## What the install does

The command from the setup page is `curl -fsSL https://get.scarville.tech/install.sh | bash -s <setup id>`. Every
visitor gets the same script, with its SHA-256 at `/install.sh.sha256`. It begins with a plain list of what it does.
In short, as you and in your home folder:

1. It downloads the weevils code (`/weevils.bundle`, a git bundle) and **checks its signature** against the release
   key pinned in the script (`ssh-keygen -Y verify`, namespace `weevils-release`). Where OpenSSH is older than 8.1,
   it checks the published SHA-256 instead. A bundle that doesn't check is refused, and nothing gets installed.
2. It runs `~/weevils/install.sh --agent`. That adds whatever is missing:
   - Node.js 22: the official build, checked against nodejs.org's `SHASUMS256.txt`, in
     `~/.local/share/weevils/node`.
   - Claude Code, through Anthropic's own installer.
   - the `weevilsd` service, listening on `127.0.0.1` only.
   - a few commands in `~/.local/bin`, weevils' hooks in `~/.claude/settings.json`, and an update timer.
3. **No root for missing system tools** (git, curl, tmux, jq, python3) on Debian and Ubuntu: apt downloads your
   distribution's own signed packages as you (`apt-get download`), and they are unpacked in
   `~/.local/share/weevils/sys`, never installed system-wide. On other distributions, or if that fails, the script
   prints the exact command (for example `sudo dnf install -y tmux jq`), asks your password for that command only,
   then drops it (`sudo -k`). If nothing is missing, no password is asked. On a Mac, root is needed only for
   Homebrew's own installer, when Homebrew is missing.
4. When run as root (that is how a fresh server starts it), it creates a regular user with passwordless sudo and
   installs as that user. Agents on a server of their own install and configure things themselves.

The install never sends your files, code, conversations, keys or passwords anywhere. It never opens a port on your
router or firewall, and it never runs anything from the setup service that the release key didn't sign.

## What leaves your machine

- **During the install**, to the setup service: the installer's step names (from a fixed list), your weevils'
  address, its version, and the login link sealed with a key that only your open setup page holds (RSA-OAEP). The
  setup service can't read your access code.
- **At your first login**, once: a "claimed" signal, so the setup service stops keeping your sealed link.
- **Updates**: every 20 to 30 minutes, weevils asks the setup service for its current version. When there is a newer
  one, it downloads the bundle and checks its signature with the release key of the version you already run. It
  installs the bundle only if the signature checks. Turn updates off with `--no-auto-update` at install time, in the
  app's settings, or with `weevils config set WEEVILS_AUTO_UPDATE 0`. They then stop entirely.
- **The setup page** counts visits anonymously: counters only, no cookie, no IP address kept, deleted after 90 days.

Nothing else. Your agents talk to Anthropic and OpenAI the way Claude Code and Codex always do.

## Releases and the signing key

Each code snapshot served to installs and updates is signed with weevils' release key:

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFpRTm2M0I5A8YHEqefdBacmjGeN63IR89ejA549gLz/ weevils-release
SHA256:2rMC745nllRyT+6YeUVOV25xgD5yGe8nxNNOM5ThEnw
```

It is also in `get/release-key.pub` and at https://get.scarville.tech/release-key.pub. To check a bundle by hand:

```sh
curl -fsSLO https://get.scarville.tech/weevils.bundle && curl -fsSLO https://get.scarville.tech/weevils.bundle.sig
printf 'weevils-release %s\n' "$(curl -fsSL https://get.scarville.tech/release-key.pub)" > allowed
ssh-keygen -Y verify -f allowed -I weevils-release -n weevils-release -s weevils.bundle.sig < weevils.bundle
```

The key signs on the machine that serves the setup page, so it protects the code between that machine and yours. It
does not protect against that machine itself being taken over; there the key belongs to a dedicated user that only
signs, so the sessions and automations running on that machine cannot read it. A bundle is published only after the
tests pass on it, and an install refuses a bundle that is unsigned or older than the one it runs. The code is public at https://github.com/Sc4rville/weevils-oss: each bundle (one commit « weevils <rev> ») is
published there with the same message, after a secret scan, so what you install is what you can read.

## Remove it

```sh
~/weevils/install.sh --uninstall --purge && rm -rf ~/weevils
```

That stops and removes the service, the phone link, the update timer, the commands, and the hooks in
`~/.claude/settings.json`. Node.js links in `~/.local/bin` go too. `--purge` also removes weevils' settings and data, Node.js's files in
`~/.local/share/weevils/node` included. Claude Code stays, since you may use it without weevils.

## Reporting a problem

Please report vulnerabilities privately, not in a public issue: GitHub's private vulnerability reporting on
https://github.com/Sc4rville/weevils-oss, or a direct message to @weevilscode on X.
