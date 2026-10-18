#!/bin/bash
# WP-02 acceptance tests on macOS: builds the test tools, the frontend and the debug app, then runs
# acceptance.py against the real screen. Usage: run-acceptance.sh [tests, e.g. 1,2,3]
# Output: app/tests/out/macos-<time>/ (results.json, one log per app run). Moves the cursor and, for
# test 4, briefly opens a fullscreen test app in its own Space. Never changes Dock or display settings.
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
out="$app/tests/out/macos-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$out"
python3 -I "$here/acceptance.py" "$out" "${1:-1,2,3,4,5,x}"
