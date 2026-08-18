#!/bin/bash
# Builds vendor/codemirror.bundle.js from entry.mjs.
#
# The OUTPUT is committed, so loading the extension needs no npm and no build —
# only changing the editor does. That keeps the extension a "load unpacked"
# folder, which is the whole reason it has been dependency-free until now.
set -euo pipefail
cd "$(dirname "$0")"

[ -d node_modules ] || npm install --no-audit --no-fund

./node_modules/.bin/esbuild entry.mjs \
  --bundle --format=esm --target=es2022 --minify \
  --outfile=../vendor/codemirror.bundle.js

printf 'vendor/codemirror.bundle.js  %s KB\n' \
  "$(( $(wc -c < ../vendor/codemirror.bundle.js) / 1024 ))"
