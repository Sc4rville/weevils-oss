#!/usr/bin/env bash
# Every day (the weevils-get-backup timer): get's install register and its records, copied into the private repository
# Sc4rville/weevils-stats, so that the trace outlives this machine. Anonymous data only: no address, no e-mail, no
# identifier. The daily counters stay on this machine (kept 90 days). Usage: get/backup-stats.sh [<data dir>]
set -euo pipefail
data=${1:-${GET_DATA:-$HOME/.local/share/weevils-get}}
repo=${GET_STATS_REPO:-https://github.com/Sc4rville/weevils-stats.git}
clone=$data/backup
[ -d "$clone/.git" ] || git clone -q "$repo" "$clone"
git -C "$clone" pull -q --ff-only 2>/dev/null || true
for f in installs.csv records.json; do [ ! -f "$data/$f" ] || cp "$data/$f" "$clone/$f"; done
cd "$clone"
git add -A
git diff --cached --quiet && exit 0
GIT_AUTHOR_NAME=weevils GIT_AUTHOR_EMAIL=weevils@users.noreply.github.com GIT_COMMITTER_NAME=weevils GIT_COMMITTER_EMAIL=weevils@users.noreply.github.com \
  git commit -q -m "stats $(date -u +%F)"
git push -q origin HEAD
echo "backed up: $(($(wc -l <installs.csv 2>/dev/null || echo 1) - 1)) installs"
