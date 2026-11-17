# A fake macOS for test/macos/run.sh: Alpine with the bash 3.2.57 that macOS ships as /bin/bash and /bin/sh, the GNU
# tools behind wrappers that refuse what the BSD tools of a Mac refuse, fakes of the macOS commands the installer
# calls (launchctl, brew, security…), and none of the commands a Mac lacks. See fake/setup.sh for the layout.
# Build context (assembled by run.sh): this file, fake/, and the repo's package.json + package-lock.json.
FROM bash:3.2
RUN apk add --no-cache coreutils findutils sed grep nawk curl git perl perl-utils python3 openssl ca-certificates \
      openssh-client-default netcat-openbsd lsof procps-ng uuidgen sudo tmux jq nodejs npm libqrencode-tools
COPY fake /opt/fakemac
RUN /usr/local/bin/bash /opt/fakemac/setup.sh
ENV PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
# The npm cache of the test user, filled once here: every scenario then runs a real `npm ci` without the network.
COPY --chown=501:20 package.json package-lock.json /tmp/npm-warm/
RUN cd /tmp/npm-warm && su mac -s /bin/bash -c 'HOME=/Users/mac PATH=/opt/cellar/node/bin:$PATH npm ci --no-audit --no-fund --no-update-notifier --include=dev --ignore-scripts >/dev/null 2>&1' \
    && rm -rf /tmp/npm-warm
USER mac
WORKDIR /Users/mac
ENV HOME=/Users/mac USER=mac LOGNAME=mac SHELL=/bin/zsh TMPDIR=/var/folders/zz/fakemac/T/
# (The base image starts through docker-entrypoint.sh, which is gone.)
ENTRYPOINT []
CMD ["sleep", "2147483647"]
