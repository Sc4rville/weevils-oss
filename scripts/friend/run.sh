#!/usr/bin/env bash
# Run from an extracted source package or a clone. No host credentials or projects are mounted.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
name=${FRIEND_NAME:-weevils-friend}
port=${FRIEND_PORT:-4286}
url=${FRIEND_URL:-}
case "$name" in *[!a-zA-Z0-9_-]*|'') echo 'Invalid FRIEND_NAME' >&2; exit 2;; esac
[[ "$port" =~ ^[0-9]+$ ]] && ((port > 1024 && port < 65536)) || { echo 'Invalid FRIEND_PORT' >&2; exit 2; }
[ "$port" != 4179 ] && [ "$port" != 4192 ] || { echo 'Choose a dedicated port' >&2; exit 2; }
case "${1:-up}" in
  up|update)
    if [ "${1:-up}" = up ] && docker container inspect "$name" >/dev/null 2>&1; then
      echo "Container $name already exists; use start, status or link. No data replaced."; exit 1
    fi
    revision=$(git -C "$root" rev-parse HEAD 2>/dev/null || cat "$root/SOURCE_REVISION" 2>/dev/null || printf source-archive)
    build=(docker build --build-arg "WEEVILS_BUILD_COMMIT=$revision" -t "$name" -f "$root/scripts/friend/Dockerfile" "$root")
    if command -v heavy >/dev/null; then heavy "${build[@]}"; else "${build[@]}"; fi
    if [ "${1:-up}" = update ]; then docker rm -f "$name" >/dev/null; fi
    docker run -d --name "$name" --hostname friend --init --restart unless-stopped \
      --cpus 2 --memory 2g --pids-limit 512 --security-opt no-new-privileges --cap-drop ALL \
      --mount "type=volume,source=$name-home,target=/home/node" \
      -p "127.0.0.1:$port:4179" -e FRIEND_URL="$url" "$name"
    for _ in $(seq 60); do curl -fs "http://127.0.0.1:$port/api/me" >/dev/null && exit 0; sleep 1; done
    echo 'Server not ready; inspect container logs.' >&2; exit 1;;
  start) docker start "$name";;
  status) docker ps -a --filter "name=^$name$";;
  link)
    secret=$(docker exec "$name" cat /home/node/.config/weevils/secret)
    printf '%s/#k=%s\n' "${url:-http://localhost:$port}" "$secret";;
  *) echo 'Usage: run.sh up|update|start|status|link' >&2; exit 2;;
esac
