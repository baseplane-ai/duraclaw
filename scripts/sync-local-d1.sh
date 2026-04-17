#!/usr/bin/env bash
# Sync prod D1 (duraclaw-auth) into each worktree's local miniflare D1.
#
# By default, discovers sibling worktrees matching /data/projects/duraclaw*.
# Override by passing explicit worktree roots as arguments.
#
# Usage:
#   ./scripts/sync-local-d1.sh                              # auto-discover
#   ./scripts/sync-local-d1.sh /path/to/wt1 /path/to/wt2    # explicit list
#
# Env:
#   CLOUDFLARE_ACCOUNT_ID   CF account id (auto-set to baseplane if unset)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Baseplane CF account — wrangler can't pick when multiple accounts are available.
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-87bd3030c315cfdc6e9f9c04ad6f37bc}"

DB_NAME="duraclaw-auth"
DUMP_RAW="$(mktemp -t duraclaw-auth-XXXX.sql)"
DUMP_RESET="$(mktemp -t duraclaw-auth-reset-XXXX.sql)"
trap 'rm -f "$DUMP_RAW" "$DUMP_RESET"' EXIT

if [ "$#" -gt 0 ]; then
  WORKTREES=("$@")
else
  WORKTREES=()
  for dir in /data/projects/duraclaw /data/projects/duraclaw-dev*; do
    [ -d "$dir/apps/orchestrator" ] && WORKTREES+=("$dir")
  done
fi

if [ "${#WORKTREES[@]}" -eq 0 ]; then
  echo "No worktrees found." >&2
  exit 1
fi

echo "Exporting remote $DB_NAME…"
(cd "$REPO_ROOT/apps/orchestrator" \
  && pnpm wrangler d1 export "$DB_NAME" --remote --output="$DUMP_RAW" >/dev/null)

# Discover tables from the dump and build a DROP-first preamble so the import
# is idempotent against worktrees that already have schema.
TABLES=$(awk '/^CREATE TABLE / { gsub(/[(,]/,"",$3); print $3 }' "$DUMP_RAW")
{
  echo "PRAGMA defer_foreign_keys=TRUE;"
  # Drop in reverse to respect FK references.
  for t in $(echo "$TABLES" | tac); do
    echo "DROP TABLE IF EXISTS $t;"
  done
  cat "$DUMP_RAW"
} > "$DUMP_RESET"

echo "Tables: $(echo "$TABLES" | tr '\n' ' ')"
echo

for tree in "${WORKTREES[@]}"; do
  echo "=== $tree ==="
  if [ ! -d "$tree/apps/orchestrator" ]; then
    echo "  (skip: no apps/orchestrator)"
    continue
  fi
  (cd "$tree/apps/orchestrator" \
    && pnpm wrangler d1 execute "$DB_NAME" --local --file="$DUMP_RESET" --yes >/dev/null) \
    && echo "  ok" \
    || echo "  FAILED"
done

echo
echo "Done. Verify a worktree with:"
echo "  cd <worktree>/apps/orchestrator && pnpm wrangler d1 execute $DB_NAME --local --command \"SELECT email, role FROM users\""
