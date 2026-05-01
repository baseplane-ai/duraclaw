#!/usr/bin/env bash
# CI variant of the migration prefix collision check.
#
# The pre-commit variant (`check-migration-collision.sh`) compares against the
# canonical main worktree's filesystem on the VPS dev box. CI has no such
# worktree, so this variant compares against a git ref instead — typically
# `origin/<base_ref>` of the PR.
#
# Behaviour:
#   - Lists files added in HEAD vs $BASE_REF that look like migrations
#   - For each added file, looks up the same numeric prefix in $BASE_REF
#   - Fails if any added file's prefix collides with a different filename
#     already present on the base
#
# Pre-existing collisions on the base (where neither side is added in the PR)
# are intentionally NOT flagged by this script — they are surfaced by the PR
# that fixes them, not by every unrelated PR.
#
# Required env: BASE_REF (e.g. origin/main).

set -euo pipefail

: "${BASE_REF:?BASE_REF must be set (e.g. origin/main)}"
MIG_DIR="apps/orchestrator/migrations"
PATTERN='^apps/orchestrator/migrations/[0-9]{4}_.+\.sql$'

added="$(git diff --name-only --diff-filter=A "$BASE_REF...HEAD" | grep -E "$PATTERN" || true)"
if [[ -z "$added" ]]; then
  echo "No new migrations in this PR — no collision check needed."
  exit 0
fi

fail=0
while IFS= read -r f; do
  base="$(basename "$f")"
  prefix="${base%%_*}"
  while IFS= read -r base_file; do
    [[ -z "$base_file" ]] && continue
    base_basename="$(basename "$base_file")"
    # Same filename on base means this PR is re-adding an existing migration
    # (rare; revert/squash). Treat as not-a-collision.
    if [[ "$base_basename" != "$base" ]]; then
      if [[ "$fail" -eq 0 ]]; then
        echo "" >&2
        echo "Migration prefix collision detected vs $BASE_REF:" >&2
        echo "" >&2
      fi
      echo "  ✗ $f (added in this PR)" >&2
      echo "      collides with $base_basename (prefix $prefix, on $BASE_REF)" >&2
      fail=1
    fi
  done < <(git ls-tree --name-only "$BASE_REF" -- "$MIG_DIR/" 2>/dev/null \
            | grep -E "/${prefix}_.+\.sql$" || true)
done <<< "$added"

if [[ "$fail" -eq 1 ]]; then
  echo "" >&2
  echo "Rename the colliding migration to the next free prefix and push." >&2
  exit 1
fi

echo "No migration prefix collisions detected vs $BASE_REF."
exit 0
