#!/usr/bin/env bash
# Tests install.sh on a fake Mac, in Docker: the bash 3.2 of macOS, BSD rules in front of the GNU tools (fake/bsd-strict),
# fakes of launchd, Homebrew, the Keychain, sudo… (fake/). One command, ends with PASS or FAIL.
#
#   test/macos/run.sh             all scenarios
#   test/macos/run.sh <name>      one of: brew nobrew password intel ssh
#
# It installs the HEAD commit of this repo (commit first). KEEP=1 keeps the containers. What it can't prove: node runs
# as Linux in the container (process.platform is "linux"), so the server's own macOS branches are only unit-tested;
# launchd, Homebrew and the Keychain are fakes. docs/ci/macos.yml runs test/macos/real-mac.sh on a real Mac.
set -uo pipefail
root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
only=${1:-all}
image=weevils-mac-test-img:$$
work=$(mktemp -d)
containers=()
fails=0 passes=0

cleanup() {
  if [ "${KEEP:-0}" = 1 ]; then echo "kept: ${containers[*]:-}"; else
    for c in ${containers[@]+"${containers[@]}"}; do docker rm -f "$c" >/dev/null 2>&1; done
    docker image rm "$image" >/dev/null 2>&1
  fi
  rm -rf "$work"
}
trap cleanup EXIT
say() { printf '\n\e[30;43m %s \e[0m\n' "$*"; }
run_heavy() { if command -v heavy >/dev/null 2>&1; then heavy "$@"; else "$@"; fi; }
check() { # check "description" command…
  local d=$1; shift
  if "$@" >"$work/out" 2>&1; then passes=$((passes + 1)); printf '  \e[32mok\e[0m   %s\n' "$d"
  else fails=$((fails + 1)); printf '  \e[31mFAIL\e[0m %s\n' "$d"; sed 's/^/       /' "$work/out" | tail -15; fi
}
sum() { sed -n '/^--- weevils summary ---$/,/^--- end ---$/p' "$work/$1.log" | sed -n "s/^$2=//p" | tail -1; }
in_mac() { docker exec "$c" bash -c "$1"; }
up() { in_mac 'n=0; until curl -sf -m 2 -o /dev/null 127.0.0.1:4179/api/me; do n=$((n+1)); [ $n -lt 30 ] || exit 1; sleep 1; done'; }
down() { in_mac 'n=0; while curl -sf -m 2 -o /dev/null 127.0.0.1:4179/api/me; do n=$((n+1)); [ $n -lt 20 ] || exit 1; sleep 1; done'; }
no_gnuisms() { in_mac '! [ -s /var/fakemac/gnuisms.log ] || { cat /var/fakemac/gnuisms.log; exit 1; }'; }

# new_mac <name> <ctl…>: a fresh fake Mac with this repo's HEAD as its "GitHub", set up by fake/ctl.
new_mac() {
  c=weevils-mac-test-$1-$$; shift
  containers+=("$c")
  docker run -d --name "$c" "$image" >/dev/null
  docker cp "$work/weevils.git" "$c:/srv/weevils.git"
  docker exec -u 0 "$c" sh -c 'chown -R 501:20 /srv/weevils.git; for x in git-upload-pack git-receive-pack; do ln -sf /opt/real/bin/git /opt/real/bin/$x; done'
  local x; for x in "$@"; do docker exec -u 0 "$c" /opt/fakemac/ctl $x; done
}
# install <log> <args…>: clone, then ./install.sh, as the person.
install() {
  local log=$1; shift
  in_mac "cd ~ && { [ -d weevils ] || git clone -q /srv/weevils.git weevils; } && cd weevils && git remote set-url origin /srv/weevils.git && ./install.sh $*" >"$work/$log.log" 2>&1
  echo $? >"$work/$log.rc"
}
rc() { cat "$work/$1.rc"; }

say "building the fake Mac"
ctx=$work/ctx; mkdir -p "$ctx"
cp -a "$root/test/macos/Dockerfile" "$root/test/macos/fake" "$root/package.json" "$root/package-lock.json" "$ctx/"
run_heavy docker build -q -t "$image" "$ctx" >/dev/null || { echo "FAIL docker build"; exit 1; }
git clone -q --bare "$root" "$work/weevils.git"
echo "testing $(git -C "$root" log -1 --format='%h %s')"

if [ "$only" = all ] || [ "$only" = brew ]; then
  say "brew: Apple Silicon, Homebrew there, a session on the screen"
  new_mac brew brew
  install brew --agent --lang en
  check "exit code 0" [ "$(rc brew)" = 0 ]
  check "status=ok, os=macos, arch=arm64, service=launchd" [ "$(sum brew status) $(sum brew os) $(sum brew arch) $(sum brew service)" = "ok macos arm64 launchd" ]
  check "the plist: label, node from Homebrew, KeepAlive, AbandonProcessGroup, PATH, LANG" in_mac 'python3 - <<EOF
import plistlib, os
d = plistlib.load(open(os.path.expanduser("~/Library/LaunchAgents/com.github.sc4rville.weevilsd.plist"), "rb"))
assert d["Label"] == "com.github.sc4rville.weevilsd" and d["ProgramArguments"] == ["/opt/homebrew/bin/node", "server/index.ts"], d
assert d["KeepAlive"] and d["RunAtLoad"] and d["AbandonProcessGroup"], d
p = d["EnvironmentVariables"]["PATH"].split(":")
assert "/opt/homebrew/bin" in p and os.path.expanduser("~/.local/bin") in p and len(p) == len(set(p)), p
assert d["EnvironmentVariables"]["LANG"].endswith("UTF-8"), d
EOF'
  check "weevilsd answers, started by launchd" up
  check "weevils-service status: running under launchd" in_mac '~/.local/bin/weevils-service status | grep -q "running (pid [0-9]*, launchd)"'
  check "the hooks are in ~/.claude/settings.json" in_mac 'grep -q weevils-hook ~/.claude/settings.json'
  check "restart: a new pid, answers again" in_mac 'p() { launchctl print gui/501/com.github.sc4rville.weevilsd | sed -n "s/^[[:space:]]*pid = \([0-9]*\).*/\1/p"; }; a=$(p); ~/.local/bin/weevils-service restart >/dev/null; sleep 3; b=$(p); [ -n "$b" ] && [ "$a" != "$b" ]'
  check "killed: launchd starts it again" in_mac 'kill -9 $(launchctl print gui/501/com.github.sc4rville.weevilsd | sed -n "s/^[[:space:]]*pid = \([0-9]*\).*/\1/p"); sleep 8'
  check "  … and it answers" up
  in_mac '~/.local/bin/weevils-service stop' >/dev/null 2>&1
  check "stop: nothing answers" down
  in_mac '~/.local/bin/weevils-service start' >/dev/null 2>&1
  check "start: it answers" up
  code=$(in_mac 'cat ~/.config/weevils/secret')
  install brew2 --agent --lang en
  check "a second run: status=ok, same access code" [ "$(sum brew2 status) $(in_mac 'cat ~/.config/weevils/secret')" = "ok $code" ]
  check "--domain is refused on a Mac" in_mac '! ~/weevils/install.sh --agent --domain example.com >/tmp/d.log 2>&1 && grep -q "status=failed" /tmp/d.log'
  check "no crontab, no GNU-only usage" sh -c "docker exec $c sh -c '! grep -q crontab /var/fakemac/calls.log'"
  check "  (gnuisms.log empty)" no_gnuisms
  in_mac '~/weevils/install.sh --uninstall --yes' >/dev/null 2>&1
  check "uninstall: plist and commands gone, nothing answers" in_mac '[ ! -e ~/Library/LaunchAgents/com.github.sc4rville.weevilsd.plist ] && [ ! -e ~/.local/bin/weevils-service ]'
  check "  … nothing answers" down
fi

if [ "$only" = all ] || [ "$only" = nobrew ]; then
  say "nobrew: Apple Silicon, no Homebrew, sudo without a password, Claude Code's login in the Keychain"
  new_mac nobrew "sudo nopasswd" "keychain on"
  install nobrew --agent --lang fr
  check "status=ok, Homebrew installed by the installer" sh -c "[ '$(sum nobrew status)' = ok ] && docker exec $c grep -q homebrew-install /var/fakemac/calls.log"
  check "claude_logged=yes from the Keychain" [ "$(sum nobrew claude_logged)" = yes ]
  check "weevilsd answers" up
  check "no GNU-only usage" no_gnuisms
fi

if [ "$only" = all ] || [ "$only" = password ]; then
  say "password: Apple Silicon, no Homebrew, sudo wants a password, run by an agent"
  new_mac password
  install password --agent --lang en
  check "exit code 3, status=needs_sudo, needs=Homebrew" [ "$(rc password) $(sum password status) $(sum password needs)" = "3 needs_sudo Homebrew" ]
  check "retry is the same install, without --agent" sh -c "[ '$(sum password retry)' = 'cd /Users/mac/weevils && ./install.sh --lang en' ]"
  check "nothing installed" in_mac '[ ! -e ~/Library/LaunchAgents/com.github.sc4rville.weevilsd.plist ] && [ ! -e ~/.config/weevils/env ]'
fi

if [ "$only" = all ] || [ "$only" = intel ]; then
  say "intel: Intel Mac, no Homebrew, tools missing"
  new_mac intel "arch x86_64" "sudo nopasswd"
  install intel --agent --lang en
  check "status=failed, names the missing tools, Homebrew's installer never fetched" sh -c "[ '$(sum intel status)' = failed ] && grep -q 'Missing: tmux jq node' '$work/intel.log' && ! docker exec $c grep -q homebrew-install /var/fakemac/calls.log"
  check "nothing installed" in_mac '[ ! -e ~/.config/weevils/env ]'
fi

if [ "$only" = all ] || [ "$only" = ssh ]; then
  say "ssh: no session on the Mac's screen (SSH only)"
  new_mac ssh brew "gui off"
  install ssh --agent --lang en
  check "status=ok, service=background, no plist" sh -c "[ '$(sum ssh status) $(sum ssh service)' = 'ok background' ] && docker exec $c sh -c '[ ! -e ~/Library/LaunchAgents/com.github.sc4rville.weevilsd.plist ]'"
  check "weevilsd answers" up
  in_mac '~/.local/bin/weevils-service stop' >/dev/null 2>&1
  check "stop: nothing answers (without setsid)" down
  in_mac '~/.local/bin/weevils-service start' >/dev/null 2>&1
  check "start: it answers" up
  check "no GNU-only usage" no_gnuisms
fi

echo
if [ "$fails" = 0 ]; then echo "PASS ($passes checks)"; else echo "FAIL ($fails of $((passes + fails)) checks)"; exit 1; fi
