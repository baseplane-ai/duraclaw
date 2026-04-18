#!/usr/bin/env bash
# cutover-rehearsal.sh — local rehearsal of cutover.sh against --local D1.
#
# Mirrors cutover.sh step-for-step but everything targets local SQLite.
# Run this with a representative dump.json before touching prod.
#
# Usage:
#   bash scripts/cutover-rehearsal.sh [path/to/dump.json]
#
# If no path is given, defaults to ./dump.json in the orchestrator dir.

set -euo pipefail

ORCHESTRATOR_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ORCHESTRATOR_DIR"

banner() {
  echo
  echo "════════════════════════════════════════════════════════════════════"
  echo "  $1"
  echo "════════════════════════════════════════════════════════════════════"
}

pause() {
  read -r -p "Press enter to continue, or Ctrl-C to abort … " _
}

DUMP_PATH="${1:-./dump.json}"
PENDING_DIR="$ORCHESTRATOR_DIR/migrations/pending"
PENDING_0009="$PENDING_DIR/0009_drop_user_preferences_legacy.sql"
DEPLOYED_0009="$ORCHESTRATOR_DIR/migrations/0009_drop_user_preferences_legacy.sql"

banner "Step 1/9 — Pre-flight"
if [ ! -f "$DUMP_PATH" ]; then
  echo "ERROR: dump file '$DUMP_PATH' not found."
  echo "  Produce one with scripts/dump-my-state.sh first."
  exit 1
fi
if ! command -v tsx >/dev/null 2>&1 && ! pnpm tsx --version >/dev/null 2>&1; then
  echo "ERROR: tsx is required (try: pnpm add -D tsx, or run via pnpm)."
  exit 1
fi
if ! command -v wrangler >/dev/null 2>&1 && ! pnpm wrangler --version >/dev/null 2>&1; then
  echo "ERROR: wrangler is required."
  exit 1
fi
echo "OK — dump='$DUMP_PATH'"
pause

banner "Step 2/9 — Wipe local D1"
echo "Ensuring local DB exists, then dropping all tables."
pause
wrangler d1 execute duraclaw-auth --local --command "SELECT 1" >/dev/null
wrangler d1 execute duraclaw-auth --local --command "PRAGMA writable_schema=1; DELETE FROM sqlite_master; PRAGMA writable_schema=0; VACUUM;"

banner "Step 3/9 — Apply migrations through 0008"
echo "0009 must NOT be in migrations/ yet (mirrors cutover.sh step 4)."
if [ -f "$DEPLOYED_0009" ]; then
  echo "ERROR: $DEPLOYED_0009 already exists — would apply 0009 too early."
  echo "Move it back to $PENDING_DIR/ and re-run."
  exit 1
fi
pause
wrangler d1 migrations apply duraclaw-auth --local

banner "Step 4/9 — Generate export.sql from dump"
echo "pnpm tsx scripts/export-do-state.ts $DUMP_PATH > export.sql"
pause
pnpm tsx scripts/export-do-state.ts "$DUMP_PATH" > export.sql

banner "Step 5/9 — Load export.sql into local D1"
pause
wrangler d1 execute duraclaw-auth --local --file=export.sql

banner "Step 6/9 — Verify columnar tables populated"
echo "Run these in another terminal and confirm the counts match the dump:"
echo
echo "  wrangler d1 execute duraclaw-auth --local \\"
echo "    --command \"SELECT COUNT(*) FROM user_preferences\""
echo "  wrangler d1 execute duraclaw-auth --local \\"
echo "    --command \"SELECT COUNT(*) FROM user_preferences_legacy\""
echo "  wrangler d1 execute duraclaw-auth --local \\"
echo "    --command \"SELECT COUNT(*) FROM user_tabs\""
echo "  wrangler d1 execute duraclaw-auth --local \\"
echo "    --command \"SELECT COUNT(*) FROM agent_sessions\""
echo
echo "Press Ctrl-C to abort if anything looks off."
pause

banner "Step 7/9 — Stage and apply 0009 (drop user_preferences_legacy)"
if [ ! -f "$PENDING_0009" ]; then
  echo "ERROR: $PENDING_0009 is missing. Cannot stage 0009."
  exit 1
fi
echo "cp $PENDING_0009 → migrations/, then apply, then remove from migrations/."
pause
cp "$PENDING_0009" "$DEPLOYED_0009"
wrangler d1 migrations apply duraclaw-auth --local
# Remove from migrations/ so the file doesn't get committed accidentally —
# it must stay in pending/ for the prod cutover to stage it itself.
rm "$DEPLOYED_0009"

banner "Step 8/9 — Smoke test"
echo "In another terminal:"
echo "  pnpm --filter @duraclaw/orchestrator dev"
echo
echo "Then log in and verify:"
echo "  - Tabs load from D1 (no 500s)"
echo "  - Sessions list renders"
echo "  - Preferences round-trip (toggle one, reload, persisted)"
echo
echo "Press enter once smoke test passes."
pause

banner "Step 9/9 — Done"
echo "✅ Rehearsal passed — safe to run cutover.sh against prod."
