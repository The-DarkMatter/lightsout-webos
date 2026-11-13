#!/bin/sh
set -e
cd "$(dirname "$0")/.."

if [ -e service/state ]; then
  echo "service/state exists and would be packaged with a sign-in in it - remove it first." >&2
  exit 1
fi

[ -d legacy/deps/node_modules/ws ] || (mkdir -p legacy/deps && cd legacy/deps &&
  npm init -y >/dev/null && npm install --no-save ws@1.1.5 >/dev/null)

rm -rf build/legacy
mkdir -p build/legacy/out
cp -r app service build/legacy/
node legacy/build.js
ares-package -o build/legacy/out --no-minify build/legacy/app build/legacy/service
ls -la build/legacy/out
