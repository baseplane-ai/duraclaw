#!/usr/bin/env bash
#
# scripts/verify/gh115-vp-janitor.sh
#
# VP: a released reservation is hard-deleted by the janitor after the
# idle_window expires; a re-attach within the window keeps the row alive.
#
# IMPORTANT — environment requirement:
#   The orchestrator's idle_window is read from CC_WORKTREE_IDLE_WINDOW_SECS
#   at boot. Default is 24h, which is impractical for a VP. Operator must
#   restart the local stack with a tiny window before running this VP:
#
#     CC_WORKTREE_IDLE_WINDOW_SECS=5 scripts/verify/dev-up.sh
#
#   The setting cannot be flipped at runtime — Workers/miniflare bindings
#   are baked into the boot. If $CC_WORKTREE_IDLE_WINDOW_SECS is unset or
#   ≥ 60, this script logs a clear hint and exits non-zero.
#
# Strategy:
#   1. Sign in as admin.
#   2. Reserve clone X under reservedBy={kind:'session', id:'vp-janitor-$$'}.
#   3. POST /api/worktrees/<X>/release.
#   4. Sleep idle_window + 1 seconds.
#   5. POST /api/admin/worktrees/sweep — synchronous janitor.
#   6. Assert: response deletedCount ≥ 1 AND <X> appears in deletedIds.
#   7. Re-attach test:
#      a. Reserve clone Y under reservedBy={kind:'session', id:'vp-reattach-$$'}.
#      b. Release Y.
#      c. Immediately re-reserve with SAME reservedBy — must clear released_at.
#      d. Sleep idle_window + 1 seconds.
#      e. POST /api/admin/worktrees/sweep.
#      f. Assert Y is NOT in deletedIds (the re-attach revived it).
#
# Run: CC_WORKTREE_IDLE_WINDOW_SECS=5 scripts/verify/dev-up.sh
#      bash scripts/verify/gh115-vp-janitor.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=gh115-vp-common.sh
source "$SCRIPT_DIR/gh115-vp-common.sh"

WINDOW_SECS="${CC_WORKTREE_IDLE_WINDOW_SECS:-}"
if [[ -z "$WINDOW_SECS" ]]; then
  vp_fail "CC_WORKTREE_IDLE_WINDOW_SECS not set in this shell — restart the orchestrator with CC_WORKTREE_IDLE_WINDOW_SECS=5 scripts/verify/dev-up.sh, then re-run this VP"
fi
if (( WINDOW_SECS > 60 )); then
  vp_fail "CC_WORKTREE_IDLE_WINDOW_SECS=${WINDOW_SECS}s is too long for a VP; restart with =5"
fi

vp_log "idle_window=${WINDOW_SECS}s (assumed orchestrator was booted with the same value)"

vp_log "Signing in as ${VERIFY_AUTH_EMAIL}"
JAR="$(gh115_bearer_admin)"

# --- Phase 1: release + sweep deletes the row ---
vp_log "Phase 1: reserve, release, wait > idle_window, sweep, expect delete"
X_RESP="$(gh115_reserve_fresh session "vp-janitor-$$" "$JAR")"
X_ID="$(echo "$X_RESP" | jq -r '.id // empty')"
if [[ -z "$X_ID" ]]; then
  vp_log "reserve response: $X_RESP"
  vp_fail "could not reserve a clone for X — pool may be empty"
fi
vp_log "X id=${X_ID}"

vp_log "releasing X"
gh115_release "$X_ID" "$JAR" >/dev/null

SLEEP_SECS=$(( WINDOW_SECS + 1 ))
vp_log "sleeping ${SLEEP_SECS}s to push past idle_window"
sleep "$SLEEP_SECS"

vp_log "POST /api/admin/worktrees/sweep"
SWEEP="$(curl -s -b "$JAR" -X POST "${ORCH_BASE}/api/admin/worktrees/sweep" \
  -H 'Content-Type: application/json' -d '{}')"
vp_log "sweep response: ${SWEEP}"

DELETED_COUNT="$(printf '%s' "$SWEEP" | jq -r '.deletedCount // 0')"
DELETED_HAS_X="$(printf '%s' "$SWEEP" | jq --arg id "$X_ID" '[.deletedIds[]? | select(. == $id)] | length' 2>/dev/null || echo 0)"

if (( DELETED_COUNT < 1 )); then
  vp_fail "sweep deletedCount=${DELETED_COUNT}, expected ≥ 1"
fi
if (( DELETED_HAS_X < 1 )); then
  vp_log "(NOTE) deletedIds did not include X=${X_ID} — janitor swept other rows but not ours; could mean release didn't write released_at, or sweep predicate uses a different cutoff"
  vp_fail "X=${X_ID} not in deletedIds"
fi
vp_pass "Phase 1: X=${X_ID} deleted by janitor sweep (deletedCount=${DELETED_COUNT})"

# --- Phase 2: re-attach within window survives ---
vp_log "Phase 2: reserve Y, release, immediately re-reserve same reservedBy, then sweep"
Y_RB_ID="vp-reattach-$$"
Y_RESP="$(gh115_reserve_fresh session "$Y_RB_ID" "$JAR")"
Y_ID="$(echo "$Y_RESP" | jq -r '.id // empty')"
if [[ -z "$Y_ID" ]]; then
  vp_log "reserve response: $Y_RESP"
  vp_fail "could not reserve a clone for Y"
fi
vp_log "Y id=${Y_ID}"

gh115_release "$Y_ID" "$JAR" >/dev/null
vp_log "released Y; re-reserving with SAME reservedBy (kind=session id=${Y_RB_ID})"
Y_REATT="$(gh115_reserve_fresh session "$Y_RB_ID" "$JAR")"
Y_REATT_ID="$(echo "$Y_REATT" | jq -r '.id // empty')"
if [[ "$Y_REATT_ID" != "$Y_ID" ]]; then
  vp_fail "re-attach returned different id (${Y_REATT_ID}) — idempotency / revive contract broken"
fi
vp_pass "re-attach returned same id=${Y_ID} (revive succeeded)"

vp_log "sleeping ${SLEEP_SECS}s past idle_window AGAIN"
sleep "$SLEEP_SECS"

SWEEP2="$(curl -s -b "$JAR" -X POST "${ORCH_BASE}/api/admin/worktrees/sweep" \
  -H 'Content-Type: application/json' -d '{}')"
vp_log "second sweep response: ${SWEEP2}"
Y_DELETED="$(printf '%s' "$SWEEP2" | jq --arg id "$Y_ID" '[.deletedIds[]? | select(. == $id)] | length' 2>/dev/null || echo 0)"
if (( Y_DELETED >= 1 )); then
  vp_fail "Y=${Y_ID} was deleted despite re-attach — revive didn't clear released_at"
fi
vp_pass "Phase 2: Y=${Y_ID} survived sweep after re-attach"

vp_log "cleanup: releasing Y"
gh115_release "$Y_ID" "$JAR" >/dev/null 2>&1 || true

exit 0
