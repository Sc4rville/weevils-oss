#!/usr/bin/env bash
# WEEVILS_RELEASE_SIGNER for make-bundle.sh: has <file> signed by the weevils-signer user into <file>.sig.
set -euo pipefail
sudo -n -u weevils-signer /usr/local/lib/weevils-sign <"$1" >"$1.sig.part"
grep -q "BEGIN SSH SIGNATURE" "$1.sig.part" || { rm -f "$1.sig.part"; exit 1; }
mv -f "$1.sig.part" "$1.sig"
