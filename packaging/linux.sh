#!/bin/bash
# Run inside the provisioned Linux VM or Linux CI; never installs packages.
set -euo pipefail
aw_repo=$(cd "$(dirname "$0")/.." && pwd)
if [[ "$(uname -s)" != Linux ]]; then
  echo 'Run this script inside a Linux VM or Linux CI with the repo copied into it.' >&2
  exit 1
fi
aw_arch=$(uname -m)
case "$aw_arch" in
  aarch64) aw_target=linux ;;
  x86_64) aw_target=linux-x64 ;;
  *) echo "Unsupported Linux architecture: $aw_arch" >&2; exit 1 ;;
esac
# No interface, route, SDK fetch, apt command or download can leave this namespace.
exec unshare --user --map-root-user --net python3 "$aw_repo/packaging/build.py" --target "$aw_target" "$@"
