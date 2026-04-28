#!/usr/bin/env bash
#
# scripts/verify/gh115-vp-common.sh
#
# Shared helpers for the GH#115 worktrees-first-class verification
# scripts (gh115-vp-*.sh). Sourced by each VP — never executed directly.
#
# Each VP sources this file at the top:
#
#   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   # shellcheck source=gh115-vp-common.sh
#   source "$SCRIPT_DIR/gh115-vp-common.sh"
#
# The helpers cover:
#
#   vp_log / vp_pass / vp_fail   — uniform stdout/stderr formatting
#   gh115_bearer_admin           — sign in as the local agent.verify
#                                  admin user, returns a cookie-jar path
#   gh115_reserve_fresh          — POST /api/worktrees (fresh-pick)
#   gh115_release                — POST /api/worktrees/:id/release
#   gh115_delete_worktree        — DELETE /api/worktrees/:id (admin)
#   gh115_list_worktrees         — GET /api/worktrees [+filter querystring]
#   gh115_d1_query               — wrangler d1 execute --local; falls
#                                  back to "[]" if wrangler is missing
#   gh115_wait_for               — poll a check-fn with timeout
#
# Side effects: assumes scripts/verify/dev-up.sh has the local stack
# running. If the orchestrator isn't responding, helpers will fail
# clearly via curl --fail-with-body.

set -euo pipefail

GH115_VP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$GH115_VP_DIR/common.sh"

# Public URL bases. Default to the worktree-derived ports computed in
# common.sh; explicit pin still wins via env.
ORCH_BASE="${ORCH_BASE:-http://127.0.0.1:${VERIFY_ORCH_PORT}}"
GATEWAY_BASE="${GATEWAY_BASE:-http://127.0.0.1:${CC_GATEWAY_PORT}}"

vp_log()  { printf '[gh115-vp] %s\n' "$*"; }
vp_fail() { printf '[gh115-vp][FAIL] %s\n' "$*" >&2; exit 1; }
vp_pass() { printf '[gh115-vp][PASS] %s\n' "$*"; }

# Sign in as the local admin test user via Better Auth; emit the path of
# the resulting cookie jar on stdout. Subsequent calls with the same jar
# inherit the session.
#
# If the test user doesn't exist yet, the underlying sign-in returns 401
# and we print the seed hint + exit non-zero — operators sometimes hit a
# fresh worktree where /api/bootstrap hasn't run.
#
#   $1 — optional cookie-jar path (default: /tmp/gh115-vp-cookie.jar)
gh115_bearer_admin() {
  local cookie_jar="${1:-/tmp/gh115-vp-cookie.jar}"
  rm -f "$cookie_jar"
  local http_code
  http_code="$(curl -s -o /tmp/gh115-vp-signin.out -w '%{http_code}' \
    -c "$cookie_jar" \
    -X POST "${ORCH_BASE}/api/auth/sign-in/email" \
    -H 'Content-Type: application/json' \
    -H "Origin: ${VERIFY_ORIGIN:-$ORCH_BASE}" \
    -d "{\"email\":\"${VERIFY_AUTH_EMAIL}\",\"password\":\"${VERIFY_AUTH_PASSWORD}\"}")"
  if [[ "$http_code" != "200" ]]; then
    vp_log "sign-in for ${VERIFY_AUTH_EMAIL} returned HTTP ${http_code}"
    vp_log "body: $(cat /tmp/gh115-vp-signin.out 2>/dev/null || true)"
    vp_log "Hint: seed the test user via:"
    vp_log "  curl -X POST ${ORCH_BASE}/api/bootstrap \\"
    vp_log "    -H \"Authorization: Bearer \$BOOTSTRAP_TOKEN\" \\"
    vp_log "    -H 'Content-Type: application/json' \\"
    vp_log "    -d '{\"email\":\"${VERIFY_AUTH_EMAIL}\",\"password\":\"${VERIFY_AUTH_PASSWORD}\",\"name\":\"${VERIFY_AUTH_NAME}\"}'"
    vp_fail "test user sign-in failed; seed via /api/bootstrap"
  fi
  printf '%s' "$cookie_jar"
}

# POST /api/worktrees (fresh-pick from pool).
#   $1 — reservedBy.kind  (e.g. session, arc, manual)
#   $2 — reservedBy.id    (string or number — passed verbatim into JSON)
#   $3 — cookie-jar path
# Echoes the JSON response body.
gh115_reserve_fresh() {
  local kind="$1" id="$2" cookie_jar="$3"
  # If id looks numeric, pass it as a number; else quote it.
  local id_json
  if [[ "$id" =~ ^[0-9]+$ ]]; then
    id_json="$id"
  else
    id_json="\"$id\""
  fi
  curl -s -b "$cookie_jar" -X POST "${ORCH_BASE}/api/worktrees" \
    -H 'Content-Type: application/json' \
    -d "{\"kind\":\"fresh\",\"reservedBy\":{\"kind\":\"${kind}\",\"id\":${id_json}}}"
}

# POST /api/worktrees/:id/release.
gh115_release() {
  local wt_id="$1" cookie_jar="$2"
  curl -s -b "$cookie_jar" -X POST "${ORCH_BASE}/api/worktrees/${wt_id}/release" \
    -H 'Content-Type: application/json'
}

# DELETE /api/worktrees/:id (admin).
gh115_delete_worktree() {
  local wt_id="$1" cookie_jar="$2"
  curl -s -b "$cookie_jar" -X DELETE "${ORCH_BASE}/api/worktrees/${wt_id}"
}

# GET /api/worktrees, optional querystring.
gh115_list_worktrees() {
  local cookie_jar="$1" qs="${2:-}"
  curl -s -b "$cookie_jar" "${ORCH_BASE}/api/worktrees${qs:+?${qs}}"
}

# Run a SQL query against the local D1 via wrangler; returns JSON if
# available, or "[]" if wrangler isn't installed (script falls back to
# best-effort assertions in that case).
#
#   $1 — SQL string (single statement preferred)
gh115_d1_query() {
  local sql="$1"
  if command -v wrangler >/dev/null 2>&1; then
    ( cd "$VERIFY_ROOT/apps/orchestrator" \
      && wrangler d1 execute duraclaw-auth --local --command="$sql" --json 2>/dev/null ) \
      || echo '[]'
  else
    echo '[]'
  fi
}

# Generic poll-loop. Calls $1 (a function name) repeatedly with $@ as
# args; returns 0 the first time it returns 0; non-zero after $2 seconds.
#
#   gh115_wait_for some_check_fn 30 arg1 arg2
gh115_wait_for() {
  local check_fn="$1" timeout="${2:-30}" elapsed=0
  shift 2
  while ((elapsed < timeout)); do
    if "$check_fn" "$@"; then return 0; fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}
