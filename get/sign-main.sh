#!/usr/bin/env bash
# Writes and signs the release manifest of a git clone's updates: one line, « weevils-release main <40-hex sha> », the
# exact main commit this service publishes after its checks (get/follow-main.sh → refresh-bundle.sh). An install
# cloned from GitHub fast-forwards to that commit only, and only when the signature checks against the release key of
# the version it runs (server/weevils-update). Signed like the bundle: WEEVILS_RELEASE_SIGNER (get/signer-client.sh,
# the key held by a dedicated user), else WEEVILS_RELEASE_KEY (default ~/.config/weevils-get/release_ed25519).
# Nothing is published unsigned. Usage: get/sign-main.sh <sha> <out, e.g. …/main.txt>
set -euo pipefail
sha=${1:?sha}
out=${2:?out}
[[ $sha =~ ^[0-9a-f]{40}$ ]] || { echo "sign-main: not a full commit sha: $sha" >&2; exit 1; }
line="weevils-release main $sha"
# Already published for this commit, with its signature: nothing to do.
[ "$(cat "$out" 2>/dev/null || true)" = "$line" ] && [ -s "$out.sig" ] && exit 0
mkdir -p "$(dirname "$out")"
tmp=$out.tmp
rm -f "$tmp" "$tmp.sig"
printf '%s\n' "$line" >"$tmp"
key=${WEEVILS_RELEASE_KEY:-$HOME/.config/weevils-get/release_ed25519}
if [ -n "${WEEVILS_RELEASE_SIGNER:-}" ]; then $WEEVILS_RELEASE_SIGNER "$tmp" || { echo "sign-main: signing failed" >&2; rm -f "$tmp"; exit 1; }
elif [ -f "$key" ]; then ssh-keygen -q -Y sign -n weevils-release -f "$key" "$tmp" >/dev/null 2>&1 || { echo "sign-main: signing failed" >&2; rm -f "$tmp"; exit 1; }
else echo "sign-main: no release key ($key)" >&2; rm -f "$tmp"; exit 1; fi
grep -q "BEGIN SSH SIGNATURE" "$tmp.sig" 2>/dev/null || { echo "sign-main: no signature produced" >&2; rm -f "$tmp" "$tmp.sig"; exit 1; }
# The signature first, then the line: a download between the two moves fails its check and is tried again later.
mv -f "$tmp.sig" "$out.sig"
mv -f "$tmp" "$out"
