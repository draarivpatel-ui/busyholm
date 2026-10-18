#!/bin/bash
set -euo pipefail
aw_repo=$(cd "$(dirname "$0")/.." && pwd)
source "$aw_repo/tools/env.sh"
exec python3 "$aw_repo/packaging/build.py" --target macos "$@"
