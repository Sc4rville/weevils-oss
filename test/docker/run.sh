#!/usr/bin/env bash
# Tests install.sh for real, in blank Docker containers (ubuntu:24.04). One command, ends with PASS or FAIL.
#
#   test/docker/run.sh            all scenarios
#   test/docker/run.sh systemd    VPS with systemd: install from a clone, service + linger, login over http, the
#                                 end screen without a domain, idempotent re-run, --domain with Caddy, a port change
#                                 that moves the Caddy site, survives a reboot, --uninstall then a new install
#   test/docker/run.sh plain      container without systemd, as root: curl | bash style (piped), Claude Code from its
#                                 official installer, WEEVILS_SAFE=1, background fallback, re-run, --uninstall --purge
#   test/docker/run.sh edge       the hard cases: truncated download, no terminal without --yes, no sudo, node 20
#                                 (NodeSource, Ubuntu apt, tarball shadowing), user with sudo + file:// repo + --dir,
#                                 re-run after editing the config, --lang fr only, bad options, --lan, a Caddyfile that
#                                 already serves another site (and a port change)
#
# Claude Code is a stub (/usr/local/bin/claude) everywhere but in the plain scenario, which installs the real one.
# It installs the HEAD commit of this repo (commit first). KEEP=1 keeps the containers for a look.
set -uo pipefail
root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
which=${1:-all}
image=weevils-test-systemd
tag=$$
work=$(mktemp -d)
containers=()
networks=()
fails=0
passes=0

cleanup() {
  if [ "${KEEP:-0}" = 1 ]; then echo "kept: ${containers[*]:-}"; else
    for c in "${containers[@]}"; do docker rm -f "$c" >/dev/null 2>&1; done
    for n in "${networks[@]}"; do docker network rm "$n" >/dev/null 2>&1; done
    docker image rm "$image" >/dev/null 2>&1
  fi
  rm -rf "$work"
}
trap cleanup EXIT

say() { printf '\n\e[30;43m %s \e[0m\n' "$*"; }
# The VPS this runs on has 'heavy' (waits for a calm machine, then nice); anywhere else, the command runs as is.
run_heavy() { if command -v heavy >/dev/null 2>&1; then heavy "$@"; else "$@"; fi; }
# fake_claude <container> [home of a logged-in user] — a Claude Code stub in /usr/local/bin (the real one is a big
# download), and a credentials file in that home when given.
fake_claude() {
  docker exec "$1" bash -c 'printf "#!/bin/sh\necho \"2.0.0 (Claude Code)\"\n" >/usr/local/bin/claude && chmod 755 /usr/local/bin/claude'
  if [ -n "${2:-}" ]; then
    docker exec "$1" bash -c "mkdir -p $2/.claude && echo '{}' >$2/.claude/.credentials.json && chown -R \$(stat -c %u:%g $2) $2/.claude"
  fi
}
QR='█|▀|▄'
# The key=value lines of the summary an agent parses; valid when it is the last thing printed and every line is key=value.
summary_lines() { sed -n '/^--- weevils summary ---$/,/^--- end ---$/p' "$1" | sed '1d;$d'; }
summary_valid() { [ "$(tail -1 "$1")" = '--- end ---' ] && [ -n "$(summary_lines "$1")" ] && ! summary_lines "$1" | grep -qvE '^[a-z_]+='; }
check() { # check "description" command… (runs on the host; use inside/as_test for the container)
  local d=$1; shift
  if "$@" >"$work/out" 2>&1; then passes=$((passes + 1)); printf '  \e[32mok\e[0m   %s\n' "$d"
  else fails=$((fails + 1)); printf '  \e[31mFAIL\e[0m %s\n' "$d"; sed 's/^/       /' "$work/out" | tail -15; fi
}

# A fresh clone of HEAD, as a bare repo (the "GitHub" of the container) and a working clone of it.
branch=$(git -C "$root" rev-parse --abbrev-ref HEAD)
git clone -q --bare --branch "$branch" "$root" "$work/weevils.git"
git -C "$work/weevils.git" symbolic-ref HEAD "refs/heads/$branch"
git clone -q "$work/weevils.git" "$work/weevils"
git -C "$work/weevils" remote set-url origin /srv/weevils.git
echo "testing $(git -C "$work/weevils" log -1 --format='%h %s')"

# ---------------------------------------------------------------- systemd
run_systemd() {
  say "systemd: blank Ubuntu 24.04 VPS, regular user with sudo"
  run_heavy docker build -q -t "$image" -f "$root/test/docker/systemd.Dockerfile" "$root/test/docker" >/dev/null || { fails=$((fails + 1)); echo "  FAIL docker build"; return; }
  local c=weevils-test-sd-$tag
  containers+=("$c")
  docker run -d --name "$c" --hostname testbox --privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock "$image" >/dev/null
  docker exec "$c" systemctl is-system-running --wait >/dev/null 2>&1
  docker cp "$work/weevils.git" "$c:/srv/weevils.git"
  docker cp "$work/weevils" "$c:/home/test/weevils"
  docker exec "$c" chown -R test:test /srv/weevils.git /home/test/weevils
  fake_claude "$c" /home/test
  as_test() { docker exec -u test -w /home/test -e XDG_RUNTIME_DIR=/run/user/1000 "$c" bash -c "$1"; }

  check "blank: no node, git, curl, tmux" as_test '! command -v node && ! command -v git && ! command -v curl && ! command -v tmux'
  echo "  \$ cd weevils && ./install.sh --yes --name Test --lang en"
  if ! as_test 'cd weevils && ./install.sh --yes --name Test --lang en' >"$work/install1.log" 2>&1; then
    fails=$((fails + 1)); echo "  FAIL install.sh exited non-zero"; tail -30 "$work/install1.log"; return
  fi
  sed 's/^/  │ /' "$work/install1.log"
  check "node >= 22.18 installed by the script" as_test 'node -p "process.versions.node" && node -e "const [a,b]=process.versions.node.split(\".\").map(Number); process.exit(a>22||(a==22&&b>=18)?0:1)"'
  check "tmux, jq, git, python3 installed" as_test 'command -v tmux && command -v jq && command -v git && command -v python3'
  check "linger enabled" as_test '[ "$(loginctl show-user test -p Linger --value)" = yes ]'
  check "weevilsd active under systemd --user" as_test 'systemctl --user is-active weevilsd && systemctl --user is-enabled weevilsd'
  check "GET /api/me answers, trusted with the local token" as_test 'curl -sf -H @$HOME/.local/share/weevils/local-token http://127.0.0.1:4179/api/me | grep -q "\"authed\":true"'
  check "without the local token, a program on the machine is not trusted" as_test 'curl -sf http://127.0.0.1:4179/api/me | grep -q "\"authed\":false" && [ "$(stat -c %a ~/.local/share/weevils/local-token)" = 600 ]'
  check "the app HTML is served" as_test 'curl -sf http://127.0.0.1:4179/ | grep -qi "<div id=\"root\""'
  check "config generated (name, lang, machine)" as_test 'grep -qx WEEVILS_USER_NAME=Test ~/.config/weevils/env && grep -qx WEEVILS_LANG=en ~/.config/weevils/env && grep -qx WEEVILS_MACHINE=testbox ~/.config/weevils/env && grep -qx WEEVILS_ORCHESTRATOR=1 ~/.config/weevils/env'
  check "commands installed: wv, weevils, weevils-service, hook" as_test 'test -x ~/.local/bin/wv && test -x ~/.local/bin/weevils && test -x ~/.local/bin/weevils-service && test -x ~/.local/bin/weevils-hook'
  check "Claude Code hooks registered" as_test '[ "$(jq "[.hooks[][].hooks[].command | select(endswith(\"weevils-hook\"))] | length" ~/.claude/settings.json)" = 6 ]'
  check "end screen shows the login link" grep -q "localhost:4179/#k=" "$work/install1.log"
  check "no domain: no QR code, the ways in explained instead" bash -c "! grep -qE '$QR' '$work/install1.log' && grep -q -- '--domain <host>' '$work/install1.log' && grep -q 'tailscale serve --bg 4179' '$work/install1.log' && grep -q -- 'install.sh --lan' '$work/install1.log' && grep -q 'ssh -L 4179:127.0.0.1:4179' '$work/install1.log'"
  check "Claude Code logged in: 'weevils is ready', agents ask by default" bash -c "grep -q 'weevils is ready' '$work/install1.log' && grep -q 'agents ask before acting' '$work/install1.log'"
  check "end screen ends on the first thing to try (no project yet: a notes app)" bash -c "tail -4 '$work/install1.log' | grep -q 'first thing to try: .*make me a small notes app'"
  check "hand-off file: install.json v1, by=script, local, Claude ready" as_test 'jq -e ".v == 1 and (.at | type) == \"number\" and .by == \"script\" and .agent == \"\" and .url == \"http://localhost:4179\" and .mode == \"local\" and .phoneLink == false and .lang == \"en\" and .ready == {\"claude\": true, \"codex\": false, \"gh\": false} and .projects == 0 and .repos == 0" ~/.local/share/weevils/install.json && [ "$(stat -c %a ~/.local/share/weevils/install.json)" = 600 ]'
  check "--yes without a terminal: no summary block" bash -c "! grep -q -- '--- weevils summary ---' '$work/install1.log'"
  check "Claude settings: hooks only (agents ask by default: no bypass dialog setting), no global env, WEEVILS_SAFE=1" as_test 'jq -e "(.skipDangerousModePermissionPrompt == null) and .env == null" ~/.claude/settings.json && test -f ~/.claude/settings.json.bak-weevils && grep -qx WEEVILS_SAFE=1 ~/.config/weevils/env'
  # Login from "outside" (x-forwarded-for: not a local request), over plain http.
  check "login with the code works over http, cookie without Secure" as_test '
    code=$(cat ~/.config/weevils/secret)
    curl -s -D /tmp/h -o /tmp/b -H "x-forwarded-for: 203.0.113.9" -H "content-type: application/json" -d "{\"secret\":\"$code\"}" http://127.0.0.1:4179/api/login
    grep -qi "^set-cookie: wv=" /tmp/h && ! grep -i "^set-cookie" /tmp/h | grep -qi secure
    tok=$(sed -n "s/^[Ss]et-[Cc]ookie: wv=\([^;]*\).*/\1/p" /tmp/h)
    curl -sf -H "x-forwarded-for: 203.0.113.9" -H "cookie: wv=$tok" http://127.0.0.1:4179/api/me | grep -q "\"authed\":true"'
  check "no cookie from outside → not logged in, wrong code → 401" as_test '
    curl -sf -H "x-forwarded-for: 203.0.113.9" http://127.0.0.1:4179/api/me | grep -q "\"authed\":false"
    [ "$(curl -s -o /dev/null -w "%{http_code}" -H "x-forwarded-for: 203.0.113.9" -H "content-type: application/json" -d "{\"secret\":\"nope\"}" http://127.0.0.1:4179/api/login)" = 401 ]'

  say "systemd: re-run = update, idempotent"
  as_test 'sha256sum ~/.config/weevils/env ~/.config/weevils/secret ~/.claude/settings.json ~/.config/systemd/user/weevilsd.service' >"$work/sum1"
  check "second run exits 0" as_test 'cd weevils && ./install.sh --yes --name Test --lang en'
  cp "$work/out" "$work/install2.log"
  as_test 'sha256sum ~/.config/weevils/env ~/.config/weevils/secret ~/.claude/settings.json ~/.config/systemd/user/weevilsd.service' >"$work/sum2"
  check "config, code, hooks and unit unchanged" diff "$work/sum1" "$work/sum2"
  check "no rebuild when nothing changed" grep -q "already built" "$work/install2.log"
  say "systemd: --no-ask-permissions, then back to asking"
  check "--no-ask-permissions: WEEVILS_SAFE=0, the bypass dialog pre-accepted and marked as weevils'" as_test 'cd weevils && ./install.sh --yes --no-ask-permissions >/tmp/noask.log 2>&1 && grep -qx WEEVILS_SAFE=0 ~/.config/weevils/env && jq -e ".skipDangerousModePermissionPrompt == true" ~/.claude/settings.json && test -f ~/.local/share/weevils/claude-skip-prompt && grep -q "WITHOUT permission prompts" /tmp/noask.log'
  check "a plain re-run keeps that choice" as_test 'cd weevils && ./install.sh --yes >/dev/null 2>&1 && grep -qx WEEVILS_SAFE=0 ~/.config/weevils/env'
  check "--ask-permissions: back to asking, the setting weevils wrote taken back" as_test 'cd weevils && ./install.sh --yes --ask-permissions >/dev/null 2>&1 && grep -qx WEEVILS_SAFE=1 ~/.config/weevils/env && jq -e ".skipDangerousModePermissionPrompt == null" ~/.claude/settings.json && ! test -e ~/.local/share/weevils/claude-skip-prompt'
  say "systemd: run by an agent (--agent, then detected from CLAUDECODE=1 without a terminal)"
  as_test 'mkdir -p ~/projects/app1/.git ~/projects/app2/.git ~/.claude/projects/-home-test-projects-app1 && touch ~/.claude/projects/-home-test-projects-app1/s1.jsonl'
  check "install.sh --agent exits 0" as_test 'cd weevils && ./install.sh --agent'
  cp "$work/out" "$work/agent1.log"; sed -n '/--- weevils summary ---/,$p' "$work/agent1.log" | sed 's/^/  │ /'
  check "summary block last, every line key=value" summary_valid "$work/agent1.log"
  check "summary: status ok, local link, Claude logged in, 1 project, 2 repos" bash -c "grep -qx status=ok '$work/agent1.log' && grep -qx mode=local '$work/agent1.log' && grep -q '^link=http://localhost:4179/#k=' '$work/agent1.log' && grep -qx claude_logged=yes '$work/agent1.log' && grep -qx projects=1 '$work/agent1.log' && grep -qx repos=2 '$work/agent1.log'"
  check "no colours, no QR code" bash -c "! grep -q \$'\\e\\[' '$work/agent1.log' && ! grep -qE '$QR' '$work/agent1.log'"
  check "end screen: the project already in the app, what to ask" grep -q 'already in the app: your Claude Code project.*' "$work/agent1.log"
  check "install.json: by=agent, one project, two repos" as_test 'jq -e ".by == \"agent\" and .projects == 1 and .repos == 2" ~/.local/share/weevils/install.json'
  check "CLAUDECODE=1 without a terminal acts as --agent" as_test 'cd weevils && CLAUDECODE=1 ./install.sh </dev/null >/tmp/cc.log 2>&1; grep -qx agent=claude /tmp/cc.log && jq -e ".by == \"agent\" and .agent == \"claude\"" ~/.local/share/weevils/install.json'
  check "a bad option still ends with a summary (status=failed)" as_test 'cd weevils && ./install.sh --agent --port abc >/tmp/bad.log 2>&1; [ $? = 2 ] && grep -qx status=failed /tmp/bad.log'
  as_test 'rm -rf ~/projects ~/.claude/projects'
  check "still active, one weevilsd" as_test 'systemctl --user is-active weevilsd && [ "$(systemctl --user show weevilsd -p NMainPID --value 2>/dev/null || echo 1)" != 0 ] && curl -sf http://127.0.0.1:4179/api/me'

  say "systemd: --domain with Caddy (tls internal for the test)"
  if as_test 'cd weevils && WEEVILS_CADDY_TLS=internal ./install.sh --yes --domain weevils.test' >"$work/install3.log" 2>&1; then
    passes=$((passes + 1)); echo "  ok   install.sh --domain weevils.test"
    sed -n '/HTTPS/,/waiting/p' "$work/install3.log" | sed 's/^/  │ /'
  else fails=$((fails + 1)); echo "  FAIL install.sh --domain"; tail -20 "$work/install3.log"; fi
  check "caddy active, Caddyfile imports the weevils site" as_test 'systemctl is-active caddy && grep -q "import /etc/caddy/weevils.caddy" /etc/caddy/Caddyfile && grep -q "reverse_proxy 127.0.0.1:4179" /etc/caddy/weevils.caddy'
  check "HTTPS answers through Caddy (not a local request)" as_test 'for i in $(seq 20); do curl -sk --resolve weevils.test:443:127.0.0.1 https://weevils.test/api/me | grep -q "\"authed\":false" && exit 0; sleep 1; done; exit 1'
  check "login over HTTPS sets a Secure cookie" as_test '
    code=$(cat ~/.config/weevils/secret)
    curl -sk -D /tmp/h3 -o /dev/null --resolve weevils.test:443:127.0.0.1 -H "content-type: application/json" -d "{\"secret\":\"$code\"}" https://weevils.test/api/login
    grep -i "^set-cookie: wv=" /tmp/h3 | grep -qi secure'
  check "WEEVILS_PUBLIC_URL set from --domain, name kept" as_test 'grep -qx WEEVILS_PUBLIC_URL=https://weevils.test ~/.config/weevils/env && grep -qx WEEVILS_USER_NAME=Test ~/.config/weevils/env'
  check "end screen shows the https link" grep -q "https://weevils.test/#k=" "$work/install3.log"
  check "install.json: public, phoneLink" as_test 'jq -e ".mode == \"public\" and .phoneLink == true and .url == \"https://weevils.test\"" ~/.local/share/weevils/install.json'
  check "a domain that does not resolve is said at once" grep -q "weevils.test does not resolve yet" "$work/install3.log"

  say "systemd: re-run with another port: the Caddy site follows"
  check "install.sh --port 4199 exits 0" as_test 'cd weevils && ./install.sh --yes --port 4199'
  check "Caddy site on 4199, tls kept, HTTPS answers" as_test 'grep -q "reverse_proxy 127.0.0.1:4199" /etc/caddy/weevils.caddy && grep -q "tls internal" /etc/caddy/weevils.caddy && for i in $(seq 20); do curl -sk --resolve weevils.test:443:127.0.0.1 https://weevils.test/api/me | grep -q "\"authed\":false" && exit 0; sleep 1; done; exit 1'
  check "back to 4179" as_test 'cd weevils && ./install.sh --yes --port 4179 >/dev/null && grep -q "reverse_proxy 127.0.0.1:4179" /etc/caddy/weevils.caddy && curl -sf http://127.0.0.1:4179/api/me'

  say "systemd: a second machine (--secondary), federated by the first through a reverse SSH tunnel"
  local c2=weevils-test-sd2-$tag net=weevils-test-net-$tag
  containers+=("$c2")
  networks+=("$net")
  docker network create "$net" >/dev/null
  docker network connect --alias mainbox "$net" "$c"
  docker run -d --name "$c2" --hostname laptop --network "$net" --privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock "$image" >/dev/null
  docker exec "$c2" systemctl is-system-running --wait >/dev/null 2>&1
  # Test harness only: sshd on the main machine and a key for the second one (what "ssh-copy-id" would do).
  docker exec "$c" bash -c 'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-server >/dev/null 2>&1 && systemctl start ssh'
  ssh-keygen -q -t ed25519 -N '' -f "$work/key"
  docker exec "$c" bash -c 'mkdir -p /home/test/.ssh && chmod 700 /home/test/.ssh'
  docker cp "$work/key.pub" "$c:/home/test/.ssh/authorized_keys"
  docker exec "$c" chown -R test:test /home/test/.ssh
  docker exec "$c2" bash -c 'mkdir -p /home/test/.ssh'
  docker cp "$work/key" "$c2:/home/test/.ssh/id_ed25519"
  docker cp "$work/weevils.git" "$c2:/srv/weevils.git"
  docker cp "$work/weevils" "$c2:/home/test/weevils"
  docker exec "$c2" bash -c 'chmod 700 /home/test/.ssh && chmod 600 /home/test/.ssh/id_ed25519 && chown -R test:test /home/test/.ssh /srv/weevils.git /home/test/weevils'
  fake_claude "$c2" /home/test
  as_2() { docker exec -u test -w /home/test -e XDG_RUNTIME_DIR=/run/user/1000 "$c2" bash -c "$1"; }
  echo "  \$ cd weevils && ./install.sh --yes --name Test --secondary mainbox"
  if as_2 'cd weevils && ./install.sh --yes --name Test --secondary mainbox' >"$work/install4.log" 2>&1; then
    passes=$((passes + 1)); echo "  ok   install.sh --secondary mainbox"; sed 's/^/  │ /' "$work/install4.log"
  else fails=$((fails + 1)); echo "  FAIL install.sh --secondary"; tail -30 "$work/install4.log"; fi
  check "secondary: weevilsd and tunnel active, no weevboss, no app build" as_2 'systemctl --user is-active weevilsd weevils-tunnel && grep -qx WEEVILS_ORCHESTRATOR=0 ~/.config/weevils/env && grep -qx WEEVILS_MACHINE=laptop ~/.config/weevils/env && test ! -e weevils/dist/index.html'
  check "main: WEEVILS_REMOTES registered by the secondary" as_test 'grep -qx "WEEVILS_REMOTES=laptop=http://127.0.0.1:4192" ~/.config/weevils/env'
  check "main: the second machine is online in its snapshot" as_test 'for i in $(seq 30); do curl -sf -H @$HOME/.local/share/weevils/local-token http://127.0.0.1:4179/api/snapshot | jq -e ".machines[] | select(.id==\"laptop\" and .online==true)" && exit 0; sleep 1; done; exit 1'
  check "secondary: units name the main host given, nothing hardcoded" as_2 'grep -q "ExecStart=.* mainbox$" ~/.config/systemd/user/weevils-tunnel.service && ! grep -rqiE "\bvps\b|yann|scarville" ~/.config/systemd/user/ ~/.config/weevils/'
  check "secondary re-run is idempotent (same tunnel port)" as_2 'cd weevils && ./install.sh --yes --secondary mainbox >/dev/null && grep -q "WEEVILS_TUNNEL_PORT=4192" ~/.config/weevils/service.conf'
  check "main: still a single remote entry" as_test '[ "$(grep -c "^WEEVILS_REMOTES=" ~/.config/weevils/env)" = 1 ] && grep -qx "WEEVILS_REMOTES=laptop=http://127.0.0.1:4192" ~/.config/weevils/env'

  say "systemd: reboot"
  docker restart "$c" >/dev/null
  docker exec "$c" systemctl is-system-running --wait >/dev/null 2>&1
  check "weevilsd back after reboot, without login (linger)" as_test 'for i in $(seq 30); do curl -sf http://127.0.0.1:4179/api/me && exit 0; sleep 1; done; exit 1'

  say "systemd: --uninstall, then a new install"
  as_test 'cat ~/.config/weevils/secret' >"$work/secret1"
  check "install.sh --uninstall exits 0" as_test 'cd weevils && ./install.sh --yes --uninstall'
  cp "$work/out" "$work/uninstall.log"; sed 's/^/  │ /' "$work/uninstall.log"
  check "weevilsd stopped, units and commands gone" as_test '! systemctl --user is-active weevilsd && ! test -e ~/.config/systemd/user/weevilsd.service && ! test -e ~/.local/bin/wv && ! test -e ~/.local/bin/weevils && ! test -e ~/.local/bin/weevils-service && ! test -e ~/.local/bin/weevils-hook && ! curl -sf -m 2 http://127.0.0.1:4179/api/me'
  check "the bypass dialog setting weevils wrote is gone too" as_test 'jq -e ".skipDangerousModePermissionPrompt == null" ~/.claude/settings.json'
  check "weevils hooks gone from the Claude settings" as_test '[ "$(jq "[.hooks[]?[]?.hooks[]?.command | select(endswith(\"weevils-hook\"))] | length" ~/.claude/settings.json)" = 0 ]'
  check "Caddy site and import gone, Caddyfile valid, public URL cleared" as_test '! test -e /etc/caddy/weevils.caddy && ! grep -q weevils.caddy /etc/caddy/Caddyfile && sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && grep -qx "WEEVILS_PUBLIC_URL=" ~/.config/weevils/env'
  check "settings and access code kept" as_test 'grep -qx WEEVILS_USER_NAME=Test ~/.config/weevils/env && test -s ~/.config/weevils/secret'
  check "a new install works, same access code" as_test 'cd weevils && ./install.sh --yes >/dev/null && systemctl --user is-active weevilsd && curl -sf http://127.0.0.1:4179/api/me && [ "$(jq "[.hooks[][].hooks[].command | select(endswith(\"weevils-hook\"))] | length" ~/.claude/settings.json)" = 6 ]'
  check "same access code" bash -c "[ \"\$(docker exec -u test $c cat /home/test/.config/weevils/secret)\" = \"\$(cat '$work/secret1')\" ]"
}

# ---------------------------------------------------------------- plain (no systemd)
run_plain() {
  say "plain: container without systemd, root, curl | bash style"
  local c=weevils-test-plain-$tag
  containers+=("$c")
  docker run -d --name "$c" --hostname plainbox ubuntu:24.04 sleep infinity >/dev/null
  docker cp "$work/weevils.git" "$c:/srv/weevils.git"
  docker exec "$c" chown -R root:root /srv/weevils.git
  in_c() { docker exec -w /root "$c" bash -c "$1"; }
  echo "  \$ bash -s -- --yes --name Test --lang fr < install.sh     (WEEVILS_REPO=/srv/weevils.git: a local copy of the repo)"
  if ! docker exec -i -w /root -e WEEVILS_REPO=/srv/weevils.git "$c" bash -s -- --yes --name Test --lang fr <"$work/weevils/install.sh" >"$work/plain1.log" 2>&1; then
    fails=$((fails + 1)); echo "  FAIL piped install exited non-zero"; tail -30 "$work/plain1.log"; return
  fi
  sed 's/^/  │ /' "$work/plain1.log"
  check "cloned into ~/weevils" in_c 'test -f ~/weevils/server/index.ts && git -C ~/weevils log -1 --oneline'
  check "background mode, weevilsd running" in_c '~/.local/bin/weevils-service status | grep -q "weevilsd: running"'
  check "GET /api/me answers, app served" in_c 'curl -sf http://127.0.0.1:4179/api/me && curl -sf http://127.0.0.1:4179/ | grep -qi "<div id=\"root\""'
  check "messages in French" grep -q "code d'accès" "$work/plain1.log"
  check "the fallback is explained" grep -q "weevils-service start|stop|status|logs" "$work/plain1.log"
  check "Claude Code installed by its official installer" in_c '~/.local/bin/claude --version'
  check "not logged in yet: 'presque prêt', run claude" grep -q "presque prêt : lance claude" "$work/plain1.log"
  check "root: WEEVILS_SAFE=1, said on the end screen, no bypass in the Claude settings" bash -c "docker exec $c grep -qx WEEVILS_SAFE=1 /root/.config/weevils/env && grep -q 'WEEVILS_SAFE=1' '$work/plain1.log' && ! docker exec $c jq -e .skipDangerousModePermissionPrompt /root/.claude/settings.json"
  count() { docker exec "$c" bash -c 'n=0; for f in /proc/[0-9]*/cmdline; do tr "\0" " " <"$f" 2>/dev/null | grep -q "^[^ ]*node server/index.ts" && n=$((n+1)); done; echo $n'; }
  check "re-run (piped again) exits 0" docker exec -i -w /root -e WEEVILS_REPO=/srv/weevils.git "$c" bash -s -- --yes --lang fr <"$work/weevils/install.sh"
  check "still one weevilsd process" test "$(count)" = 1
  check "stop / start" in_c '~/.local/bin/weevils-service stop && ! curl -sf -m 2 http://127.0.0.1:4179/api/me; ~/.local/bin/weevils-service start && for i in $(seq 20); do curl -sf http://127.0.0.1:4179/api/me && exit 0; sleep 0.5; done; exit 1'
  check "--uninstall --purge (piped) exits 0" docker exec -i "$c" bash -s -- --yes --lang fr --uninstall --purge <"$work/weevils/install.sh"
  check "no weevilsd left, commands, settings and data gone, the clone kept" bash -c "[ '$(count)' = 0 ] && docker exec $c bash -c '! test -e ~/.local/bin/weevils-service && ! test -e ~/.config/weevils && ! test -e ~/.local/share/weevils && test -f ~/weevils/install.sh'"
}

# ---------------------------------------------------------------- edge cases (no systemd: plain containers)
# box <name> [root setup command] — a blank ubuntu:24.04 with the bare repo in /srv/weevils.git and install.sh in /tmp.
# Sets $c (not echoed: the container list must be filled in this shell, for the cleanup).
box() {
  c=weevils-test-$1-$tag
  containers+=("$c")
  docker run -d --name "$c" --hostname "$1" ubuntu:24.04 sleep infinity >/dev/null
  docker cp "$work/weevils.git" "$c:/srv/weevils.git"
  docker cp "$work/weevils/install.sh" "$c:/tmp/install.sh"
  docker exec "$c" chmod -R a+rX /srv/weevils.git /tmp/install.sh
  # Test harness only: the local "GitHub" belongs to the host's uid, which git would call dubious ownership.
  docker exec "$c" bash -c 'printf "[safe]\n\tdirectory = *\n" >/etc/gitconfig'
  fake_claude "$c"
  if [ -n "${2:-}" ]; then
    run_heavy docker exec -e DEBIAN_FRONTEND=noninteractive "$c" bash -c "$2" >"$work/setup-$1.log" 2>&1 || { echo "  setup of $1 failed:"; tail -20 "$work/setup-$1.log"; }
  fi
}
# A regular user "u" with passwordless sudo (what a VPS provider gives you).
SUDO_USER_SETUP='apt-get update -qq && apt-get install -y -qq sudo >/dev/null && useradd -m -s /bin/bash u && echo "u ALL=(ALL) NOPASSWD:ALL" >/etc/sudoers.d/u'
node_major() { docker exec ${2:+-u "$2"} "$1" bash -lc 'node -p "process.versions.node.split(\".\")[0]"'; }

run_edge() {
  local len n c log

  say "edge: a download cut short runs nothing"
  box trunc
  len=$(wc -c <"$work/weevils/install.sh")
  # Cuts all along the script, then at every byte of its end (the call line included; len-1 is the whole script).
  local cuts=0
  for n in $(seq 50 1500 "$len") $(seq $((len - 80)) $((len - 2))); do
    [ "$n" -gt 0 ] && [ "$n" -lt $((len - 1)) ] || continue
    cuts=$((cuts + 1))
    head -c "$n" "$work/weevils/install.sh" | docker exec -i -e WEEVILS_REPO=/srv/weevils.git "$c" bash -s -- --yes --lang en >/dev/null 2>&1
  done
  check "$cuts truncated scripts: no package, no clone, no config" docker exec "$c" bash -c '! command -v git && ! command -v tmux && ! test -e ~/weevils && ! test -e ~/.config/weevils && [ -z "$(ls /var/lib/apt/lists | grep -v -e ^partial$ -e ^lock$)" ]'

  say "edge: bad options are refused before anything runs"
  check "--port abc → exit 2" bash -c "docker exec $c bash /tmp/install.sh --yes --port abc >/dev/null 2>&1; [ \$? = 2 ]"
  check "--lang de → exit 2, says why" bash -c "out=\$(docker exec $c bash /tmp/install.sh --yes --lang de 2>&1); [ \$? = 2 ] && grep -q 'invalid value: --lang de' <<<\"\$out\""
  check "--domain 'a b{' → exit 2" bash -c "docker exec $c bash /tmp/install.sh --yes --domain 'a b{' >/dev/null 2>&1; [ \$? = 2 ]"
  check "still nothing installed" docker exec "$c" bash -c '! command -v git && ! test -e ~/.config/weevils'

  say "edge: no terminal and no --yes: nothing is installed without consent"
  docker exec -i -e WEEVILS_REPO=/srv/weevils.git "$c" bash -s -- --lang en <"$work/weevils/install.sh" >"$work/notty.log" 2>&1
  echo $? >"$work/notty.rc"
  check "exits non-zero, says to use --yes or a terminal" bash -c "[ \$(cat '$work/notty.rc') != 0 ] && grep -q 'run with --yes or from a terminal' '$work/notty.log'"
  check "still nothing installed" docker exec "$c" bash -c '! command -v git && ! test -e ~/.config/weevils'

  say "edge: regular user without sudo, tmux missing → clear refusal"
  box nosudo 'apt-get update -qq && apt-get install -y -qq git curl jq python3 ca-certificates >/dev/null && useradd -m -s /bin/bash u'
  docker exec -i -u u -w /home/u -e WEEVILS_REPO=/srv/weevils.git "$c" bash -s -- --yes --lang en <"$work/weevils/install.sh" >"$work/nosudo.log" 2>&1
  echo $? >"$work/nosudo.rc"
  sed 's/^/  │ /' "$work/nosudo.log"
  check "exits non-zero" test "$(cat "$work/nosudo.rc")" != 0
  check "names tmux and asks for root" bash -c "grep -q 'missing: tmux' '$work/nosudo.log' && grep -q 'needs root' '$work/nosudo.log'"
  check "wrote nothing in the home" docker exec -u u "$c" bash -c '! test -e ~/weevils && ! test -e ~/.config/weevils'

  say "edge: user with sudo, node 20 from NodeSource, cat install.sh | bash, file:// repo, --dir, --lang fr"
  box ns20 "$SUDO_USER_SETUP"' && apt-get install -y -qq curl ca-certificates gnupg >/dev/null && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null && apt-get install -y -qq nodejs >/dev/null'
  check "node 20 before" test "$(node_major "$c" u)" = 20
  echo '  $ cat install.sh | WEEVILS_REPO=file:///srv/weevils.git bash -s -- --yes --name "Ana Maria" --lang fr --dir w'
  docker exec -u u -w /home/u "$c" bash -c 'cat /tmp/install.sh | WEEVILS_REPO=file:///srv/weevils.git bash -s -- --yes --name "Ana Maria" --lang fr --dir w' >"$work/ns20.log" 2>&1
  echo $? >"$work/ns20.rc"
  sed 's/^/  │ /' "$work/ns20.log"
  check "exits 0" test "$(cat "$work/ns20.rc")" = 0
  check "node upgraded to 22" test "$(node_major "$c" u)" = 22
  check "cloned into ~/w from the file:// repo" docker exec -u u "$c" bash -c 'test -f ~/w/server/index.ts && [ "$(git -C ~/w remote get-url origin)" = file:///srv/weevils.git ]'
  check "weevilsd answers" docker exec -u u "$c" curl -sf http://127.0.0.1:4179/api/me
  check "nothing in the home belongs to root" docker exec "$c" bash -c '[ -z "$(find /home/u -user root | head -1)" ]'
  check "config: name with a space, lang fr, mode 600" docker exec -u u "$c" bash -c 'grep -qx "WEEVILS_USER_NAME=Ana Maria" ~/.config/weevils/env && grep -qx WEEVILS_LANG=fr ~/.config/weevils/env && [ "$(stat -c %a ~/.config/weevils/env)" = 600 ]'
  check "the server reads the name with its space" docker exec -u u "$c" bash -c 'curl -sf -H @$HOME/.local/share/weevils/local-token http://127.0.0.1:4179/api/snapshot | grep -q "Ana Maria"'
  check "Claude Code not logged in: 'presque prêt', run claude once" grep -q "presque prêt : lance claude" "$work/ns20.log"
  check "--lang fr: no English line" bash -c "! grep -E 'checking the system|getting weevils|your settings|dependencies and app|weevils is ready|access code|login link|waiting for' '$work/ns20.log'"

  say "edge: re-run after editing the config by hand"
  docker exec -u u "$c" bash -c 'f=~/.config/weevils/env; sed -i "s/^WEEVILS_PORT=.*/WEEVILS_PORT=4185/; s/^WEEVILS_ORCHESTRATOR=.*/WEEVILS_ORCHESTRATOR=0/; s/^OPENAI_API_KEY=.*/OPENAI_API_KEY=sk-test-SECRET42/; s/^WEEVILS_MACHINE_NAME=.*/WEEVILS_MACHINE_NAME=My Box/" $f && echo "# my own note" >>$f && cp $f /tmp/env.before'
  docker exec -u u -w /home/u "$c" bash -c 'cat /tmp/install.sh | WEEVILS_REPO=file:///srv/weevils.git bash -s -- --yes --dir w' >"$work/ns20b.log" 2>&1
  echo $? >"$work/ns20b.rc"
  sed 's/^/  │ /' "$work/ns20b.log"
  check "exits 0" test "$(cat "$work/ns20b.rc")" = 0
  check "every edited value kept (port, orchestrator, key, name, note)" docker exec -u u "$c" bash -c 'diff /tmp/env.before ~/.config/weevils/env'
  check "weevilsd moved to the edited port 4185" docker exec -u u "$c" bash -c 'for i in $(seq 20); do curl -sf http://127.0.0.1:4185/api/me >/dev/null && ! curl -sf -m 1 http://127.0.0.1:4179/api/me && exit 0; sleep 0.5; done; exit 1'
  check "re-run speaks the language of the config (fr) without --lang" grep -q "code d'accès" "$work/ns20b.log"
  check "the API key never shows in the output" bash -c "! grep -q SECRET42 '$work/ns20b.log' '$work/ns20.log'"
  check "config still mode 600" docker exec -u u "$c" bash -c '[ "$(stat -c %a ~/.config/weevils/env)" = 600 ]'

  say "edge: Ubuntu's own nodejs 18 + npm (apt) → upgraded"
  box apt18 'apt-get update -qq && apt-get install -y -qq nodejs npm curl >/dev/null'
  check "node 18 before" test "$(node_major "$c")" = 18
  docker exec -i -e WEEVILS_REPO=/srv/weevils.git "$c" bash -s -- --yes --lang en <"$work/weevils/install.sh" >"$work/apt18.log" 2>&1
  echo $? >"$work/apt18.rc"
  check "exits 0" bash -c "[ \$(cat '$work/apt18.rc') = 0 ] || { tail -30 '$work/apt18.log'; exit 1; }"
  check "node 22 now, weevilsd answers" bash -c "[ \$(docker exec $c node -p 'process.versions.node.split(\".\")[0]') = 22 ] && docker exec $c curl -sf http://127.0.0.1:4179/api/me"

  say "edge: an older node 20 tarball in /usr/local/bin shadows the system one"
  local arch; case "$(uname -m)" in aarch64) arch=arm64 ;; *) arch=x64 ;; esac
  box tar20 "apt-get update -qq && apt-get install -y -qq curl ca-certificates xz-utils >/dev/null && curl -fsSL https://nodejs.org/dist/latest-v20.x/ | grep -o 'node-v20[0-9.]*-linux-$arch.tar.xz' | head -1 | xargs -I{} curl -fsSL https://nodejs.org/dist/latest-v20.x/{} -o /tmp/n.tar.xz && tar -xJf /tmp/n.tar.xz -C /usr/local --strip-components=1"
  check "node 20 in /usr/local/bin before" bash -c "[ \$(docker exec $c node -p 'process.versions.node.split(\".\")[0]') = 20 ] && [ \$(docker exec $c bash -c 'command -v node') = /usr/local/bin/node ]"
  docker exec -i -e WEEVILS_REPO=/srv/weevils.git "$c" bash -s -- --yes --lang en <"$work/weevils/install.sh" >"$work/tar20.log" 2>&1
  echo $? >"$work/tar20.rc"
  check "exits 0" bash -c "[ \$(cat '$work/tar20.rc') = 0 ] || { tail -30 '$work/tar20.log'; exit 1; }"
  check "says which node shadows the new one" grep -q "older node comes first in your PATH.*/usr/local/bin/node" "$work/tar20.log"
  check "weevilsd runs on node 22 from /usr/bin" docker exec "$c" bash -c 'grep -qx "WEEVILS_NODE=/usr/bin/node" ~/.config/weevils/service.conf && curl -sf http://127.0.0.1:4179/api/me'

  say "edge: --lan, for a phone on the same home network"
  box lan
  docker exec -i -e WEEVILS_REPO=/srv/weevils.git "$c" bash -s -- --yes --lang en --lan <"$work/weevils/install.sh" >"$work/lan.log" 2>&1
  echo $? >"$work/lan.rc"
  local ip; ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$c")
  sed -n '/weevils is ready\|almost ready/,$p' "$work/lan.log" | sed 's/^/  │ /'
  check "exits 0, WEEVILS_HOST=0.0.0.0" bash -c "[ \$(cat '$work/lan.rc') = 0 ] && docker exec $c grep -qx WEEVILS_HOST=0.0.0.0 /root/.config/weevils/env"
  check "end screen: the LAN address ($ip) with a QR code" bash -c "grep -q 'http://$ip:4179/#k=' '$work/lan.log' && grep -qE '$QR' '$work/lan.log'"
  check "a private address: no warning, but http limits said" bash -c "! grep -q 'not a private network address' '$work/lan.log' && grep -q 'neither the microphone nor notifications' '$work/lan.log'"
  check "weevilsd answers on the LAN address" docker exec "$c" curl -sf "http://$ip:4179/api/me"

  say "edge: Caddy already serves another site (no systemd)"
  box caddy 'apt-get update -qq && apt-get install -y -qq caddy curl >/dev/null && printf "other.test {\n\ttls internal\n\trespond \"other site\"\n}\n" >/etc/caddy/Caddyfile && cp /etc/caddy/Caddyfile /tmp/Caddyfile.orig && caddy start --config /etc/caddy/Caddyfile >/dev/null 2>&1'
  other() { docker exec "$c" bash -c 'for i in $(seq 20); do [ "$(curl -sk --resolve other.test:443:127.0.0.1 https://other.test)" = "other site" ] && exit 0; sleep 0.5; done; exit 1'; }
  check "the other site answers before" other
  docker exec -i -e WEEVILS_REPO=/srv/weevils.git -e WEEVILS_CADDY_TLS=internal "$c" bash -s -- --yes --lang en --domain https://weevils.test/ <"$work/weevils/install.sh" >"$work/caddy1.log" 2>&1
  echo $? >"$work/caddy1.rc"
  sed -n '/HTTPS/,/waiting/p' "$work/caddy1.log" | sed 's/^/  │ /'
  check "exits 0 (--domain given as a URL)" bash -c "[ \$(cat '$work/caddy1.rc') = 0 ] || { tail -30 '$work/caddy1.log'; exit 1; }"
  check "Caddyfile: the other site untouched, one import added" docker exec "$c" bash -c '[ "$(diff /tmp/Caddyfile.orig /etc/caddy/Caddyfile | grep "^[<>]" | grep -v "^> *$")" = "> import /etc/caddy/weevils.caddy" ] && cmp /tmp/Caddyfile.orig /etc/caddy/Caddyfile.bak-weevils'
  check "the other site still answers" other
  check "weevils answers over HTTPS" docker exec "$c" bash -c 'for i in $(seq 20); do curl -sk --resolve weevils.test:443:127.0.0.1 https://weevils.test/api/me | grep -q "\"authed\":false" && exit 0; sleep 0.5; done; exit 1'
  docker exec "$c" bash -c 'cp /etc/caddy/Caddyfile /tmp/cf.mid && cp /etc/caddy/weevils.caddy /tmp/wc.mid'
  echo '  $ install.sh --domain other.test     (a domain the other site already has: Caddy must refuse it)'
  docker exec -i -e WEEVILS_REPO=/srv/weevils.git -e WEEVILS_CADDY_TLS=internal "$c" bash -s -- --yes --lang en --domain other.test <"$work/weevils/install.sh" >"$work/caddy2.log" 2>&1
  echo $? >"$work/caddy2.rc"
  check "exits 0 and says Caddy refused" bash -c "[ \$(cat '$work/caddy2.rc') = 0 ] && grep -q 'Caddy refuses the new config' '$work/caddy2.log'"
  check "both Caddy files exactly as before, config still valid" docker exec "$c" bash -c 'cmp /tmp/cf.mid /etc/caddy/Caddyfile && cmp /tmp/wc.mid /etc/caddy/weevils.caddy && caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1'
  check "public URL back to the working domain" docker exec "$c" grep -qx WEEVILS_PUBLIC_URL=https://weevils.test /root/.config/weevils/env
  check "end screen shows the working https link" grep -q "https://weevils.test/#k=" "$work/caddy2.log"
  check "the other site still answers" other
  echo '  $ install.sh --port 4199     (no --domain: the site set up before follows the new port)'
  docker exec -i -e WEEVILS_REPO=/srv/weevils.git "$c" bash -s -- --yes --lang en --port 4199 <"$work/weevils/install.sh" >"$work/caddy3.log" 2>&1
  echo $? >"$work/caddy3.rc"
  check "exits 0, the Caddy site moved to 4199 (tls internal kept)" bash -c "[ \$(cat '$work/caddy3.rc') = 0 ] && docker exec $c bash -c 'grep -q \"reverse_proxy 127.0.0.1:4199\" /etc/caddy/weevils.caddy && grep -q \"tls internal\" /etc/caddy/weevils.caddy' || { tail -30 '$work/caddy3.log'; exit 1; }"
  check "weevils answers over HTTPS on the new port" docker exec "$c" bash -c 'for i in $(seq 20); do curl -sk --resolve weevils.test:443:127.0.0.1 https://weevils.test/api/me | grep -q "\"authed\":false" && curl -sf http://127.0.0.1:4199/api/me >/dev/null && exit 0; sleep 0.5; done; exit 1'
  check "end screen shows the https link" grep -q "https://weevils.test/#k=" "$work/caddy3.log"
  check "the other site still answers" other
}

case "$which" in
  systemd) run_systemd ;;
  plain) run_plain ;;
  edge) run_edge ;;
  all) run_systemd; run_plain; run_edge ;;
  *) echo "usage: $0 [all|systemd|plain|edge]"; exit 2 ;;
esac

echo
if [ "$fails" = 0 ] && [ "$passes" -gt 0 ]; then printf '\e[30;42m PASS \e[0m %d checks\n' "$passes"; exit 0
else printf '\e[97;41m FAIL \e[0m %d failed, %d passed\n' "$fails" "$passes"; exit 1; fi
