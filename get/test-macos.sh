#!/usr/bin/env bash
# The Mac branches of get/bootstrap.sh, run on Linux. The script the setup page serves for "My computer" runs the way
# a Mac runs it (curl … | bash) inside the official bash:3.2 image, macOS's bash, on a fake Mac made of stand-ins
# first in the PATH: uname says Darwin, sudo wants a password, the Command Line Tools and Homebrew are missing, and
# brew, launchctl, cloudflared and the installer are doubles that write down what they are asked. Tools that macOS
# does not have, or flags only GNU knows, stop the run. A real get/server.mjs follows it, like the page would.
#   get/test-macos.sh                  PASS/FAIL per check, exit 1 when one fails
#   WVTEST_HOST=1 get/test-macos.sh    no Docker: same doubles under this machine's bash (not 3.2)
#   WVTEST_KEEP=1                      keep the work folder (printed) to read the logs
#   GET_INSTALLER=<path/install.sh>    the installer whose step titles the service reads (default: this clone's)
# The first run builds a small image from bash:3.2 (adds curl and nodejs with apk: needs the network once).
# Not checked here, only on a real Mac (get/e2e-mac.mjs): Homebrew, launchd, sudo, LibreSSL, BSD tools themselves.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d /tmp/wvget-mac.XXXXXX)
image=weevils-get-mactest:1 code=SECRET-CODE-123 turl=https://fake-mac-link.trycloudflare.com
pass=0 failed=0 srv=''
cleanup() {
  [ -z "$srv" ] || kill "$srv" 2>/dev/null || true
  # The tunnel doubles left running: this machine's processes only without Docker (a container takes its own away).
  [ "$docker" = 1 ] || cat "$work"/*/state/pids 2>/dev/null | xargs -r kill 2>/dev/null || true
  if [ -n "${WVTEST_KEEP:-}" ]; then echo "kept: $work"; else rm -rf "$work"; fi
}
docker=0
trap cleanup EXIT

# ---------------------------------------------------------------- where it runs: bash 3.2 in Docker, else this bash
if [ -z "${WVTEST_HOST:-}" ] && docker image inspect bash:3.2 >/dev/null 2>&1; then
  # The image plus the two real tools the script needs that Alpine lacks (curl, node), and bash where a Mac has it.
  docker image inspect "$image" >/dev/null 2>&1 || printf 'FROM bash:3.2\nRUN apk add --no-cache curl nodejs && ln -sf /usr/local/bin/bash /bin/bash\n' | docker build -q -t "$image" - >/dev/null 2>&1 || true
  ! docker image inspect "$image" >/dev/null 2>&1 || docker=1
fi
if [ "$docker" = 1 ]; then echo "running in Docker: $(docker run --rm "$image" bash --version | head -1)"
else echo "running under this machine's bash ($BASH_VERSION): bash 3.2 itself is NOT checked"; fi

# ---------------------------------------------------------------- the service, and the page's side of a setup
port=$(node -e 'const s = require("node:net").createServer().listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close() })')
base=http://127.0.0.1:$port
echo 'FAKE BUNDLE' >"$work/fake.bundle"
GET_PORT=$port GET_BASE=$base GET_PREVIEW_KEY=testkey GET_TRUST_PROXY=0 GET_BUNDLE=$work/fake.bundle node "$here/server.mjs" >"$work/server.log" 2>&1 &
srv=$!
for _ in $(seq 1 50); do curl -fsS -o /dev/null "$base/health" 2>/dev/null && break; sleep 0.2; done
cat >"$work/page.mjs" <<'EOF'
// What the page does: a key pair and a job (new), then the job's state with the sealed link opened (status).
import crypto from 'node:crypto'
import fs from 'node:fs'
const [cmd, base, file] = process.argv.slice(2)
const api = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-get-key': 'testkey' }, body: JSON.stringify(body) })).json()
if (cmd === 'new') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const j = await api('/api/job', { kind: 'pc', lang: 'en', pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') })
  fs.writeFileSync(file, JSON.stringify({ ...j, key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }))
  console.log(j.sid)
} else {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'))
  const s = await api('/api/status', { sid: j.sid, view: j.view })
  let link = ''
  try { link = crypto.privateDecrypt({ key: j.key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(s.result.sealed, 'base64')).toString() } catch {}
  console.log(`state=${s.state}\nsteps=${(s.steps || []).join(',')}\nerror=${s.error || ''}\nurl=${s.result?.url || ''}\nmode=${s.result?.mode || ''}\nlink=${link}`)
}
EOF

# ---------------------------------------------------------------- the fake Mac: one folder of doubles per scenario
stub() { cat >"$1"; chmod 755 "$1"; }
fake_mac() { # fake_mac <folder>
  local w=$1 name
  mkdir -p "$w/bin" "$w/usrbin" "$w/brew" "$w/state" "$w/Mac&home"
  : >"$w/state/calls"; : >"$w/state/gnu"; : >"$w/state/curl"
  stub "$w/bin/uname" <<'EOF'
#!/bin/sh
case "${1:-}" in -m) echo arm64 ;; -r) echo 24.1.0 ;; *) echo Darwin ;; esac
EOF
  printf '#!/bin/sh\necho 15.1\n' | stub "$w/bin/sw_vers"
  # Sealing the link: Node as it is, and no openssl that knows OAEP with SHA-256; in one scenario, neither works.
  printf '#!/bin/sh\n[ "$SCENARIO" != bare ] || exit 1\nPATH=$WVT_REAL exec node "$@"\n' | stub "$w/bin/node"
  printf '#!/bin/sh\necho "openssl $1" >>"$WVT/state/calls"\nexit 1\n' | stub "$w/bin/openssl"
  printf '#!/bin/sh\nexit 44\n' | stub "$w/bin/security"
  printf '#!/bin/sh\n[ "$1" = -p ] && [ -e "$WVT/state/clt" ]\n' | stub "$w/bin/xcode-select"
  printf '#!/bin/sh\necho "pkill $*" >>"$WVT/state/calls"\nexit 1\n' | stub "$w/bin/pkill"
  printf '#!/bin/sh\necho "[QR of $5]"\n' | stub "$w/bin/qrencode"
  printf '#!/bin/sh\n[ "$SCENARIO" = root ] && [ "${1:-}" = -u ] && { echo 0; exit 0; }\nPATH=$WVT_REAL exec id "$@"\n' | stub "$w/bin/id"
  # BSD wc pads its count with spaces.
  printf '#!/bin/sh\nPATH=$WVT_REAL wc "$@" | sed "s/^/       /"\n' | stub "$w/bin/wc"
  # sudo: no right until the password was typed (sudo -v in a terminal), then valid without one.
  stub "$w/bin/sudo" <<'EOF'
#!/bin/sh
case "$*" in
  '-n true' | '-n -v') [ -e "$WVT/state/sudo" ] ;;
  -v) echo "sudo -v" >>"$WVT/state/calls"; : >"$WVT/state/sudo" ;;
  *) echo "sudo $*" >>"$WVT/state/gnu"; exit 99 ;;
esac
EOF
  # Not on a Mac at all, then flags that only GNU tools take.
  for name in systemctl loginctl useradd runuser apt-get timeout setsid sha256sum getent nproc; do
    printf '#!/bin/sh\necho "%s $* (not on a Mac)" >>"$WVT/state/gnu"\nexit 127\n' "$name" | stub "$w/bin/$name"
  done
  while IFS='|' read -r name pat; do
    printf '#!/bin/sh\ncase " $* " in %s) echo "%s $* (GNU only)" >>"$WVT/state/gnu"; exit 99 ;; esac\nPATH=$WVT_REAL exec %s "$@"\n' "$pat" "$name" "$name" | stub "$w/bin/$name"
  done <<'EOF'
tail|*" --pid"*
sed|*" -i "[!\ ]*
base64|*" -w"*|*" -d "*
date|*" -d"*|*"%N"*
readlink|*" -f"*
stat|*" -c"*
grep|*" -P"*
EOF
  # /usr/bin/git: Apple's stub until the Command Line Tools are there, then just enough git for the bootstrap.
  stub "$w/usrbin/git" <<'EOF'
#!/bin/sh
[ -e "$WVT/state/clt" ] || { echo "git $* before the Command Line Tools (a dialog on a real Mac)" >>"$WVT/state/gnu"; exit 1; }
echo "git $*" >>"$WVT/state/calls"
case "$1" in
  clone) [ "$(cat "$5")" = 'FAKE BUNDLE' ] && mkdir -p "$6/.git" && cp "$WVT/installer" "$6/install.sh" ;;
  -C) [ "$3 $4 $5" = 'remote set-url origin' ] ;;
  *) exit 1 ;;
esac
EOF
  # curl: Homebrew's installer and the tunnel are doubles, the rest is the real curl toward the local service.
  stub "$w/bin/curl" <<'EOF'
#!/bin/sh
echo "curl $*" >>"$WVT/state/curl"
out='' prev=''
for a in "$@"; do [ "$prev" = -o ] && out=$a; prev=$a; done
for a in "$@"; do
  case "$a" in
    https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh) cp "$WVT/homebrew-installer" "$out"; exit 0 ;;
    https://*.trycloudflare.com/*) exit 0 ;;
    https://*) echo "curl $a (unexpected download)" >>"$WVT/state/gnu"; exit 22 ;;
  esac
done
PATH=$WVT_REAL exec curl "$@"
EOF
  # Homebrew's installer: needs sudo already unlocked and no question, brings brew and the Command Line Tools.
  stub "$w/homebrew-installer" <<'EOF'
[ "${NONINTERACTIVE:-}" = 1 ] && sudo -n true || { echo "Need sudo access on macOS"; exit 1; }
mkdir -p "$WVT_BREW/bin" && cp "$WVT/brew-double" "$WVT_BREW/bin/brew" && : >"$WVT/state/clt"
echo "homebrew installed" >>"$WVT/state/calls"
EOF
  stub "$w/brew-double" <<'EOF'
#!/bin/sh
echo "brew $* [NONINTERACTIVE=${NONINTERACTIVE:-}]" >>"$WVT/state/calls"
case "$*" in
  shellenv) echo "export HOMEBREW_PREFIX=\"$WVT_BREW\"; export PATH=\"$WVT_BREW/bin:\${PATH}\";" ;;
  'install cloudflared') cp "$WVT/cloudflared-double" "$WVT_BREW/bin/cloudflared" ;;
  *) exit 1 ;;
esac
EOF
  stub "$w/cloudflared-double" <<EOF
#!/bin/sh
echo "cloudflared \$*" >>"\$WVT/state/calls"
echo \$\$ >>"\$WVT/state/pids"
echo "2026-11-13T22:00:00Z INF |  $turl  |"
exec sleep 300
EOF
  # launchd: a session on the screen (gui/<uid>) unless the scenario has none; bootstrap starts what the file says.
  stub "$w/bin/launchctl" <<'EOF'
#!/bin/sh
echo "launchctl $1 $2" >>"$WVT/state/calls"
unx() { sed -e 's/&lt;/</g' -e 's/&gt;/>/g' -e 's/&amp;/\&/g'; }
case "$1" in
  print) case "$2" in gui/*/*) [ -e "$WVT/state/loaded" ] ;; *) [ "$SCENARIO" != bare ] ;; esac ;;
  bootout) rm -f "$WVT/state/loaded" ;;
  enable) ;;
  bootstrap)
    out=$(sed -n 's:.*<key>StandardOutPath</key><string>\(.*\)</string>.*:\1:p' "$3" | unx)
    sed -n '/<array>/,/<\/array>/s:.*<string>\(.*\)</string>.*:\1:p' "$3" | unx >"$WVT/state/args"
    set --
    while IFS= read -r a; do set -- "$@" "$a"; done <"$WVT/state/args"
    : >"$WVT/state/loaded"
    "$@" >>"$out" 2>&1 &
    ;;
  *) exit 1 ;;
esac
EOF
  # ./install.sh --agent: the log a real install writes (titles as " title ", details, the summary block last).
  stub "$w/installer" <<EOF
#!/usr/bin/env bash
set -eu
echo "install.sh \$* [GIT_TERMINAL_PROMPT=\${GIT_TERMINAL_PROMPT:-}]" >>"\$WVT/state/calls"
url='' prev=''
for a in "\$@"; do [ "\$prev" != --url ] || url=\$a; prev=\$a; done
step() { printf '\n %s \n' "\$1"; sleep 0.4; }
step 'checking the system'; echo '  · run by an AI agent'; echo '  ✓ git, curl, tmux 3.5a, jq, python3'
step 'getting weevils'; echo "  ✓ \$PWD (abc1234 2026-11-13)"
step 'your settings'; echo '  · code: $code'
step 'dependencies and app build'
step 'weevilsd service'
printf '\n waiting for weevilsd \n'
if [ -n "\$url" ]; then mode=public; else mode=local url=http://localhost:4179; fi
printf '\n  ★ weevils is ready\n  %s/#k=%s\n\n--- weevils summary ---\nstatus=ok\nurl=%s\ncode=%s\nlink=%s/#k=%s\nmode=%s\nport=4179\nready=no\nos=macos\narch=arm64\nlang=en\nagent=\n--- end ---\n' "\$url" '$code' "\$url" '$code' "\$url" '$code' "\$mode"
EOF
}

# run <scenario> <tty|notty>: a new setup, then its command in the fake Mac. Sets $w, $rc, $st (the page's view).
run() {
  w=$work/$1 rc=0
  fake_mac "$w"
  # A Mac that already has Homebrew and the Command Line Tools.
  [ "$1" != bare ] || { mkdir -p "$w/brew/bin" && cp "$w/brew-double" "$w/brew/bin/brew" && : >"$w/state/clt"; }
  local sid cmd
  sid=$(node "$work/page.mjs" new "$base" "$w/job.json")
  cmd="curl -fsSL '$base/i/$sid' | bash"
  if [ "$docker" = 1 ]; then
    local t=-t; [ "$2" = tty ] || t=-i
    docker run --rm "$t" --network host --user "$(id -u):$(id -g)" -v "$work:$work" -v "$w/usrbin/git:/usr/bin/git:ro" -v "$w/brew:/opt/homebrew" \
      -e WVT="$w" -e WVT_REAL=/usr/local/bin:/usr/bin:/bin -e WVT_BREW=/opt/homebrew -e SCENARIO="$1" -e HOME="$w/Mac&home" -e PATH="$w/bin:/usr/local/bin:/usr/bin:/bin" \
      "$image" bash -c "$cmd" >"$w/out" 2>&1 </dev/null || rc=$?
  else
    # A terminal of its own (script) or none at all (setsid), like the two Docker runs. Their real paths: the fake
    # Mac's PATH has no setsid.
    local wrap=("$(command -v setsid)" -w bash -c "$cmd"); [ "$2" != tty ] || wrap=("$(command -v script)" -qec "$cmd" /dev/null)
    env WVT="$w" WVT_REAL="$PATH" WVT_BREW="$w/brew" SCENARIO="$1" HOME="$w/Mac&home" PATH="$w/bin:$w/usrbin:$w/brew/bin:$PATH" "${wrap[@]}" >"$w/out" 2>&1 </dev/null || rc=$?
  fi
  st=$(node "$work/page.mjs" status "$base" "$w/job.json")
}
val() { printf '%s\n' "$st" | sed -n "s/^$1=//p"; }
at() { grep -n -m1 -e "$1" "$w/state/calls" | cut -d: -f1 || true; }
ok() { pass=$((pass + 1)); echo "PASS  $1"; }
ko() { failed=$((failed + 1)); echo "FAIL  $1"; shift; printf '      %s\n' "$@"; }
check() { if eval "$2"; then ok "$1"; else ko "$1" "$2"; fi; }
is() { if [ "$2" = "$3" ]; then ok "$1"; else ko "$1" "expected: $3" "got:      $2"; fi; }
before() { # before <name> <pattern> <pattern>: both in the doubles' journal, in that order
  local a b; a=$(at "$2"); b=$(at "$3")
  if [ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ]; then ok "$1"; else ko "$1" "$2 (line ${a:-none}) then $3 (line ${b:-none})"; fi
}

# ---------------------------------------------------------------- 1. a new Mac, the person at its terminal
echo "— a Mac without Homebrew or the Command Line Tools, in a terminal"
run fresh tty
plist="$w/Mac&home/Library/LaunchAgents/com.github.sc4rville.weevils-link.plist"
is 'the script ends well' "$rc" 0
is 'the page sees it done' "$(val state)" 'done'
is 'steps in order: start, each installer title once, the link, done' "$(val steps)" start,s_system,s_source,s_config,s_build,s_service,waiting,tunnel,done
is 'the sealed link opens with the key of the page (Node, RSA-OAEP SHA-256)' "$(val link)" "$turl/#k=$code"
is 'the address is the public one of the tunnel' "$(val url) $(val mode)" "$turl public"
before 'the password is asked once, before Homebrew' '^sudo -v' '^homebrew installed'
before 'Homebrew (and the Command Line Tools) before git clones' '^homebrew installed' '^git clone -q -b main'
before 'the code before the installer' '^git -C .* remote set-url origin' '^install.sh --agent --lang en \[GIT_TERMINAL_PROMPT=0\]'
before 'cloudflared from Homebrew, without a question, after the install' '^install.sh --agent --lang en \[' '^brew install cloudflared \[NONINTERACTIVE=1\]'
before 'an earlier link agent is unloaded before the new one is loaded' '^launchctl bootout gui/[0-9]*/com.github.sc4rville.weevils-link' '^launchctl bootstrap gui/[0-9]*$'
before 'launchd runs the tunnel the file describes' '^launchctl bootstrap' '^cloudflared tunnel --no-autoupdate --url http://127.0.0.1:4179$'
before 'then the installer learns the public address' '^cloudflared tunnel' "^install.sh --agent --lang en --url $turl --no-update \["
check 'the agent file: label, kept alive, values XML-escaped' "grep -q '<string>com.github.sc4rville.weevils-link</string>' '$plist' && grep -q '<key>KeepAlive</key><true/>' '$plist' && grep -q 'Mac&amp;home/.local/share/weevils/link.log</string>' '$plist' && ! grep -q 'Mac&home' '$plist'"
check 'the tunnel log is where Linux has it' "grep -q '$turl' '$w/Mac&home/.local/share/weevils/link.log'"
check 'no systemd, no GNU-only flag, no tool a Mac lacks' "[ ! -s '$w/state/gnu' ]"
check 'the access code never leaves the machine in clear' "! grep -q '$code' '$w/state/curl'"
check 'only step names go out: event, step or title, and the sealed link' "! grep '/r/' '$w/state/curl' | grep -v -e 'event=start\$' -e 'event=step --data-urlencode \(step=[a-z_]*\|title=[a-z ]*\)\$' -e 'event=done .*sealed=[A-Za-z0-9+/=]*\$' | grep -q ."
check 'openssl was not needed: a Mac seals with Node first' "! grep -q '^openssl' '$w/state/calls'"
check 'the terminal ends with the link and its QR code' "grep -q '^  $turl/#k=$code' '$w/out' && grep -q '\[QR of $turl/#k=$code\]' '$w/out'"

# ---------------------------------------------------------------- 2. root on a Mac
echo "— the same command with sudo (root)"
run root tty
check 'it stops' "[ '$rc' != 0 ] && [ '$(val state)' = failed ]"
check 'and says to run it without sudo' "printf '%s' \"\$(val error)\" | grep -q 'without sudo'"
check 'before creating a user or installing anything' "[ ! -s '$w/state/gnu' ] && [ ! -s '$w/state/calls' ]"

# ---------------------------------------------------------------- 3. no way to type the password
echo "— no terminal to type the password in, Homebrew missing"
run nopassword notty
check 'it stops' "[ '$rc' != 0 ] && [ '$(val state)' = failed ]"
check 'and says Homebrew needs the password of an administrator' "printf '%s' \"\$(val error)\" | grep -q 'Homebrew is missing.*password'"
check 'without touching git (no dialog) or Homebrew' "[ ! -s '$w/state/gnu' ] && ! grep -q -e '^git' -e '^homebrew' -e '^install.sh' '$w/state/calls'"

# ---------------------------------------------------------------- 4. a Mac already set up, reached without its screen
echo "— a Mac with Homebrew, no session on its screen (SSH), and nothing that can seal the link"
run bare tty
is 'the script still ends well, the page sees it done at the tunnel address, without a link' "$rc $(val state) $(val url) [$(val link)]" "0 done $turl []"
before 'Node was tried, then openssl' '^install.sh .* --no-update' '^openssl base64'
check 'the terminal says so and shows the link' "grep -q 'the setup page could not receive it' '$w/out' && grep -q '^  $turl/#k=$code' '$w/out'"
check 'no password asked, Homebrew not installed again' "! grep -q -e '^sudo' -e '^homebrew installed' '$w/state/calls'"
before 'an earlier background link is stopped, then a new one starts without launchd' '^pkill -u [0-9]* -f cloudflared tunnel' '^cloudflared tunnel --no-autoupdate --url http://127.0.0.1:4179$'
check 'no agent loaded, no agent file left' "! grep -q '^launchctl bootstrap' '$w/state/calls' && [ ! -e '$w/Mac&home/Library/LaunchAgents/com.github.sc4rville.weevils-link.plist' ]"
check 'no systemd, no GNU-only flag, no tool a Mac lacks' "[ ! -s '$w/state/gnu' ]"

echo
echo "$pass passed, $failed failed"
[ "$failed" = 0 ] || { [ -n "${WVTEST_KEEP:-}" ] || echo "(WVTEST_KEEP=1 keeps the logs)"; exit 1; }
