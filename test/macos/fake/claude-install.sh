#!/bin/bash
# What `curl -fsSL https://claude.ai/install.sh` answers on the fake Mac: puts the stub where the real installer
# puts Claude Code.
set -e
mkdir -p "$HOME/.local/bin"
cp /opt/fakemac/claude "$HOME/.local/bin/claude"
chmod 755 "$HOME/.local/bin/claude"
echo "claude-install $HOME/.local/bin/claude" >>/var/fakemac/calls.log
echo "✔ Claude Code successfully installed! (fake)"
