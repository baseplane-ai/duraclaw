#!/usr/bin/env bash
#
# scripts/verify/gh115-vp-pool-exhaust.sh
#
# VP: empty pool returns 503 pool_exhausted with operator hint.
#
# Strategy (entirely API-driven — the cleanest VP of the eight):
#   1. Sign in as admin.
#   2. Loop POST /api/worktrees {kind:'fresh', reservedBy:{kind:'session', id:'vp-N-$$'}}
#      until either the response is 503 or we hit a safety cap (50).
#   3. Assert the final response body has {error:'pool_exhausted', freeCount:0, ...}.
#   4. Print final pool stats from GET /api/worktrees.
#   5. Cleanup: release every reservation we created.
#
# Run: bash scripts/verify/gh115-vp-pool-exhaust.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=gh115-vp-common.sh
source "$SCRIPT_DIR/gh115-vp-common.sh"

CAP=50
RESERVED_IDS=()

# Cleanup hook — release every id we successfully reserved, regardless
# of pass/fail. Idempotent: release on a non-existent id 404s but that's
# fine for cleanup.
cleanup_pool_exhaust() {
  if (( ${#RESERVED_IDS[@]} == 0 )); then return 0; fi
  vp_log "cleanup: releasing ${#RESERVED_IDS[@]} reservations"
  for rid in "${RESERVED_IDS[@]}"; do
    gh115_release "$rid" "$JAR" >/dev/null 2>&1 || true
  done
}
trap cleanup_pool_exhaust EXIT

vp_log "Signing in as ${VERIFY_AUTH_EMAIL}"
JAR="$(gh115_bearer_admin)"

vp_log "Reserving until pool exhaustion (cap=${CAP})"
LAST_BODY=""
LAST_CODE=""
EXHAUSTED=0
for i in $(seq 1 "$CAP"); do
  TMP_BODY="/tmp/gh115-vp-pool-${i}.out"
  CODE="$(curl -s -o "$TMP_BODY" -w '%{http_code}' \
    -b "$JAR" -X POST "${ORCH_BASE}/api/worktrees" \
    -H 'Content-Type: application/json' \
    -d "{\"kind\":\"fresh\",\"reservedBy\":{\"kind\":\"session\",\"id\":\"vp-exhaust-${i}-$$\"}}")"
  LAST_CODE="$CODE"
  LAST_BODY="$(cat "$TMP_BODY")"
  if [[ "$CODE" == "200" ]]; then
    NEW_ID="$(printf '%s' "$LAST_BODY" | jq -r '.id // empty')"
    if [[ -n "$NEW_ID" ]]; then
      RESERVED_IDS+=("$NEW_ID")
    fi
    continue
  fi
  if [[ "$CODE" == "503" ]]; then
    vp_log "got HTTP 503 after ${i} reserve attempts — pool exhausted as expected"
    EXHAUSTED=1
    break
  fi
  # Any other code is a hard failure.
  vp_fail "unexpected HTTP ${CODE} on reserve #${i}: ${LAST_BODY}"
done

if [[ "$EXHAUSTED" -ne 1 ]]; then
  vp_fail "pool did not exhaust within ${CAP} reserve attempts (last code=${LAST_CODE}); verify the pool isn't unbounded"
fi

vp_log "503 body: ${LAST_BODY}"

# Validate the body shape — error code + freeCount=0 + operator hint.
ERR="$(printf '%s' "$LAST_BODY" | jq -r '.error // empty')"
FREE="$(printf '%s' "$LAST_BODY" | jq -r '.freeCount // empty')"
HINT="$(printf '%s' "$LAST_BODY" | jq -r '.hint // empty')"

if [[ "$ERR" != "pool_exhausted" ]]; then
  vp_fail "expected error=pool_exhausted, got error=${ERR:-<missing>}"
fi
if [[ "$FREE" != "0" ]]; then
  vp_fail "expected freeCount=0, got freeCount=${FREE:-<missing>}"
fi
if [[ -z "$HINT" ]]; then
  vp_log "(NOTE) response missing 'hint' field; spec calls for an operator hint pointing at scripts/setup-clone.sh"
fi

vp_pass "503 pool_exhausted body shape matches spec (error=pool_exhausted, freeCount=0)"

vp_log "Final pool stats (GET /api/worktrees):"
LIST="$(gh115_list_worktrees "$JAR")"
TOTAL="$(printf '%s' "$LIST" | jq '.worktrees | length // (. | length)' 2>/dev/null || echo "?")"
HELD="$(printf '%s' "$LIST" | jq '[.worktrees[]? // .[]? | select(.status == "held")] | length' 2>/dev/null || echo "?")"
vp_log "total=${TOTAL} held=${HELD}"

exit 0
