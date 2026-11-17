# A blank Ubuntu 24.04 "VPS": systemd as PID 1 (with logind and the system bus, like any real server) and a regular
# user "test" with passwordless sudo. Nothing else: no node, git, curl, tmux… install.sh has to bring them.
FROM ubuntu:24.04
ENV container=docker
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends systemd systemd-sysv dbus libpam-systemd sudo \
 && rm -rf /var/lib/apt/lists/* \
 && (userdel -r ubuntu 2>/dev/null || true) \
 && useradd -m -s /bin/bash -u 1000 test \
 && echo 'test ALL=(ALL) NOPASSWD:ALL' >/etc/sudoers.d/test && chmod 440 /etc/sudoers.d/test \
 && systemctl mask systemd-udevd.service systemd-udevd-kernel.socket systemd-udevd-control.socket \
      getty.target console-getty.service systemd-firstboot.service systemd-resolved.service systemd-timesyncd.service
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
