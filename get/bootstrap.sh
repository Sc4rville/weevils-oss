#!/usr/bin/env bash
# weevils — installer started from the setup page, https://tryweevils.scarville.tech. The same file for everyone:
# https://get.scarville.tech/install.sh (SHA-256: https://get.scarville.tech/install.sh.sha256). Full security notes:
# https://get.scarville.tech/security (SECURITY.md). Written for bash 3.2 and BSD tools as well as Linux.
# Usage: curl -fsSL https://get.scarville.tech/install.sh | bash -s <setup id> [--no-link] [--no-auto-update]
#        [--no-permission-prompts]
# The setup id only lets this script tell the page that opened it how far the install is.
#
# WHAT IT IS: weevils lets you watch and drive the Claude Code / Codex sessions of this machine from your phone. Its
# agents run HERE, as you, with your files. On a computer they ask before acting (you answer from the app); on a
# rented server, which the setup page recommends and creates at Hetzner, they act without asking.
#
# WHAT IT DOES, as you, in your home folder:
#   1. Downloads the weevils code, checks its signature against the release key pinned below (refused if it does not
#      check), puts it in ~/weevils and runs its installer, ~/weevils/install.sh --agent. That adds Node.js 22 (the
#      official build, checked against nodejs.org's SHA-256 list, in ~/.local/share/weevils/node) and Claude Code
#      (Anthropic's installer) if missing, a background service (weevilsd, on 127.0.0.1 only), a few commands in
#      ~/.local/bin, its hooks in ~/.claude/settings.json, and a timer that installs new signed versions (opt out:
#      --no-auto-update, or in the app's settings).
#   2. System tools that are missing (git, curl, tmux, jq, python3): on Debian/Ubuntu, apt downloads your
#      distribution's own signed packages as you (apt-get download) and they are unpacked in
#      ~/.local/share/weevils/sys, never installed system-wide: no root, no password. Elsewhere, or if that fails, it
#      shows the one command ("sudo dnf install -y tmux jq") and asks your password for that command alone, then
#      forgets it (sudo -k). On a Mac: Homebrew's own installer, only if Homebrew is missing.
#   3. A computer: opens an HTTPS link so your phone can reach weevils from anywhere (a Cloudflare quick tunnel to
#      127.0.0.1, user service weevils-link; cloudflared from Cloudflare's GitHub release, checked against the
#      SHA-256 GitHub publishes). Only weevils' own app is reachable there, behind your access code (72
#      random bits). --no-link: no link, weevils stays on this machine (reach it later through Tailscale, say).
#   4. Tells the setup page how far it is: step names only, then your weevils' address; the login link is sealed with
#      a key only your open page holds, so the setup service never sees your access code.
#   Run as root (that is how a fresh server starts it): it installs for a regular user with passwordless sudo.
#
# WHAT IT NEVER DOES: send your files, code, conversations or keys anywhere; open a port on your router or firewall;
# keep a password; run anything from the setup service that is not signed by the release key.
#
# THE CODE IT RUNS, to read before: https://github.com/Sc4rville/weevils-oss (public). Each code bundle served to
# installs (/weevils.bundle, one commit « weevils <rev> ») is published there as the same commit message, after a
# secret scan. Its signature: /weevils.bundle.sig (check with ssh-keygen -Y verify and /release-key.pub); SHA-256:
# /weevils.bundle.sha256.
#
# UNDO, in one line:  ~/weevils/install.sh --uninstall --purge && rm -rf ~/weevils
# The installer's full log stays here, in ~/weevils-install.log.
set -euo pipefail

# The whole script is one function, called on the last line: a download cut short runs nothing.
_weevils_get() {
  BASE=@BASE@ SID=@SID@ UI_LANG=@LANG@ MODE=@MODE@ REACH=@REACH@ REPO=@REPO@ BUNDLE=@BUNDLE@
  PUB=@PUB@
  # The shared copy (get.scarville.tech/install.sh): the setup id comes as the argument, and this setup's settings
  # are read as plain values, checked one by one (nothing fetched here is run).
  # Options after the setup id: --no-link (no public link for the phone: weevils stays on this machine only),
  # --no-auto-update (never fetch a new version by itself), --no-permission-prompts (a computer's agents act without
  # asking, as on a server).
  local opt link=1 extra=() prompts=1
  for opt in "${@:2}"; do
    case $opt in
      --no-link) link=0 ;;
      --no-auto-update) extra+=(--no-auto-update) ;;
      --no-permission-prompts) prompts=0 ;;
    esac
  done
  if [ -z "$SID" ]; then
    SID=${1:-}
    [[ $SID =~ ^[a-z2-9]{10}$ ]] || { printf '  weevils · usage: curl -fsSL %s/install.sh | bash -s <setup id from the page>\n' "$BASE" >&2; exit 1; }
    local kv k v
    kv=$(curl -fsS -m 30 "$BASE/i/$SID.env") || { printf '  weevils · this setup link has expired: open the setup page again.\n' >&2; exit 1; }
    while IFS='=' read -r k v; do
      case $k in
        lang) [[ $v =~ ^(en|fr)$ ]] && UI_LANG=$v || true ;;
        mode) [[ $v =~ ^[a-z]{1,8}$ ]] && MODE=$v || true ;;
        reach) [[ $v =~ ^[A-Za-z0-9.:/_-]{0,200}$ ]] && REACH=$v || true ;;
        pub) [[ $v =~ ^[A-Za-z0-9+/=]{200,800}$ ]] && PUB=$v || true ;;
      esac
    done <<<"$kv"
    [ -n "$MODE" ] && [ -n "$PUB" ] || { printf '  weevils · this setup link has expired: open the setup page again.\n' >&2; exit 1; }
  fi
  # The installer's step titles, the only lines that leave this machine.
  TITLES=@TITLES@
  OS=$(uname -s)

  say() { printf '  weevils · %s\n' "$*"; }
  report() { curl -fsS -m 20 -o /dev/null -X POST "$BASE/r/$SID" "$@" 2>/dev/null || true; }
  event() { report --data-urlencode "event=$1" ${2:+--data-urlencode "step=$2"}; }
  fail() {
    report --data-urlencode event=failed --data-urlencode "error=$(printf '%s' "$1" | tr '\n' ' ' | cut -c1-300)"
    printf '  weevils · %s\n' "$1" >&2
    exit 1
  }

  case $OS in
    Linux | Darwin) ;;
    # Windows' own bash (Git Bash, MSYS2, Cygwin): the same install, handed to the first Linux of WSL.
    MINGW* | MSYS* | CYGWIN*)
      local d=''
      ! command -v wsl.exe >/dev/null 2>&1 || d=$(wsl.exe -l -q 2>/dev/null | tr -d '\000\r' | grep -v '^docker-desktop' | grep . | head -1 || true)
      if [ -n "$d" ]; then
        say "installing in $d (WSL)"
        MSYS_NO_PATHCONV=1 exec wsl.exe -d "$d" -- bash -lc "curl -fsSL '$BASE/install.sh' | bash -s $SID"
      fi
      if [ "$UI_LANG" = fr ]; then fail "weevils tourne sous Linux, et ce Windows n’a pas encore Linux (WSL). Le plus simple : reviens sur la page et choisis un serveur. Sinon ouvre PowerShell en administrateur, tape wsl --install, redémarre, ouvre Ubuntu une fois, puis colle à nouveau la commande."
      else fail "weevils runs in Linux, and this Windows has no Linux (WSL) yet. Simplest: go back to the page and pick a server. Or open PowerShell as administrator, type wsl --install, restart, open Ubuntu once, then paste the command again."; fi
      ;;
    *) fail "weevils runs on Linux and macOS (a VPS, a Linux PC, a Mac, or WSL2 on Windows)." ;;
  esac

  RELEASE_KEY=@RELEASEKEY@
  # verify_bundle <file> <base>: the file is the code weevils' release key signed (namespace weevils-release).
  verify_bundle() {
    local sig allowed ok=1 v want
    sig=$(mktemp) allowed=$(mktemp)
    printf 'weevils-release %s\n' "$RELEASE_KEY" >"$allowed"
    # ssh-keygen -Y came with OpenSSH 8.1.
    v=$(ssh -V 2>&1 | sed -n 's/^OpenSSH_\([0-9]*\)\.\([0-9]*\).*/\1 \2/p')
    if [ -n "$v" ] && { [ "${v% *}" -gt 8 ] || { [ "${v% *}" = 8 ] && [ "${v#* }" -ge 1 ]; }; }; then
      curl -fsS -m 30 "$2/weevils.bundle.sig" -o "$sig" 2>/dev/null &&
        ssh-keygen -Y verify -f "$allowed" -I weevils-release -n weevils-release -s "$sig" <"$1" >/dev/null 2>&1 && ok=0
    else
      want=$(curl -fsS -m 30 "$2/weevils.bundle.sha256" 2>/dev/null | cut -d' ' -f1)
      [ -n "$want" ] && [ "$want" = "$(if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1"; else openssl dgst -sha256 -r "$1"; fi | cut -d' ' -f1)" ] && ok=0
    fi
    rm -f "$sig" "$allowed"
    return $ok
  }

  # user_debs <command>…: Debian/Ubuntu packages for these commands, and the libraries they need that this system
  # lacks, downloaded by apt as the user (signed by the distribution, checked by apt) and unpacked under $sys/root.
  # Each command gets a small launcher in $sys/bin that points it at those libraries.
  user_debs() {
    local root=$sys/root debs=$sys/debs pkgs='' p dep libdirs='' c lib
    mkdir -p "$root" "$debs" "$sys/bin"
    for c in "$@"; do case $c in python3) pkgs="$pkgs python3-minimal" ;; *) pkgs="$pkgs $c" ;; esac; done
    # The packages and every dependency not already installed here.
    for dep in $(apt-cache depends --recurse --no-recommends --no-suggests --no-conflicts --no-breaks --no-replaces --no-enhances $pkgs 2>/dev/null | grep '^[a-z0-9]' | sort -u); do
      dpkg -s "$dep" >/dev/null 2>&1 && continue
      (cd "$debs" && apt-get download "$dep" >/dev/null 2>&1) || true
    done
    for p in "$debs"/*.deb; do [ -f "$p" ] && dpkg-deb -x "$p" "$root"; done
    for lib in "$root"/lib/*-linux-gnu "$root"/usr/lib/*-linux-gnu; do [ -d "$lib" ] && libdirs="$libdirs${libdirs:+:}$lib"; done
    for c in "$@"; do
      [ -x "$root/usr/bin/$c" ] || continue
      local envs=''
      case $c in
        git) envs="GIT_EXEC_PATH=$root/usr/lib/git-core " ;;
        python3) envs="PYTHONHOME=$root/usr " ;;
      esac
      printf '#!/bin/sh\n# weevils: %s from your distribution, unpacked in your home folder (get/bootstrap.sh).\n%sLD_LIBRARY_PATH=%s${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH} exec %s "$@"\n' "$c" "$envs" "$libdirs" "$root/usr/bin/$c" >"$sys/bin/$c"
      chmod 755 "$sys/bin/$c"
    done
    PATH=$sys/bin:$PATH; export PATH; hash -r
  }

  # Homebrew, in the PATH or where it lives on Apple Silicon and on Intel (a new terminal may not have it yet).
  brew_bin() {
    local b
    for b in "$(command -v brew 2>/dev/null || true)" /opt/homebrew/bin/brew /usr/local/bin/brew; do
      [ -n "$b" ] && [ -x "$b" ] && { printf '%s' "$b"; return 0; }
    done
    return 1
  }
  # Its folder first in the PATH for this run: git, node, cloudflared and qrencode come from there on a Mac.
  brew_path() { local b; b=$(brew_bin) || return 1; eval "$("$b" shellenv)"; }
  brew_install() { NONINTERACTIVE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 HOMEBREW_NO_ENV_HINTS=1 "$(brew_bin)" install "$@" </dev/null; }
  # On a Mac without Apple's Command Line Tools, /usr/bin/git is a stub that opens a dialog and fails.
  git_ok() {
    local g; g=$(command -v git 2>/dev/null) || return 1
    [ "$OS" != Darwin ] || [ "$g" != /usr/bin/git ] || xcode-select -p >/dev/null 2>&1
  }

  # ------------------------------------------------------------ 1. root: hand over to a regular user
  if [ "$(id -u)" = 0 ]; then
    # A Mac: Homebrew refuses to run as root, and what follows creates a Linux user.
    [ "$OS" != Darwin ] || fail "on a Mac, run this command as yourself, without sudo (weevils and Homebrew never run as root)."
    local user=${SUDO_USER:-}
    [ -n "$user" ] && [ "$user" != root ] || user=weevils
    event start
    if ! id -u "$user" >/dev/null 2>&1; then
      useradd -m -s /bin/bash "$user" || fail "could not create the user $user"
      say "user $user created"
    fi
    # A fresh VPS updates itself at boot: wait for apt's lock instead of failing on it.
    [ ! -d /etc/apt/apt.conf.d ] || printf 'DPkg::Lock::Timeout "600";\n' >/etc/apt/apt.conf.d/90weevils-lock
    if ! command -v sudo >/dev/null; then
      if command -v apt-get >/dev/null; then DEBIAN_FRONTEND=noninteractive apt-get install -y -qq sudo >/dev/null 2>&1 || { apt-get update -qq >/dev/null 2>&1; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq sudo >/dev/null 2>&1; }
      elif command -v dnf >/dev/null; then dnf install -y -q sudo >/dev/null 2>&1
      fi
      command -v sudo >/dev/null || fail "sudo is missing and could not be installed"
    fi
    # weevils' agents install and configure things themselves: sudo without a password, like on a fresh VPS.
    printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$user" >"/etc/sudoers.d/90-weevils-$user"
    chmod 440 "/etc/sudoers.d/90-weevils-$user"
    loginctl enable-linger "$user" >/dev/null 2>&1 || true
    # This same script again, as that user: the copy already running (written out from memory, never fetched again).
    local self a q=''
    self=$(mktemp /tmp/weevils-get.XXXXXX)
    for a in "$SID" "${@:2}"; do q="$q $(printf '%q' "$a")"; done
    { echo 'set -euo pipefail'; declare -f _weevils_get; echo "_weevils_get$q"; } >"$self"
    chmod 644 "$self"
    exec runuser -l "$user" -c "bash $self"
  fi

  event start
  cd "$HOME"
  local log=$HOME/weevils-install.log
  # A Linux computer: the system tools weevils needs (git, curl, tmux, jq, python3). One missing on Debian or Ubuntu:
  # its signed packages are fetched by apt as you (apt-get download, no root) and unpacked in your home folder
  # (~/.local/share/weevils/sys), never installed system-wide. Only where that can't work (another distribution, no
  # apt lists) the one install command is shown, and your password is asked for that command alone.
  local sys=$HOME/.local/share/weevils/sys
  if [ "$MODE" = pc ] && [ "$OS" = Linux ] && [ "$(id -u)" != 0 ]; then
    local miss='' c cmd=''
    for c in git curl tmux jq python3; do command -v "$c" >/dev/null 2>&1 || miss="$miss $c"; done
    if [ -n "$miss" ] && command -v apt-get >/dev/null && command -v dpkg >/dev/null; then
      say "missing:$miss. Getting them from your system's own packages, into your home folder (no root)"
      user_debs $miss || true
      miss=''
      for c in git curl tmux jq python3; do command -v "$c" >/dev/null 2>&1 || miss="$miss $c"; done
    fi
    if [ -n "$miss" ]; then
      if command -v apt-get >/dev/null; then cmd="apt-get install -y$miss"
      elif command -v dnf >/dev/null; then cmd="dnf install -y$miss"
      elif command -v pacman >/dev/null; then cmd="pacman -S --needed --noconfirm${miss/python3/python}"
      fi
      if [ -n "$cmd" ] && command -v sudo >/dev/null; then
        if sudo -n true 2>/dev/null; then
          sudo -n env DEBIAN_FRONTEND=noninteractive $cmd >/dev/null 2>&1 || true
        elif { : </dev/tty; } 2>/dev/null; then
          say "still missing:$miss. Installing them needs your password, for this one command:"
          say "  sudo $cmd"
          sudo env DEBIAN_FRONTEND=noninteractive $cmd </dev/tty || true
          # Done with root: nothing after this reuses the password.
          sudo -k 2>/dev/null || true
        fi
      fi
    fi
  fi
  # ------------------------------------------------------------ 2. the code
  if [ "$OS" = Darwin ]; then
    # Homebrew goes in here, before the code, rather than in the installer (which would install it with this same
    # command): its installer also brings Apple's Command Line Tools, without a dialog, and git needs them to clone.
    # One order for every Mac, and the installer then needs no password at all.
    # (Apple Silicon only: Homebrew's installer refuses Intel Macs. There, weevils' installer goes on with the tools
    # the Mac already has, or says which ones are missing.)
    if ! brew_bin >/dev/null && [ "$(uname -m)" = arm64 ]; then
      # Homebrew's own installer is the one thing that needs the Mac's password: asked once here, kept only while it runs.
      if ! sudo -n true 2>/dev/null && { : </dev/tty; } 2>/dev/null; then
        say "Homebrew is missing. Its installer needs your Mac password once:"
        sudo -v </dev/tty || true
      fi
      sudo -n true 2>/dev/null || fail "Homebrew is missing, and installing it needs the password of an administrator of this Mac: start again and type it when the terminal asks."
      (while sudo -n -v 2>/dev/null; do sleep 50; done) &
      local keep=$!
      say "installing Homebrew and Apple's developer tools (this can take several minutes)"
      event step s_system
      local hb; hb=$(mktemp)
      curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh -o "$hb" || fail "could not download Homebrew's installer"
      NONINTERACTIVE=1 /bin/bash "$hb" </dev/null >"$log" 2>&1 || true
      kill "$keep" 2>/dev/null || true
      sudo -k 2>/dev/null || true
      rm -f "$hb"
      brew_bin >/dev/null || fail "Homebrew did not install (see ~/weevils-install.log)"
    fi
    brew_path || true
    # Homebrew without the Command Line Tools (a macOS upgrade removes them): git from Homebrew.
    git_ok || ! brew_bin >/dev/null || brew_install git >>"$log" 2>&1 || true
    if ! git_ok; then
      [ "$(uname -m)" = arm64 ] || fail "git is missing on this Intel Mac, and Homebrew no longer installs there: install Apple's developer tools (xcode-select --install), then start again."
      fail "could not install git (see ~/weevils-install.log)"
    fi
  elif ! command -v git >/dev/null; then
    sudo -n true 2>/dev/null || fail "git is missing and installing it needs sudo without a password"
    if command -v apt-get >/dev/null; then sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git >/dev/null 2>&1 || { sudo -n apt-get update -qq >/dev/null 2>&1; sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git >/dev/null 2>&1; }
    elif command -v dnf >/dev/null; then sudo -n dnf install -y -q git >/dev/null 2>&1
    elif command -v pacman >/dev/null; then sudo -n pacman -S --noconfirm git >/dev/null 2>&1
    fi
    command -v git >/dev/null || fail "could not install git"
  fi
  local dir=$HOME/weevils
  if [ ! -d "$dir/.git" ]; then
    [ ! -e "$dir" ] || fail "$dir exists and is not a weevils clone"
    if [ "$BUNDLE" = 1 ]; then
      local b; b=$(mktemp)
      curl -fsSL "$BASE/weevils.bundle?sid=$SID" -o "$b" || fail "could not download weevils"
      # The code is signed with weevils' release key (its public half is pinned in this script): a bundle whose
      # signature does not check is refused. Where ssh-keygen can't check signatures (OpenSSH before 8.1), its
      # published SHA-256 at least.
      verify_bundle "$b" "$BASE" || { sleep 3; curl -fsSL "$BASE/weevils.bundle?sid=$SID" -o "$b" && verify_bundle "$b" "$BASE"; } || fail "the downloaded code did not match weevils' signature: nothing was installed"
      git clone -q -b main "$b" "$dir" || fail "could not unpack weevils"
      rm -f "$b"
      git -C "$dir" remote set-url origin "$REPO"
    else
      git clone -q "$REPO" "$dir" || fail "could not download weevils from $REPO"
    fi
  fi

  # ------------------------------------------------------------ 3. the install, its step names reported
  run_install() {
    : >"$log"
    # The installer never asks anything; neither does git when the repository is not readable from here.
    (cd "$dir" && GIT_TERMINAL_PROMPT=0 ./install.sh --agent --lang "$UI_LANG" "$@") >>"$log" 2>&1 &
    local pid=$! line t seen=0 total alive
    # "tail --pid" is GNU only: the new complete lines of the log are read once a second while the installer runs,
    # and one last time after it ended.
    while :; do
      alive=1
      kill -0 "$pid" 2>/dev/null || alive=0
      total=$(($(wc -l <"$log")))
      if [ "$total" -gt "$seen" ]; then
        while IFS= read -r line; do
          [[ $line =~ ^\ ([^\ ].{0,70}[^\ ])\ $ ]] || continue
          t=${BASH_REMATCH[1]}
          case "$TITLES" in *"|$t|"*) report --data-urlencode event=step --data-urlencode "title=$t" ;; esac
        done < <(sed -n "$((seen + 1)),${total}p" "$log")
        seen=$total
      fi
      [ "$alive" = 1 ] || break
      sleep 1
    done
    wait "$pid" || true
  }
  sum() { sed -n '/^--- weevils summary ---$/,/^--- end ---$/p' "$log" | sed -n "s/^$1=//p" | tail -1; }
  check() {
    local status; status=$(sum status)
    case $status in
      ok) ;;
      needs_sudo) fail "this needs admin rights: sudo without a password for $(id -un)" ;;
      '') fail "the installer stopped before its end (see ~/weevils-install.log)" ;;
      *) fail "$(sum error)" ;;
    esac
  }

  # A computer: its agents ask before acting (answered from the app), unless the person said otherwise.
  [ "$MODE" != pc ] || [ "$prompts" = 0 ] || extra+=(--ask-permissions)
  case $MODE in
    vps) run_install --domain "$REACH" ${extra[@]+"${extra[@]}"} ;;
    url) run_install --url "$REACH" ${extra[@]+"${extra[@]}"} ;;
    *) run_install ${extra[@]+"${extra[@]}"} ;;
  esac
  check

  # ------------------------------------------------------------ 4. a computer: an HTTPS link for the phone
  if [ "$MODE" = pc ] && [ "$(sum mode)" = local ] && [ "$link" = 1 ]; then
    event step tunnel
    local port bin arch turl='' state=$HOME/.local/share/weevils
    port=$(sum port)
    mkdir -p "$state/bin"
    # A Mac: cloudflared from Homebrew (there since the install), else from its release like on Linux.
    if [ "$OS" = Darwin ] && ! command -v cloudflared >/dev/null && brew_bin >/dev/null; then
      brew_install cloudflared >/dev/null 2>&1 || true
    fi
    bin=$(command -v cloudflared || echo "$state/bin/cloudflared")
    if [ ! -x "$bin" ]; then
      case $(uname -m) in x86_64 | amd64) arch=amd64 ;; aarch64 | arm64) arch=arm64 ;; armv7l) arch=arm ;; *) fail "no secure link for this processor ($(uname -m))" ;; esac
      # Cloudflare's latest release, checked against the SHA-256 GitHub publishes for that very file.
      local asset=cloudflared-linux-$arch meta tag want got f
      [ "$OS" != Darwin ] || asset=cloudflared-darwin-$arch.tgz
      meta=$(curl -fsSL -m 30 https://api.github.com/repos/cloudflare/cloudflared/releases/latest | python3 -c 'import json,sys
d=json.load(sys.stdin); a=[x for x in d.get("assets",[]) if x.get("name")==sys.argv[1]]
print(d.get("tag_name",""), (a[0].get("digest") or "") if a else "")' "$asset" 2>/dev/null) || meta=''
      tag=${meta%% *} want=${meta#* }; want=${want#sha256:}
      [ -n "$tag" ] && [ ${#want} = 64 ] || fail "could not read cloudflared's release and checksum"
      f=$state/bin/$asset
      curl -fsSL "https://github.com/cloudflare/cloudflared/releases/download/$tag/$asset" -o "$f" || fail "could not download the secure link (cloudflared)"
      got=$(if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$f"; else openssl dgst -sha256 -r "$f"; fi | cut -d' ' -f1)
      [ "$got" = "$want" ] || { rm -f "$f"; fail "cloudflared did not match its published checksum: not installed"; }
      if [ "$OS" = Darwin ]; then
        # The macOS release is an archive that holds the one binary, "cloudflared".
        tar -xzf "$f" -C "$state" cloudflared && mv -f "$state/cloudflared" "$bin.tmp" || fail "could not unpack the secure link (cloudflared)"
        rm -f "$f"
      else
        mv -f "$f" "$bin.tmp"
      fi
      chmod 755 "$bin.tmp" && mv -f "$bin.tmp" "$bin"
    fi
    local tlog=$state/link.log kept=''
    : >"$tlog"
    if [ "$OS" = Darwin ]; then
      # A Mac: a launchd agent of the session opened on its screen, started at every login and restarted if it stops.
      local label=com.github.sc4rville.weevils-link dom plist
      dom=gui/$(id -u)
      plist=$HOME/Library/LaunchAgents/$label.plist
      xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
      # An earlier link is stopped first: the agent (bootout returns before the job is gone, so wait for that), and a
      # background one left by a run without a session.
      launchctl bootout "$dom/$label" >/dev/null 2>&1 || true
      for _ in $(seq 1 30); do launchctl print "$dom/$label" >/dev/null 2>&1 || break; sleep 0.5; done
      pkill -u "$(id -u)" -f "cloudflared tunnel --no-autoupdate --url http://127.0.0.1:$port" 2>/dev/null || true
      if launchctl print "$dom" >/dev/null 2>&1; then
        mkdir -p "$HOME/Library/LaunchAgents"
        cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- weevils, HTTPS link for the phone: a Cloudflare quick tunnel to 127.0.0.1:$port. Written by the setup page's install. -->
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$bin")</string>
    <string>tunnel</string>
    <string>--no-autoupdate</string>
    <string>--url</string>
    <string>http://127.0.0.1:$port</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$(xml "$tlog")</string>
  <key>StandardErrorPath</key><string>$(xml "$tlog")</string>
</dict>
</plist>
EOF
        launchctl enable "$dom/$label" >/dev/null 2>&1 || true
        if launchctl bootstrap "$dom" "$plist" >/dev/null 2>&1; then kept=launchd; fi
      fi
      # No session on the Mac's screen (SSH only), or launchd refused: no file left behind, a plain background process.
      [ -n "$kept" ] || rm -f "$plist"
    elif systemctl --user show-environment >/dev/null 2>&1; then
      kept=systemd
      mkdir -p "$HOME/.config/systemd/user"
      cat >"$HOME/.config/systemd/user/weevils-link.service" <<EOF
[Unit]
Description=weevils — HTTPS link for the phone (Cloudflare quick tunnel to 127.0.0.1:$port)
After=network-online.target weevilsd.service

[Service]
ExecStart=/bin/sh -c 'exec "$bin" tunnel --no-autoupdate --url http://127.0.0.1:$port >>"$tlog" 2>&1'
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
      systemctl --user daemon-reload
      systemctl --user enable weevils-link >/dev/null 2>&1 || true
      systemctl --user restart weevils-link
    fi
    if [ -z "$kept" ]; then
      # No service manager to keep it up: a plain background process, until the computer restarts.
      pkill -u "$(id -u)" -f "cloudflared tunnel --no-autoupdate --url http://127.0.0.1:$port" 2>/dev/null || true
      nohup "$bin" tunnel --no-autoupdate --url "http://127.0.0.1:$port" >>"$tlog" 2>&1 </dev/null &
    fi
    for _ in $(seq 1 60); do
      turl=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$tlog" | tail -1 || true)
      [ -z "$turl" ] || break
      sleep 1
    done
    [ -n "$turl" ] || fail "the secure link did not come up (see $tlog)"
    # Wait until the link answers, then tell weevils its public address.
    for _ in $(seq 1 30); do curl -fsS -m 5 -o /dev/null "$turl/manifest.webmanifest" 2>/dev/null && break; sleep 2; done
    run_install --url "$turl" --no-update
    check
  fi

  # ------------------------------------------------------------ 5. done: the address, sealed for the page
  # RSA-OAEP with SHA-256, what the page's key opens (WebCrypto), as base64 on one line. The link goes in on stdin,
  # never as an argument. Two ways to the same result: openssl, and Node (the installer made sure it is there).
  seal_openssl() {
    local key out
    key=$(mktemp)
    out=$(printf '%s' "$PUB" | openssl base64 -d -A >"$key" 2>/dev/null && openssl pkeyutl -encrypt -pubin -keyform DER -inkey "$key" \
      -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 -pkeyopt rsa_mgf1_md:sha256 2>/dev/null | openssl base64 -A 2>/dev/null) || out=''
    rm -f "$key"
    printf '%s' "$out"
  }
  seal_node() {
    WV_PUB=$PUB node -e 'const c = require("node:crypto")
      const key = c.createPublicKey({ key: Buffer.from(process.env.WV_PUB, "base64"), format: "der", type: "spki" })
      const link = require("node:fs").readFileSync(0)
      process.stdout.write(c.publicEncrypt({ key, padding: c.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, link).toString("base64"))' 2>/dev/null || true
  }
  local url link mode ready enc='' how order='openssl node' cur
  url=$(sum url) link=$(sum link) mode=$(sum mode) ready=$(sum ready)
  # The key of the page following this setup now: another page may have taken it over (« continue on this one »,
  # after the first one was closed). Public; the one this script came with when the service doesn't answer.
  cur=$(curl -fsS -m 10 "$BASE/k/$SID" 2>/dev/null || true)
  if [ "${#cur}" -ge 200 ] && [ -z "$(printf '%s' "$cur" | tr -d 'A-Za-z0-9+/=')" ]; then PUB=$cur; fi
  # The second is tried when the first is missing, fails or gives nothing. A Mac starts with Node: the openssl that
  # macOS ships is LibreSSL, which may not know these options. Neither works: the install still ends, the link is
  # shown here (a way that stops before reading the link breaks the pipe: that is not an error either).
  [ "$OS" != Darwin ] || order='node openssl'
  for how in $order; do
    [ "${#enc}" -ge 100 ] || enc=$(printf '%s' "$link" | "seal_$how") || true
  done
  [ "${#enc}" -ge 100 ] || enc=''
  # The version installed, for the setup page's register of installs: the snapshot's revision (its commit says
  # « weevils <rev> »), else the clone's.
  local version
  version=$(git -C "$dir" log -1 --format=%s 2>/dev/null | sed -n 's/^weevils \([0-9a-f]\{7,40\}\)$/\1/p')
  [ -n "$version" ] || version=$(git -C "$dir" rev-parse --short HEAD 2>/dev/null || true)
  # The first login on this weevils tells the setup page, once, so it stops keeping the link (server/index.ts reads
  # this file, posts « claimed » to it, and deletes it). Nothing else ever goes back to the setup page.
  { mkdir -p "$HOME/.local/share/weevils" && printf '%s/r/%s\n' "$BASE" "$SID" >"$HOME/.local/share/weevils/get-claim" && chmod 600 "$HOME/.local/share/weevils/get-claim"; } 2>/dev/null || true
  report --data-urlencode event=done --data-urlencode "url=$url" --data-urlencode "mode=$mode" \
    --data-urlencode "ready=$ready" --data-urlencode "sealed=$enc" --data-urlencode "version=$version"
  echo
  say "ready: $url"
  [ -n "$enc" ] || say "open the link from $log on your phone (the setup page could not receive it)"
  if [ "$MODE" = pc ]; then
    say "on your phone, open this link (it logs you in, keep it to yourself):"
    printf '\n  %s\n\n' "$link"
    ! command -v qrencode >/dev/null || qrencode -t ANSIUTF8 -m 2 "$link" | sed 's/^/  /' || true
  fi
}
_weevils_get "$@"
