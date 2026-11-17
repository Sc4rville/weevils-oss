#!/usr/bin/env bash
# Start of the fresh container (scripts/fresh.sh): what install.sh would have set on this host, then weevilsd in the
# foreground (Docker restarts it; --init reaps what it leaves behind).
set -euo pipefail
cfg() { ~/.local/bin/weevils-service config "$@"; }
host=$(hostname -s | tr 'A-Z' 'a-z' | tr -c 'a-z0-9-\n' '-' | cut -c1-20)
cfg default WEEVILS_MACHINE "$host"
cfg default WEEVILS_MACHINE_NAME "$host"
# Reached through Docker's port mapping, never from the container's own loopback.
cfg set WEEVILS_HOST 0.0.0.0
[ -z "${FRESH_URL:-}" ] || cfg set WEEVILS_PUBLIC_URL "$FRESH_URL"
# A stable access code given by the host keeps the same login link across resets.
if [ -n "${FRESH_SECRET:-}" ]; then (umask 077 && printf %s "$FRESH_SECRET" >~/.config/weevils/secret); fi
cd ~/weevils
exec env NODE_ENV=production PATH="$HOME/.local/bin:$PATH" node server/index.ts
