#!/usr/bin/env bash
# While the weevils repository is private, get/server.mjs serves the code to the installs it starts (GET_BUNDLE).
# This builds that bundle: a single commit snapshot of a committed revision (no history, no author e-mail), without
# the paths that must not be redistributed. Usage: get/make-bundle.sh [<rev>] [<out>] [<checkout>]
# <checkout> is the clone to take <rev> from (default: the one this script is in). The bundle is what an install
# gets: for Mac visitors, <rev> must hold the installer that supports macOS.
set -euo pipefail
rev=${1:-HEAD}
out=${2:-$HOME/.local/share/weevils-get/weevils.bundle}
src=$(git -C "${3:-$(dirname "$0")/..}" rev-parse --show-toplevel)
commit=$(git -C "$src" rev-parse --verify "$rev^{commit}")
# Built next to the bundle, not in /tmp (a full /tmp must not leave installs with an old or unsigned bundle).
mkdir -p "$(dirname "$out")"
work=$(mktemp -d "$(dirname "$out")/.bundle-work.XXXXXX")
trap 'rm -rf "$work"' EXIT
git -C "$src" archive "$commit" | tar -x -C "$work"
rm -rf "$work/harness-interface-kit" "$work/harness-interface-kit.zip" "$work/content" "$work/docs/incidents"
cd "$work"
git init -q -b main
git add -A
GIT_AUTHOR_NAME=weevils GIT_AUTHOR_EMAIL=weevils@users.noreply.github.com GIT_COMMITTER_NAME=weevils GIT_COMMITTER_EMAIL=weevils@users.noreply.github.com \
  git commit -q -m "weevils ${commit:0:7}"
mkdir -p "$(dirname "$out")"
git bundle create -q "$out.tmp" HEAD main
# Signed with the release key (get/release-key.pub is its public half, pinned in the install script and weevils-update):
# an install or an update refuses a bundle whose signature does not check. WEEVILS_RELEASE_KEY, default
# ~/.config/weevils-get/release_ed25519; no key, no signature (a test bundle).
key=${WEEVILS_RELEASE_KEY:-$HOME/.config/weevils-get/release_ed25519}
rm -f "$out.tmp.sig"
if [ -f "$key" ]; then ssh-keygen -q -Y sign -n weevils-release -f "$key" "$out.tmp" >/dev/null 2>&1; fi
(cd "$(dirname "$out")" && sha256sum "$(basename "$out.tmp")" | sed 's/\.tmp$//') >"$out.sha256.tmp"
# The signature first, then the bundle: a download between the two moves fails its check and is tried again.
[ ! -f "$out.tmp.sig" ] || mv -f "$out.tmp.sig" "$out.sig"
mv -f "$out.sha256.tmp" "$out.sha256"
mv -f "$out.tmp" "$out"
echo "$out (${commit:0:7}, $(du -h "$out" | cut -f1))"
