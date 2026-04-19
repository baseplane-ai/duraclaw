#!/usr/bin/env bash

set -euo pipefail

VERIFY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Make sure agent-installed global npm binaries (chrome-devtools-axi,
# gh-axi, portless, etc.) are visible to every verify script regardless
# of whether the parent shell sourced the npm-global profile. The tool
# path is published in the session-start hook as ~/.npm-global/bin.
_NPM_GLOBAL_BIN="$HOME/.npm-global/bin"
if [[ -d "$_NPM_GLOBAL_BIN" && ":$PATH:" != *":$_NPM_GLOBAL_BIN:"* ]]; then
  export PATH="$_NPM_GLOBAL_BIN:$PATH"
fi

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

# Per-worktree port derivation (GH#3/#4 follow-up, durable replacement for
# the hard-coded 43173/9877 pair that collided between worktrees).
#
# Each worktree gets a stable, deterministic port pair derived from its
# absolute path. cksum is POSIX so works on bare Ubuntu / macOS alike; the
# modulo keeps us comfortably inside the 43000–43799 / 9800–10599 ranges
# that are (a) above well-known ports, (b) out of the way of the common
# 8080/3000 dev-server defaults, and (c) distinct from the shared gateway
# at 9877 that the main worktree / prod stack still uses.
#
# Explicit overrides always win: set VERIFY_ORCH_PORT / CC_GATEWAY_PORT in
# the shell or in $VERIFY_ROOT/.env to pin to a specific value. Otherwise
# a fresh worktree Just Works — no manual allocation, no collisions with
# peers running in parallel.
_derive_worktree_port_offset() {
  printf '%s' "$VERIFY_ROOT" | cksum | awk '{ print $1 % 800 }'
}

_WORKTREE_PORT_OFFSET="$(_derive_worktree_port_offset)"
_DERIVED_ORCH_PORT=$((43000 + _WORKTREE_PORT_OFFSET))
_DERIVED_GATEWAY_PORT=$((9800 + _WORKTREE_PORT_OFFSET))

VERIFY_ORCH_PORT="${VERIFY_ORCH_PORT:-$_DERIVED_ORCH_PORT}"
# Use VERIFY_GATEWAY_PORT (not CC_GATEWAY_PORT) as the verify-specific
# override knob — the ambient shell profile may export CC_GATEWAY_PORT
# (e.g. the main-worktree's 9877) and we don't want that to hijack our
# per-worktree derivation. Explicit verify-layer pin still wins.
VERIFY_GATEWAY_PORT="${VERIFY_GATEWAY_PORT:-$_DERIVED_GATEWAY_PORT}"
# Now stamp CC_GATEWAY_PORT unconditionally so every child process (the
# spawned gateway itself, auxiliary curl/jq scripts, etc.) agrees with
# what we advertise in VERIFY_GATEWAY_URL. Exporting overrides any
# inherited ambient value.
export CC_GATEWAY_PORT="$VERIFY_GATEWAY_PORT"

# Browser / CDP port derivation (4 ports per worktree, non-overlapping ranges).
# These prevent two worktrees from fighting for the same Chrome CDP socket
# or chrome-devtools-axi bridge port.
_DERIVED_BROWSER_A_PORT=$((11000 + _WORKTREE_PORT_OFFSET))
_DERIVED_BROWSER_B_PORT=$((12000 + _WORKTREE_PORT_OFFSET))
_DERIVED_AXI_A_BRIDGE_PORT=$((13000 + _WORKTREE_PORT_OFFSET))
_DERIVED_AXI_B_BRIDGE_PORT=$((14000 + _WORKTREE_PORT_OFFSET))

BROWSER_A_PORT="${BROWSER_A_PORT:-$_DERIVED_BROWSER_A_PORT}"
BROWSER_B_PORT="${BROWSER_B_PORT:-$_DERIVED_BROWSER_B_PORT}"
AXI_A_BRIDGE_PORT="${AXI_A_BRIDGE_PORT:-$_DERIVED_AXI_A_BRIDGE_PORT}"
AXI_B_BRIDGE_PORT="${AXI_B_BRIDGE_PORT:-$_DERIVED_AXI_B_BRIDGE_PORT}"
export BROWSER_A_PORT BROWSER_B_PORT AXI_A_BRIDGE_PORT AXI_B_BRIDGE_PORT

# Per-worktree Chrome profile and axi state dirs — prevents cookie/session
# cross-contamination when multiple worktrees run dual-browser verify.
_WORKTREE_SLUG="$(basename "$VERIFY_ROOT")"
BROWSER_A_PROFILE="${BROWSER_A_PROFILE:-/tmp/duraclaw-chrome-a-${_WORKTREE_SLUG}}"
BROWSER_B_PROFILE="${BROWSER_B_PROFILE:-/tmp/duraclaw-chrome-b-${_WORKTREE_SLUG}}"
AXI_A_STATE="${AXI_A_STATE:-/tmp/duraclaw-axi-a-${_WORKTREE_SLUG}}"
AXI_B_STATE="${AXI_B_STATE:-/tmp/duraclaw-axi-b-${_WORKTREE_SLUG}}"
export BROWSER_A_PROFILE BROWSER_B_PROFILE AXI_A_STATE AXI_B_STATE

if [[ -f "$VERIFY_RUNTIME_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$VERIFY_RUNTIME_FILE"
fi

VERIFY_ORCH_URL="${VERIFY_ORCH_URL:-${VERIFY_ORCH_RUNTIME_URL:-http://127.0.0.1:${VERIFY_ORCH_PORT}}}"
VERIFY_ORCH_READY_URL="${VERIFY_ORCH_READY_URL:-$VERIFY_ORCH_URL/api/auth/get-session}"
VERIFY_ORIGIN="${VERIFY_ORIGIN:-$VERIFY_ORCH_URL}"

VERIFY_GATEWAY_URL="${VERIFY_GATEWAY_URL:-http://127.0.0.1:${CC_GATEWAY_PORT}}"
VERIFY_GATEWAY_WS_URL="${VERIFY_GATEWAY_WS_URL:-ws://127.0.0.1:${CC_GATEWAY_PORT}}"
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

# Regenerate apps/orchestrator/.dev.vars so its URL/port bindings match the
# currently-derived VERIFY_ORCH_PORT / CC_GATEWAY_PORT / CC_GATEWAY_SECRET.
# Idempotent: preserves BETTER_AUTH_SECRET, VAPID_*, and any other keys not
# explicitly managed here. Creates the file from scratch if missing.
#
# The contract: .dev.vars is gitignored and generated — never edit it by
# hand expecting persistence across `dev-up.sh` invocations. Per-secret
# overrides live in $VERIFY_ROOT/.env (also gitignored, sourced first).
sync_dev_vars() {
  local dev_vars="$VERIFY_ROOT/apps/orchestrator/.dev.vars"
  local managed_keys=(BETTER_AUTH_URL CC_GATEWAY_URL CC_GATEWAY_SECRET WORKER_PUBLIC_URL BOOTSTRAP_TOKEN)
  local secret="${CC_GATEWAY_SECRET:-${CC_GATEWAY_API_TOKEN:-}}"

  if [[ -z "$secret" ]]; then
    echo "sync_dev_vars: CC_GATEWAY_SECRET / CC_GATEWAY_API_TOKEN unset in \$VERIFY_ROOT/.env — gateway auth will fail" >&2
    return 1
  fi

  local tmp
  tmp="$(mktemp)"

  # 1) Carry forward every key NOT in our managed set.
  if [[ -f "$dev_vars" ]]; then
    while IFS= read -r line; do
      local key="${line%%=*}"
      local skip=0
      for mk in "${managed_keys[@]}"; do
        if [[ "$key" == "$mk" ]]; then skip=1; break; fi
      done
      if [[ "$skip" -eq 0 ]]; then
        printf '%s\n' "$line" >>"$tmp"
      fi
    done <"$dev_vars"
  fi

  # 2) Seed BETTER_AUTH_SECRET if the preserved block didn't have one.
  if ! grep -q '^BETTER_AUTH_SECRET=' "$tmp" 2>/dev/null; then
    printf 'BETTER_AUTH_SECRET=dev-secret-change-me-in-production\n' >>"$tmp"
  fi

  # 3) Append the managed block. BOOTSTRAP_TOKEN is optional — only
  # emitted when the caller has it in the environment (seed-users.sh
  # path); the prod/main-worktree path doesn't need it.
  cat >>"$tmp" <<EOF
BETTER_AUTH_URL=$VERIFY_ORCH_URL
CC_GATEWAY_URL=$VERIFY_GATEWAY_WS_URL
CC_GATEWAY_SECRET=$secret
WORKER_PUBLIC_URL=$VERIFY_ORCH_URL
EOF
  if [[ -n "${BOOTSTRAP_TOKEN:-}" ]]; then
    printf 'BOOTSTRAP_TOKEN=%s\n' "$BOOTSTRAP_TOKEN" >>"$tmp"
  fi

  mv "$tmp" "$dev_vars"
}
