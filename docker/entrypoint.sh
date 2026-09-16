#!/bin/sh
# Refresh the profile from the image on every start; sessions stay in the volume.
set -eu
mkdir -p "$DSH_HOME/profiles"
rm -rf "$DSH_HOME/profiles/telegram"
cp -R /opt/dsh-telegram/profile "$DSH_HOME/profiles/telegram"
exec "$@"
