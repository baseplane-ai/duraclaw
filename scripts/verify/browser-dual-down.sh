#!/usr/bin/env bash
#
# GH#8: Teardown companion to browser-dual-up.sh. Idempotent.

set -euo pipefail

source "$(dirname "$0")/common.sh"

BROWSER_A_PID_FILE="${BROWSER_A_PID_FILE:-$VERIFY_STATE_DIR/browser-a.pid}"
BROWSER_B_PID_FILE="${BROWSER_B_PID_FILE:-$VERIFY_STATE_DIR/browser-b.pid}"

stop_browser() {
  local label="$1"
  local pid_file="$2"

  if [[ ! -f "$pid_file" ]]; then
    echo "Browser $label not running (no pid file)"
    return 0
  fi

  local pid
  pid="$(cat "$pid_file")"

  if kill -0 "$pid" >/dev/null 2>&1; then
    # Chrome spawns a process tree; kill the process group so renderers die too.
    kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    # Brief grace, then SIGKILL anything still alive.
    sleep 1
    kill -0 "$pid" >/dev/null 2>&1 && kill -KILL "$pid" 2>/dev/null || true
    echo "Stopped browser $label (pid $pid)"
  else
    echo "Browser $label pid $pid already exited"
  fi
  rm -f "$pid_file"
}

stop_browser "A" "$BROWSER_A_PID_FILE"
stop_browser "B" "$BROWSER_B_PID_FILE"
