#!/usr/bin/env bash
# test-copy.sh — a throwaway weevils next to a real one, that can never touch the real one.
#
#   scripts/test-copy.sh up <name> <port> [checkout]   start a copy in its own Docker container
#   scripts/test-copy.sh tmux <name> <tmux args…>      run tmux inside the copy (create panes, read them…)
#   scripts/test-copy.sh link <name>                   the copy's login link (it asks for its own access code)
#   scripts/test-copy.sh down <name>                   stop and remove the copy's container (its folder stays)
#
# WEEVILS_COPY_ORCHESTRATOR=1 on « up »: the copy runs as a main machine (For you, sleep mode, automations), still in
# its container; without Claude logged in there, weevboss and the automations never start an agent.
#
# Why: on 2026-11-14 a hand-made script ran « TMUX_TMPDIR=$H tmux -L weevils kill-server » before $H existed. tmux
# then fell back to /tmp, killed the real weevils tmux server and every agent session, twice. So a copy is physically
# apart: it runs in a container that mounts only its own folder (read-write) and the dependencies (read-only). The
# live tmux socket, ~/.config/weevils, ~/.claude and the live data simply don't exist in there. No Docker, no copy.
# Inside, every tmux call still names the copy's own socket by absolute path, and kill-server, -L and -S are refused.
# WEEVILS_ALLOW_LOCAL_VOICE=1: scripts may write to the copy's weevboss and open its live voice as the user, which the
# live weevils refuses to anything but a signed-in browser.
set -euo pipefail

ROOT=${WEEVILS_TEST_COPIES:-/tmp/weevils-test-copies}
IMAGE=${WEEVILS_TEST_COPY_IMAGE:-weevils-test-copy:1}
here=$(cd "$(dirname "$0")" && pwd)
DOCKER=${WEEVILS_DOCKER:-docker}
die() { echo "test-copy: $*" >&2; exit 1; }

case "$ROOT" in /*) ;; *) die "WEEVILS_TEST_COPIES must be an absolute path" ;; esac
cmd=${1:-}; name=${2:-}
[ -n "$cmd" ] && [ -n "$name" ] || die "usage: test-copy.sh up|tmux|down <name> …"
[[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$ ]] || die "name must be letters, digits, - or _"
{ command -v "$DOCKER" >/dev/null 2>&1 && "$DOCKER" info >/dev/null 2>&1; } || die "Docker is required: a test copy never runs next to the live weevils without it"

DIR="$ROOT/$name"
BOX="weevils-copy-$name"
# Inside the container: the copy's folder is /copy, its HOME and its TMUX_TMPDIR, so its socket is always this path.
SOCK="/copy/tmux-$(id -u)/weevils"

# Never mount anything of the live install.
guard_dir() {
  case "$1/" in
    "$HOME/.config/"*|"$HOME/.claude/"*|"$HOME/.codex/"*|"$HOME/.local/share/weevils/"*|/tmp/tmux-*) die "refusing to mount $1" ;;
  esac
}

case "$cmd" in
  up)
    port=${3:-}; checkout=$(cd "${4:-$here/..}" && pwd -P)
    [[ "$port" =~ ^[0-9]+$ ]] || die "port must be a number"
    { [ "$port" -ge 1024 ] && [ "$port" -le 65000 ]; } || die "port out of range"
    case "$port" in 4179|4180) die "port $port belongs to the real weevils" ;; esac
    [ -f "$checkout/server/index.ts" ] || die "$checkout is not a weevils checkout"
    [ -e "$DIR" ] && die "$DIR already exists: « down $name » and remove it first, or pick another name"
    guard_dir "$DIR"
    deps=$(cd "$checkout/node_modules" 2>/dev/null && pwd -P) || die "$checkout has no node_modules"
    guard_dir "$deps"
    "$DOCKER" image inspect "$IMAGE" >/dev/null 2>&1 || "$DOCKER" build -q -t "$IMAGE" "$here/test-copy" >/dev/null
    # The app: a copy of the checkout (server, shared, built app), never the checkout itself.
    mkdir -p "$DIR/app/node_modules" "$DIR/projects" "$DIR/tmux-$(id -u)"
    chmod 700 "$DIR/tmux-$(id -u)"
    for part in server shared dist package.json; do
      if [ -e "$checkout/$part" ]; then cp -R "$checkout/$part" "$DIR/app/"; fi
    done
    # WEEVILS_COPY_CLAUDE=1: a real Claude Code in the copy — the installed binary (read-only) and only the current
    # access token of this machine's login (never the refresh token: refreshing a copy would sign the original out).
    claude_mount=()
    if [ "${WEEVILS_COPY_CLAUDE:-}" = 1 ]; then
      cc=$(dirname "$(dirname "$(readlink -f "$(command -v claude)")")")
      guard_dir "$cc"
      mkdir -p "$DIR/.claude" "$DIR/bin" && chmod 700 "$DIR/.claude"
      (umask 077 && python3 -c 'import json,os,sys
o=json.load(open(os.path.expanduser("~/.claude/.credentials.json")))["claudeAiOauth"]
json.dump({"claudeAiOauth":{k:o[k] for k in ("accessToken","expiresAt","scopes","subscriptionType") if k in o}},sys.stdout)' > "$DIR/.claude/.credentials.json")
      echo '{"hasCompletedOnboarding":true}' > "$DIR/.claude.json"
      ln -sf /opt/claude-code/bin/claude.exe "$DIR/bin/claude"
      claude_mount=(-v "$cc:/opt/claude-code:ro" -e PATH=/copy/bin:/usr/local/bin:/usr/bin:/bin)
    fi
    # WEEVILS_COPY_RESTARTABLE=1: the server runs in a loop, so « docker exec $BOX pkill -f '^node server/index.ts' »
    # restarts weevilsd alone while the copy's tmux sessions live on (what a live restart does).
    run=(node server/index.ts)
    [ "${WEEVILS_COPY_RESTARTABLE:-}" = 1 ] && run=(sh -c 'while :; do node server/index.ts; sleep 1; done')
    "$DOCKER" run -d --name "$BOX" --init --user "$(id -u):$(id -g)" \
      --label weevils-test-copy="$name" "${claude_mount[@]}" -e WEEVILS_STRUCTURED="${WEEVILS_STRUCTURED:-}" \
      -p "127.0.0.1:$port:$port" \
      -v "$DIR:/copy" -v "$deps:/copy/app/node_modules:ro" \
      -e HOME=/copy -e TMUX_TMPDIR=/copy -e LANG=C.UTF-8 -e WEEVILS_LANG="${WEEVILS_LANG:-en}" \
      -e WEEVILS_PORT="$port" -e WEEVILS_HOOK_PORT=$((port + 1)) -e WEEVILS_ORCHESTRATOR="${WEEVILS_COPY_ORCHESTRATOR:-0}" -e WEEVILS_MACHINE=test-copy \
      -e WEEVILS_HOST=0.0.0.0 -e WEEVILS_ALLOW_LOCAL_VOICE=1 \
      -w /copy/app "$IMAGE" "${run[@]}" >/dev/null
    echo "test copy $name: http://127.0.0.1:$port · folder $DIR · container $BOX"
    ;;
  tmux)
    shift 2
    for a in "$@"; do case "$a" in kill-server|kill-ser|-L|-S) die "« $a » is not allowed here" ;; esac; done
    "$DOCKER" exec "$BOX" tmux -S "$SOCK" "$@"
    ;;
  link)
    for _ in $(seq 1 40); do [ -s "$DIR/.config/weevils/secret" ] && break; sleep 0.25; done
    [ -s "$DIR/.config/weevils/secret" ] || die "the copy has no access code yet (see « docker logs $BOX »)"
    echo "http://127.0.0.1:$("$DOCKER" port "$BOX" | sed -n 's/.*:\([0-9]*\)$/\1/p' | head -1)/#k=$(tr -d '[:space:]' < "$DIR/.config/weevils/secret")"
    ;;
  down)
    "$DOCKER" rm -f "$BOX" >/dev/null 2>&1 || true
    echo "test copy $name stopped (folder kept: $DIR)"
    ;;
  *) die "unknown command $cmd" ;;
esac
