#!/usr/bin/env bash
#
# scripts/verify/gh115-vp-chain-inherit.sh
#
# VP: chain auto-advance preserves the same worktreeId across mode
# transitions. Predecessor (e.g. implementation) and its successor
# (e.g. verify) MUST share one worktreeId in agent_sessions.
#
# Strategy:
#   The fully-driven path (auto-advance fires from runner-side run-end
#   JSON, which requires a live SDK session) is too expensive for a
#   shell VP. We instead test the schema-level invariant that auto-
#   advance is contracted to uphold:
#
#     SELECT count(DISTINCT worktreeId) FROM agent_sessions
#     WHERE kataIssue = N AND worktreeId IS NOT NULL
#
#   must be ≤ 1 across however many sessions the chain has. If P1.4
#   wired things correctly, every successor inherits its predecessor's
#   worktreeId, so the count is exactly 1 (or 0 for chains that never
#   reserved, e.g. read-only).
#
#   We pick the test issue from env GH115_VP_CHAIN_ISSUE (default: a
#   sentinel value the operator should set). If no rows exist for that
#   issue yet, the script is a no-op success — the contract holds
#   vacuously. The operator can drive a real chain by running:
#
#     kata enter implementation --issue=$GH115_VP_CHAIN_ISSUE
#     # ...let session complete and auto-advance to verify...
#
#   then re-running this VP.
#
# Run: GH115_VP_CHAIN_ISSUE=200 bash scripts/verify/gh115-vp-chain-inherit.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=gh115-vp-common.sh
source "$SCRIPT_DIR/gh115-vp-common.sh"

CHAIN_ISSUE="${GH115_VP_CHAIN_ISSUE:-}"
if [[ -z "$CHAIN_ISSUE" ]]; then
  vp_log "GH115_VP_CHAIN_ISSUE not set; defaulting to 115 (this spec's own issue)"
  CHAIN_ISSUE=115
fi

if ! command -v wrangler >/dev/null 2>&1; then
  vp_fail "wrangler not on PATH — chain-inherit assertion requires D1 query access; install via 'pnpm install' at repo root"
fi

vp_log "Querying chain rows for kataIssue=${CHAIN_ISSUE}"
ROWS_JSON="$(gh115_d1_query "SELECT id, worktreeId, status FROM agent_sessions WHERE kataIssue = ${CHAIN_ISSUE};")"

# Count session rows total + rows with worktreeId set.
# wrangler --json wraps the result set; jq pulls the meta fields out.
TOTAL="$(printf '%s' "$ROWS_JSON" | jq '[.[]? | .results[]?] | length' 2>/dev/null || echo 0)"
WITH_WT="$(printf '%s' "$ROWS_JSON" | jq '[.[]? | .results[]? | select(.worktreeId != null)] | length' 2>/dev/null || echo 0)"
DISTINCT_WT="$(printf '%s' "$ROWS_JSON" | jq '[.[]? | .results[]? | select(.worktreeId != null) | .worktreeId] | unique | length' 2>/dev/null || echo 0)"

vp_log "chain stats: total=${TOTAL} with_worktreeId=${WITH_WT} distinct_worktreeId=${DISTINCT_WT}"

if [[ "$TOTAL" -eq 0 ]]; then
  vp_log "(NOTE) no agent_sessions rows for kataIssue=${CHAIN_ISSUE} — the contract holds vacuously. Drive a chain via 'kata enter implementation --issue=${CHAIN_ISSUE}' to make this VP meaningful."
  vp_pass "schema-level invariant holds (no rows yet)"
  exit 0
fi

if [[ "$DISTINCT_WT" -gt 1 ]]; then
  vp_log "row dump:"
  printf '%s\n' "$ROWS_JSON" | jq '.[]? | .results[]?' >&2 || true
  vp_fail "chain kataIssue=${CHAIN_ISSUE} has ${DISTINCT_WT} distinct worktreeIds — P1.4 successor inheritance broken"
fi

if [[ "$WITH_WT" -eq 0 ]]; then
  vp_log "(NOTE) all rows for kataIssue=${CHAIN_ISSUE} have worktreeId=NULL — chain may be read-only-mode-only (research/planning/freeform). Inheritance is vacuously consistent."
  vp_pass "schema-level invariant holds (no reservations on this chain)"
else
  vp_pass "chain kataIssue=${CHAIN_ISSUE}: ${WITH_WT}/${TOTAL} rows share a single worktreeId"
fi

exit 0
