#!/usr/bin/env bash

set -euo pipefail

source "$(dirname "$0")/common.sh"

rm -f "$VERIFY_RUNTIME_FILE"

if command -v tmux >/dev/null 2>&1 && tmux has-session -t "$ORCH_TMUX_SESSION" 2>/dev/null; then
  tmux kill-session -t "$ORCH_TMUX_SESSION"
  echo "Stopped orchestrator tmux session ($ORCH_TMUX_SESSION)"
fi

stop_pidfile() {
  local label="$1"
  local pid_file="$2"

  cleanup_stale_pidfile "$pid_file"

  if [[ ! -f "$pid_file" ]]; then
    echo "$label is not managed by scripts/verify"
    return 0
  fi

  local pid
  pid="$(cat "$pid_file")"
  kill "$pid" >/dev/null 2>&1 || true

  for _ in $(seq 1 20); do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      rm -f "$pid_file"
      echo "Stopped $label (pid $pid)"
      return 0
    fi
    sleep 0.5
  done

  kill -9 "$pid" >/dev/null 2>&1 || true
  rm -f "$pid_file"
  echo "Force-stopped $label (pid $pid)"
}

stop_pidfile "gateway" "$GATEWAY_PID_FILE"
stop_pidfile "orchestrator" "$ORCH_PID_FILE"
