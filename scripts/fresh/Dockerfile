# A blank weevils machine, as someone who just installed it would have it (scripts/fresh.sh builds and runs it).
# Ubuntu 24.04, Node 22, Claude Code installed but not logged in, a regular user without sudo, and weevils put in
# place by its own install.sh from a clone of the repo. No key, no project, no session, no data of anyone.
FROM ubuntu:24.04
ARG NODE_MAJOR=22
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl git tmux jq python3 qrencode procps iproute2 xz-utils \
 && rm -rf /var/lib/apt/lists/* \
 && arch=$(dpkg --print-architecture | sed 's/amd64/x64/') \
 && ver=$(curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/SHASUMS256.txt" | grep -o "node-v[0-9.]*-linux-$arch.tar.xz" | head -1) \
 && curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/$ver" | tar -xJ -C /usr/local --strip-components=1 \
 && npm i -g --no-audit --no-fund @anthropic-ai/claude-code \
 && (userdel -r ubuntu 2>/dev/null || true) \
 && useradd -m -s /bin/bash -u 1000 me
ENV LANG=C.UTF-8
COPY --chown=me:me weevils /home/me/weevils
USER me
WORKDIR /home/me
# The real installer, no question asked. It starts weevilsd once (background mode, no systemd here): what that first
# run wrote is thrown away, so the container's first start is the server's very first start.
RUN cd weevils && ./install.sh --yes --no-update \
 && (~/.local/bin/weevils-service stop || true) \
 && rm -rf ~/.local/share/weevils ~/.config/weevils/secret \
 && sed -i '/^WEEVILS_MACHINE/d' ~/.config/weevils/env
EXPOSE 4179
CMD ["/home/me/weevils/scripts/fresh/entrypoint.sh"]
