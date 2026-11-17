#!/bin/bash
# What `curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh` answers on the fake Mac.
# Like the real installer: never as root, needs an administrator (sudo; with NONINTERACTIVE=1 it must need no
# password), creates the prefix (/opt/homebrew on Apple Silicon, /usr/local on Intel) for the person, installs the
# Command Line Tools, and tells how to put brew in the PATH (it does not do it).
set -u
state=/var/fakemac
abort() { printf '%s\n' "$@" >&2; exit 1; }
[ "$(id -u)" != 0 ] || abort "Don't run this as root!"
[ "${BASH_VERSION:-}" ] || abort "Bash is required to interpret this script."
# The real one switches to non-interactive when stdin is not a terminal.
[ -t 0 ] || NONINTERACTIVE=1
echo "homebrew-install noninteractive=${NONINTERACTIVE:-0}" >>"$state/calls.log"
if [ -n "${NONINTERACTIVE:-}" ]; then
  sudo -n -l mkdir >/dev/null 2>&1 || abort "Need sudo access on macOS (e.g. the user $(id -un) needs to be an Administrator)!"
else
  sudo -v || abort "Need sudo access on macOS (e.g. the user $(id -un) needs to be an Administrator)!"
fi
case "$(uname -m)" in arm64) prefix=/opt/homebrew ;; *) prefix=/usr/local ;; esac
echo "==> This script will install:"
echo "$prefix/bin/brew"
for d in bin sbin etc share Cellar; do
  sudo mkdir -p "$prefix/$d" || abort "Failed to create $prefix/$d"
  sudo chown "$(id -un)" "$prefix/$d"
done
[ "$prefix" = /usr/local ] || sudo chown "$(id -un)" "$prefix"
cp /opt/fakemac/brew "$prefix/bin/brew"
chmod 755 "$prefix/bin/brew"
rm -f "$state/no-clt"
echo "==> Installation successful!"
echo "==> Next steps:"
echo "- Run these commands in your terminal to add Homebrew to your PATH:"
echo "    eval \"\$($prefix/bin/brew shellenv)\""
