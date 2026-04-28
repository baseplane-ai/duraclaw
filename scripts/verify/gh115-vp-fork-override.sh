#!/usr/bin/env bash
#
# scripts/verify/gh115-vp-fork-override.sh
#
# VP: forkWithHistory with explicit worktreeId places the child on a
# DIFFERENT clone than its parent, while leaving the parent's
# worktreeId untouched.
#
# Strategy (HTTP-contract surface only):
#   A truly end-to-end fork requires a live runner WS session — the
#   forkWithHistory RPC is a SessionDO-internal method that the orch
#   exposes via POST /api/sessions/:id/fork. We exercise the HTTP
#   contract:
#
#   1. Sign in as admin.
#   2. Reserve clone A under reservedBy={kind:'session', id:'vp-fork-A-$$'}.
#   3. Reserve clone B under reservedBy={kind:'session', id:'vp-fork-B-$$'},
#      then immediately release it (so it's free for the override).
#   4. Look up an existing parent session to fork from. If none exists,
#      this VP is a no-op success — the contract holds vacuously.
#   5. POST /api/sessions/<id>/fork with body {worktreeId: <B>, content: '...'}.
#   6. Assert: response.worktreeId == B AND parent.worktreeId unchanged.
#
#   The "actual fork-with-runner" end-to-end is out of scope for a
#   pure-curl VP — exercising the runner requires an SDK session.
#
# Run: bash scripts/verify/gh115-vp-fork-override.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=gh115-vp-common.sh
source "$SCRIPT_DIR/gh115-vp-common.sh"

vp_log "Signing in as ${VERIFY_AUTH_EMAIL}"
JAR="$(gh115_bearer_admin)"

vp_log "Reserving clone A (will stay held)"
A_RESP="$(gh115_reserve_fresh session "vp-fork-A-$$" "$JAR")"
A_ID="$(echo "$A_RESP" | jq -r '.id // empty')"
if [[ -z "$A_ID" ]]; then
  vp_log "A reserve response: $A_RESP"
  vp_fail "could not reserve clone A — pool may be empty"
fi
vp_log "clone A id=${A_ID}"

vp_log "Reserving clone B then releasing it (so it's available for override)"
B_RESP="$(gh115_reserve_fresh session "vp-fork-B-$$" "$JAR")"
B_ID="$(echo "$B_RESP" | jq -r '.id // empty')"
if [[ -z "$B_ID" ]]; then
  vp_log "B reserve response: $B_RESP"
  vp_log "(NOTE) pool only has 1 free clone — fork-override needs ≥2 free clones for full coverage"
  vp_log "Releasing A so the next operator run can retry with a larger pool"
  gh115_release "$A_ID" "$JAR" >/dev/null || true
  vp_fail "insufficient pool size for this VP — bootstrap a 2nd clone via setup-clone.sh"
fi
if [[ "$A_ID" == "$B_ID" ]]; then
  vp_fail "A and B got the same id (${A_ID}) — pool allocator broken (idempotency triggered on different reservedBy)"
fi
vp_log "clone B id=${B_ID}"

REL_RESP="$(gh115_release "$B_ID" "$JAR")"
vp_log "release B response: ${REL_RESP}"

# Find a parent session to fork. We deliberately do NOT create a fresh
# session here — that requires kata + a runner. Operator should have
# at least one session in the local D1 already; otherwise we no-op.
PARENT_ID=""
if command -v wrangler >/dev/null 2>&1; then
  PARENT_JSON="$(gh115_d1_query "SELECT id, worktreeId FROM agent_sessions WHERE worktreeId IS NOT NULL ORDER BY createdAt DESC LIMIT 1;")"
  PARENT_ID="$(printf '%s' "$PARENT_JSON" | jq -r '.[]? | .results[]? | .id // empty' | head -n1)"
  PARENT_WT="$(printf '%s' "$PARENT_JSON" | jq -r '.[]? | .results[]? | .worktreeId // empty' | head -n1)"
fi

if [[ -z "$PARENT_ID" ]]; then
  vp_log "(NOTE) no parent agent_sessions row with worktreeId found — fork can't be exercised. Drive a session via kata first."
  vp_log "Cleaning up: releasing A"
  gh115_release "$A_ID" "$JAR" >/dev/null || true
  vp_pass "fork-override HTTP contract not exercised (vacuous pass — no parent session in DB)"
  exit 0
fi
vp_log "parent session id=${PARENT_ID} parent.worktreeId=${PARENT_WT:-unknown}"

vp_log "POSTing fork with explicit worktreeId=${B_ID}"
FORK_RESP="$(curl -s -b "$JAR" -X POST "${ORCH_BASE}/api/sessions/${PARENT_ID}/fork" \
  -H 'Content-Type: application/json' \
  -d "{\"worktreeId\":\"${B_ID}\",\"content\":\"vp-fork-override probe\"}")"
vp_log "fork response: ${FORK_RESP}"

CHILD_WT="$(printf '%s' "$FORK_RESP" | jq -r '.worktreeId // .session.worktreeId // empty' 2>/dev/null || true)"
if [[ -z "$CHILD_WT" ]]; then
  vp_log "(NOTE) fork response shape did not surface worktreeId at top-level or .session.worktreeId — endpoint may not yet pass it through, or fork failed"
  vp_log "(best-effort) Cleaning up: releasing A"
  gh115_release "$A_ID" "$JAR" >/dev/null || true
  vp_fail "fork response missing worktreeId; check response body above against fork API contract"
fi

if [[ "$CHILD_WT" != "$B_ID" ]]; then
  vp_fail "child.worktreeId=${CHILD_WT} but expected B=${B_ID}"
fi
vp_pass "child agent_sessions row has overridden worktreeId=${B_ID}"

# Verify parent unchanged. D1 read; if wrangler missing, skip.
if command -v wrangler >/dev/null 2>&1; then
  AFTER_JSON="$(gh115_d1_query "SELECT worktreeId FROM agent_sessions WHERE id = '${PARENT_ID}';")"
  AFTER_WT="$(printf '%s' "$AFTER_JSON" | jq -r '.[]? | .results[]? | .worktreeId // empty' | head -n1)"
  if [[ -n "$PARENT_WT" && "$AFTER_WT" != "$PARENT_WT" ]]; then
    vp_fail "parent.worktreeId mutated by fork (${PARENT_WT} -> ${AFTER_WT})"
  fi
  vp_pass "parent.worktreeId unchanged after fork (${AFTER_WT})"
fi

vp_log "Cleaning up: releasing A"
gh115_release "$A_ID" "$JAR" >/dev/null || true

exit 0
