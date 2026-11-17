#!/usr/bin/env bash
# Keeps get on main, every 2 minutes (the weevils-get-bundle timer): moves the live checkout this service runs from
# (~/.local/share/weevils-get/live) to origin/main, restarts the service when its own code changed, and rebuilds the
# bundle the installs download. A restart cuts nothing: the service finishes its requests and hands its setups in
# progress to the next run through RAM (get/server.mjs), and Caddy holds visitors' requests meanwhile
# (lb_try_duration). Usage: get/follow-main.sh (from the live checkout).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
live=$(git -C "$here/.." rev-parse --show-toplevel)
git -C "$live" fetch -q origin main
new=$(git -C "$live" rev-parse --verify 'origin/main^{commit}')
old=$(git -C "$live" rev-parse HEAD)
restart=0
if [ "$new" != "$old" ]; then
  changed=$(git -C "$live" diff --name-only "$old" "$new")
  git -C "$live" checkout -q --detach --force "$new"
  # What the service reads once, at start: its code, the install script it serves, the installer's step titles.
  if grep -qxE 'get/server\.mjs|get/bootstrap\.sh|get/release-key\.pub|install\.sh' <<<"$changed"; then restart=1
  else echo "get on ${new:0:7} (pages and assets only: no restart)"; fi
fi
# The bundle first (signed), then the service that serves the script checking it.
"$live/get/refresh-bundle.sh"
if [ "$restart" = 1 ]; then
  systemctl --user restart weevils-get
  echo "get restarted on ${new:0:7}"
fi
