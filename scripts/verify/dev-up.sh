#!/usr/bin/env bash

set -euo pipefail

source "$(dirname "$0")/common.sh"

require_cmd bun
require_cmd pnpm
require_cmd curl
require_cmd tmux

cleanup_stale_pidfile "$GATEWAY_PID_FILE"
cleanup_stale_pidfile "$ORCH_PID_FILE"
rm -f "$VERIFY_RUNTIME_FILE"

wait_for_service() {
  local label="$1"
  local url="$2"
  local pid_file="$3"
  local log_file="$4"
  local attempts="$5"

  for _ in $(seq 1 "$attempts"); do
    if curl --silent --show-error --fail "$url" >/dev/null 2>&1; then
      return 0
    fi

    if [[ -f "$pid_file" ]]; then
      local pid
      pid="$(cat "$pid_file")"
      if ! kill -0 "$pid" >/dev/null 2>&1; then
        echo "$label exited before becoming ready" >&2
        tail -n 80 "$log_file" >&2 || true
        cleanup_stale_pidfile "$pid_file"
        return 1
      fi
    fi

    sleep 1
  done

  echo "Timed out waiting for $label at $url" >&2
  tail -n 80 "$log_file" >&2 || true
  return 1
}

wait_for_tmux_service() {
  local label="$1"
  local url="$2"
  local tmux_session="$3"
  local log_file="$4"
  local attempts="$5"

  for _ in $(seq 1 "$attempts"); do
    if curl --silent --show-error --fail "$url" >/dev/null 2>&1; then
      return 0
    fi

    if ! tmux has-session -t "$tmux_session" 2>/dev/null; then
      echo "$label tmux session exited before becoming ready" >&2
      tail -n 80 "$log_file" >&2 || true
      return 1
    fi

    sleep 1
  done

  echo "Timed out waiting for $label at $url" >&2
  tail -n 80 "$log_file" >&2 || true
  return 1
}

start_gateway() {
  nohup bash -lc "
    set -euo pipefail
    cd \"$VERIFY_ROOT\"
    if [[ -f ./.env ]]; then
      set -a
      source ./.env
      set +a
    fi
    exec bun run packages/cc-gateway/src/server.ts
  " >"$GATEWAY_LOG_FILE" 2>&1 &

  echo $! >"$GATEWAY_PID_FILE"
}

start_orchestrator() {
  rm -f "$ORCH_PID_FILE"
  : >"$ORCH_LOG_FILE"
  tmux new-session -d -s "$ORCH_TMUX_SESSION" -c "$VERIFY_ROOT/apps/orchestrator" "bash '$VERIFY_ROOT/scripts/verify/orchestrator-launch.sh'"
  tmux pipe-pane -o -t "$ORCH_TMUX_SESSION" "cat >>'$ORCH_LOG_FILE'"
}

detect_orchestrator_url() {
  local attempts="$1"

  for _ in $(seq 1 "$attempts"); do
    if tmux has-session -t "$ORCH_TMUX_SESSION" 2>/dev/null; then
      local detected
      detected="$(tmux capture-pane -pt "$ORCH_TMUX_SESSION" | grep -Eo 'http://(localhost|127\.0\.0\.1):[0-9]+' | tail -n 1 || true)"
      if [[ -n "$detected" ]]; then
        printf 'VERIFY_ORCH_RUNTIME_URL=%q\n' "$detected" >"$VERIFY_RUNTIME_FILE"
        echo "$detected"
        return 0
      fi
    fi

    if ! tmux has-session -t "$ORCH_TMUX_SESSION" 2>/dev/null; then
      echo "orchestrator exited before publishing a local URL" >&2
      tail -n 80 "$ORCH_LOG_FILE" >&2 || true
      return 1
    fi

    sleep 1
  done

  echo "Timed out waiting for orchestrator URL in $ORCH_LOG_FILE" >&2
  tail -n 80 "$ORCH_LOG_FILE" >&2 || true
  return 1
}

print_section "gateway"
if curl --silent --show-error --fail "$VERIFY_GATEWAY_READY_URL" >/dev/null 2>&1; then
  echo "Gateway already responding at $VERIFY_GATEWAY_URL"
elif [[ -f "$GATEWAY_PID_FILE" ]]; then
  echo "Gateway start already in progress (pid $(cat "$GATEWAY_PID_FILE"))"
else
  start_gateway
  echo "Started gateway (pid $(cat "$GATEWAY_PID_FILE"))"
fi

print_section "orchestrator"
if curl --silent --show-error --fail "$VERIFY_ORCH_READY_URL" >/dev/null 2>&1; then
  echo "Orchestrator already responding at $VERIFY_ORCH_URL"
elif tmux has-session -t "$ORCH_TMUX_SESSION" 2>/dev/null; then
  echo "Orchestrator start already in progress (tmux:$ORCH_TMUX_SESSION)"
else
  start_orchestrator
  echo "Started orchestrator (tmux:$ORCH_TMUX_SESSION)"
fi

print_section "wait"
wait_for_service "gateway" "$VERIFY_GATEWAY_READY_URL" "$GATEWAY_PID_FILE" "$GATEWAY_LOG_FILE" 60
VERIFY_ORCH_URL="$(detect_orchestrator_url 90)"
VERIFY_ORCH_READY_URL="$VERIFY_ORCH_URL/api/auth/get-session"
wait_for_tmux_service "orchestrator" "$VERIFY_ORCH_READY_URL" "$ORCH_TMUX_SESSION" "$ORCH_LOG_FILE" 90

echo "Gateway ready:      $VERIFY_GATEWAY_URL"
echo "Orchestrator ready: $VERIFY_ORCH_URL"
echo "Gateway log:        $GATEWAY_LOG_FILE"
echo "Orchestrator log:   $ORCH_LOG_FILE"
