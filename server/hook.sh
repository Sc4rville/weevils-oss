#!/bin/sh
# Hook Claude Code → weevilsd (local). Ne bloque jamais la session : 1 s max, erreurs ignorées.
# Installé par server/install.sh dans ~/.claude/settings.json (tous les événements utiles).
curl -s -m 1 -X POST -H 'content-type: application/json' -H "x-pid: $PPID" \
  --data-binary @- "http://127.0.0.1:${WEEVILS_HOOK_PORT:-4180}/hook" >/dev/null 2>&1 || true
exit 0
