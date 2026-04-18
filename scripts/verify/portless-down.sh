#!/usr/bin/env bash
#
# GH#8 Phase 2: Teardown companion to portless-up.sh. Idempotent.
# Stops the two wrapped services. Does NOT stop the portless proxy itself —
# that's a shared resource (other projects on the same host may use it).
# If you really want to stop the proxy: `portless proxy stop`.

set -euo pipefail

source "$(dirname "$0")/common.sh"

PORTLESS_ORCH_PID_FILE="${PORTLESS_ORCH_PID_FILE:-$VERIFY_STATE_DIR/portless-orch.pid}"
PORTLESS_GATEWAY_PID_FILE="${PORTLESS_GATEWAY_PID_FILE:-$VERIFY_STATE_DIR/portless-gw.pid}"
PORTLESS_RUNTIME_FILE="${PORTLESS_RUNTIME_FILE:-$VERIFY_STATE_DIR/portless.runtime.env}"

stop_wrapper() {
  local label="$1"
  local pid_file="$2"

  if [[ ! -f "$pid_file" ]]; then
    echo "$label not running (no pid file)"
    return 0
  fi

  local pid
  pid="$(cat "$pid_file")"

  if kill -0 "$pid" >/dev/null 2>&1; then
    # The pid is the `bash -lc "... exec portless ... exec <real cmd>"`
    # process group leader. Signal the group so portless + child both die.
    kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    sleep 1
    kill -0 "$pid" >/dev/null 2>&1 && kill -KILL "$pid" 2>/dev/null || true
    echo "Stopped $label (pid $pid)"
  else
    echo "$label pid $pid already exited"
  fi
  rm -f "$pid_file"
}

stop_wrapper "orchestrator (portless)" "$PORTLESS_ORCH_PID_FILE"
stop_wrapper "gateway (portless)" "$PORTLESS_GATEWAY_PID_FILE"

rm -f "$PORTLESS_RUNTIME_FILE"
# Only clear the shared runtime file if it currently reflects our portless
# URLs — don't clobber a concurrent dev-up.sh run.
if [[ -f "$VERIFY_RUNTIME_FILE" ]] && grep -q 'duraclaw-orch.localhost' "$VERIFY_RUNTIME_FILE" 2>/dev/null; then
  rm -f "$VERIFY_RUNTIME_FILE"
fi
