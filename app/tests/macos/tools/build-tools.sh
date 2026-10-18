#!/bin/bash
# WP-02 test tools: compiles every *.swift in this folder into bin/ with swiftc -O.
# A tool is skipped when its binary is newer than its source. Exits non-zero if any compile fails.
# Works from any working directory because it resolves its own location.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="$here/bin"
mkdir -p "$out"

status=0
shopt -s nullglob
for src in "$here"/*.swift; do
  name="$(basename "$src" .swift)"
  bin="$out/$name"
  if [[ -x "$bin" && "$bin" -nt "$src" ]]; then
    echo "up to date: $name"
    continue
  fi
  echo "compiling: $name"
  if ! swiftc -O -o "$bin" "$src"; then
    echo "FAILED: $name" >&2
    status=1
  fi
done
exit "$status"
