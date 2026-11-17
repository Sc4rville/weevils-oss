#!/bin/bash
# weevils on a real Mac: installs it for real from this checkout, checks the launchd service, tmux, the Keychain
# login, restart and uninstall. Meant for a throwaway Mac (a GitHub Actions macOS runner): it installs into the
# real HOME of whoever runs it and removes everything at the end.
#
#   /bin/bash test/macos/real-mac.sh          RUN_UNIT=1 also runs the unit tests on the Mac
#
# Ends with PASS or FAIL and the list of what failed. Runs under macOS's own bash 3.2.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
root=$PWD
fails=0 passes=0 failed=''
log=$HOME/weevils-install.log
out=$(mktemp)

say() { printf '\n== %s ==\n' "$*"; }
check() { # check "description" command…
  local d=$1; shift
  if "$@" >"$out" 2>&1; then passes=$((passes + 1)); printf '  ok   %s\n' "$d"
  else fails=$((fails + 1)); failed="$failed
  - $d"; printf '  FAIL %s\n' "$d"; sed 's/^/       /' "$out" | tail -20; fi
}
note() { printf '  ·    %s\n' "$*"; }
# The access code never goes to the job's log.
mask() { sed -e 's/^code=.*/code=***/' -e 's/#k=[A-Za-z0-9_-]*/#k=***/g' -e 's/\(code[^:]*: \).*/\1***/'; }
sum() { sed -n '/^--- weevils summary ---$/,/^--- end ---$/p' "$log" | sed -n "s/^$1=//p" | tail -1; }
has() { grep -q -- "$1"; }
uid=$(id -u)
label=com.github.sc4rville.weevilsd
plist=$HOME/Library/LaunchAgents/$label.plist
svc=$HOME/.local/bin/weevils-service
up() { curl -sf -m 3 "http://127.0.0.1:$port/api/me" >/dev/null; }
wait_up() { local n=0; while ! up && [ "$n" -lt 40 ]; do sleep 0.5; n=$((n + 1)); done; up; }
wait_down() { local n=0; while up && [ "$n" -lt 40 ]; do sleep 0.5; n=$((n + 1)); done; ! up; }
daemon_pid() { launchctl print "gui/$uid/$label" 2>/dev/null | sed -n 's/^[[:space:]]*pid = \([0-9][0-9]*\).*/\1/p' | head -1; }

say "the machine"
sw_vers 2>&1 | sed 's/^/  /'
note "arch $(uname -m), /bin/bash $(/bin/bash -c 'echo $BASH_VERSION')"
note "brew: $(command -v brew || echo none) $(brew --version 2>/dev/null | head -1)"
note "node: $(command -v node || echo none) $(node -v 2>/dev/null)"
note "tmux: $(command -v tmux || echo none)  jq: $(command -v jq || echo none)  python3: $(command -v python3 || echo none)  qrencode: $(command -v qrencode || echo none)"
note "sudo without a password: $(sudo -n true 2>/dev/null && echo yes || echo no)"
note "a session on the screen (launchctl print gui/$uid): $(launchctl print "gui/$uid" >/dev/null 2>&1 && echo yes || echo no)"
note "LANG=${LANG:-} LC_ALL=${LC_ALL:-}"
note "openssl: $(openssl version 2>&1)"

say "the scripts parse under bash 3.2"
for f in install.sh server/install.sh server/weevils-service server/weevils-cli server/wv; do
  check "bash -n $f" /bin/bash -n "$f"
done
check "sh -n server/hook.sh" /bin/sh -n server/hook.sh

say "install (./install.sh --agent --lang en)"
start=$(date +%s)
/bin/bash ./install.sh --agent --lang en >"$log" 2>&1
rc=$?
note "exit code $rc, $(($(date +%s) - start)) s"
mask <"$log" | sed 's/^/  | /'
check "exit code 0" [ "$rc" = 0 ]
check "the summary ends the output" [ "$(tail -1 "$log")" = '--- end ---' ]
check "status=ok" [ "$(sum status)" = ok ]
check "os=macos" [ "$(sum os)" = macos ]
check "arch=$(uname -m)" [ "$(sum arch)" = "$(uname -m)" ]
check "mode=local" [ "$(sum mode)" = local ]
check "claude_installed=yes (the official installer works on this Mac)" [ "$(sum claude_installed)" = yes ]
port=$(sum port); port=${port:-4179}
check "no GNU tool was missed (no 'command not found' or 'illegal option' in the log)" sh -c "! grep -nEi 'command not found|illegal option|invalid option|unrecognized option|usage: (sed|date|stat|mktemp|readlink|base64|tail|grep)' '$log'"

say "the service (launchd)"
mode=$("$svc" mode 2>&1)
note "weevils-service mode: $mode"
check "mode is launchd" [ "$mode" = launchd ]
check "the plist exists" [ -f "$plist" ]
check "plutil -lint" plutil -lint "$plist"
plutil -p "$plist" 2>&1 | sed 's/^/  | /'
check "launchd runs it" sh -c "launchctl print gui/$uid/$label | grep -q 'state = running'"
check "weevilsd answers on 127.0.0.1:$port" wait_up
check "weevils-service status says running" sh -c "'$svc' status | grep -q 'weevilsd: running'"
"$svc" status 2>&1 | sed 's/^/  | /'
check "the log file is written" [ -s "$HOME/.local/share/weevils/weevilsd.log" ]
tail -5 "$HOME/.local/share/weevils/weevilsd.log" 2>/dev/null | sed 's/^/  | /'
check "the Mac is kept awake while weevilsd runs (caffeinate -s -w <pid>)" sh -c "pgrep -fl caffeinate | grep -q -- '-s -w $(daemon_pid)'"
check "the commands are in ~/.local/bin" sh -c "[ -x ~/.local/bin/wv ] && [ -x ~/.local/bin/weevils ] && [ -x ~/.local/bin/weevils-hook ] && [ -x ~/.local/bin/weevils-service ]"
check "the Claude Code hooks are in ~/.claude/settings.json" sh -c "jq -e '.hooks.Stop[0].hooks[0].command | endswith(\"/weevils-hook\")' ~/.claude/settings.json"
check "no crontab line" sh -c "! crontab -l 2>/dev/null | grep -q weevils"
check "the app is served" sh -c "curl -sf -m 5 http://127.0.0.1:$port/ | grep -qi '<html'"
check "the access code logs in" sh -c "curl -sf -m 5 -o /dev/null -X POST -H 'content-type: application/json' -d \"{\\\"secret\\\":\\\"\$(cat ~/.config/weevils/secret)\\\"}\" http://127.0.0.1:$port/api/login"

say "the Keychain (Claude Code's login on a Mac)"
note "before: claude_logged=$(sum claude_logged)"
if security add-generic-password -U -s 'Claude Code-credentials' -a "$(id -un)" \
  -w '{"claudeAiOauth":{"accessToken":"not-a-real-token","subscriptionType":"max","rateLimitTier":"default_claude_max_20x","expiresAt":4102444800000}}' >"$out" 2>&1; then
  keychain=1
  check "the entry is seen without reading the secret" security find-generic-password -s 'Claude Code-credentials'
  check "the secret reads back as JSON" sh -c "security find-generic-password -s 'Claude Code-credentials' -w | jq -e '.claudeAiOauth.subscriptionType == \"max\"'"
else
  keychain=0
  note "the Keychain can't be written here: $(tail -1 "$out")"
fi

say "a session in tmux, started by weevilsd under launchd"
# A stand-in for Claude Code: it notes the environment it was started with, then waits like a real session.
real_claude=$(command -v claude || echo "$HOME/.local/bin/claude")
note "claude: $real_claude ($("$real_claude" --version 2>&1 | head -1))"
mkdir -p "$HOME/.local/share/weevils-test"
[ ! -e "$real_claude" ] || mv "$real_claude" "$HOME/.local/share/weevils-test/claude.real"
mkdir -p "$HOME/.local/bin"
cat >"$HOME/.local/bin/claude" <<EOF
#!/bin/bash
{ echo "ARGS=\$*"; echo "PATH=\$PATH"; echo "LANG=\${LANG:-}"; echo "TMUX=\${TMUX:-}"; command -v tmux jq node git; security find-generic-password -s 'Claude Code-credentials' >/dev/null 2>&1 && echo KEYCHAIN=reachable || echo KEYCHAIN=unreachable; } >"$HOME/.local/share/weevils-test/claude.env" 2>&1
case "\${1:-}" in --version) echo "2.0.0 (Claude Code)"; exit 0 ;; esac
echo "été — session de test"
exec sleep 600
EOF
chmod 755 "$HOME/.local/bin/claude"
mkdir -p "$HOME/projects/demo-été" && git -C "$HOME/projects/demo-été" init -q 2>/dev/null
sleep 6 # the daemon rescans the project folders
"$HOME/.local/bin/weevils" projects 2>&1 | sed 's/^/  | /'
proj=$(curl -sf -m 8 "http://127.0.0.1:$port/api/snapshot" | jq -r '.projects[] | select(.name | test("demo")) | .id' | head -1)
note "project id: ${proj:-none}"
check "the daemon lists the project (a folder name with an accent)" [ -n "$proj" ]
new=$("$HOME/.local/bin/weevils" new "${proj:-demo}" "say hello — été" 2>&1)
note "weevils new: $new"
sleep 4
tmux -u -L weevils list-sessions 2>&1 | sed 's/^/  | /'
check "a wv-* tmux session exists on the weevils socket" sh -c "tmux -u -L weevils list-sessions -F '#{session_name}' | grep -q '^wv-'"
curl -sf -m 8 "http://127.0.0.1:$port/api/snapshot" | jq -c '.sessions[] | {id: .id[0:8], tool, status, title, cwd: (.cwd // .projectId)}' 2>&1 | sed 's/^/  | /'
check "the daemon lists the session (tmux output parsed under launchd's environment)" sh -c "curl -sf -m 8 http://127.0.0.1:$port/api/snapshot | jq -e '[.sessions[] | select(.status != \"done\")] | length >= 1'"
check "weevils sessions prints it" sh -c "'$HOME/.local/bin/weevils' sessions | grep -q claude"
sed 's/^/  | /' "$HOME/.local/share/weevils-test/claude.env" 2>/dev/null
check "the agent's PATH has Homebrew and ~/.local/bin" sh -c "grep '^PATH=' '$HOME/.local/share/weevils-test/claude.env' | grep -q '$(brew --prefix)/bin' && grep '^PATH=' '$HOME/.local/share/weevils-test/claude.env' | grep -q '$HOME/.local/bin'"
check "the agent's locale is UTF-8" sh -c "grep '^LANG=' '$HOME/.local/share/weevils-test/claude.env' | grep -qi 'utf-8'"
[ "$keychain" = 0 ] || check "the Keychain is reachable from an agent in a tmux pane" grep -q KEYCHAIN=reachable "$HOME/.local/share/weevils-test/claude.env"
check "wv ls lists it" sh -c "cd '$HOME/projects/demo-été' && '$HOME/.local/bin/wv' ls | grep -q '^wv-'"

say "restart, stop, start, crash"
before=$(daemon_pid)
"$svc" restart >"$out" 2>&1; rc=$?
check "weevils-service restart" [ "$rc" = 0 ]
check "it answers again" wait_up
after=$(daemon_pid)
note "pid $before → $after"
check "a new process" sh -c "[ -n '$after' ] && [ '$before' != '$after' ]"
check "the tmux session survived the restart" sh -c "tmux -u -L weevils list-sessions -F '#{session_name}' | grep -q '^wv-'"
check "the daemon still lists the session" sh -c "sleep 3; curl -sf -m 8 http://127.0.0.1:$port/api/snapshot | jq -e '[.sessions[] | select(.status != \"done\")] | length >= 1'"
"$svc" stop >"$out" 2>&1
check "stop: nothing answers" wait_down
check "stop: launchd no longer has it" sh -c "! launchctl print gui/$uid/$label >/dev/null 2>&1"
check "stop: the tmux session is still there" sh -c "tmux -u -L weevils list-sessions -F '#{session_name}' | grep -q '^wv-'"
"$svc" start >"$out" 2>&1
check "start: it answers" wait_up
pid=$(daemon_pid)
[ -z "$pid" ] || kill -9 "$pid"
sleep 2
check "killed: launchd starts it again" sh -c 'n=0; while ! curl -sf -m 3 http://127.0.0.1:'"$port"'/api/me >/dev/null && [ $n -lt 60 ]; do sleep 0.5; n=$((n+1)); done; curl -sf -m 3 http://127.0.0.1:'"$port"'/api/me >/dev/null'
note "pid $pid → $(daemon_pid)"

say "a second run changes nothing"
code_before=$(cat "$HOME/.config/weevils/secret")
/bin/bash ./install.sh --agent --lang en >"$log" 2>&1; rc=$?
check "exit code 0" [ "$rc" = 0 ]
check "status=ok" [ "$(sum status)" = ok ]
check "same access code" [ "$(cat "$HOME/.config/weevils/secret")" = "$code_before" ]
check "it answers" wait_up
[ "$keychain" = 0 ] || check "claude_logged=yes (from the Keychain)" [ "$(sum claude_logged)" = yes ]
[ "$keychain" = 0 ] || check "ready=yes" [ "$(sum ready)" = yes ]
note "projects=$(sum projects) repos=$(sum repos) laptop=$(sum laptop) sudo=$(sum sudo) tailscale=$(sum tailscale)"

say "refusals"
/bin/bash ./install.sh --agent --domain example.com >"$out" 2>&1; rc=$?
check "--domain is refused on a Mac" sh -c "[ $rc != 0 ] && grep -q 'status=failed' '$out' && grep -qi 'macOS' '$out'"
check "the service still runs after the refusal" up

if [ "${RUN_UNIT:-0}" = 1 ]; then
  say "the unit tests, on this Mac"
  (npx vitest run >"$HOME/vitest.log" 2>&1; echo "exit=$?" >>"$HOME/vitest.log") || true
  tail -40 "$HOME/vitest.log" | sed 's/^/  | /'
  grep -E '^ (FAIL|×)|FAIL ' "$HOME/vitest.log" | sort -u | head -60 | sed 's/^/  | /'
  check "vitest run" grep -q '^exit=0$' "$HOME/vitest.log"
fi

say "uninstall"
/bin/bash ./install.sh --uninstall --yes >"$out" 2>&1; rc=$?
mask <"$out" | sed 's/^/  | /'
check "exit code 0" [ "$rc" = 0 ]
check "nothing answers" wait_down
check "the plist is gone" [ ! -e "$plist" ]
check "launchd no longer has it" sh -c "! launchctl print gui/$uid/$label >/dev/null 2>&1"
check "the commands are gone" sh -c "[ ! -e ~/.local/bin/wv ] && [ ! -e ~/.local/bin/weevils ] && [ ! -e ~/.local/bin/weevils-service ] && [ ! -e ~/.local/bin/weevils-hook ]"
check "the hooks are gone" sh -c "! grep -q weevils-hook ~/.claude/settings.json"
check "the settings and the access code are kept" [ -s "$HOME/.config/weevils/secret" ]
tmux -u -L weevils kill-server 2>/dev/null || true

say "a piped install (curl | bash style), in French, into another folder"
rm -rf "$HOME/.config/weevils" "$HOME/.local/share/weevils"
WEEVILS_REPO="file://$root" /bin/bash -c "cat '$root/install.sh' | /bin/bash -s -- --agent --lang fr --dir '$HOME/weevils-piped'" >"$log" 2>&1; rc=$?
mask <"$log" | tail -45 | sed 's/^/  | /'
check "exit code 0" [ "$rc" = 0 ]
check "status=ok" [ "$(sum status)" = ok ]
check "lang=fr" [ "$(sum lang)" = fr ]
check "it runs from the new folder" sh -c "plutil -p '$plist' | grep -q '$HOME/weevils-piped'"
port=$(sum port); port=${port:-4179}
check "it answers" wait_up
/bin/bash "$HOME/weevils-piped/install.sh" --uninstall --purge --yes >"$out" 2>&1; rc=$?
check "uninstall --purge" [ "$rc" = 0 ]
check "settings and data are gone" sh -c "[ ! -e ~/.config/weevils ] && [ ! -e ~/.local/share/weevils ]"
check "nothing answers" wait_down

# Leave the Mac as it was.
security delete-generic-password -s 'Claude Code-credentials' >/dev/null 2>&1 || true
rm -f "$HOME/.local/bin/claude"
[ ! -e "$HOME/.local/share/weevils-test/claude.real" ] || mv "$HOME/.local/share/weevils-test/claude.real" "$real_claude"
rm -rf "$HOME/.local/share/weevils-test" "$HOME/projects/demo-été" "$HOME/weevils-piped"
rm -f "$out"

echo
if [ "$fails" = 0 ]; then echo "PASS ($passes checks)"; else echo "FAIL ($fails of $((passes + fails)) checks)$failed"; exit 1; fi
