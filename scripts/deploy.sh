#!/usr/bin/env bash
# Package, install, and (by default) launch on the TV.
# Usage: deploy.sh [device] [--no-launch]
# --no-launch installs without pulling the app onto the screen - useful when
# something else is on the TV right now.
#
# Developer install over SSH, for a TV rooted with Homebrew Channel (users
# install from Homebrew Channel instead). ares-install/ares-launch work
# against Homebrew's root sshd on port 22 just as they do against LG's
# Developer Mode on 9922. One-time setup:
#   - Homebrew Channel > Settings > SSH server on (it starts at boot, so
#     reboot after enabling)
#   - your SSH public key in /home/root/.ssh/authorized_keys on the TV
#   - ares-setup-device -a tv-root -i "username=root" -i "privatekey=<key file>" #       -i "passphrase=" -i "host=<TV address>" -i "port=22"
# The device defaults to "tv-root"; pass another ares device name to override.
#
# (Homebrew's own install API, luna://org.webosbrew.hbchannel.service/install,
# also works but is fussier: it needs an http(s) ipkUrl the TV can reach,
# plus the file's sha256 as ipkHash, or it fails with "Invalid file checksum".)
set -euo pipefail
cd "$(dirname "$0")/.."

DEVICE="tv-root"
LAUNCH=1
for arg in "$@"; do
  case "$arg" in
    --no-launch) LAUNCH=0 ;;
    *) DEVICE="$arg" ;;
  esac
done

./scripts/package.sh

IPK=$(ls build/*.ipk | head -1)
echo "Installing $IPK on device '$DEVICE'..."
# While the TV is busy playing video, Homebrew's sshd sometimes refuses the
# command channel right after the upload ("Unable to exec"); a retry a few
# seconds later goes through.
for attempt in 1 2 3 4; do
  if ares-install -d "$DEVICE" "$IPK"; then
    break
  fi
  if [ "$attempt" = "4" ]; then
    echo "Install failed after $attempt attempts." >&2
    exit 1
  fi
  echo "Install attempt $attempt failed; retrying in 5s..."
  sleep 5
done

if [ "$LAUNCH" = "1" ]; then
  APP_ID=$(node -p "require('./app/appinfo.json').id")
  echo "Launching $APP_ID..."
  ares-launch -d "$DEVICE" "$APP_ID"
else
  echo "Installed. Not launching (--no-launch passed)."
fi
