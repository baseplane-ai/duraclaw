#!/usr/bin/env bash
# cutover.sh — big-bang cutover for issue #7 (D1 + PartyKit migration).
#
# Total expected downtime: 10–15 min (single window covering steps 2–9).
# Step 6 is a verification pause — keep it short to stay within the window.
# Rollback: revert to the parent commit of the feature branch and redeploy.
#
# This script is meant to be read end-to-end before running. It pauses
# between steps so the operator can verify each one in another terminal
# (wrangler tail, the maintenance page, etc.).
#
# Pre-flight:
#   - You are on the feature/7-d1-partykit-migration branch (or it is merged).
#   - wrangler is logged in to the baseplane-ai account.
#   - You have the JSON dump from export-do-state.ts ready (or know how to
#     produce it — see header of scripts/export-do-state.ts).
#   - You're running this from apps/orchestrator/.
#   - You have run scripts/cutover-rehearsal.sh against a recent prod dump and it passed.

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

PENDING_DIR="$ORCHESTRATOR_DIR/migrations/pending"
PENDING_0009="$PENDING_DIR/0009_drop_user_preferences_legacy.sql"
DEPLOYED_0009="$ORCHESTRATOR_DIR/migrations/0009_drop_user_preferences_legacy.sql"

banner "Step 0/11 — Confirm local rehearsal"
echo "Have you run scripts/cutover-rehearsal.sh against a local D1 with a"
echo "representative dump.json? This is a hard prerequisite — the rehearsal"
echo "exercises export-do-state.ts SQL generation against real data shapes"
echo "and catches escaping/index/upsert bugs before they hit prod."
echo
echo "Type REHEARSED to acknowledge, or Ctrl-C to abort and rehearse first."
read -r ack
if [ "$ack" != "REHEARSED" ]; then
  echo "Aborting — rehearsal not confirmed."
  exit 1
fi

banner "Step 1/11 — Enable maintenance mode"
echo "Set MAINTENANCE_MODE secret to '1'. When prompted, type: 1"
pause
wrangler secret put MAINTENANCE_MODE

banner "Step 2/11 — Deploy with maintenance mode active"
echo "Deploys current branch with MAINTENANCE_MODE=1, taking the app offline."
pause
wrangler deploy

banner "Step 3/11 — Generate export.sql from your DO dump"
echo "Pipe your dump.json through scripts/export-do-state.ts to produce export.sql."
echo "Example: pnpm tsx scripts/export-do-state.ts dump.json > export.sql"
pause
if [ ! -f export.sql ]; then
  echo "ERROR: export.sql is missing in $ORCHESTRATOR_DIR. Generate it before continuing."
  exit 1
fi

banner "Step 4/11 — Apply D1 schema migrations through 0008"
echo "0009 (drop user_preferences_legacy) lives in migrations/pending/ and is"
echo "intentionally NOT applied here — wrangler only scans the top-level"
echo "migrations/ directory, so 0008 is the latest migration it will see. 0009"
echo "is staged into place after verification (steps 6–7)."
pause
if [ -f "$DEPLOYED_0009" ]; then
  echo "ERROR: $DEPLOYED_0009 already exists — this would cause wrangler to apply"
  echo "0009 before verification. Move it back to $PENDING_DIR/ and re-run."
  exit 1
fi
wrangler d1 migrations apply duraclaw-auth --remote

banner "Step 5/11 — Load exported state into D1"
pause
wrangler d1 execute duraclaw-auth --remote --file=export.sql

banner "Step 6/11 — Verify columnar user_preferences populated"
echo "0009 drops user_preferences_legacy permanently — only proceed after the"
echo "new columnar user_preferences row count looks right. Recommended check:"
echo "  wrangler d1 execute duraclaw-auth --remote \\"
echo "    --command \"SELECT COUNT(*) FROM user_preferences\""
echo "Compare against the legacy table if useful:"
echo "  wrangler d1 execute duraclaw-auth --remote \\"
echo "    --command \"SELECT COUNT(*) FROM user_preferences_legacy\""
echo "Press Ctrl-C to abort if the counts look wrong — 0009 has not been applied"
echo "yet, so user_preferences_legacy is still available for inspection or"
echo "rollback. Press enter only after verification succeeds."
pause

banner "Step 7/11 — Stage and apply 0009 (drop user_preferences_legacy)"
echo "Copying $PENDING_0009 → migrations/ so wrangler picks it up, then applying."
pause
if [ ! -f "$PENDING_0009" ]; then
  echo "ERROR: $PENDING_0009 is missing. Cannot stage 0009."
  exit 1
fi
cp "$PENDING_0009" "$DEPLOYED_0009"
wrangler d1 migrations apply duraclaw-auth --remote

banner "Step 8/11 — Cutover deploy (ProjectRegistry deleted)"
echo "This deploys the post-cutover code: ProjectRegistry DO is gone, D1 is sole truth."
pause
wrangler deploy

banner "Step 9/11 — Disable maintenance mode"
echo "Set MAINTENANCE_MODE secret to '0'. When prompted, type: 0"
pause
wrangler secret put MAINTENANCE_MODE

banner "Step 10/11 — Final deploy to lift maintenance"
pause
wrangler deploy

banner "Done."
echo "Smoke-test:"
echo "  curl -fsS https://dura.baseplane.ai/api/health"
echo "  Browse to https://dura.baseplane.ai/login and verify the dashboard renders."
echo
echo "Rollback if needed:"
echo "  git revert <feature-merge-commit>  # then redeploy"
