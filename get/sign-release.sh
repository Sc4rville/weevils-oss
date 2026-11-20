#!/usr/bin/env bash
# Signs a release bundle read on stdin and writes the signature on stdout, with a key the publishing user cannot read.
# Installed root-owned as /usr/local/lib/weevils-sign and run as the weevils-signer user through one sudo rule
# (get/setup-signer.sh). make-bundle.sh calls it with WEEVILS_RELEASE_SIGNER=get/signer-client.sh.
set -euo pipefail
key=/var/lib/weevils-signer/release_ed25519
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
head -c 200000000 >"$work/bundle"
ssh-keygen -q -Y sign -n weevils-release -f "$key" "$work/bundle" >/dev/null 2>&1
cat "$work/bundle.sig"
