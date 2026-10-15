#!/usr/bin/env bash
# Package, install, and (by default) launch on the TV.
# Usage: deploy.sh [device] [--no-launch]
# --no-launch installs without pulling the app onto the screen - useful when
# something else is on the TV right now.
#
# The TV is rooted with Homebrew Channel, and LG's Developer Mode app is
# gone. ares-install/ares-launch still work: they just point at Homebrew's
# root sshd on port 22 instead of Dev Mode's on 9922. One-time setup:
#   - Homebrew Channel > Settings > SSH server on (it starts at boot, so
#     reboot after enabling)
#   - this PC's key in /home/root/.ssh/authorized_keys on the TV
#   - ares-setup-device -a tv-root -i "username=root" -i "privatekey=f1hud_tv" \
#       -i "passphrase=" -i "host=192.168.29.100" -i "port=22"
#
# (Homebrew's own install API, luna://org.webosbrew.hbchannel.service/install,
# also works but is fussier: it needs an http(s) ipkUrl the TV can reach -
# Windows Firewall blocks a server on this PC - plus the file's sha256 as
# ipkHash, or it fails with "Invalid file checksum".)
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
  echo "Launching com.amogh.f1hud..."
  ares-launch -d "$DEVICE" com.amogh.f1hud
else
  echo "Installed. Not launching (--no-launch passed)."
fi
