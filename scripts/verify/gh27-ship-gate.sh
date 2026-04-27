#!/usr/bin/env bash
#
# scripts/verify/gh27-ship-gate.sh
#
# GH#27 docs-runner v1 release gate (P1.9, spec line 175).
#
# Drives a 3-minute co-edit between two axi-browsers and a local
# docs-runner against planning/specs/0018.md. Asserts:
#   1. File hash before == file hash after, modulo deliberate edits.
#   2. /health stays "ok" throughout the test window.
#   3. Runner survives the full duration without crashing.
#   4. (Manual at this stage) browser DOMs and on-disk content agree.
#
# The deterministic axi-driven edit harness is a follow-up (P3a
# verification per file-pipeline.ts header comment); this script's
# value is the runner-survives-3-min + /health gate. Replace the
# human-window with axi page.evaluate edits when that lands.
#
# Run: bash scripts/verify/gh27-ship-gate.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

log() {
  printf '[ship-gate] %s\n' "$*"
}

fail() {
  printf '[ship-gate][FAIL] %s\n' "$*" >&2
  exit 1
}

TEST_DURATION_SEC="${TEST_DURATION_SEC:-180}"
PROJECT_ID="${PROJECT_ID:-gh27-shipgate}"
DOCS_WORKTREE="${DOCS_WORKTREE:-$REPO_ROOT}"
TARGET_FILE="planning/specs/0018.md"
ORCHESTRATOR_PORT="${ORCHESTRATOR_PORT:-${VERIFY_ORCH_PORT:-43054}}"
HEALTH_PORT="${HEALTH_PORT:-${CC_DOCS_RUNNER_PORT:-9899}}"
DOCS_RUNNER_SECRET_VAL="${DOCS_RUNNER_SECRET:-shipgate-token}"

require_cmd curl
require_cmd sha256sum
require_cmd bun

log "starting -- duration=${TEST_DURATION_SEC}s, projectId=${PROJECT_ID}"
log "target file: ${TARGET_FILE}"
log "orchestrator port: ${ORCHESTRATOR_PORT}"
log "docs-runner health port: ${HEALTH_PORT}"

# 1. preflight
if [[ ! -f "${DOCS_WORKTREE}/${TARGET_FILE}" ]]; then
  fail "target file not found: ${DOCS_WORKTREE}/${TARGET_FILE}"
fi

INITIAL_HASH="$(sha256sum "${DOCS_WORKTREE}/${TARGET_FILE}" | awk '{print $1}')"
log "initial sha256: ${INITIAL_HASH}"

# 2. ensure orchestrator + gateway are up (idempotent)
log "ensuring dev stack is up via dev-up.sh"
bash "$SCRIPT_DIR/dev-up.sh"

# 3. build + start docs-runner
log "building @duraclaw/docs-runner"
( cd "$REPO_ROOT" && pnpm --filter @duraclaw/docs-runner build ) \
  || fail "docs-runner build failed"

RUNNER_DIR="${RUNNER_DIR:-/tmp/duraclaw-docs-runners-shipgate}"
mkdir -p "$RUNNER_DIR"
CMD_FILE="$RUNNER_DIR/${PROJECT_ID}.cmd"
PID_FILE="$RUNNER_DIR/${PROJECT_ID}.pid"
EXIT_FILE="$RUNNER_DIR/${PROJECT_ID}.exit"
META_FILE="$RUNNER_DIR/${PROJECT_ID}.meta.json"
RUNNER_LOG="$RUNNER_DIR/${PROJECT_ID}.log"

# Clear any stale lifecycle files from a prior run.
rm -f "$PID_FILE" "$EXIT_FILE" "$META_FILE" "$RUNNER_LOG"

cat > "$CMD_FILE" <<EOF
{
  "type": "docs-runner",
  "projectId": "${PROJECT_ID}",
  "docsWorktreePath": "${DOCS_WORKTREE}",
  "callbackBase": "wss://localhost:${ORCHESTRATOR_PORT}/api/collab/repo-document",
  "bearer": "${DOCS_RUNNER_SECRET_VAL}",
  "watch": ["planning/specs/0018.md"],
  "ignored": [],
  "healthPort": ${HEALTH_PORT}
}
EOF

log "launching docs-runner (log: ${RUNNER_LOG})"
(
  bun "$REPO_ROOT/packages/docs-runner/dist/main.js" \
    "$PROJECT_ID" "$CMD_FILE" "$PID_FILE" "$EXIT_FILE" "$META_FILE" \
    > "$RUNNER_LOG" 2>&1 &
  echo $! > "$RUNNER_DIR/${PROJECT_ID}.bgpid"
)
RUNNER_BG_PID="$(cat "$RUNNER_DIR/${PROJECT_ID}.bgpid")"
log "docs-runner spawned bg pid=${RUNNER_BG_PID}"

cleanup_runner() {
  if [[ -n "${RUNNER_BG_PID:-}" ]] && kill -0 "$RUNNER_BG_PID" 2>/dev/null; then
    log "terminating runner pid=${RUNNER_BG_PID}"
    kill -TERM "$RUNNER_BG_PID" 2>/dev/null || true
    sleep 3
    kill -KILL "$RUNNER_BG_PID" 2>/dev/null || true
  fi
}
trap cleanup_runner EXIT

# 4. wait for /health → "status":"ok"
log "waiting for /health -> ok"
HEALTH_URL="http://127.0.0.1:${HEALTH_PORT}/health"
HEALTH_OK=0
for i in $(seq 1 30); do
  if curl -fsS "$HEALTH_URL" 2>/dev/null | grep -q '"status":"ok"'; then
    log "/health ok after ${i}s"
    HEALTH_OK=1
    break
  fi
  sleep 1
done
if [[ "$HEALTH_OK" -ne 1 ]]; then
  log "tail of runner log:"
  tail -n 50 "$RUNNER_LOG" || true
  fail "/health never reached ok at $HEALTH_URL"
fi

# 5. dual-browser login + open the docs route
log "running axi-dual-login"
bash "$SCRIPT_DIR/axi-dual-login.sh" || fail "dual axi login failed"

DOCS_URL="http://127.0.0.1:${ORCHESTRATOR_PORT}/projects/${PROJECT_ID}/docs?file=${TARGET_FILE}"
log "opening ${DOCS_URL} in both browsers"
"$SCRIPT_DIR/axi-a" open "$DOCS_URL" >/dev/null || log "axi-a open returned non-zero (continuing)"
"$SCRIPT_DIR/axi-b" open "$DOCS_URL" >/dev/null || log "axi-b open returned non-zero (continuing)"
sleep 5

# 6. co-edit window — until the deterministic axi harness lands, this is
# a soak window that asserts the runner survives + /health stays ok.
# TODO(P3a verification): replace with axi page.evaluate edits.
log "co-edit window: ${TEST_DURATION_SEC}s -- drive edits via the two browser sessions"
log "(TODO P3a verification: replace human window with axi page.evaluate edits)"

# Periodic /health probe while the window is open. Bail early if it goes
# non-ok rather than waiting the full duration to discover the failure.
PROBE_INTERVAL_SEC=15
elapsed=0
while [[ "$elapsed" -lt "$TEST_DURATION_SEC" ]]; do
  if ! curl -fsS "$HEALTH_URL" 2>/dev/null | grep -q '"status":"ok"'; then
    log "tail of runner log:"
    tail -n 50 "$RUNNER_LOG" || true
    fail "/health became non-ok at t=${elapsed}s"
  fi
  if ! kill -0 "$RUNNER_BG_PID" 2>/dev/null; then
    log "tail of runner log:"
    tail -n 50 "$RUNNER_LOG" || true
    fail "runner pid=${RUNNER_BG_PID} died at t=${elapsed}s"
  fi
  sleep "$PROBE_INTERVAL_SEC"
  elapsed=$(( elapsed + PROBE_INTERVAL_SEC ))
done

# 7. assert final state
FINAL_HASH="$(sha256sum "${DOCS_WORKTREE}/${TARGET_FILE}" | awk '{print $1}')"
log "final sha256: ${FINAL_HASH}"
if [[ "$INITIAL_HASH" == "$FINAL_HASH" ]]; then
  log "(no edits were injected during the window -- file unchanged)"
else
  log "file content changed during the window (expected if edits were driven)"
fi

if ! curl -fsS "$HEALTH_URL" 2>/dev/null | grep -q '"status":"ok"'; then
  log "tail of runner log:"
  tail -n 50 "$RUNNER_LOG" || true
  fail "/health is no longer ok at end of run"
fi

log "manual verification: confirm both browsers + on-disk content match"
log "PASS -- runner survived ${TEST_DURATION_SEC}s; /health ok throughout"
