#!/usr/bin/env bash
# Keeps the bundle get serves on main: fetches origin/main and rebuilds the bundle when main moved (or the bundle is
# missing). Run by the weevils-get-bundle timer (every 2 minutes), so each push to main reaches new installs.
# Usage: get/refresh-bundle.sh [<out>]
set -euo pipefail
out=${1:-$HOME/.local/share/weevils-get/weevils.bundle}
here=$(cd "$(dirname "$0")" && pwd)
src=$(git -C "$here/.." rev-parse --show-toplevel)
# The revision to publish: the one follow-main.sh chose (green CI), else origin/main.
if [ -n "${WEEVILS_GET_REV:-}" ]; then rev=$WEEVILS_GET_REV
else git -C "$src" fetch -q origin main; rev=$(git -C "$src" rev-parse --verify 'origin/main^{commit}'); fi
stamp="$out.rev"
# The key lives with a dedicated user when get/setup-signer.sh ran: sign through it.
[ -n "${WEEVILS_RELEASE_SIGNER:-}" ] || [ ! -x /usr/local/lib/weevils-sign ] || export WEEVILS_RELEASE_SIGNER="$here/signer-client.sh"
# The signed manifest of the same revision, for git clones of the repository (server/weevils-update fast-forwards to
# exactly this commit, and only when its signature checks): « weevils-release main <sha> », next to the bundle.
"$here/sign-main.sh" "$rev" "$(dirname "$out")/main.txt" || echo "sign-main failed for ${rev:0:7}: git clones stay where they are" >&2
[ -s "$out" ] && [ "$(cat "$stamp" 2>/dev/null)" = "$rev" ] && exit 0
"$here/make-bundle.sh" "$rev" "$out"
echo "$rev" > "$stamp"
# The public repository follows, with the same revision (secret scan first; see publish-oss.sh).
"$here/publish-oss.sh" "$rev" || echo "publish-oss failed for ${rev:0:7}" >&2
