#!/bin/bash
# WP-02 test tool: prints the name of the frontmost application (for example: Mail).
set -euo pipefail

# Newer macOS prints:  "Mail" ASN:0x0-0x1868867: (in front)
# Older output looked like: "LSDisplayName"="Mail"
line="$(lsappinfo info -only name "$(lsappinfo front)")"
if [[ "$line" == *'"LSDisplayName"="'* ]]; then
  name="${line#*\"LSDisplayName\"=\"}"
  name="${name%%\"*}"
else
  name="${line#\"}"
  name="${name%%\"*}"
fi
printf '%s\n' "$name"
