#!/usr/bin/env bash
# get/server.mjs serves the code to the installs it starts and to the updates of installs made from it (GET_BUNDLE),
# signed, so they need nothing from GitHub. This builds that bundle: a single commit snapshot of a committed revision (no history, no author e-mail), without
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
# The same exclusions as the open-source export (scripts/release-policy.json): the bundle is downloadable by anyone,
# so private notes, reports and screenshots of the owner's instance never go in it.
python3 - "$work" "$src/scripts/release-policy.json" <<'PY'
import fnmatch, json, os, shutil, sys
root, policy = sys.argv[1], json.load(open(sys.argv[2]))
pats = policy["exclude"]
def gone(rel):
    return any(fnmatch.fnmatch(rel, p) or fnmatch.fnmatch(rel + "/", p) or (p.endswith("/**") and (rel == p[:-3] or rel.startswith(p[:-2]))) for p in pats)
for d, dirs, files in os.walk(root, topdown=True):
    rel_d = os.path.relpath(d, root)
    for n in list(dirs):
        rel = os.path.normpath(os.path.join(rel_d, n))
        if gone(rel):
            shutil.rmtree(os.path.join(d, n)); dirs.remove(n)
    for n in files:
        rel = os.path.normpath(os.path.join(rel_d, n))
        if gone(rel):
            os.remove(os.path.join(d, n))
PY
# Personal traces left in shipped files: refuse to publish rather than ship them.
# Looked for: the publisher's home folder and this machine's own addresses (none written here).
leak=(-e "$HOME/")
for ip in $(hostname -I 2>/dev/null); do case $ip in 127.*|10.*|172.*|192.168.*|::1|f[cd]*|fe80*) ;; *) leak+=(-e "$ip") ;; esac; done
if [ "$HOME" != / ] && grep -rIlF --exclude-dir=test --exclude='*.test.*' "${leak[@]}" "$work" >"$work.leaks" 2>/dev/null; then
  echo "make-bundle: personal traces in $(wc -l <"$work.leaks") file(s):" >&2; sed "s|$work/||" "$work.leaks" >&2; rm -f "$work.leaks"; exit 1
fi
rm -f "$work.leaks"
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
# Never an unsigned bundle where installs fetch it: no key or a failed signature stops here (WEEVILS_UNSIGNED_BUNDLE=1
# for a throwaway test bundle). WEEVILS_RELEASE_SIGNER: a command that signs <file> into <file>.sig with a key this
# user cannot read (get/sign-release.sh, run through sudo as a dedicated user).
if [ -n "${WEEVILS_RELEASE_SIGNER:-}" ]; then $WEEVILS_RELEASE_SIGNER "$out.tmp" || { echo "make-bundle: signing failed" >&2; rm -f "$out.tmp"; exit 1; }
elif [ -f "$key" ]; then ssh-keygen -q -Y sign -n weevils-release -f "$key" "$out.tmp" >/dev/null 2>&1 || { echo "make-bundle: signing failed" >&2; rm -f "$out.tmp"; exit 1; }
elif [ "${WEEVILS_UNSIGNED_BUNDLE:-}" != 1 ]; then echo "make-bundle: no release key ($key); set WEEVILS_UNSIGNED_BUNDLE=1 for a test bundle" >&2; rm -f "$out.tmp"; exit 1; fi
[ -f "$out.tmp.sig" ] || [ "${WEEVILS_UNSIGNED_BUNDLE:-}" = 1 ] || { echo "make-bundle: no signature produced" >&2; rm -f "$out.tmp"; exit 1; }
(cd "$(dirname "$out")" && sha256sum "$(basename "$out.tmp")" | sed 's/\.tmp$//') >"$out.sha256.tmp"
# The signature first, then the bundle: a download between the two moves fails its check and is tried again.
[ ! -f "$out.tmp.sig" ] || mv -f "$out.tmp.sig" "$out.sig"
mv -f "$out.sha256.tmp" "$out.sha256"
mv -f "$out.tmp" "$out"
echo "$out (${commit:0:7}, $(du -h "$out" | cut -f1))"
