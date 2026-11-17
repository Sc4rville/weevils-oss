#!/usr/bin/env bash
# weevils — bring your conversations from this computer to your weevils.
#
# What it does: lists the Claude Code and Codex conversations on this computer (each one's first lines, last lines,
#   size and date, so your weevils can show their titles), sends that list to your weevils, then sends whole the ones
#   you tap there, with the git address of their folder so your weevils can clone the same project.
# What it never does: install anything, change or delete a file here, read anything outside ~/.claude/projects and
#   ~/.codex (plus `git remote` in a conversation's own folder), keep running after you close this window.
# Where it sends: only to the weevils address below, over the link this one-time code opens.
# Stop: Ctrl+C, or close the window. Nothing is left behind.
#
# Usage: curl -fsSL <your weevils>/api/bring.sh | bash -s <code>
set -u
base="__BASE__"
code="${1:-}"
case "$code" in
  '' | *[!A-Za-z0-9_-]*) echo "This needs the whole line from your weevils (it ends with a code)."; exit 1 ;;
esac
command -v curl >/dev/null 2>&1 || { echo "curl is missing on this computer."; exit 1; }
command -v gzip >/dev/null 2>&1 || { echo "gzip is missing on this computer."; exit 1; }
api="$base/api/bring/pc/$code"
tmp=$(mktemp -d 2>/dev/null || mktemp -d -t weevils-bring) || exit 1
trap 'rm -rf "$tmp"' EXIT
trap 'echo; echo "Stopped."; exit 0' INT TERM

mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0; }
size() { wc -c <"$1" | tr -d ' '; }

# git only where it really runs: on a Mac without its developer tools, `git` would open an install dialog.
git_ok=0
if command -v git >/dev/null 2>&1; then
  if [ "$(uname -s)" = Darwin ]; then xcode-select -p >/dev/null 2>&1 && git_ok=1; else git_ok=1; fi
fi

: >"$tmp/list"
add() {
  case "$2" in *'	'* | *'
'*) return ;; esac
  printf '%s\t%s\t%s\n' "$(mtime "$2")" "$1" "$2" >>"$tmp/list"
}

# Claude Code: ~/.claude/projects/<folder>/<id>.jsonl (one level: a conversation's subagents sit deeper).
# Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, and the archived ones.
# Under WSL, the same folders of the Windows side too.
claude_dirs="$HOME/.claude/projects"
codex_dirs="${CODEX_HOME:-$HOME/.codex}"
if grep -qi microsoft /proc/version 2>/dev/null; then
  for u in /mnt/c/Users/*; do
    [ -d "$u/.claude/projects" ] && claude_dirs="$claude_dirs
$u/.claude/projects"
    [ -d "$u/.codex" ] && codex_dirs="$codex_dirs
$u/.codex"
  done
fi
echo "$claude_dirs" | while IFS= read -r d; do
  for f in "$d"/*/*.jsonl; do [ -f "$f" ] && add claude "$f"; done
done
echo "$codex_dirs" | while IFS= read -r d; do
  for s in "$d/sessions" "$d/archived_sessions"; do
    [ -d "$s" ] && find "$s" -type f -name 'rollout-*.jsonl' 2>/dev/null | while IFS= read -r f; do add codex "$f"; done
  done
done

total=$(wc -l <"$tmp/list" | tr -d ' ')
if [ "$total" = 0 ]; then
  echo "No Claude Code or Codex conversation on this computer (looked in ~/.claude/projects and ~/.codex)."
  exit 0
fi
# The 300 most recent.
sort -rn "$tmp/list" | head -n 300 >"$tmp/top"

# The list sent: per conversation, one header line, then its first 48 KB and its last 16 KB.
: >"$tmp/map"
{
  n=0
  while IFS='	' read -r m tool f; do
    n=$((n + 1))
    s=$(size "$f")
    head -c 49152 "$f" >"$tmp/h" 2>/dev/null
    if [ "$s" -gt 65536 ]; then tail -c 16384 "$f" >"$tmp/t" 2>/dev/null; else : >"$tmp/t"; fi
    printf 'WVB1\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$n" "$tool" "$s" "$m" "$(size "$tmp/h")" "$(size "$tmp/t")" "$f"
    cat "$tmp/h" "$tmp/t"
    printf '%s\t%s\n' "$n" "$f" >>"$tmp/map"
  done <"$tmp/top"
  # Codex keeps the names of its conversations apart.
  echo "$codex_dirs" | while IFS= read -r d; do
    i="$d/session_index.jsonl"
    if [ -f "$i" ]; then
      tail -c 262144 "$i" >"$tmp/i"
      printf 'WVB1\t0\tcodex-index\t%s\t0\t%s\t0\t%s\n' "$(size "$tmp/i")" "$(size "$tmp/i")" "$i"
      cat "$tmp/i"
    fi
  done
} | gzip -c >"$tmp/index.gz"

host=$(hostname 2>/dev/null | cut -d. -f1)
if ! r=$(curl -fsS -X POST --data-binary @"$tmp/index.gz" -H 'content-type: application/gzip' -H "x-host: ${host:-computer}" "$api/index" 2>&1); then
  echo "Your weevils did not take the list ($r). Get a fresh line from your weevils and paste it again."
  exit 1
fi
shown=$(wc -l <"$tmp/map" | tr -d ' ')
echo "Your weevils now shows $shown conversations from this computer."
echo "Tap the ones you want there. Keep this window open until they are across; Ctrl+C when you are done."

fails=0
while :; do
  if ! r=$(curl -fsS --max-time 40 "$api/next" 2>/dev/null); then
    fails=$((fails + 1))
    [ "$fails" -gt 40 ] && { echo "Lost your weevils. Paste the line again to go on."; exit 1; }
    sleep 3
    continue
  fi
  fails=0
  case "$r" in bye*) echo "Done: your weevils closed this link."; exit 0 ;; esac
  for n in $r; do
    case "$n" in '' | *[!0-9]*) continue ;; esac
    f=$(awk -F'	' -v n="$n" '$1 == n { print $2; exit }' "$tmp/map")
    [ -n "$f" ] && [ -f "$f" ] || continue
    cwd=$(head -c 300000 "$f" | grep -o '"cwd":"[^"]*"' | head -n 1 | sed 's/^"cwd":"//; s/"$//')
    origin='' root='' branch=''
    if [ "$git_ok" = 1 ] && [ -n "$cwd" ] && [ -d "$cwd" ]; then
      root=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null)
      origin=$(git -C "$cwd" remote get-url origin 2>/dev/null)
      branch=$(git -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null)
    fi
    printf 'Sending a conversation (%s KB)… ' "$(($(size "$f") / 1024))"
    if gzip -c "$f" | curl -fsS -T - -X POST -H 'content-type: application/gzip' \
      -H "x-git-origin: $origin" -H "x-git-root: $root" -H "x-git-branch: $branch" "$api/file/$n" >/dev/null 2>&1; then
      echo "across."
    else
      echo "failed (tap it again on your phone)."
    fi
  done
done
