FROM node:22-bookworm@sha256:7702d8aa4d5910871692af4480eb3ba86f23047a6417a44d857d06c95d060d3f
RUN apt-get update && apt-get install -y --no-install-recommends tmux jq python3 qrencode iproute2 ca-certificates curl git \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g --no-audit --no-fund @anthropic-ai/claude-code@2.1.322
COPY --chown=node:node . /opt/weevils
WORKDIR /opt/weevils
ARG WEEVILS_BUILD_COMMIT=source-archive
RUN npm ci --include=dev --ignore-scripts && WEEVILS_BUILD_COMMIT="$WEEVILS_BUILD_COMMIT" npm run build && npm prune --omit=dev
ENV HOME=/home/node LANG=C.UTF-8 NODE_ENV=production
USER node
RUN mkdir -p /home/node/projects /home/node/.config/weevils \
 && cp .env.example /home/node/.config/weevils/env \
 && ./server/weevils-service config set WEEVILS_SAFE 1 \
 && ./server/weevils-service config set WEEVILS_DISCOVER 0 \
 && ./server/install.sh \
 && ./server/weevils-service stop \
 && rm -rf /home/node/.local/share/weevils /home/node/.config/weevils/secret \
 && mkdir -p /home/node/.local/share/weevils
EXPOSE 4179
CMD ["bash", "/opt/weevils/scripts/friend/entrypoint.sh"]
