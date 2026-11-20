#!/usr/bin/env bash
# Keeps the public repository (github.com/Sc4rville/weevils-oss) equal to what installs get: after each new bundle,
# the same revision is exported with scripts/release-policy.json (no history, no personal paths, no internal
# reports), scanned for secrets with gitleaks, and pushed as one commit « weevils <rev> » on top of the public main.
# A scan that finds anything but the known test fixtures publishes nothing. Usage: get/publish-oss.sh <rev>
# Off unless WEEVILS_PUBLISH_OSS=1 (in the environment, or in ~/.config/weevils-get/env).
set -euo pipefail
on=${WEEVILS_PUBLISH_OSS:-$(sed -n 's/^WEEVILS_PUBLISH_OSS=//p' "$HOME/.config/weevils-get/env" 2>/dev/null | tail -1)}
[ "$on" = 1 ] || exit 0
rev=${1:?rev}
here=$(cd "$(dirname "$0")" && pwd)
src=$(git -C "$here/.." rev-parse --show-toplevel)
state=${WEEVILS_OSS_DIR:-$HOME/.local/share/weevils-get/oss}
repo=${WEEVILS_OSS_REPO:-https://github.com/Sc4rville/weevils-oss.git}
mkdir -p "$state"
work=$(mktemp -d "$state/.work.XXXXXX")
trap 'rm -rf "$work"' EXIT
short=$(git -C "$src" rev-parse --short=7 "$rev")
[ "$(cat "$state/published" 2>/dev/null || true)" != "$short" ] || exit 0

(cd "$src" && python3 scripts/release.py export --source "$rev" --output "$work/snap.tar.gz" >/dev/null)
mkdir "$work/tree" && tar -xzf "$work/snap.tar.gz" -C "$work/tree"
tree=$work/tree/weevils
rm -f "$tree/release-manifest.json"
grep -rIl "$HOME" "$tree" | xargs -r sed -i "s|$HOME|/home/alex|g"
# The private repository's address becomes the public one (README, AGENTS.md, install.sh's clone).
grep -rIlE 'Sc4rville/weevils-oss([^-A-Za-z0-9_]|$)' "$tree" | xargs -r sed -i -E 's#Sc4rville/weevils-oss([^-A-Za-z0-9_]|$)#Sc4rville/weevils-oss\1#g'

# Secrets: gitleaks over the whole tree; only the known fake fixtures may show up.
docker run --rm -v "$tree:/src:ro" -v "$work:/out" zricethezav/gitleaks:latest dir /src --no-banner \
  --report-format json --report-path /out/leaks.json >/dev/null 2>&1 || true
[ -f "$work/leaks.json" ] || { echo "publish-oss: gitleaks did not run, nothing published" >&2; exit 1; }
left=$(jq -r '.[] | select(.File != "/src/server/memory.test.ts" and .File != "/src/server/weevil.test.ts") | "\(.RuleID) \(.File):\(.StartLine)"' "$work/leaks.json")
if [ -n "$left" ]; then echo "publish-oss: possible secrets, nothing published:" >&2; echo "$left" >&2; exit 1; fi

git clone -q --depth 1 "$repo" "$work/oss"
find "$work/oss" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -a "$tree/." "$work/oss/"
cd "$work/oss"
git add -A
git diff --cached --quiet && { echo "$short" >"$state/published"; exit 0; }
GIT_AUTHOR_NAME=weevils GIT_AUTHOR_EMAIL=205611309+Sc4rville@users.noreply.github.com GIT_COMMITTER_NAME=weevils \
  GIT_COMMITTER_EMAIL=205611309+Sc4rville@users.noreply.github.com git commit -q -m "weevils $short"
git push -q origin HEAD:main
echo "$short" >"$state/published"
echo "published weevils $short to $repo"
