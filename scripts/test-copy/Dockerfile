# The box a weevils test copy runs in (scripts/test-copy.sh): node, tmux and git, nothing of the host. The copy's
# folder and the dependencies are the only things mounted; the live tmux socket and ~/.config/weevils don't exist here.
FROM node:22-slim
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tmux git procps ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV LANG=C.UTF-8
