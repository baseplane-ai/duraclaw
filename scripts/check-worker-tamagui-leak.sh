#!/usr/bin/env bash
# GH#125 P1a: prevent @tamagui/* imports from leaking into the Worker
# entry. Tamagui in dist/<worker> would bloat the bundle and slow cold
# start. Greps the orchestrator's server*.ts files; exits 1 on match.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_GLOB="$ROOT/apps/orchestrator/src/server*.ts"

LEAKS=$(grep -rE "from ['\"]@tamagui" $TARGET_GLOB 2>/dev/null || true)
if [[ -n "$LEAKS" ]]; then
  echo "ERROR: @tamagui import detected in Worker entry — leak would bloat Worker bundle:" >&2
  echo "$LEAKS" >&2
  exit 1
fi
echo "OK: no @tamagui imports in apps/orchestrator/src/server*.ts"
