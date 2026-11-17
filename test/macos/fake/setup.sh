#!/usr/local/bin/bash
# Turns the Alpine image into the fake Mac (run once, as root, by the Dockerfile). Layout:
#   /bin/bash, /bin/sh        bash 3.2.57, as on macOS (no other bash anywhere)
#   /bin, /usr/bin, …         what a Mac has out of the box: the GNU/busybox tools behind bsd-strict (same names, BSD
#                             rules), and fakes of the macOS-only commands (launchctl, security, sw_vers, pmset…)
#   /opt/real/bin             the real tools the wrappers run
#   /opt/real/hidden          commands a Mac does not have (sha256sum, setsid, timeout, getent, ip, ss…): out of the PATH
#   /opt/cellar/<formula>/bin what Homebrew brings (tmux, jq, node, qrencode): visible only after the fake `brew install`
#   /var/fakemac              state and logs: flag files (see fake/ctl), calls.log, gnuisms.log, forbidden.log
#   /Users/mac                the person: uid 501, group staff, not an administrator until `ctl sudo nopasswd`
set -euo pipefail
fake=/opt/fakemac real=/opt/real/bin hidden=/opt/real/hidden cellar=/opt/cellar state=/var/fakemac
bb=/bin/busybox
dirs="/usr/local/bin /usr/bin /bin /usr/sbin /sbin"
$bb mkdir -p "$real" "$hidden" "$state/launchd"
$bb chmod 755 "$fake"/*

# take <name> <dest dir> — moves a command out of the PATH into dest (every copy leaves the PATH, the first is kept).
take() {
  local n=$1 dest=$2 d kept=0 target
  for d in $dirs; do
    [ -e "$d/$n" ] || [ -L "$d/$n" ] || continue
    if [ "$kept" = 1 ]; then $bb rm -f "$d/$n"; continue; fi
    $bb mkdir -p "$dest"
    if [ -L "$d/$n" ]; then
      target=$($bb readlink "$d/$n")
      # A busybox applet keeps its name (busybox reads it); any other link is resolved.
      [ "$target" = /bin/busybox ] || target=$($bb realpath "$d/$n")
      $bb ln -s "$target" "$dest/$n"; $bb rm "$d/$n"
    else $bb mv "$d/$n" "$dest/$n"; fi
    kept=1
  done
  [ "$kept" = 1 ] || { echo "setup: $n is not in this image" >&2; return 1; }
}

# ---------------------------------------------------------------- bash 3.2 where macOS has it
$bb cp /usr/local/bin/bash /bin/bash
$bb rm -f /usr/local/bin/bash /usr/local/bin/bashbug /usr/local/bin/docker-entrypoint.sh

# ---------------------------------------------------------------- what only Homebrew brings
take tmux "$cellar/tmux/bin"
take jq "$cellar/jq/bin"
take qrencode "$cellar/qrencode/bin"
for c in node npm npx; do take "$c" "$cellar/node/bin"; done
# Homebrew's node tells npm its global prefix is Homebrew's (written by the fake `brew install node`).
: >"$state/npmrc"
$bb ln -sf "$state/npmrc" /usr/lib/node_modules/npm/npmrc

# ---------------------------------------------------------------- commands a Mac does not have
# (sha256sum and friends exist on macOS 13 and later, realpath too, readlink -f on 12.3 and later: hidden here, the
# scripts must also run on the Macs that lack them.)
for c in sha256sum sha1sum sha224sum sha384sum sha512sum md5sum b2sum setsid timeout getent ip ss nproc free \
  systemctl loginctl journalctl apt-get apt dpkg dnf yum pacman apk runuser useradd usermod userdel groupadd adduser \
  addgroup deluser tac shuf numfmt stdbuf realpath flock pidof nsenter unshare ionice chrt taskset lsblk fuser watch \
  wget pstree truncate xdg-open hostnamectl service; do
  take "$c" "$hidden" 2>/dev/null || true
done

# ---------------------------------------------------------------- BSD rules in front of the GNU tools
$bb rm -f /usr/bin/awk /bin/awk
$bb mv /usr/bin/nawk "$real/awk" # the "one true awk", the awk of macOS
for c in cat cp date df hostname ln ls mkdir mv ps rm sleep; do take "$c" "$real"; $bb ln -s "$fake/bsd-strict" "/bin/$c"; done
for c in sed stat readlink grep find tail head base64 xargs sort mktemp du install touch cut tr wc od paste; do
  take "$c" "$real"; $bb ln -s "$fake/bsd-strict" "/usr/bin/$c"
done
$bb ln -s "$fake/bsd-strict" /usr/bin/awk

# ---------------------------------------------------------------- fakes of the macOS commands
take uname "$real"
take curl "$real"
take uuidgen "$real"
take sudo "$hidden"
take crontab "$hidden" 2>/dev/null || true
take python3 "$real"
take git "$real"
for c in uname sw_vers security pmset uuidgen xcode-select caffeinate sudo open crontab curl; do $bb ln -s "$fake/$c" "/usr/bin/$c"; done
# git and python3 come with the Command Line Tools: without them, /usr/bin has stubs that fail (ctl clt off).
for c in python3 git; do $bb ln -s "$fake/clt-stub" "/usr/bin/$c"; done
$bb ln -s "$fake/launchctl" /bin/launchctl
take route "$hidden" 2>/dev/null || true
$bb ln -s "$fake/route" /sbin/route
for c in ipconfig scutil; do $bb ln -s "$fake/$c" "/usr/sbin/$c"; done

# ---------------------------------------------------------------- the person
$bb sed -i 's/^[^:]*:x:20:.*/staff:x:20:/' /etc/group
$bb grep -q '^staff:' /etc/group || echo 'staff:x:20:' >>/etc/group
$bb mkdir -p /Users
$hidden/adduser -D -h /Users/mac -u 501 -G staff -s /bin/bash mac
echo 'mac ALL=(ALL) NOPASSWD: ALL' >/etc/sudoers.d/mac
$bb chmod 440 /etc/sudoers.d/mac
$bb mkdir -p /var/folders/zz/fakemac/T
$bb chown -R 501:20 /var/folders/zz/fakemac
$bb chmod 700 /var/folders/zz/fakemac/T
$bb chmod 1777 "$state" "$state/launchd"
$bb chmod 666 "$state/npmrc"
echo arm64 >"$state/arch"
$bb chmod 666 "$state/arch"
# The local "GitHub" of the tests is copied in by docker cp, with the uid of the host.
printf '[safe]\n\tdirectory = *\n' >/etc/gitconfig

# ---------------------------------------------------------------- /bin/sh is bash 3.2 too (in POSIX mode)
$bb ln -sf bash /bin/sh
