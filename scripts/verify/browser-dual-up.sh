#!/usr/bin/env bash
#
# GH#8: Launch two independent Chrome browsers with separate profile dirs
# and CDP endpoints so verify-mode can drive two distinct users through
# `chrome-devtools-axi` simultaneously.
#
# `chrome-devtools-axi` does not expose a profile-per-invocation knob — it
# attaches to (or launches) a single shared Chrome. But it DOES honour
# `CHROME_DEVTOOLS_AXI_BROWSER_URL`, which lets us pre-launch the two
# Chromes ourselves and point each axi invocation at the one we want.
#
# Usage:
#     scripts/verify/browser-dual-up.sh       # idempotent: leaves running
#     scripts/verify/axi-a open /login        # drive user A
#     scripts/verify/axi-b open /login        # drive user B
#     scripts/verify/browser-dual-down.sh     # teardown
#
# See planning/research/2026-04-18-verify-infra-issue-8.md §3.2 and the
# "Dual browser profiles" section of CLAUDE.md.

set -euo pipefail

source "$(dirname "$0")/common.sh"

require_cmd curl

# Ports and profiles are derived per-worktree in common.sh — no hardcoded
# defaults here. BROWSER_A_PORT, BROWSER_B_PORT, BROWSER_A_PROFILE, and
# BROWSER_B_PROFILE are already exported by common.sh above.
BROWSER_A_PID_FILE="${BROWSER_A_PID_FILE:-$VERIFY_STATE_DIR/browser-a.pid}"
BROWSER_B_PID_FILE="${BROWSER_B_PID_FILE:-$VERIFY_STATE_DIR/browser-b.pid}"
BROWSER_A_LOG_FILE="${BROWSER_A_LOG_FILE:-$VERIFY_LOG_DIR/browser-a.log}"
BROWSER_B_LOG_FILE="${BROWSER_B_LOG_FILE:-$VERIFY_LOG_DIR/browser-b.log}"

# Chrome binary — try stable paths. Users can override via env.
CHROME_BIN="${CHROME_BIN:-}"
if [[ -z "$CHROME_BIN" ]]; then
  for candidate in \
    /opt/google/chrome/chrome \
    /usr/bin/google-chrome \
    /usr/bin/chromium \
    /usr/bin/chromium-browser; do
    if [[ -x "$candidate" ]]; then
      CHROME_BIN="$candidate"
      break
    fi
  done
fi
if [[ -z "$CHROME_BIN" ]]; then
  echo "Could not locate a Chrome binary — set CHROME_BIN=/path/to/chrome" >&2
  exit 1
fi

launch_browser() {
  local label="$1"
  local port="$2"
  local profile="$3"
  local pid_file="$4"
  local log_file="$5"

  cleanup_stale_pidfile "$pid_file"

  # Idempotent: if CDP already answers, skip.
  if curl --silent --show-error --fail "http://127.0.0.1:${port}/json/version" >/dev/null 2>&1; then
    echo "Browser $label already listening on :$port"
    return 0
  fi

  mkdir -p "$profile"
  # --remote-debugging-port pins CDP to a port (not to a pipe) so
  # chrome-devtools-axi can attach via CHROME_DEVTOOLS_AXI_BROWSER_URL.
  # --user-data-dir gives an isolated cookie jar.
  # --no-first-run/--no-default-browser-check silence dialogs.
  # --headless=new keeps this usable on a headless VPS; swap to headed
  # locally by exporting BROWSER_HEADED=1 before running.
  local headless_arg="--headless=new"
  if [[ "${BROWSER_HEADED:-0}" == "1" ]]; then
    headless_arg=""
  fi

  nohup "$CHROME_BIN" \
    ${headless_arg} \
    --no-first-run \
    --no-default-browser-check \
    --disable-dev-shm-usage \
    --disable-gpu \
    --remote-debugging-port="$port" \
    --remote-allow-origins="*" \
    --user-data-dir="$profile" \
    about:blank \
    >"$log_file" 2>&1 &

  echo $! >"$pid_file"
  echo "Started browser $label (pid $(cat "$pid_file")) on :$port profile=$profile"

  # Wait for CDP readiness.
  local attempts=30
  for _ in $(seq 1 "$attempts"); do
    if curl --silent --show-error --fail "http://127.0.0.1:${port}/json/version" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "Browser $label did not open CDP on :$port within ${attempts}s" >&2
  tail -n 40 "$log_file" >&2 || true
  return 1
}

print_section "browser A"
launch_browser "A" "$BROWSER_A_PORT" "$BROWSER_A_PROFILE" "$BROWSER_A_PID_FILE" "$BROWSER_A_LOG_FILE"

print_section "browser B"
launch_browser "B" "$BROWSER_B_PORT" "$BROWSER_B_PROFILE" "$BROWSER_B_PID_FILE" "$BROWSER_B_LOG_FILE"

echo
echo "Browser A CDP: http://127.0.0.1:$BROWSER_A_PORT  profile=$BROWSER_A_PROFILE"
echo "Browser B CDP: http://127.0.0.1:$BROWSER_B_PORT  profile=$BROWSER_B_PROFILE"
echo "Drive them via: scripts/verify/axi-a ... / scripts/verify/axi-b ..."
