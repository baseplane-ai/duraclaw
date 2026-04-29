#!/usr/bin/env bash
# GH#125 P1a + GH#131 P2: prevent web-renderer imports from leaking into
# the CF Worker entry. Three module families are banned:
#
#   1. @tamagui/*                       (GH#125) — adds ~? MB and pulls
#      browser-only style runtime into the Worker bundle.
#   2. react-native-web / react-native-web-lite  (GH#131) — RNW polyfills
#      shipped to the Worker would cost ~500 KB and break in eval/global
#      scope (no `window`, no `document`).
#   3. react-native                     (GH#131) — Vite's `resolve.alias`
#      reroutes web client imports to `@tamagui/react-native-web-lite`,
#      but the Worker entry must never request `react-native` in the
#      first place. Belt-and-suspenders alongside `ssr.noExternal` in
#      `apps/orchestrator/vite.config.ts`.
#
# Greps the orchestrator's server*.ts files; exits 1 on match.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_GLOB="$ROOT/apps/orchestrator/src/server*.ts"

LEAKS=$(grep -rE "from ['\"](@tamagui|react-native-web|react-native)" $TARGET_GLOB 2>/dev/null || true)
if [[ -n "$LEAKS" ]]; then
  echo "ERROR: web-renderer import detected in Worker entry — leak would bloat Worker bundle and/or break in Workers runtime:" >&2
  echo "$LEAKS" >&2
  exit 1
fi
echo "OK: no @tamagui / react-native[-web][-lite] imports in apps/orchestrator/src/server*.ts"
