#!/usr/bin/env bash
#
# GH#8 Phase 2: Run the orchestrator + agent-gateway under portless so both
# services publish at stable `.localhost` subdomains instead of ephemeral
# ports. This makes `.dev.vars` values portable across worktrees and
# sessions, and gives verify-mode a single documented contract:
#
#     WORKER_PUBLIC_URL=https://duraclaw-orch.localhost
#     CC_GATEWAY_URL=wss://duraclaw-gw.localhost
#
# The gateway honours portless's injected PORT env var (see server.ts), so
# no code changes are needed to opt in.
#
# Prerequisites (one-time, run manually):
#   1. npm install -g portless
#   2. portless proxy start     # prompts sudo; binds 443, trusts local CA
#   3. portless hosts sync      # adds *.localhost entries to /etc/hosts
#
# Usage:
#     scripts/verify/portless-up.sh       # idempotent
#     scripts/verify/portless-down.sh     # teardown
#
# Runtime state written to $VERIFY_STATE_DIR/portless.runtime.env so the
# existing verify `common.sh` contract (VERIFY_ORCH_RUNTIME_URL,
# VERIFY_GATEWAY_URL) continues to work unchanged.
#
# Design notes: planning/research/2026-04-18-verify-infra-issue-8.md §3.3.

set -euo pipefail

source "$(dirname "$0")/common.sh"

require_cmd portless
require_cmd curl
require_cmd pnpm
require_cmd bun

# Stable names — single-level subdomains keep DNS resolution cheap
# (`.localhost` is reserved per RFC 6761 and resolves without /etc/hosts in
# Chrome/Firefox; portless hosts-sync papers over Safari/Linux edge cases).
ORCH_NAME="${ORCH_NAME:-duraclaw-orch}"
GATEWAY_NAME="${GATEWAY_NAME:-duraclaw-gw}"

# Portless publishes HTTPS on 443 by default. These env vars let operators
# override for CI or privileged-port-restricted envs (PORTLESS_PORT=4443 etc).
ORCH_SCHEME="${ORCH_SCHEME:-https}"
ORCH_WS_SCHEME="${ORCH_WS_SCHEME:-wss}"
GATEWAY_SCHEME="${GATEWAY_SCHEME:-https}"
GATEWAY_WS_SCHEME="${GATEWAY_WS_SCHEME:-wss}"

ORCH_URL="${ORCH_SCHEME}://${ORCH_NAME}.localhost"
ORCH_WS_URL="${ORCH_WS_SCHEME}://${ORCH_NAME}.localhost"
GATEWAY_URL="${GATEWAY_SCHEME}://${GATEWAY_NAME}.localhost"
GATEWAY_WS_URL="${GATEWAY_WS_SCHEME}://${GATEWAY_NAME}.localhost"

PORTLESS_ORCH_PID_FILE="${PORTLESS_ORCH_PID_FILE:-$VERIFY_STATE_DIR/portless-orch.pid}"
PORTLESS_GATEWAY_PID_FILE="${PORTLESS_GATEWAY_PID_FILE:-$VERIFY_STATE_DIR/portless-gw.pid}"
PORTLESS_ORCH_LOG_FILE="${PORTLESS_ORCH_LOG_FILE:-$VERIFY_LOG_DIR/portless-orch.log}"
PORTLESS_GATEWAY_LOG_FILE="${PORTLESS_GATEWAY_LOG_FILE:-$VERIFY_LOG_DIR/portless-gw.log}"
PORTLESS_RUNTIME_FILE="${PORTLESS_RUNTIME_FILE:-$VERIFY_STATE_DIR/portless.runtime.env}"

# ── Preflight ──────────────────────────────────────────────────────────

preflight_portless_proxy() {
  # `portless list` prints active routes; if the proxy isn't up it fails
  # non-zero. We use this as our readiness probe.
  if ! portless list >/dev/null 2>&1; then
    cat <<'EOF' >&2
Portless proxy is not running. Run these once (each may prompt for sudo):

  portless proxy start
  portless hosts sync

Then re-run this script.
EOF
    exit 2
  fi
}

# ── Launch wrappers ────────────────────────────────────────────────────

launch_orchestrator() {
  cleanup_stale_pidfile "$PORTLESS_ORCH_PID_FILE"
  if [[ -f "$PORTLESS_ORCH_PID_FILE" ]]; then
    echo "Orchestrator (portless) already running (pid $(cat "$PORTLESS_ORCH_PID_FILE"))"
    return 0
  fi

  : >"$PORTLESS_ORCH_LOG_FILE"
  # Vite respects $PORT — portless injects it. We pass --host 127.0.0.1 so
  # the dev server binds to the loopback portless dials; --strictPort is
  # intentionally omitted because portless picks a fresh ephemeral port on
  # each restart.
  nohup bash -lc "
    set -euo pipefail
    cd \"$VERIFY_ROOT/apps/orchestrator\"
    if [[ -f \"$VERIFY_ROOT/.env\" ]]; then
      set -a
      source \"$VERIFY_ROOT/.env\"
      set +a
    fi
    # Force orchestrator-side env so the DO sees the stable portless URLs,
    # not whatever leaked in from the ambient shell.
    export CC_GATEWAY_URL=\"$GATEWAY_WS_URL\"
    export WORKER_PUBLIC_URL=\"$ORCH_URL\"
    export BETTER_AUTH_URL=\"$ORCH_URL\"
    exec portless \"$ORCH_NAME\" pnpm exec vite dev --host 127.0.0.1
  " >"$PORTLESS_ORCH_LOG_FILE" 2>&1 &

  echo $! >"$PORTLESS_ORCH_PID_FILE"
  echo "Started orchestrator under portless (pid $(cat "$PORTLESS_ORCH_PID_FILE")) → $ORCH_URL"
}

launch_gateway() {
  cleanup_stale_pidfile "$PORTLESS_GATEWAY_PID_FILE"
  if [[ -f "$PORTLESS_GATEWAY_PID_FILE" ]]; then
    echo "Gateway (portless) already running (pid $(cat "$PORTLESS_GATEWAY_PID_FILE"))"
    return 0
  fi

  : >"$PORTLESS_GATEWAY_LOG_FILE"
  # Gateway reads PORT (added in server.ts for this feature) falling back
  # to CC_GATEWAY_PORT. Portless injects PORT for its child, so no shell
  # juggling required.
  nohup bash -lc "
    set -euo pipefail
    cd \"$VERIFY_ROOT\"
    if [[ -f ./.env ]]; then
      set -a
      source ./.env
      set +a
    fi
    exec portless \"$GATEWAY_NAME\" bun run packages/agent-gateway/src/server.ts
  " >"$PORTLESS_GATEWAY_LOG_FILE" 2>&1 &

  echo $! >"$PORTLESS_GATEWAY_PID_FILE"
  echo "Started gateway under portless (pid $(cat "$PORTLESS_GATEWAY_PID_FILE")) → $GATEWAY_URL"
}

wait_for_url() {
  local label="$1"
  local url="$2"
  local attempts="${3:-60}"

  for _ in $(seq 1 "$attempts"); do
    # -k because portless HTTPS uses its local CA which may not be on the
    # curl trust store on every host; the route + response is what we care
    # about, not cert verification.
    if curl -k --silent --show-error --fail "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  echo "Timed out waiting for $label at $url" >&2
  return 1
}

# ── Go ─────────────────────────────────────────────────────────────────

preflight_portless_proxy

print_section "orchestrator (portless)"
launch_orchestrator

print_section "gateway (portless)"
launch_gateway

print_section "wait"
wait_for_url "gateway /health" "$GATEWAY_URL/health" 60
wait_for_url "orchestrator auth" "$ORCH_URL/api/auth/get-session" 90

# ── Publish runtime env ────────────────────────────────────────────────

cat >"$PORTLESS_RUNTIME_FILE" <<EOF
# Written by scripts/verify/portless-up.sh — do not edit.
VERIFY_ORCH_URL="$ORCH_URL"
VERIFY_ORCH_READY_URL="$ORCH_URL/api/auth/get-session"
VERIFY_ORCH_RUNTIME_URL="$ORCH_URL"
VERIFY_ORIGIN="$ORCH_URL"
VERIFY_GATEWAY_URL="$GATEWAY_URL"
VERIFY_GATEWAY_WS_URL="$GATEWAY_WS_URL"
VERIFY_GATEWAY_READY_URL="$GATEWAY_URL/health"
EOF

# Mirror into the canonical runtime file so common.sh picks it up without
# needing to know whether portless or direct-port mode is in use.
cp "$PORTLESS_RUNTIME_FILE" "$VERIFY_RUNTIME_FILE"

echo
echo "Orchestrator:  $ORCH_URL"
echo "Gateway:       $GATEWAY_URL"
echo "Gateway WS:    $GATEWAY_WS_URL"
echo "Logs:          $PORTLESS_ORCH_LOG_FILE  |  $PORTLESS_GATEWAY_LOG_FILE"
echo "Runtime:       $PORTLESS_RUNTIME_FILE"
echo
echo "NOTE: .dev.vars in apps/orchestrator is the source of truth for the DO."
echo "      Copy .dev.vars.example (portless section) if you haven't."
