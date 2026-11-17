# Installing weevils for your user

You are an AI agent (Claude Code, Codex…) and your user asked you to install weevils, for example
"install https://github.com/Sc4rville/weevils". Follow these steps in order. Everything runs without questions;
your user hears from you once, at the end, unless a step below says to ask. Got this file through a web fetch or a
summary? Clone first (step 2), then read `AGENTS.md` from the clone in full: step 7 matters as much as the install.

(Asked to work on weevils' code instead? Skip this file and read [CONTRIBUTING.md](CONTRIBUTING.md).)

What it is, for your final message: weevils is an app on the user's phone to watch and drive the Claude Code and
Codex sessions running on this machine, with an assistant called weevboss at the top.

## 1. Check the machine

- `uname -s` must print `Linux` (a VPS, a home server, a desktop, or WSL2 on Windows) or `Darwin` (a Mac, Apple
  Silicon or Intel). Anything else: stop, tell the user weevils runs on Linux and macOS, and install nothing.
- A regular user with sudo is best. Root works, but agents then keep their permission prompts. On a Mac: the user's
  own account, never root and never `sudo` in front of the installer (it refuses).
- Install nothing yourself first: the installer adds what is missing (git, tmux, jq, Node.js 22, Claude Code…). On a
  Mac it takes them from Homebrew, and installs Homebrew too when it is missing, on Apple Silicon only: Homebrew no
  longer installs on Intel Macs, so there the installer stops (`status=failed`) and names the missing tools. Tell the
  user, in plain words, they can come from MacPorts or an existing Homebrew, then run the installer again.

## 2. Get the code

Already inside a clone (`install.sh` and `server/` next to this file)? Stay there. Otherwise:

```sh
git clone https://github.com/Sc4rville/weevils ~/weevils && cd ~/weevils
```

If `~/weevils` already exists, `cd ~/weevils`: the installer updates it. Use `git clone`, not `curl | bash`.

On a Mac where `xcode-select -p` fails, git is not installed yet (calling it only opens a dialog). Skip the clone
and, in step 4, start the installer with this line instead: it brings git and clones into `~/weevils` itself.

```sh
nohup sh -c 'curl -fsSL https://raw.githubusercontent.com/Sc4rville/weevils/main/install.sh | bash -s -- --agent --lang <fr|en> [options from step 3]' > ~/weevils-install.log 2>&1 &
```

## 3. Pick the options

- `--lang fr` if the user writes to you in French, else `--lang en`.
- `--name <first name>` only if you know it for sure (they told you). Never ask just for this.
- How the phone reaches the machine, at most one, only when you know it applies:
  - `--domain <host>`: the user told you about a domain that points to this machine (HTTPS through Caddy; needs sudo
    and ports 80/443 open).
  - `--url <https://…>`: something else already serves HTTPS to this machine and forwards to weevils' port, 4179
    (Tailscale serve, their own reverse proxy).
  - The user gave you an `https://` address and you can't tell which? `curl -sI <address>`: if it already answers,
    even with an error like 502, something serves HTTPS there: `--url`. If the name points to this machine and
    nothing answers yet: `--domain`.
  - `--lan`: the user wants plain http on their home Wi-Fi. Never on a VPS.
  - none: fine, step 6 decides.
  - On a Mac, never `--domain`: it sets up Caddy, on Linux only, and the installer refuses it. An address that
    already answers is `--url`; otherwise none.
- A re-run keeps the earlier settings: pass only what changes.

## 4. Run the installer

`--agent` means: no questions, no colours, sudo only when it needs no password (never a prompt that hangs), and a
summary block at the end. It takes 2 to 10 minutes on a blank machine, longer than most tool timeouts, so run it in
the background:

```sh
cd ~/weevils && nohup ./install.sh --agent --lang <fr|en> [options from step 3] > ~/weevils-install.log 2>&1 &
```

Then wait for the summary, in checks of under a minute each, until the log ends with `--- end ---`:

```sh
for i in 1 2 3 4 5 6 7 8 9 10; do grep -q "^--- end ---" ~/weevils-install.log && break; sleep 5; done; tail -n 45 ~/weevils-install.log
```

The summary is `key=value` lines between `--- weevils summary ---` and `--- end ---`:

| key | meaning |
|---|---|
| `status` | `ok`, `needs_sudo` or `failed` (then `error` says why) |
| `url`, `code`, `link` | the address the phone opens, the access code, and the login link `<url>/#k=<code>` |
| `mode` | `public` (HTTPS from anywhere), `lan` (same Wi-Fi, http), `local` (this machine only) |
| `https`, `port` | `yes`/`no`; the local port weevils listens on (127.0.0.1) |
| `ready` | `yes` when Claude Code is installed and logged in |
| `claude_installed`, `claude_logged` | Claude Code (required: weevboss runs on it) |
| `codex_installed`, `codex_logged` | Codex (optional) |
| `gh_installed`, `gh_logged`, `gh_login` | GitHub CLI (optional) |
| `projects` | Claude Code projects with a session in the last 3 days: the app shows them at once |
| `projects_all`, `repos` | all Claude Code projects; git repos in `~/projects` |
| `tailscale`, `tailscale_name` | Tailscale installed; this machine's `…ts.net` name when it is connected |
| `os`, `arch` | `linux` or `macos`; the processor (`x86_64`, `arm64`…) |
| `service` | `systemd`, `launchd` (a Mac) or `background` (no service manager reachable, e.g. a Mac over SSH with no session open on its screen: weevils runs until the next restart) |
| `laptop`, `wsl`, `sudo` | `yes`/`no`; `sudo` is `yes`, `password` (you can't use it) or `no` |
| `qrencode` | `yes` when you can draw a QR code (step 7); on a Mac it may be in `/opt/homebrew/bin`, outside your PATH |
| `needs`, `retry` | with `needs_sudo` only: what needs root, and the command that does it all from a terminal |
| `handoff` | the file weevboss reads (`weevils setup`) to pick up where you stopped (`~/.local/share/weevils/install.json`) |
| `next` | what to do now: steps 6 and 7 below |

- `status=needs_sudo`: sudo wants a password you can't type. Ask the user, in one sentence, to run the `retry`
  command once in a terminal of their own (it asks for their password and finishes the install), then tell you.
  This is the only command you ever give them. When they are done, run step 4 again to get the summary.
  On a Mac it means Homebrew is missing (`needs=Homebrew`): its own installer asks for the Mac password. Same
  answer, the `retry` command in the Terminal app, as it is: never with `sudo` in front.
- `status=failed`: read `error` and the lines above it. Fix the cause if it is clearly yours to fix, run once more,
  otherwise tell the user what went wrong in plain words.

## 5. Don't redo what's ready

Trust the summary; don't re-check by hand.

- `claude_logged=yes`: Claude Code works, leave it alone. `no`: the user has to log in once (a browser login you
  can't do for them): ask them to type `claude` in a terminal and follow the steps.
- Codex and GitHub are optional: don't install them or log in for the user. weevboss offers them in the app later.
- `projects` and `repos` are already in the app: say so in your final message.

## 6. Phone access

From `mode`:

- `public`: done, the link works from anywhere.
- `lan`: works on the same Wi-Fi only (no microphone, no notifications over http).
- `local`: the phone can't reach it yet. In this order:
  1. `tailscale_name` is set: run `sudo -n tailscale serve --bg <port>` (or `tailscale serve --bg <port>` if the user
     is the Tailscale operator, and always on a Mac: no sudo there), then step 4 again with
     `--url https://<tailscale_name>`. The phone needs the Tailscale app, logged in to the same account.
  2. Otherwise (on a Mac: see below) ask the user exactly one plain question, and nothing else: "To open it on your
     phone, weevils needs a way in: do you have a domain name pointing to this machine, or should I set up Tailscale
     (free: a private link between your phone and this machine)?" Don't offer the other ways in printed by the
     installer (home Wi-Fi, SSH tunnel): they are for people at a terminal. When the user answers, do the work
     yourself:
     - a domain: step 4 again with `--domain <host>` (HTTPS is set up for them).
     - Tailscale: `curl -fsSL https://tailscale.com/install.sh | sh` and `sudo tailscale up` (both need sudo without
       a password; otherwise this is a `retry`-style command for the user). `tailscale up` prints a login link: give
       it to the user, wait until they say it's done, then do 1. If `tailscale serve` prints a link to enable HTTPS
       on their tailnet, give them that link too.
  3. Nobody to answer (a one-shot run): set nothing up, end with that question.

  On a Mac (`os=macos`), 2 is different: there is no domain to offer, and Tailscale is an app the user installs.
  - The app may be there without its command in the PATH: the installer finds it, and you call it as
    `TAILSCALE_BE_CLI=1 /Applications/Tailscale.app/Contents/MacOS/Tailscale` in place of `tailscale`. If `tailscale status` succeeds, it is
    signed in: do 1, and with an empty `tailscale_name`, give `--url` the `https://…ts.net` address that
    `tailscale serve` prints.
  - Otherwise the one question is: "To open it on your phone, weevils needs Tailscale (free: a private link between
    your phone and this Mac). Can you install it from https://tailscale.com/download/mac and sign in?" A link, never
    a command. Wait until they say it's done, then do 1 the same way. If `tailscale serve` prints a link to enable
    HTTPS on their tailnet, give them that link too.

## 7. The final message

This message is your whole final reply, from its first line ("It's installed!") to its last: no status line or
preamble before it ("the install worked, here is the message"), no `---` separators, no recap of the steps you ran.
Your user may not be technical: write it like a friend who just set something up for them, in their
language, short (about 6 lines plus the link), in this order:

1. It's installed (if `ready=no`, the one thing left, step 5).
2. The link to open on the phone, `link` from the summary, on its own line. It contains their access code: say it
   works like a password, in a few words.
3. A QR code, when `mode` is `public` or `lan` and `qrencode=yes`: run `qrencode -t UTF8 -m 2 '<link>'` and paste
   its output unchanged in a code block. Never draw or retype a QR code yourself.
4. Add it to the home screen: iPhone: Share → Add to Home Screen; Android: ⋮ → Install app.
5. What's already there, when `projects` > 0 ("your 12 Claude Code projects are already in it"), and the first thing
   to try: open the app and write to weevboss, in the field at the top, "what are my projects up to?" when
   `projects` > 0, otherwise "make me a small notes app".

With `mode=local`, 2 to 4 become the question from step 6 (on a Mac, the Mac one), then "once that's done, I'll give
you the link for your phone"; still give the link, as one that already works in a browser on this machine, and
keep 5.

Never in this message: commands, file paths, port numbers, IP addresses, settings names (`WEEVILS_*`), options,
"localhost" or "127.0.0.1" explanations, the installer's technical notes (PATH, permission prompts, SSH tunnels).
weevboss explains the rest inside the app.

Template (English, public):

> weevils is installed! On your phone, open this link (it logs you in, so keep it to yourself like a password):
>
> https://weevils.example.com/#k=AbC123xyz
>
> *(QR code)*
>
> Then add it to your home screen (iPhone: Share → Add to Home Screen; Android: ⋮ → Install app).
> Your 12 Claude Code projects are already in it. To start, write to weevboss at the top: "what are my projects up to?"

Template (French, local):

> C'est installé ! Il reste une chose pour l'ouvrir sur ton téléphone : weevils a besoin d'un chemin jusqu'à cette
> machine. Tu as un nom de domaine qui pointe vers elle, ou je mets en place Tailscale (gratuit : un lien privé entre
> ton téléphone et cette machine) ?
>
> Dès que c'est fait, je te donne le lien pour ton téléphone. En attendant, il marche déjà dans un navigateur sur
> cette machine (il te connecte, garde-le pour toi comme un mot de passe) : http://localhost:4179/#k=AbC123xyz
>
> Pour commencer, écris à weevboss en haut : « fais-moi une petite app de notes ».

## Don't

- Leave a sudo prompt hanging: use `sudo -n`; when it needs a password, see `needs_sudo` above.
- Print, log or repeat secrets: the access code, keys in `~/.config/weevils/env`, tokens. The one exception is the
  login link, once, in your final message.
- Edit `~/.claude/settings.json` or `~/.config/weevils/env` by hand: the installer adds the hooks and settings.
- Change systemd units, launchd agents, crontab, Caddy or the firewall beyond what the installer does; start weevils
  by hand.
- Run `./install.sh` without `--agent`: it would wait for answers or take every question as no.
