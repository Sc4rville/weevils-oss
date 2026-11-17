# get — the public way in

`https://tryweevils.scarville.tech` (the link to share; `https://get.scarville.tech` serves the same): someone sees a
link, opens it on a phone or a computer, and ends up on their own weevils without typing anything (or, for a computer,
by pasting one command in its terminal). Open to anyone since 2026-11-14, with one link for everyone. Pasted on
Twitter/X, iMessage or WhatsApp, it shows a share card (Open Graph and Twitter tags in `index.html`; the image,
`og.png`, 1200×630, comes from Sc4rville/weevils-content, `productions/og/weevils-og-ask.png`, and its URL carries
`?v=<first 8 characters of its sha256>` so that X fetches the new card when it changes).

1. A short page (English by default, a small FR switch) says what weevils is, then right away: **plug in your
   machine** ("a server keeps your agents working while your phone and computer are off").
   - On a phone: exactly three machines: a server created for you at Hetzner (recommended, for agents that run
     24/7), your own VPS (rented anywhere), or your own computer (Mac, Linux, or Windows with WSL).
   - On a Mac, Linux or Windows (WSL) computer: connect this computer here and now (one command), with a nudge
     toward a VPS ("your agents keep working with this computer off").
2. **Create a server for me** at **Hetzner**: the person creates an account and an API token (links on the page),
   pastes the token in a masked field, then picks one of three sizes with the real prices from Hetzner's API: light
   (4 GB, 2 to 3 agents), recommended (8 GB, about 6), strong (16 GB, about a dozen; a Claude Code session takes up
   to about 1 GB). Hetzner offers no OAuth to third parties: a token is the only way. Since 2026-11-17 the token never
   leaves the person's browser except toward Hetzner: the page calls Hetzner's API itself (`get/hetzner.js`; Hetzner
   allows it, CORS), creates the server with the cloud-init this service gave the setup (`userData` in the
   `POST /api/job` answer: it only runs `/i/<sid>`), then tells this service just the server's id, address and size
   (`POST /api/hetzner/created`). (Hostinger was offered too
   until 2026-11-14; dropped as one option too many. A VPS rented there goes through "I already have a VPS".)
   - Hetzner: the cheapest x86 type of each size near the person, Ubuntu 24.04, a cloud-init that runs the install.
     Hetzner bills by the hour: each size shows its real hourly price and its monthly cap ("€0.0115/h · max
     €7.19/month"), VAT included, with the server's IPv4 address that Hetzner bills on top of the type (`GET /pricing`),
     and the button says "billed by the hour". Sign-up asks for an ID check (a photo of an ID and a selfie, through iDenfy), then a manual review: the page says
     so under the option and on the account step, so nobody is surprised.
   **I already have a VPS**: first, the same one-line command as a computer, to paste in a terminal on the server (as
   root or a sudo user): no secret goes anywhere; its first request (`/i/<sid>.env`) starts the setup, and the
   address it comes from names the machine (`<ip>.sslip.io`; from an address the Internet can't reach, it is set up
   like a computer, with a link of its own). That is the whole screen: since 2026-11-17 there is no IP/password form
   any more (people's AI assistants rightly refused to send a root password to a third party).
   **My computer** (Mac, Linux, or Windows with WSL): `curl -fsSL https://get.scarville.tech/install.sh | bash -s <id>`
   in its terminal. Since 2026-11-15 that script is the same file for everyone (`/install.sh`, its SHA-256 at
   `/install.sh.sha256`), opens with a plain « what it does / never does / the code it runs / undo in one line » header,
   and reads the setup's settings from `/i/<id>.env` as checked values: people's own AI assistants refused the old
   per-setup URL (unverifiable, looked like it could differ per person). Servers still use `/i/<id>`. On Windows the page shows `powershell -c "irm https://get.scarville.tech/w/<id> | iex"` instead (it works
   from PowerShell, cmd and Git Bash alike): it runs the same install in WSL's first Linux, or tells the page and the
   terminal that WSL is missing (a phone shows both commands). Until 2026-11-15 Windows got the bash command: pasted in
   PowerShell or cmd it fetched the script and nothing ran, which is why no computer install had finished. Git Bash
   pasting the bash command is handed to WSL too, and a computer's failed install can be pasted again (the page keeps
   following it).

   **Safety (2026-11-17, because people's own Claude and Codex refused the install):** see `SECURITY.md`, served at
   `/security` and linked from the script, the computer step and the footer. The code bundle is signed with the
   release key (`get/make-bundle.sh` signs with `~/.config/weevils-get/release_ed25519` on this VPS; the public half
   is `get/release-key.pub`, pinned in the script). Installs and `weevils-update` refuse a bundle whose signature
   doesn't check; `/weevils.bundle.sig`, `/weevils.bundle.sha256` and `/release-key.pub` are public. On a computer:
   - Node.js goes in the home folder: the official build, checked against nodejs.org's SHA-256.
   - Missing system tools come from the distribution's own packages, unpacked in the home folder
     (`apt-get download`, no root). Elsewhere, one shown `sudo` command, then `sudo -k`.
   - cloudflared is checked against GitHub's published digest.
   - Agents keep their permission prompts (`--ask-permissions`).
   - Options after the id: `--no-link`, `--no-auto-update`, `--no-permission-prompts`.

   `follow-main.sh` rebuilds (and signs) the bundle before restarting the service.
3. A live progress screen follows the install (the installer's step names). Its address is the setup's resume link:
   closing the page and opening it again brings the person back here, with no button to find.
4. At the end the page shows the person's own weevils: its address, the access code, "Open my weevils", the link to
   copy (from an app's browser such as X's, the page says to open it in Safari or Chrome, where it can go on the home
   screen); a computer shows a QR code for the phone. The page no longer jumps away by itself. The existing in-app
   onboarding takes over: weevboss welcomes them and connects Claude Code or Codex through their official sign-in
   link, then the first steps.

### Coming back (the page was closed, the in-app browser forgot it)

The install runs on the person's server whatever happens to the page: a setup lives in this service, not in the page.
The page finds it again, in this order, and never shows the start screen while something is installing:

- **The address bar**: as soon as a setup exists, the page's URL is its resume link, `/#job=<sid>.<secret>` (a reload,
  or an in-app browser that reloads the tab, comes back to it). The same link opened in **any** browser gets the
  progress, then the final link: from the secret (after the `#`, never sent to a server) the page derives the token
  that opens the setup's status here, and the key that opens its own private key, which it left here sealed
  (AES-GCM). This service holds neither the secret nor anything that opens the sealed key or the sealed link.
- **This browser** (localStorage), 7 days.
- **The Hetzner token again**, on the Hetzner screen itself (there is no separate resume screen or button since
  2026-11-14): in the browser, the same account's token lists the servers weevils made there (Hetzner label
  `app=weevils`, plus `weevils-sid`); the page asks this service how far those setups are by their `weevils-sid`
  (`/api/hetzner/setups`, no token), and offers **"Continue on this one"** before any new server. A setup still
  installing is taken over by the new page, by that label (`/api/hetzner/attach`; only the account's owner can read
  it), and the install asks for the page's current key, `GET /k/<sid>`, just before it seals the link. A finished,
  stopped or forgotten one: the page asks Hetzner for a new root password (`reset_password`, from the browser) and
  shows it on the page only, with a link to Hetzner's console and this setup's command (a Hetzner setup gets a
  `command` too): the person logs in to the server's console with that password and pastes the command; its first
  request starts the setup. The install runs again (it keeps what is there) and ends with a fresh link for this page.
  A server the page created but could not report (closed right after) is reported then.
- **Going back** is the phone's own gesture (or the browser's arrow): each step is an entry in the browser's history
  (`#hetzner`, `#vps`, `#computer`), and the page has no Back button, resume screen or restart link of its own. Going
  back and forth keeps what was typed (the token, password and key in memory only; the address, user and port in this
  browser). A step already done is never offered again: back during an install, or after it, lands on that install.
  Before any setup exists, the step picked is also kept for a day, so coming back from Hetzner's own pages (sign-up, ID
  check, console: native screens this page can't follow) lands on the token field again.
- **One way on after a failure**: the sizes come as soon as the token is pasted; a refused token shows one "Try
  again"; a stopped install,
  a stalled one, or a final link this browser can't open shows one "Try again", which goes back to the token (Hetzner),
  the VPS access, or the computer's command.
- **Never a second server without asking**: when the token's account already has a weevils server, the page offers to
  continue on it, and creating another takes a tap on "Create another server anyway" (`another: true`; without it,
  `POST /api/<host>/create` answers `409 exists` with the list). Two taps, or a page reopened during the call, make
  one server (`409 creating`).

A finished setup is kept 7 days, with its sealed link, until an hour after the first login on the new weevils: the
bootstrap leaves `~/.local/share/weevils/get-claim` (this service's `/r/<sid>`), and the new weevils posts `claimed`
there once, at its first login, then deletes the file (`server/get-claim.ts`); nothing else ever goes back. The hour
covers a first login made in a browser that is then lost (an in-app browser).

Where the new weevils is reached:

| path | address | HTTPS |
|---|---|---|
| Hetzner, own VPS | `https://<ip-with-dashes>.sslip.io` | Caddy + Let's Encrypt, set up by `install.sh --domain` |
| computer | `https://<random>.trycloudflare.com` | Cloudflare quick tunnel (no account); the address changes if the computer restarts. weevboss can set up a lasting one (Tailscale, a VPS) |

### On a Mac

Same command, same screens. `get/bootstrap.sh` is written for macOS's own bash (3.2) and BSD tools, and differs from
Linux in four places:

- **As yourself, never root.** `sudo curl … | bash` stops with a sentence saying so (Homebrew refuses root, and the
  root path creates a Linux user).
- **Homebrew first.** Everything weevils needs on a Mac comes from Homebrew, installed as the person. When it is
  missing, the script asks for the Mac password once in the terminal (`sudo -v`, kept fresh while it runs) and runs
  Homebrew's official installer without questions, before anything else: that installer also brings Apple's Command
  Line Tools, which git needs to get the code (without them `/usr/bin/git` only opens a dialog). With Homebrew already
  there, no password is asked at all. No way to type one (no terminal) and no Homebrew: it stops and says so.
- **The link is a launchd agent**, `~/Library/LaunchAgents/com.github.sc4rville.weevils-link.plist`, loaded in the
  session opened on the Mac's screen (`gui/<uid>`), started at login and restarted if it stops, where Linux has the
  systemd user unit `weevils-link`. cloudflared comes from Homebrew (else from its release archive). Its log is the
  same file, `~/.local/share/weevils/link.log`. Reached over SSH with no session on the screen: a plain background
  process and no agent file, like on a Linux without systemd. `install.sh --uninstall` removes the agent.
- **The link is sealed with Node first** (`crypto.publicEncrypt`, RSA-OAEP, SHA-256), then `openssl` if that fails:
  the openssl macOS ships is LibreSSL, which may not know the OAEP options. Linux tries them the other way round.

## Security

- **Nothing stored.** Setups live in memory (one that never started: 6 hours; creating or installing a server: a day
  after its last sign of life; finished: 7 days, its sealed link until an hour after the first login there); no
  database, no file: a restart hands them to the next run through a file in RAM (`/dev/shm`, mode 600). Request
  bodies are never logged (Caddy logs the paths only, setup ids masked).
- **The Hetzner token never reaches the service.** The page uses it from the browser, toward Hetzner only (the
  page's CSP allows `connect-src` to itself and `https://api.hetzner.cloud`, nothing else), and clears it once the
  server exists. No route of the service accepts a token.
- **No password or key either.** No route takes one, and this service runs no `ssh` (since 2026-11-17): a machine
  installs itself with the command pasted in its own terminal. The root password Hetzner returns when it creates a
  server is discarded in the browser; the one it gives for a lost setup is only shown on the page.
- **No access, ever.** The service never has an SSH key, a password, a token or a tunnel. The new weevils is served by the
  person's machine itself; nothing is proxied through this service.
- **The access code never reaches the service.** The page generates an RSA-OAEP key pair (WebCrypto); the install
  encrypts the login link with the public half (`openssl pkeyutl`, or Node's `crypto`), and the service only relays the ciphertext. Only
  a page holding the private half can open it: the one that started the setup, a page opened with its resume link
  (the private half comes back sealed with a key derived from the link's secret, which never reaches the service), or
  a page that took the setup over by the server's `weevils-sid` label (read with the host's token, in the browser). It only follows a link to the
  address the install reported.
- **The install reports step names only**, checked against the installer's own titles on both sides, never a line of
  its log (which holds the access code: it stays on the machine, `~/weevils-install.log`). Two steps are the
  bootstrap's own and go by name: `tunnel`, and `s_system` while it installs Homebrew on a Mac.
- **No code from visitors runs here**, and the service starts no program at all.
- **Rate limits** per client address (setups, server reports, script downloads) and per setup (reports), plus a cap
  on setups in memory.
- **Preview gate** (off since the launch; old links with `?k=` still open the page, the key is ignored): with
  `GET_PREVIEW_KEY`, the page needs `/?k=<key>` (or `/#k=<key>`) in its URL, and its API calls carry the key in a
  header: no redirect and no cookie needed (some iOS contexts drop a cookie set on a redirect). Install scripts stay
  reachable by their unguessable setup id; the page's own assets are public.

What the service has: setup ids, the page's public key and its sealed private key, step names, the address of the
machine, the sealed login link. Never a password, a key or a token, in any path.

## Anonymous stats

Counters only, one file a day in `<GET_DATA>/stats` (mode 600), deleted after 90 days; the page says so in one line.

- **Visits and visitors.** The page sends a beacon when it opens (`/api/hit`; no cookie, no identifier). A visitor is
  told apart for one day by a hash of their address and browser with a salt that only lives in memory and changes every
  day: neither the hashes nor the salt are written. Bots, link previewers, this server's own traffic and private
  addresses (2.24.59.87, 127.*, 172.*) are not counted.
- **Where from**: the app it was opened in, else the referring site's address (its origin only); iMessage and WhatsApp
  send none and count as « direct ». **Where the link was pasted**: the link-preview fetches (WhatsApp or Signal,
  iMessage, Twitter/X, Telegram, Slack…). **Device**: from the browser's name. **Country**: from the page's time zone
  and the system's tz database, never from the address, without any outside service.
- **The funnel**: page opened → option picked (Hetzner, own VPS, computer) → install started (server
  created, VPS connected, script fetched) → installed (the install's last report) → the phone opened its weevils.
  **Code downloads**: by installs, and by installed weevils updating themselves.
- **The install register**, `<GET_DATA>/installs.csv`, appended and never rewritten: time, how (Hetzner,
  own VPS, computer; Hostinger in older lines), rough country, the version installed, a random id tied to nothing, and whether the line was rebuilt
  from Caddy's log. Kept for good, with the records (best day for visits and for installs, `records.json`), and backed
  up every day in the private repository Sc4rville/weevils-stats (`get/backup-stats.sh`, the `weevils-get-backup` timer).
- **Where to see it**: the private page `/stats/<GET_STATS_KEY>` (records first, the funnel, sources, devices,
  countries, previews, the register and its CSV, the days); `node get/stats.mjs [days] | --csv | --json`; and in the
  weevils of this machine, « for you » (with `GET_NOTIFY`): a word at each successful install (« Someone just installed
  weevils via Hetzner. ») and the day's numbers once it is over.
- **« N people already run weevils »** on the page: off unless `GET_PUBLIC_COUNT=1` (N is the register's length).
- **The days before**: `sudo cat /var/log/caddy/get.log | node get/backfill.mjs` rebuilds them from Caddy's log, with
  the same exclusions (no country or final switch there). Caddy's log itself keeps no address or header since
  (`format filter` in the site).

## Run

```sh
GET_PORT=4182 GET_BASE=https://get.scarville.tech node get/server.mjs
```

| env | meaning |
|---|---|
| `GET_BASE` | public URL of this service (used in the install command and cloud-init) |
| `GET_PREVIEW_KEY` | gate everything behind `/?k=<key>` (unset on scarville.tech since the launch) |
| `GET_REPO` | the repository installs clone (default GitHub) |
| `GET_BUNDLE` | while the repository is private: a bundle built by `get/make-bundle.sh [<rev>] [<out>] [<checkout>]` (one squashed commit, no history), kept on `origin/main` by `get/refresh-bundle.sh` (the `weevils-get-bundle` timer, every 2 min). It is what every install gets, so it must hold the installer that supports macOS; the file is read at each download, replacing it needs no restart |
| `GET_INSTALLER` | the `install.sh` the allowed step titles are read from, at start (default: this clone's). Same titles as the bundle's |
| `GET_HETZNER_API` | Hetzner's API base (tests: `get/host-mock.mjs`) |
| `GET_ALLOW_TARGETS`, `GET_TARGET_URLS` | tests only: a private machine address accepted, and the URL its weevils gets (`ip=url`) |
| `GET_DATA` | where the stats, the install register and the records are kept (default `~/.local/share/weevils-get`) |
| `GET_STATS_KEY` | the private stats page, `/stats/<key>` (off without it) |
| `GET_NOTIFY` | the weevils on this machine (`http://127.0.0.1:4179`): a word in its « for you » at each install and each day |
| `GET_PUBLIC_COUNT` | `1`: « N people already run weevils » on the page (off by default) |
| `GET_CODE_URL` | the public repository the page links to once GitHub says it is public (default `github.com/Sc4rville/weevils-oss`) |
| `GET_HANDOFF` | the RAM file a stopping service hands its setups in progress to the next one through (default `/dev/shm/weevils-get-<uid>.jobs`; empty: none) |

On scarville.tech: systemd user unit `weevils-get`, env in `~/.config/weevils-get/env`, Caddy site
`/etc/caddy/sites/get.caddy` for both `get.scarville.tech` and `tryweevils.scarville.tech` (explicit `127.0.0.1`, so
the dev-server reaper leaves it alone; `lb_try_duration` holds requests while the service restarts).

It follows main by itself: the service runs from a checkout of its own, `~/.local/share/weevils-get/live` (a worktree
detached at `origin/main`), and the `weevils-get-bundle` timer runs `get/follow-main.sh` from it every 2 minutes. That
moves the checkout to the new main, restarts the service only when what it reads at start changed (`get/server.mjs`,
`get/bootstrap.sh`, `install.sh`; the page and its assets are read at each request), and rebuilds the bundle. A
restart cuts nothing: on SIGTERM the service stops taking connections, lets its requests finish (a server being
created; 20 s at most), then hands its setups in progress to the next run through RAM.

## Tests

- `npx vitest run get/`: API, a Hetzner double (sizes, prices, payment method, purchase body), the
  bootstrap's real `openssl` encryption opened like the page does, guards (preview gate, SSRF, step allowlist, rate
  limits). For a Mac: the script read by bash 3.2 (the `bash:3.2` Docker image when it is there), the page's first
  screen for a Mac, Linux and iPhone browser (happy-dom), the bootstrap's two ways of sealing the link (its own shell
  functions, Node and openssl) opened with WebCrypto like the page.
- `get/test-macos.sh`: the Mac branches of the bootstrap on Linux. The served script runs under bash 3.2 (Docker) on
  a fake Mac: stand-ins for `uname`, `sudo`, `xcode-select`, `git`, Homebrew's installer, `brew`, `launchctl`,
  `cloudflared` and `install.sh`, and guards that stop the run on a GNU-only flag or a tool macOS lacks. Four
  scenarios against a real `get/server.mjs`: a new Mac in a terminal (password once, Homebrew before git, launchd
  agent, link sealed and opened), root, no terminal for the password, a Mac over SSH where nothing can seal the link.
  It proves the order and the shell, not Homebrew, launchd, sudo or the BSD tools themselves.
- `node get/e2e-mac.mjs` (`WVGET_SOURCE=<checkout>` or `WVGET_BUNDLE=<file>`): the same path for real, on a Mac, with
  no browser: a local service, a setup created like the page does, the command run with `/bin/bash`, the real
  installer, a real quick tunnel, then the sealed link opened and the new weevils logged in to. For a macOS runner
  of GitHub Actions; `--dry` stops before the command.
- `node get/e2e.mjs vps|pc|hetzner …`: drives a real setup through the API exactly like the page (key pair, polling,
  unsealing, then logs in to the new weevils with the unsealed code). Verified on 2026-11-13:
  - own VPS: the `essai` machine (`essai reset`), the command run there over SSH (by the tester, as the person would);
  - computer: a plain Ubuntu 24.04 Docker container (no systemd), command pasted, Cloudflare link;
  - Hetzner: `get/host-mock.mjs`, whose "boot" resets `essai` and runs there, as root, what Hetzner
    would (cloud-init's runcmd);
  - the page in real iPhone WebKit (Playwright `webkit` in the `mcr.microsoft.com/playwright` image: Ubuntu 26.04
    has no WebKit build): gate by `?k=` and `#k=`, reload, language switch, size picker.
