#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
cd /opt/weevils
# All paths are inside this container's persistent HOME; no host account is imported.
./server/weevils-service config set WEEVILS_HOST 0.0.0.0
./server/weevils-service config default WEEVILS_MACHINE friend
./server/weevils-service config default WEEVILS_MACHINE_NAME 'my server'
[ -z "${FRIEND_URL:-}" ] || ./server/weevils-service config set WEEVILS_PUBLIC_URL "$FRIEND_URL"
exec node server/index.ts
