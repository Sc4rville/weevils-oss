#!/usr/bin/env bash
# Keeps the bundle get serves on main: fetches origin/main and rebuilds the bundle when main moved (or the bundle is
# missing). Run by the weevils-get-bundle timer (every 2 minutes), so each push to main reaches new installs.
# Usage: get/refresh-bundle.sh [<out>]
set -euo pipefail
out=${1:-$HOME/.local/share/weevils-get/weevils.bundle}
here=$(cd "$(dirname "$0")" && pwd)
src=$(git -C "$here/.." rev-parse --show-toplevel)
git -C "$src" fetch -q origin main
rev=$(git -C "$src" rev-parse --verify 'origin/main^{commit}')
stamp="$out.rev"
[ -s "$out" ] && [ "$(cat "$stamp" 2>/dev/null)" = "$rev" ] && exit 0
"$here/make-bundle.sh" "$rev" "$out"
echo "$rev" > "$stamp"
# The public repository follows, with the same revision (secret scan first; see publish-oss.sh).
"$here/publish-oss.sh" "$rev" || echo "publish-oss failed for ${rev:0:7}" >&2
