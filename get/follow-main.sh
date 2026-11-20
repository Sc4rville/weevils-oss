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
# Only a commit that passes the checks goes out (installs update themselves from it). They run here, once per commit,
# in a throwaway worktree: lint, the tests (each retried twice) and the build. Red stays on the last good commit and
# keeps its log in ~/.local/share/weevils-get/ci/. WEEVILS_GET_REQUIRE_CI=0 turns the gate off.
if [ "$new" != "$old" ] && [ "${WEEVILS_GET_REQUIRE_CI:-1}" != 0 ]; then
  verdicts=${GET_DATA:-$HOME/.local/share/weevils-get}/ci
  mkdir -p "$verdicts"
  v=$(cat "$verdicts/$new" 2>/dev/null || true)
  if [ -z "$v" ]; then
    wt=$(mktemp -d "${XDG_CACHE_HOME:-$HOME/.cache}/weevils-ci.XXXXXX")
    git -C "$live" worktree add -q --detach "$wt" "$new"
    if (cd "$wt" && npm ci --no-audit --no-fund && npm run lint && nice npx vitest run --retry 2 && npm run build) >"$verdicts/$new.log" 2>&1; then v=green; else v=red; fi
    git -C "$live" worktree remove --force "$wt" || rm -rf "$wt"
    echo "$v" >"$verdicts/$new"
    ls -1t "$verdicts" | tail -n +41 | sed "s|^|$verdicts/|" | xargs -r rm -f
  fi
  if [ "$v" != green ]; then echo "main ${new:0:7}: checks failed (see $verdicts/$new.log), staying on ${old:0:7}" >&2; new=$old; fi
fi
restart=0
if [ "$new" != "$old" ]; then
  changed=$(git -C "$live" diff --name-only "$old" "$new")
  git -C "$live" checkout -q --detach --force "$new"
  # What the service reads once, at start: its code, the install script it serves, the installer's step titles.
  if grep -qxE 'get/server\.mjs|get/bootstrap\.sh|get/release-key\.pub|install\.sh' <<<"$changed"; then restart=1
  else echo "get on ${new:0:7} (pages and assets only: no restart)"; fi
fi
# The bundle first (signed), then the service that serves the script checking it.
WEEVILS_GET_REV=$(git -C "$live" rev-parse HEAD) "$live/get/refresh-bundle.sh"
if [ "$restart" = 1 ]; then
  systemctl --user restart weevils-get
  echo "get restarted on ${new:0:7}"
fi
