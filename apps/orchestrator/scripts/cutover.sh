#!/usr/bin/env bash
# cutover.sh — big-bang cutover for issue #7 (D1 + PartyKit migration).
#
# Total expected downtime: 10–15 min (single window covering steps 2–7).
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

banner "Step 1/8 — Enable maintenance mode"
echo "Set MAINTENANCE_MODE secret to '1'. When prompted, type: 1"
pause
wrangler secret put MAINTENANCE_MODE

banner "Step 2/8 — Deploy with maintenance mode active"
echo "Deploys current branch with MAINTENANCE_MODE=1, taking the app offline."
pause
wrangler deploy

banner "Step 3/8 — Generate export.sql from your DO dump"
echo "Pipe your dump.json through scripts/export-do-state.ts to produce export.sql."
echo "Example: pnpm tsx scripts/export-do-state.ts dump.json > export.sql"
pause
if [ ! -f export.sql ]; then
  echo "ERROR: export.sql is missing in $ORCHESTRATOR_DIR. Generate it before continuing."
  exit 1
fi

banner "Step 4/8 — Apply D1 schema migrations"
pause
wrangler d1 migrations apply duraclaw-auth --remote

banner "Step 5/8 — Load exported state into D1"
pause
wrangler d1 execute duraclaw-auth --remote --file=export.sql

banner "Step 6/8 — Cutover deploy (ProjectRegistry deleted)"
echo "This deploys the post-cutover code: ProjectRegistry DO is gone, D1 is sole truth."
pause
wrangler deploy

banner "Step 7/8 — Disable maintenance mode"
echo "Set MAINTENANCE_MODE secret to '0'. When prompted, type: 0"
pause
wrangler secret put MAINTENANCE_MODE

banner "Step 8/8 — Final deploy to lift maintenance"
pause
wrangler deploy

banner "Done."
echo "Smoke-test:"
echo "  curl -fsS https://dura.baseplane.ai/api/health"
echo "  Browse to https://dura.baseplane.ai/login and verify the dashboard renders."
echo
echo "Rollback if needed:"
echo "  git revert <feature-merge-commit>  # then redeploy"
