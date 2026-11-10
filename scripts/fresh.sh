#!/usr/bin/env bash
# fresh.sh — weevils as a newcomer sees it: a blank install in its own Docker container, next to your real one and
# never touching it (its own disk, network and loopback; no key, no repo, no mail, no data of yours).
#
#   scripts/fresh.sh up [--port 4177] [--url https://fresh.example.com] [--host myserver]
#                             builds the image from the HEAD commit if needed, starts the container, prints the link
#   scripts/fresh.sh reset    back to a just-installed state (same image, same login link): the app forgets the old
#                             one on every device as soon as it reloads
#   scripts/fresh.sh build    rebuilds the image from the HEAD commit (commit first), then reset
#   scripts/fresh.sh link     the login link (with the access code)
#   scripts/fresh.sh status | logs | down
#
# Settings (port, public url, host name, access code) are kept in ~/.config/weevils-fresh/. The container listens on
# 127.0.0.1:<port> only: put a reverse proxy in front for HTTPS (Caddy: reverse_proxy 127.0.0.1:<port>).
set -euo pipefail
root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
conf_dir=${XDG_CONFIG_HOME:-$HOME/.config}/weevils-fresh
conf=$conf_dir/env
image=weevils-fresh
name=weevils-fresh

mkdir -p "$conf_dir"
[ -f "$conf" ] || printf 'FRESH_PORT=4177\nFRESH_URL=\nFRESH_HOST=myserver\n' >"$conf"
# shellcheck disable=SC1090
. "$conf"
[ -s "$conf_dir/secret" ] || (umask 077 && head -c 9 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n' >"$conf_dir/secret")
secret=$(cat "$conf_dir/secret")
save() { printf 'FRESH_PORT=%s\nFRESH_URL=%s\nFRESH_HOST=%s\n' "$FRESH_PORT" "$FRESH_URL" "$FRESH_HOST" >"$conf"; }
run_heavy() { if command -v heavy >/dev/null; then heavy "$@"; else "$@"; fi; }

build() {
  local work; work=$(mktemp -d)
  trap 'rm -rf "$work"' RETURN
  # A clone of the committed HEAD, like a user's "git clone": no uncommitted file, no node_modules, no dist.
  git clone -q "$root" "$work/weevils"
  git -C "$work/weevils" remote set-url origin "$(git -C "$root" remote get-url origin 2>/dev/null || echo "$root")"
  cp "$root/scripts/fresh/Dockerfile" "$work/Dockerfile"
  echo "image from $(git -C "$work/weevils" log -1 --format='%h %s' | cut -c1-80)"
  run_heavy docker build -q -t "$image" "$work" >/dev/null
}

start() {
  docker image inspect "$image" >/dev/null 2>&1 || build
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" --hostname "$FRESH_HOST" --init --restart unless-stopped \
    --cpus 2 --memory 2g --pids-limit 1024 --security-opt no-new-privileges \
    -p "127.0.0.1:$FRESH_PORT:4179" -e FRESH_URL="$FRESH_URL" -e FRESH_SECRET="$secret" "$image" >/dev/null
  for _ in $(seq 1 40); do curl -fs "http://127.0.0.1:$FRESH_PORT/api/me" >/dev/null 2>&1 && break; sleep 0.5; done
  curl -fs "http://127.0.0.1:$FRESH_PORT/api/me" >/dev/null || { echo "weevilsd did not answer, see: $0 logs" >&2; exit 1; }
}

link() {
  local base=${FRESH_URL:-http://127.0.0.1:$FRESH_PORT}
  echo "$base/#k=$secret"
}

cmd=${1:-status}
shift || true
case "$cmd" in
  up)
    while [ $# -gt 0 ]; do
      case "$1" in
        --port) FRESH_PORT=$2; shift ;;
        --url) FRESH_URL=${2%/}; shift ;;
        --host) FRESH_HOST=$2; shift ;;
        *) echo "unknown option: $1" >&2; exit 1 ;;
      esac
      shift
    done
    save
    start
    link ;;
  reset) start; echo "blank again"; link ;;
  build) build; start; link ;;
  link) link ;;
  status) docker ps -a --filter "name=^$name$" --format '{{.Names}}: {{.Status}} ({{.Ports}})' ;;
  logs) exec docker logs -f --tail 100 "$name" ;;
  down) docker rm -f "$name" >/dev/null 2>&1 && echo "stopped" || echo "not running" ;;
  *) sed -n 2,14p "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
