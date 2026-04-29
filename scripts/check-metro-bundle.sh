#!/usr/bin/env bash
# GH#131 P2 — Metro smoke-bundle CI gate (hard gate per spec D3).
#
# Purpose: prove the orchestrator's source tree resolves cleanly under
# a Metro+react-native target. Failure (resolver/transform error)
# blocks PR merge. Success emits a bundle to /tmp/metro-smoke/ that is
# NOT shipped — Vite remains the production web bundler.
#
# Invocation: run from anywhere; the script cd's to the repo root.
# Used by: `pnpm --filter @duraclaw/orchestrator verify:metro` and
# any CI step that wants a single command to gate the smoke build.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
OUT_DIR=/tmp/metro-smoke
rm -rf "$OUT_DIR"

echo "GH#131 P2: running Metro smoke build → $OUT_DIR"

# Expo SDK 54+ canonical invocation. `--no-minify` keeps the bundle
# greppable so VP-4 step 2 can confirm the router source made it
# through the pnpm-monorepo resolver.
pnpm --filter @duraclaw/orchestrator exec npx expo export \
  --platform web \
  --output-dir "$OUT_DIR" \
  --no-minify \
  || { echo "ERROR: Metro smoke build failed" >&2; exit 1; }

# Expo SDK 54 emits a code-split bundle into _expo/static/js/web/:
# `__common-*.js` carries the workspace runtime, `entry-rn-*.js`
# carries the route tree, and per-route / per-language chunks split
# off dynamic imports. Verify both core chunks exist and the entry
# chunk contains the orchestrator's router code (proves the
# pnpm-monorepo resolver walked our source, not just the metro
# runtime preamble).
COMMON_BUNDLE=$(find "$OUT_DIR/_expo/static/js/web" -name '__common-*.js' 2>/dev/null | head -n 1 || true)
ENTRY_BUNDLE=$(find "$OUT_DIR/_expo/static/js/web" -name 'entry-rn-*.js' 2>/dev/null | head -n 1 || true)

if [[ -z "${COMMON_BUNDLE:-}" || ! -s "$COMMON_BUNDLE" ]]; then
  echo "ERROR: no common bundle (__common-*.js) at $OUT_DIR/_expo/static/js/web/" >&2
  exit 1
fi
if [[ -z "${ENTRY_BUNDLE:-}" || ! -s "$ENTRY_BUNDLE" ]]; then
  echo "ERROR: no entry bundle (entry-rn-*.js) at $OUT_DIR/_expo/static/js/web/" >&2
  exit 1
fi

if ! grep -q 'createRouter' "$ENTRY_BUNDLE"; then
  echo "ERROR: entry bundle does not contain 'createRouter' — orchestrator router source did not make it through Metro's resolver" >&2
  exit 1
fi

TOTAL_BYTES=$(($(wc -c < "$COMMON_BUNDLE") + $(wc -c < "$ENTRY_BUNDLE")))
echo "OK: Metro smoke bundle emitted (common: $(wc -c < "$COMMON_BUNDLE") bytes, entry: $(wc -c < "$ENTRY_BUNDLE") bytes, total core: $TOTAL_BYTES bytes)"
echo "OK: entry bundle contains orchestrator router source (createRouter found)"
