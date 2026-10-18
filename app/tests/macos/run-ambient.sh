#!/bin/bash
# WP-12 acceptance tests on macOS (ambient mode). Builds the test tools, the frontend and the debug
# app, then runs ambient.py against the real screen. Usage: run-ambient.sh [tests, e.g. 1,2,3,4]
# Moves the cursor (CGWarpMouseCursorPosition) and briefly opens a fullscreen test app in its own Space.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app="$(cd "$here/../.." && pwd)"
repo="$(cd "$app/.." && pwd)"
source "$repo/tools/env.sh"
bash "$here/tools/build-tools.sh" >/dev/null
node "$app/scripts/assemble-frontend.mjs" >/dev/null
if [[ -z "${BUSYHOLM_BIN:-}" ]]; then
  (cd "$app/src-tauri" && cargo build --quiet)
fi
out="$app/tests/out/macos-ambient-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$out"
python3 -I "$here/ambient.py" "$out" "${1:-1,2,3,4}"
