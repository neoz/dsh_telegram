#!/bin/sh
set -eu
if [ "$(id -u)" = 0 ]; then
  # Bind mounts keep the host's ownership (root when Docker creates them); fix it, then re-run as node.
  chown node:node /data /workspace
  # setpriv keeps the environment, so HOME would stay /root (unreadable by node).
  export HOME=/home/node
  exec setpriv --reuid=node --regid=node --init-groups "$0" "$@"
fi
# Refresh the profile from the image on every start; sessions stay in the volume.
mkdir -p "$DSH_HOME/profiles" "$DSH_AGENTS_HOME/skills"
rm -rf "$DSH_HOME/profiles/telegram"
cp -R /opt/dsh-telegram/profile "$DSH_HOME/profiles/telegram"
exec "$@"
