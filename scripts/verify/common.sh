#!/usr/bin/env bash

set -euo pipefail

VERIFY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERIFY_LOG_DIR="${VERIFY_LOG_DIR:-$VERIFY_ROOT/logs/verify}"
VERIFY_STATE_DIR="${VERIFY_STATE_DIR:-$VERIFY_LOG_DIR/state}"
VERIFY_RUNTIME_FILE="${VERIFY_RUNTIME_FILE:-$VERIFY_STATE_DIR/runtime.env}"

if [[ -f "$VERIFY_ROOT/.env" ]]; then
  while IFS= read -r line; do
    [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
    key="${line%%=*}"
    value="${line#*=}"
    if [[ -z "${!key+x}" ]]; then
      export "$key=$value"
    fi
  done <"$VERIFY_ROOT/.env"
fi

VERIFY_ORCH_PORT="${VERIFY_ORCH_PORT:-43173}"
if [[ -f "$VERIFY_RUNTIME_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$VERIFY_RUNTIME_FILE"
fi

VERIFY_ORCH_URL="${VERIFY_ORCH_URL:-${VERIFY_ORCH_RUNTIME_URL:-http://127.0.0.1:${VERIFY_ORCH_PORT}}}"
VERIFY_ORCH_READY_URL="${VERIFY_ORCH_READY_URL:-$VERIFY_ORCH_URL/api/auth/get-session}"
VERIFY_ORIGIN="${VERIFY_ORIGIN:-$VERIFY_ORCH_URL}"

VERIFY_GATEWAY_URL="${VERIFY_GATEWAY_URL:-http://127.0.0.1:9877}"
VERIFY_GATEWAY_WS_URL="${VERIFY_GATEWAY_WS_URL:-ws://127.0.0.1:9877}"
VERIFY_GATEWAY_READY_URL="${VERIFY_GATEWAY_READY_URL:-$VERIFY_GATEWAY_URL/health}"
VERIFY_GATEWAY_TOKEN="${VERIFY_GATEWAY_TOKEN:-${CC_GATEWAY_API_TOKEN:-}}"

VERIFY_PROJECT="${VERIFY_PROJECT:-}"
VERIFY_AUTH_EMAIL="${VERIFY_AUTH_EMAIL:-agent.verify+duraclaw@example.com}"
VERIFY_AUTH_PASSWORD="${VERIFY_AUTH_PASSWORD:-duraclaw-test-password}"
VERIFY_AUTH_NAME="${VERIFY_AUTH_NAME:-agent-verify}"
VERIFY_COOKIE_JAR="${VERIFY_COOKIE_JAR:-$VERIFY_STATE_DIR/auth.cookies.txt}"

# GH#8: dual-browser / multi-user defaults. `+a` / `+b` subaddressing keeps
# the accounts distinct at the auth layer without needing extra mailboxes.
VERIFY_USER_A_EMAIL="${VERIFY_USER_A_EMAIL:-agent.verify+a@example.com}"
VERIFY_USER_A_PASSWORD="${VERIFY_USER_A_PASSWORD:-duraclaw-test-password-a}"
VERIFY_USER_A_NAME="${VERIFY_USER_A_NAME:-agent-verify-a}"
VERIFY_USER_B_EMAIL="${VERIFY_USER_B_EMAIL:-agent.verify+b@example.com}"
VERIFY_USER_B_PASSWORD="${VERIFY_USER_B_PASSWORD:-duraclaw-test-password-b}"
VERIFY_USER_B_NAME="${VERIFY_USER_B_NAME:-agent-verify-b}"

VERIFY_BROWSER_SESSION="${VERIFY_BROWSER_SESSION:-duraclaw-verify}"
VERIFY_BROWSER_SNAPSHOT="${VERIFY_BROWSER_SNAPSHOT:-$VERIFY_LOG_DIR/browser-snapshot.txt}"
VERIFY_BROWSER_SCREENSHOT="${VERIFY_BROWSER_SCREENSHOT:-$VERIFY_LOG_DIR/browser-login.png}"

GATEWAY_LOG_FILE="${GATEWAY_LOG_FILE:-$VERIFY_LOG_DIR/gateway.log}"
GATEWAY_PID_FILE="${GATEWAY_PID_FILE:-$VERIFY_STATE_DIR/gateway.pid}"
ORCH_LOG_FILE="${ORCH_LOG_FILE:-$VERIFY_LOG_DIR/orchestrator.log}"
ORCH_PID_FILE="${ORCH_PID_FILE:-$VERIFY_STATE_DIR/orchestrator.pid}"
ORCH_TMUX_SESSION="${ORCH_TMUX_SESSION:-duraclaw-verify-orchestrator}"

mkdir -p "$VERIFY_LOG_DIR" "$VERIFY_STATE_DIR"

VERIFY_GATEWAY_AUTH_ARGS=()
if [[ -n "$VERIFY_GATEWAY_TOKEN" ]]; then
  VERIFY_GATEWAY_AUTH_ARGS=(-H "Authorization: Bearer $VERIFY_GATEWAY_TOKEN")
fi

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

curl_json() {
  curl --silent --show-error --fail-with-body "$@"
}

wait_for_url() {
  local url="$1"
  local attempts="${2:-60}"

  for _ in $(seq 1 "$attempts"); do
    if curl --silent --show-error --fail "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  echo "Timed out waiting for $url" >&2
  return 1
}

print_section() {
  printf '\n[%s]\n' "$1"
}

browser_is_visible() {
  local session="$1"
  local selector="$2"

  agent-browser --session "$session" is visible "$selector" 2>/dev/null || printf 'false\n'
}

wait_for_browser_visibility() {
  local session="$1"
  local selector="$2"
  local expected="${3:-true}"
  local attempts="${4:-20}"
  local delay_ms="${5:-250}"

  for _ in $(seq 1 "$attempts"); do
    local visibility
    visibility="$(browser_is_visible "$session" "$selector")"
    if [[ "$visibility" == "$expected" ]]; then
      return 0
    fi
    agent-browser --session "$session" wait "$delay_ms" >/dev/null
  done

  echo "Timed out waiting for browser visibility $expected on selector: $selector" >&2
  return 1
}

wait_for_browser_text() {
  local session="$1"
  local needle="$2"
  local selector="${3:-body}"
  local attempts="${4:-20}"
  local delay_ms="${5:-250}"

  for _ in $(seq 1 "$attempts"); do
    local body_text
    body_text="$(agent-browser --session "$session" get text "$selector" 2>/dev/null || true)"
    if grep -Fq "$needle" <<<"$body_text"; then
      return 0
    fi
    agent-browser --session "$session" wait "$delay_ms" >/dev/null
  done

  echo "Timed out waiting for browser text: $needle" >&2
  return 1
}

cleanup_stale_pidfile() {
  local pid_file="$1"

  if [[ ! -f "$pid_file" ]]; then
    return 0
  fi

  local pid
  pid="$(cat "$pid_file")"

  if ! kill -0 "$pid" >/dev/null 2>&1; then
    rm -f "$pid_file"
  fi
}
