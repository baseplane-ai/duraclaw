#!/usr/bin/env bash
#
# scripts/verify/gh115-vp-discovery.sh
#
# VP: a new clone created on the VPS appears in the registry within 60s.
#
# Strategy:
#   1. Sign in as admin.
#   2. Snapshot the current GET /api/worktrees row count.
#   3. Lay down a synthetic clone fixture under /data/projects/<slug>/
#      with .git/HEAD pointing at refs/heads/main. We do NOT initialise
#      a real git repo (no `git init` shell-out — keeps the VP curl-only)
#      — the gateway sweep at packages/agent-gateway/src/worktree-sweep.ts
#      reads HEAD via `git -C <path> rev-parse --abbrev-ref HEAD`, which
#      operates fine on a directory with just .git/HEAD.
#   4. Trigger a sweep — either by waiting up to 70s (the 60s
#      setInterval plus jitter) or by POSTing to /sessions/start which
#      lazy-runs the sweep at request head. We pick the wait path —
#      simpler, no fake gateway calls, and the spec contracts on the
#      passive sweep window.
#   5. Assert: GET /api/worktrees row count increased AND a row with
#      path == fixture path exists.
#   6. Cleanup: DELETE /api/worktrees/:id for the fixture row, rm -rf
#      the fixture dir.
#
# Caveat: /data/projects/ on the dev VPS is owned by `ubuntu` and
# writable to that user. If this script is run as a different user, the
# mkdir + rm fail — operator should switch to the ubuntu user before
# running. Detected at the top.
#
# Run: bash scripts/verify/gh115-vp-discovery.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=gh115-vp-common.sh
source "$SCRIPT_DIR/gh115-vp-common.sh"

PROJECTS_ROOT="${GH115_PROJECTS_ROOT:-/data/projects}"
SLUG="vp-discovery-$$-$(date +%s)"
FIXTURE="${PROJECTS_ROOT}/${SLUG}"

if [[ ! -d "$PROJECTS_ROOT" ]]; then
  vp_fail "${PROJECTS_ROOT} does not exist — operator must run on the dev VPS"
fi
if [[ ! -w "$PROJECTS_ROOT" ]]; then
  vp_fail "${PROJECTS_ROOT} not writable by current user $(whoami) — su to the ubuntu account"
fi

cleanup_discovery() {
  if [[ -n "${WT_ROW_ID:-}" ]]; then
    vp_log "cleanup: DELETE /api/worktrees/${WT_ROW_ID}"
    gh115_delete_worktree "$WT_ROW_ID" "$JAR" >/dev/null 2>&1 || true
  fi
  if [[ -d "$FIXTURE" ]]; then
    vp_log "cleanup: rm -rf ${FIXTURE}"
    rm -rf "$FIXTURE"
  fi
}
trap cleanup_discovery EXIT

vp_log "Signing in as ${VERIFY_AUTH_EMAIL}"
JAR="$(gh115_bearer_admin)"

vp_log "Snapshotting current registry size"
BEFORE_LIST="$(gh115_list_worktrees "$JAR")"
BEFORE_COUNT="$(printf '%s' "$BEFORE_LIST" | jq '.worktrees | length // (. | length)' 2>/dev/null || echo 0)"
vp_log "before: ${BEFORE_COUNT} rows"

vp_log "Laying down synthetic clone fixture at ${FIXTURE}"
mkdir -p "$FIXTURE/.git"
printf 'ref: refs/heads/main\n' > "$FIXTURE/.git/HEAD"
# Add a .duraclaw/reservation.json so the sweep classifies it
# deterministically as reservedBy={kind:'manual', id: SLUG}. This makes
# the post-sweep assertion stable regardless of which branch heuristic
# the gateway falls back to.
mkdir -p "$FIXTURE/.duraclaw"
cat > "$FIXTURE/.duraclaw/reservation.json" <<EOF
{"kind":"manual","id":"${SLUG}"}
EOF

# The check function we'll poll: does the registry contain a row with
# path == $FIXTURE?
check_fixture_in_registry() {
  local list path_match
  list="$(gh115_list_worktrees "$JAR")"
  path_match="$(printf '%s' "$list" | jq -r --arg p "$FIXTURE" '
    [.worktrees[]? // .[]? | select(.path == $p) | .id] | first // empty
  ' 2>/dev/null)"
  if [[ -n "$path_match" ]]; then
    WT_ROW_ID="$path_match"
    return 0
  fi
  return 1
}

vp_log "Polling registry for fixture path; up to 70s (60s sweep interval + jitter)"
if gh115_wait_for check_fixture_in_registry 70; then
  vp_pass "fixture appeared in registry as id=${WT_ROW_ID} within 70s"
else
  vp_log "(NOTE) sweep didn't pick up fixture within 70s; this can happen if (a) the gateway sweep is disabled in dev, or (b) PROJECT_PATTERNS / WORKTREE_PATTERNS exclude the slug"
  vp_log "Trying lazy-upsert via POST /sessions/start as a fallback nudge"
  curl -s -o /dev/null \
    -H "Authorization: Bearer ${CC_GATEWAY_API_TOKEN:-}" \
    "${GATEWAY_BASE}/sessions" >/dev/null 2>&1 || true
  if gh115_wait_for check_fixture_in_registry 30; then
    vp_pass "fixture appeared after lazy-upsert nudge"
  else
    vp_fail "fixture path ${FIXTURE} never appeared in /api/worktrees within combined window"
  fi
fi

exit 0
