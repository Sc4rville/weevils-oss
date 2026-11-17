#!/usr/bin/env bash
# Machine setup of weevils (called by ../install.sh, can also be run alone). Idempotent: re-run = update.
#   server/install.sh                        main machine: weevilsd serves the app and runs weevboss
#   (Linux: a systemd --user unit; a Mac: a launchd agent of your session. Runs under macOS's bash 3.2.)
#   server/install.sh secondary <ssh-host>   secondary machine: local weevilsd + reverse SSH tunnel to the main
#                                            machine <ssh-host>, which federates it (its sessions show up there)
# Ports come from ~/.config/weevils/env (WEEVILS_PORT, WEEVILS_HOOK_PORT); WEEVILS_TUNNEL_PORT forces the port the
# main machine listens on for this secondary one (otherwise the main machine picks a free one).
set -euo pipefail
USER=${USER:-$(id -un)}
role=${1:-main}
main_host=${2:-}
here=$(cd "$(dirname "$0")" && pwd)
repo=$(dirname "$here")
svc=$here/weevils-service
cfg() { "$svc" config "$@"; }

case "$role" in
  main) ;;
  secondary) [ -n "$main_host" ] || { echo "usage: server/install.sh secondary <ssh host of the main machine>" >&2; exit 1; } ;;
  *) echo "usage: server/install.sh [main | secondary <ssh-host>]" >&2; exit 1 ;;
esac

port=$(cfg get WEEVILS_PORT); port=${port:-4179}
hook_port=$(cfg get WEEVILS_HOOK_PORT); hook_port=${hook_port:-4180}
# weevboss runs on the main machine only. A re-run keeps a main machine's choice (WEEVILS_ORCHESTRATOR=0 stays 0);
# a secondary machine becoming the main one gets it back.
prev_role=$(sed -n 's/^WEEVILS_ROLE=//p' ~/.config/weevils/service.conf 2>/dev/null | head -1 || true)
if [ "$role" = secondary ]; then cfg set WEEVILS_ORCHESTRATOR 0
elif [ "$prev_role" = secondary ]; then cfg set WEEVILS_ORCHESTRATOR 1
else cfg default WEEVILS_ORCHESTRATOR 1; fi

# ---------------------------------------------------------------- commands: wv, weevils (agents' cli), hook, service
mkdir -p ~/.local/bin ~/.claude
install -m 755 "$here/wv" ~/.local/bin/wv
install -m 755 "$here/weevils-service" ~/.local/bin/weevils-service
# The hook and the cli are called from agent sessions, whose environment may not carry the ports: bake them in.
sed "s/WEEVILS_HOOK_PORT:-4180/WEEVILS_HOOK_PORT:-$hook_port/" "$here/hook.sh" >~/.local/bin/weevils-hook && chmod 755 ~/.local/bin/weevils-hook
sed "s/WEEVILS_PORT:-4179/WEEVILS_PORT:-$port/" "$here/weevils-cli" >~/.local/bin/weevils && chmod 755 ~/.local/bin/weevils
# Updates by itself (weevils-update, timer below): on unless WEEVILS_AUTO_UPDATE=0.
install -m 755 "$here/weevils-update" ~/.local/bin/weevils-update
# tmux guard: ~/.local/bin/tmux, ahead of the real one, refuses to close the live weevils sessions without the
# server's token (a test script once closed them all through « tmux -L weevils kill-server »).
install -m 755 "$here/tmux-guard" ~/.local/bin/tmux

# ---------------------------------------------------------------- Claude Code hooks: weevils-hook on the useful events, other hooks kept
# Only weevils' own entries are written to the user's Claude Code settings: no global env, no other preference.
# (weevils sessions get their quiet variables per session: QUIET_ENV in server/mux.ts, 'quiet' in wv.)
settings=~/.claude/settings.json
[ -s "$settings" ] || echo '{}' >"$settings"
# The settings as they were before weevils ever touched them, kept once.
[ -f "$settings.bak-weevils" ] || cp "$settings" "$settings.bak-weevils"
tmp=$(mktemp)
jq --arg cmd "$HOME/.local/bin/weevils-hook" '
  .hooks //= {} |
  reduce ("SessionStart","UserPromptSubmit","PostToolUse","Notification","Stop","SessionEnd") as $e (.;
    if ([.hooks[$e][]?.hooks[]?.command] | index($cmd)) then .
    else .hooks[$e] = ((.hooks[$e] // []) + [{"hooks":[{"type":"command","command":$cmd}]}]) end)
' "$settings" >"$tmp" && mv "$tmp" "$settings"

# Agents run with --dangerously-skip-permissions unless WEEVILS_SAFE=1: Claude Code's one-time warning about it
# would otherwise end the first session (weevboss included) before anyone sees it. Not as root: there the flag is
# refused anyway, and install.sh sets WEEVILS_SAFE=1.
if [ "$(cfg get WEEVILS_SAFE)" != 1 ] && [ "$(id -u)" != 0 ] && [ "$(jq -r '.skipDangerousModePermissionPrompt // false' "$settings")" != true ]; then
  tmp=$(mktemp)
  jq '.skipDangerousModePermissionPrompt = true' "$settings" >"$tmp" && mv "$tmp" "$settings"
fi
# weevils hooks whose script no longer exists on disk are removed (they made every Stop fail). Other hooks: untouched.
for f in $(jq -r '.hooks[][]?.hooks[]?.command // empty' "$settings" | awk '{print $1}' | sort -u); do
  case "$f" in */weevils-hook | */weevils*/hook.sh) [ -x "$f" ] || {
    tmp=$(mktemp)
    jq --arg f "$f" '.hooks |= with_entries(.value |= map(.hooks |= map(select((.command // "") | split(" ")[0] != $f)) | select(.hooks | length > 0)))' "$settings" >"$tmp" && mv "$tmp" "$settings"
    echo "hook removed (script missing): $f"
  } ;; esac
done

# ---------------------------------------------------------------- secondary machine: tunnel port, registered on the main machine
tunnel_port=${WEEVILS_TUNNEL_PORT:-}
if [ "$role" = secondary ]; then
  id=$(cfg get WEEVILS_MACHINE); id=${id:-$(hostname -s | tr 'A-Z' 'a-z' | tr -c 'a-z0-9-\n' '-' | cut -c1-20)}
  ssh_opts=(-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)
  if [ -z "$tunnel_port" ]; then
    # The main machine picks (or finds again) the port it will listen on for us, and adds us to WEEVILS_REMOTES.
    tunnel_port=$(ssh "${ssh_opts[@]}" "$main_host" "\$HOME/.local/bin/weevils-service add-remote $(printf '%q' "$id")" 2>/dev/null | tail -1 || true)
    if ! [[ "$tunnel_port" =~ ^[0-9]+$ ]]; then
      # shellcheck disable=SC1090
      tunnel_port=$( { [ -f ~/.config/weevils/service.conf ] && . ~/.config/weevils/service.conf; echo "${WEEVILS_TUNNEL_PORT:-4192}"; } )
      echo "WARNING: could not register this machine on $main_host (ssh $main_host without password? weevils installed there?)." >&2
      echo "  On $main_host, run: weevils-service add-remote $id http://127.0.0.1:$tunnel_port" >&2
    fi
  else
    ssh "${ssh_opts[@]}" "$main_host" "\$HOME/.local/bin/weevils-service add-remote $(printf '%q' "$id") http://127.0.0.1:$tunnel_port" >/dev/null 2>&1 ||
      echo "WARNING: on $main_host, run: weevils-service add-remote $id http://127.0.0.1:$tunnel_port" >&2
  fi
fi

# ---------------------------------------------------------------- service description (read by weevils-service)
node_bin=$(command -v node)
npm_bin=$(npm prefix -g 2>/dev/null)/bin
# ~/.local/share/weevils/sys/bin: system tools the setup page's install unpacked in the home folder (no root).
svc_path="$HOME/.local/bin:$HOME/.local/share/weevils/sys/bin:$(dirname "$node_bin"):$npm_bin:/usr/local/bin:/usr/bin:/bin"
if [ "$(uname -s)" = Darwin ]; then
  # A Mac: Homebrew's folder (tmux, jq, gh… live there; /opt/homebrew on Apple Silicon, /usr/local on Intel) and the
  # system tools in sbin. launchd gives a service nothing more than what is written here.
  brew_prefix=${HOMEBREW_PREFIX:-}
  [ -n "$brew_prefix" ] || for b in /opt/homebrew /usr/local; do [ -x "$b/bin/brew" ] && { brew_prefix=$b; break; }; done
  svc_path="$HOME/.local/bin:$(dirname "$node_bin"):$npm_bin${brew_prefix:+:$brew_prefix/bin:$brew_prefix/sbin}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  # Each folder once (node's and npm's are usually Homebrew's own).
  svc_path=$(printf '%s' "$svc_path" | tr ':' '\n' | awk 'NF && !seen[$0]++' | paste -sd: -)
fi
mkdir -p ~/.config/weevils
cat >~/.config/weevils/service.conf <<EOF
# Written by server/install.sh — read by weevils-service.
WEEVILS_ROLE=$role
WEEVILS_DIR=$(printf '%q' "$repo")
WEEVILS_NODE=$(printf '%q' "$node_bin")
WEEVILS_PATH=$(printf '%q' "$svc_path")
WEEVILS_MAIN_HOST=$(printf '%q' "$main_host")
WEEVILS_TUNNEL_PORT=$tunnel_port
EOF

# ---------------------------------------------------------------- systemd --user (survives logout and reboot thanks to linger)
if [ -d /run/systemd/system ] && command -v loginctl >/dev/null; then
  if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != yes ]; then
    # WEEVILS_NO_PROMPT=1 (run by an agent): never a password prompt, it would hang.
    loginctl enable-linger "$USER" 2>/dev/null || { [ "$(id -u)" = 0 ] || sudo -n loginctl enable-linger "$USER" 2>/dev/null || { [ "${WEEVILS_NO_PROMPT:-0}" != 1 ] && sudo loginctl enable-linger "$USER"; }; } || true
  fi
  # The user manager starts with linger: wait for its bus (first run, or a session opened without login).
  for _ in $(seq 1 20); do [ -S "/run/user/$(id -u)/bus" ] && break; sleep 0.5; done
  if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != yes ]; then
    echo "WARNING: linger is off: weevilsd stops when you log out and won't start at boot. Fix: sudo loginctl enable-linger $USER" >&2
  fi
fi

units=~/.config/systemd/user
if [ "$("$svc" mode)" = systemd ]; then
  export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
  [ -n "${DBUS_SESSION_BUS_ADDRESS:-}" ] || export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
  mkdir -p "$units"
  # A main unit from an older install carried WEEVILS_REMOTES: it moves to the config file.
  old=$(sed -n 's/^Environment=WEEVILS_REMOTES=//p' "$units/weevilsd.service" 2>/dev/null | head -1 || true)
  if [ -n "$old" ]; then cfg default WEEVILS_REMOTES "$old"; fi
  cat >"$units/weevilsd.service" <<EOF
[Unit]
Description=weevilsd — weevils server ($role): Claude Code / Codex sessions, app API
After=network.target

[Service]
WorkingDirectory=$repo
ExecStart=$node_bin server/index.ts
Restart=always
RestartSec=2
# The agent sessions (tmux server started by weevilsd) must survive a restart of weevilsd.
KillMode=process
Environment=PATH=$svc_path
Environment=NODE_ENV=production
# Settings and keys: one per line, NAME=value (model: .env.example).
EnvironmentFile=-%h/.config/weevils/env

[Install]
WantedBy=default.target
EOF
  if [ "$role" = secondary ]; then
    cat >"$units/weevils-tunnel.service" <<EOF
[Unit]
Description=weevils — reverse SSH tunnel: $main_host reads this weevilsd (127.0.0.1:$tunnel_port there → 127.0.0.1:$port here)
After=network-online.target weevilsd.service

[Service]
ExecStart=$(command -v ssh) -NT -o BatchMode=yes -o ServerAliveInterval=20 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -R 127.0.0.1:$tunnel_port:127.0.0.1:$port $main_host
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
EOF
  else
    systemctl --user disable --now weevils-tunnel >/dev/null 2>&1 || true
    rm -f "$units/weevils-tunnel.service"
  fi
  # Updates: a look every 20 to 30 minutes; weevils-update itself decides (setting, plain install, calm moment).
  cat >"$units/weevils-update.service" <<EOF
[Unit]
Description=weevils — update to the latest version when nothing is working (server/weevils-update)

[Service]
Type=oneshot
ExecStart=%h/.local/bin/weevils-update
Nice=10
Environment=PATH=$svc_path
EOF
  cat >"$units/weevils-update.timer" <<EOF
[Unit]
Description=weevils — look for a new version every 20 to 30 minutes

[Timer]
OnActiveSec=15min
OnUnitActiveSec=20min
RandomizedDelaySec=10min

[Install]
WantedBy=timers.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now weevils-update.timer >/dev/null 2>&1 || true
elif [ "$("$svc" mode)" != launchd ] && command -v crontab >/dev/null; then
  # No systemd (a container, WSL without it): the same look from cron.
  { crontab -l 2>/dev/null | grep -v 'weevils-update' || true; echo "*/25 * * * * $HOME/.local/bin/weevils-update >/dev/null 2>&1"; } | crontab - 2>/dev/null || true
fi

# ---------------------------------------------------------------- launchd (a Mac): an agent of the person's session
# Started at every login and restarted if it stops. The settings file (~/.config/weevils/env) is read by weevilsd
# itself. With no session open on the Mac's screen (SSH only) there is no launchd domain to load an agent into:
# weevils-service then runs weevilsd in the background, and no file is written (it would start a second weevilsd at
# the next login).
agents=~/Library/LaunchAgents
prefix=com.github.sc4rville
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
if [ "$("$svc" mode)" = launchd ]; then
  data=~/.local/share/weevils
  mkdir -p "$agents" "$data"
  cat >"$agents/$prefix.weevilsd.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- weevilsd, the weevils server ($role): Claude Code / Codex sessions, app API. Written by server/install.sh. -->
<plist version="1.0">
<dict>
  <key>Label</key><string>$prefix.weevilsd</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$node_bin")</string>
    <string>server/index.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml "$repo")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml "$svc_path")</string>
    <key>NODE_ENV</key><string>production</string>
    <!-- launchd sets no locale: without a UTF-8 one, tmux and the agents in its panes mangle accents. -->
    <key>LANG</key><string>en_US.UTF-8</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <!-- launchd's default is 256 open files: too few for a server that follows many sessions. -->
  <key>SoftResourceLimits</key><dict><key>NumberOfFiles</key><integer>8192</integer></dict>
  <!-- The agent sessions (tmux server started by weevilsd) must survive a restart of weevilsd. -->
  <key>AbandonProcessGroup</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$(xml "$data/weevilsd.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$data/weevilsd.log")</string>
</dict>
</plist>
EOF
  if [ "$role" = secondary ]; then
    cat >"$agents/$prefix.weevils-tunnel.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- weevils, reverse SSH tunnel: the main machine reads this weevilsd (127.0.0.1:$tunnel_port there, 127.0.0.1:$port here). -->
<plist version="1.0">
<dict>
  <key>Label</key><string>$prefix.weevils-tunnel</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$(command -v ssh)")</string>
    <string>-NT</string>
    <string>-o</string><string>BatchMode=yes</string>
    <string>-o</string><string>ServerAliveInterval=20</string>
    <string>-o</string><string>ServerAliveCountMax=3</string>
    <string>-o</string><string>ExitOnForwardFailure=yes</string>
    <string>-R</string><string>127.0.0.1:$tunnel_port:127.0.0.1:$port</string>
    <string>$(xml "$main_host")</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$(xml "$data/tunnel.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$data/tunnel.log")</string>
</dict>
</plist>
EOF
  else
    launchctl bootout "gui/$(id -u)/$prefix.weevils-tunnel" >/dev/null 2>&1 || true
    rm -f "$agents/$prefix.weevils-tunnel.plist"
  fi
elif [ "$(uname -s)" = Darwin ]; then
  rm -f "$agents/$prefix.weevilsd.plist" "$agents/$prefix.weevils-tunnel.plist"
fi
"$svc" restart
"$svc" status
