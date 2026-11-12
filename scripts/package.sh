#!/usr/bin/env bash
# Packages the app + service into a single .ipk under build/.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d service/node_modules/webos-service ]; then
  echo "service/node_modules/webos-service missing - installing (pinned commit, see service/package.json)..."
  (cd service && npm install --no-save webos-service)
fi
if [ ! -d service/node_modules/ws ]; then
  echo "service/node_modules/ws missing - installing..."
  (cd service && npm install --no-save ws@8.21.3)
fi

# service/state/ is where the service keeps the viewer's sign-in on the TV
# (service/lib/store.js). If a local run ever created it, it must not ship.
if [ -e service/state ]; then
  echo "service/state exists and would be packaged with a sign-in in it - remove it first." >&2
  exit 1
fi

rm -rf build
mkdir -p build
ares-package app service -o build
ls -la build
