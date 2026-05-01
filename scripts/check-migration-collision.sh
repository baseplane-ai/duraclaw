#!/usr/bin/env bash
# Detect D1 migration prefix collisions against the canonical main worktree.
#
# The deploy pipeline runs `git pull` on the canonical main worktree
# (default: /data/projects/duraclaw), so its filesystem reflects what is
# currently shipped. This hook compares newly-staged migration files in the
# current worktree against that canonical state and fails the commit if any
# numeric prefix is already taken under a different filename.
#
# Skips silently when:
#   - The canonical main worktree path does not exist (fresh clones, CI,
#     non-VPS devs)
#   - This worktree IS the canonical main worktree (no self-reference)
#   - No staged file matches the migration filename pattern
#
# Override the canonical path via DURACLAW_MAIN_MIRROR.
#
# Read-only by design — never writes, fetches, or mutates anything.

set -euo pipefail

MAIN_MIRROR="${DURACLAW_MAIN_MIRROR:-/data/projects/duraclaw}"
MIG_DIR="apps/orchestrator/migrations"
PATTERN='^apps/orchestrator/migrations/[0-9]{4}_.+\.sql$'

repo_root="$(git rev-parse --show-toplevel)"

# If this worktree IS the canonical main mirror, there is nothing to compare.
if [[ -d "$MAIN_MIRROR" ]]; then
  this_real="$(realpath "$repo_root")"
  mirror_real="$(realpath "$MAIN_MIRROR")"
  if [[ "$this_real" == "$mirror_real" ]]; then
    exit 0
  fi
fi

# If the canonical mirror is not present (e.g. fresh clone on a laptop), the
# check is moot. Fail-open so the hook is portable.
if [[ ! -d "$MAIN_MIRROR/$MIG_DIR" ]]; then
  exit 0
fi

staged="$(git diff --cached --name-only --diff-filter=A | grep -E "$PATTERN" || true)"
if [[ -z "$staged" ]]; then
  exit 0
fi

fail=0
while IFS= read -r f; do
  base="$(basename "$f")"
  prefix="${base%%_*}"
  while IFS= read -r main_file; do
    main_base="$(basename "$main_file")"
    # Same filename in main means this is a re-add of an existing migration
    # (rare but legitimate during reverts) — treat as no-collision.
    if [[ "$main_base" != "$base" ]]; then
      if [[ "$fail" -eq 0 ]]; then
        echo "" >&2
        echo "Migration prefix collision detected vs canonical main:" >&2
        echo "  $MAIN_MIRROR/$MIG_DIR" >&2
        echo "" >&2
      fi
      echo "  ✗ $f" >&2
      echo "      collides with $main_base (prefix $prefix)" >&2
      fail=1
    fi
  done < <(find "$MAIN_MIRROR/$MIG_DIR" -maxdepth 1 -name "${prefix}_*.sql" 2>/dev/null)
done <<< "$staged"

if [[ "$fail" -eq 1 ]]; then
  echo "" >&2
  echo "Rename the colliding migration to the next free prefix and re-stage." >&2
  echo "Override the canonical path via DURACLAW_MAIN_MIRROR if needed." >&2
  exit 1
fi

exit 0
