#!/usr/bin/env bash
# ============================================================================
# link-kata.sh — Install the kata CLI from this worktree
# ============================================================================
#
# Creates a symlink at ~/.local/bin/kata pointing to this worktree's
# packages/kata/kata, then runs `bun install` in packages/kata/ so
# dependencies are available.
#
# Run this once after cloning, or after pulling a commit that moved
# kata into the monorepo. Safe to re-run — overwrites existing symlink.
#
# Usage:
#   scripts/link-kata.sh
#
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
KATA_DIR="$ROOT/packages/kata"
KATA_BIN="$KATA_DIR/kata"
LINK_TARGET="$HOME/.local/bin/kata"

if [[ ! -x "$KATA_BIN" ]]; then
  echo "Error: $KATA_BIN not found or not executable" >&2
  exit 1
fi

# Ensure ~/.local/bin exists and is on PATH
mkdir -p "$(dirname "$LINK_TARGET")"
if ! echo "$PATH" | tr ':' '\n' | grep -q "$HOME/.local/bin"; then
  echo "Warning: ~/.local/bin is not on PATH. Add it to your shell profile." >&2
fi

# Install deps
if command -v bun &> /dev/null; then
  echo "Installing kata dependencies..."
  (cd "$KATA_DIR" && bun install --silent 2>/dev/null || bun install)
else
  echo "Warning: bun not found — kata deps not installed. Install bun: https://bun.sh" >&2
fi

# Create/overwrite symlink
/usr/bin/ln -sf "$KATA_BIN" "$LINK_TARGET"
echo "Linked: $LINK_TARGET → $KATA_BIN"

# Verify
if "$LINK_TARGET" help &>/dev/null; then
  echo "✓ kata CLI working"
else
  echo "Warning: kata CLI not responding — check bun and dependencies" >&2
fi
