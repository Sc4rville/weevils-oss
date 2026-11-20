#!/usr/bin/env bash
# Run once as root on the publishing server: moves the release key out of the publisher's home into a dedicated
# weevils-signer user, which only signs (get/sign-release.sh). A session or automation running as the publisher can
# then no longer read the key and sign a bundle of its own. Usage: sudo get/setup-signer.sh <publisher user>
set -euo pipefail
pub=${1:?publisher user}
home=$(getent passwd "$pub" | cut -d: -f6)
src="$home/.config/weevils-get/release_ed25519"
id weevils-signer >/dev/null 2>&1 || useradd --system --home-dir /var/lib/weevils-signer --shell /usr/sbin/nologin weevils-signer
install -d -m 0700 -o weevils-signer -g weevils-signer /var/lib/weevils-signer
if [ -f "$src" ]; then
  install -m 0400 -o weevils-signer -g weevils-signer "$src" /var/lib/weevils-signer/release_ed25519
  install -m 0444 -o weevils-signer -g weevils-signer "$src.pub" /var/lib/weevils-signer/release_ed25519.pub
fi
[ -f /var/lib/weevils-signer/release_ed25519 ] || { echo "no release key at $src" >&2; exit 1; }
install -m 0755 -o root -g root "$(dirname "$0")/sign-release.sh" /usr/local/lib/weevils-sign
echo "$pub ALL=(weevils-signer) NOPASSWD: /usr/local/lib/weevils-sign" >/etc/sudoers.d/weevils-signer
chmod 0440 /etc/sudoers.d/weevils-signer
visudo -cf /etc/sudoers.d/weevils-signer >/dev/null
# Check it signs before removing the publisher's copy.
sig=$(echo test | sudo -n -u "$pub" sudo -n -u weevils-signer /usr/local/lib/weevils-sign)
case $sig in *"BEGIN SSH SIGNATURE"*) ;; *) echo "signer check failed; key left in place" >&2; exit 1 ;; esac
[ ! -f "$src" ] || shred -u "$src"
echo "ok: key in /var/lib/weevils-signer, publisher signs through /usr/local/lib/weevils-sign"
