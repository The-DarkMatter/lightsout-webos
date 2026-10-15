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

rm -rf build
mkdir -p build
ares-package app service -o build
ls -la build
